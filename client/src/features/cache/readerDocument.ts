import { ApiError, api, getApiBase, type ContentPage, type DocumentDetail } from '../../api/client'
import { authStore } from '../../api/authStore'
import { STORE_DOCUMENTS, STORE_OFFLINE, tx } from './db'
import { ReaderCache } from './readerCache'
import { splitSentences, type Sentence } from '../readalong/splitSentences'

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 64 * 1024 * 1024

export interface PreparedContent {
  content: ContentPage
  sentences: Sentence[]
}

export interface StoredContent {
  key: string
  revision: string
  value: string
  bytes: number
  accessedAt: number
  expires: number
  /** 显式下载到「离线书单」的书置 true：不随普通 24h TTL / LRU 静默淘汰 */
  pinned?: boolean
}

export interface LoadedReaderDocument extends PreparedContent {
  doc: DocumentDetail
  /** true 表示本次是在断网状态下直接从已下载的离线副本打开的 */
  fromOffline: boolean
}

const memory = new ReaderCache<PreparedContent>(32 * 1024 * 1024, 5 * 60 * 1000)
const pending = new Map<string, Promise<LoadedReaderDocument>>()

export function readerDocKey(docId: string, userId = authStore.userId, apiBase = getApiBase()): string {
  return JSON.stringify([apiBase, userId, docId])
}

export function documentRevision(doc: DocumentDetail): string {
  return JSON.stringify(['reader-v2', doc.importedAt, doc.fileSize, doc.paragraphCount, doc.imageCount])
}

async function persist(row: StoredContent): Promise<void> {
  if (!row.pinned && row.bytes > MAX_BYTES) return
  await tx(STORE_DOCUMENTS, 'readwrite', store => store.put(row))
  // 游标逐条处理，淘汰列表仅保留容量元数据，避免同时持有所有正文。
  // 已显式下载离线（pinned=true）的书不参与普通缓存的过期与 LRU 淘汰。
  const { openCacheDb } = await import('./db')
  const db = await openCacheDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const transaction = db.transaction(STORE_DOCUMENTS, 'readwrite')
      const store = transaction.objectStore(STORE_DOCUMENTS)
      let total = 0
      const entries: { key: string; bytes: number; accessedAt: number }[] = []
      const cursor = store.openCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) {
          for (const entry of entries.sort((a, b) => a.accessedAt - b.accessedAt)) {
            if (total <= MAX_BYTES) break
            store.delete(entry.key)
            total -= entry.bytes
          }
          return
        }
        const entry = current.value as StoredContent
        if (entry.pinned) {
          current.continue()
          return
        }
        if (entry.expires <= Date.now()) current.delete()
        else { total += entry.bytes; entries.push({ key: entry.key, bytes: entry.bytes, accessedAt: entry.accessedAt }) }
        current.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => resolve()
      transaction.onerror = () => resolve()
    } catch { resolve() }
  })
}

/** 显式下载到离线书单时调用：把正文与预切句持久化并标记 pinned，返回估算字节数 */
export async function savePinnedDocument(
  docId: string,
  doc: DocumentDetail,
  content: ContentPage,
  sentences: Sentence[],
): Promise<number> {
  const key = readerDocKey(docId)
  const revision = documentRevision(doc)
  const serialized = JSON.stringify({ content, sentences } satisfies PreparedContent)
  const bytes = serialized.length * 2
  const row: StoredContent = {
    key,
    revision,
    value: serialized,
    bytes,
    accessedAt: Date.now(),
    expires: Date.now() + TTL_MS,
    pinned: true,
  }
  await persist(row)
  return bytes
}

/** 从离线书单移除时取消常驻标记（保留为普通 24h 缓存，不影响在线阅读） */
export async function unpinDocument(docId: string): Promise<void> {
  const key = readerDocKey(docId)
  const existing = await tx<StoredContent | undefined>(STORE_DOCUMENTS, 'readonly', store => store.get(key))
  if (!existing || !existing.pinned) return
  await tx(STORE_DOCUMENTS, 'readwrite', store =>
    store.put({ ...existing, pinned: false, expires: Date.now() + TTL_MS, accessedAt: Date.now() }),
  )
}

/** 每次先校验详情的授权/存在性；仅在断网（status=0）且存在已下载离线副本时允许本地打开。 */
export function loadReaderDocument(docId: string): Promise<LoadedReaderDocument> {
  const scope = () => readerDocKey(docId)
  const key = scope()
  const assertScope = () => {
    if (scope() !== key) throw new ApiError('READER_CONTEXT_CHANGED', '账号或服务端已切换，请重新打开书籍。', 409)
  }
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async (): Promise<LoadedReaderDocument> => {
    let doc: DocumentDetail
    try {
      doc = await api.getDocument(docId)
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        memory.invalidate(key)
        void tx(STORE_DOCUMENTS, 'readwrite', store => store.delete(key))
        void tx(STORE_OFFLINE, 'readwrite', store => store.delete(key))
        throw error
      }
      // 仅在网络不可达（status === 0）时尝试打开当前读者已显式下载的离线副本
      if (error instanceof ApiError && error.status === 0) {
        const offlineMeta = await tx<{ doc?: DocumentDetail } | undefined>(
          STORE_OFFLINE,
          'readonly',
          store => store.get(key),
        )
        const stored = await tx<StoredContent | undefined>(
          STORE_DOCUMENTS,
          'readonly',
          store => store.get(key),
        )
        assertScope()
        if (offlineMeta?.doc && stored) {
          try {
            const parsed = JSON.parse(stored.value) as PreparedContent
            if (Array.isArray(parsed.content?.paragraphs) && Array.isArray(parsed.sentences)) {
              return { doc: offlineMeta.doc, ...parsed, fromOffline: true }
            }
          } catch {
            /* 离线副本损坏则沿用原始网络错误 */
          }
        }
      }
      throw error
    }
    assertScope()
    const revision = documentRevision(doc)
    const value = await memory.load(key, revision, async () => {
      assertScope()
      const stored = await tx<StoredContent | undefined>(STORE_DOCUMENTS, 'readonly', store => store.get(key))
      assertScope()
      if (stored && stored.revision === revision && (stored.pinned || stored.expires > Date.now())) {
        try {
          const parsed = JSON.parse(stored.value) as PreparedContent
          if (!Array.isArray(parsed.content?.paragraphs) || !Array.isArray(parsed.sentences)) throw new Error('缓存损坏')
          void tx(STORE_DOCUMENTS, 'readwrite', store => store.put({ ...stored, accessedAt: Date.now() }))
          return parsed
        } catch { /* 缓存损坏时重新读取服务端 */ }
      }
      const content = await api.getContent(docId)
      assertScope()
      const prepared = { content, sentences: splitSentences(content.paragraphs) }
      const serialized = JSON.stringify(prepared)
      const row: StoredContent = {
        key,
        revision,
        value: serialized,
        bytes: serialized.length * 2,
        accessedAt: Date.now(),
        expires: Date.now() + TTL_MS,
        pinned: stored?.pinned ?? false,
      }
      void persist(row).catch(() => {})
      return prepared
    })
    assertScope()
    return { doc, ...value, fromOffline: false }
  })().finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
