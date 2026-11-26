import { ApiError, api, getApiBase, type DocumentDetail } from '../../api/client'
import { authStore } from '../../api/authStore'
import { splitSentences } from '../readalong/splitSentences'
import { assertImageScope, cacheEntry, cachePut, imageScope } from '../render/imageCache'
import { restoreImages } from '../render/restoreImages'
import { STORE_OFFLINE, tx } from './db'
import { readerDocKey, savePinnedDocument, unpinDocument } from './readerDocument'

/**
 * 真正的离线书单管理。
 *
 * 与普通正文缓存（24h TTL / 64MB LRU）的区别：
 *   1. 由读者显式触发「下载本书」，同时缓存正文 + 预切句 + 全部可用插图；
 *   2. 正文在 STORE_DOCUMENTS 里标记 pinned=true，不随普通缓存过期淘汰；
 *   3. 按 [apiBase, userId, docId] 隔离，换账号或换服务器绝不串书；
 *   4. 断网时可在书架「离线文档」列出并直接打开，在线时仍先验权（401/403/404 立刻清理）。
 */

export interface OfflineBookRecord {
  key: string
  apiBase: string
  userId: string
  docId: string
  doc: DocumentDetail
  savedAt: string
  contentSaved: boolean
  totalImages: number
  savedImages: number
  missingImages: number
  bytes: number
}

export interface OfflineDownloadProgress {
  stage: 'content' | 'images' | 'done'
  done: number
  total: number
}

/** 纯函数：生成离线保存状态的中文摘要 */
export function formatOfflineStatus(rec: Pick<OfflineBookRecord, 'contentSaved' | 'totalImages' | 'savedImages' | 'missingImages'>): string {
  const textPart = rec.contentSaved ? '正文已保存' : '正文未保存'
  if (rec.totalImages <= 0) return `${textPart} · 无插图`
  if (rec.missingImages <= 0 && rec.savedImages >= rec.totalImages) {
    return `${textPart} · 插图 ${rec.savedImages}/${rec.totalImages} 已保存`
  }
  return `${textPart} · 插图 ${rec.savedImages}/${rec.totalImages}（${rec.missingImages} 张待联网补齐）`
}

/** 纯函数：格式化本地占用体积 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 纯函数：按当前服务器与读者过滤离线书单，按下载时间降序 */
export function filterOfflineRecords(
  rows: OfflineBookRecord[],
  apiBase: string,
  userId: string | null,
): OfflineBookRecord[] {
  if (!userId) return []
  return rows
    .filter((r) => r.apiBase === apiBase && r.userId === userId)
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
}

export async function listOfflineBooks(
  userId: string | null = authStore.userId,
  apiBase: string = getApiBase(),
): Promise<OfflineBookRecord[]> {
  if (!userId) return []
  const all = (await tx<OfflineBookRecord[]>(STORE_OFFLINE, 'readonly', (s) => s.getAll())) ?? []
  return filterOfflineRecords(all, apiBase, userId)
}

export async function getOfflineBook(docId: string): Promise<OfflineBookRecord | null> {
  const userId = authStore.userId
  if (!userId) return null
  const key = readerDocKey(docId, userId, getApiBase())
  return (await tx<OfflineBookRecord | undefined>(STORE_OFFLINE, 'readonly', (s) => s.get(key))) ?? null
}

/**
 * 下载整本书到本机离线书单：
 *   1. 拉取文档详情与完整正文，切句后常驻落盘；
 *   2. 逐张检查/下载插图到隔离图片缓存（EPUB 缺失缓存时尝试从原文件恢复）；
 *   3. 写入 STORE_OFFLINE 元数据记录。
 */
export async function downloadBookForOffline(
  docId: string,
  onProgress?: (p: OfflineDownloadProgress) => void,
): Promise<OfflineBookRecord> {
  const apiBase = getApiBase()
  const userId = authStore.userId
  if (!userId) {
    throw new ApiError('AUTH_REQUIRED', '请先登录后再下载离线书籍。', 401)
  }
  const key = readerDocKey(docId, userId, apiBase)
  const scope = imageScope(docId)

  onProgress?.({ stage: 'content', done: 0, total: 1 })
  const doc = await api.getDocument(docId)
  const content = await api.getContent(docId)
  assertImageScope(scope)

  const sentences = splitSentences(content.paragraphs)
  const contentBytes = await savePinnedDocument(docId, doc, content, sentences)

  // 去重图片 ID（同一张图可能在多个段落引用）
  const uniqueImageIds = [...new Set(content.imageRefs.map((r) => r.imageId))]
  let savedImages = 0
  let missingImages = 0
  let imageBytes = 0
  let restoredAttempted = false

  for (let i = 0; i < uniqueImageIds.length; i++) {
    const imageId = uniqueImageIds[i]
    onProgress?.({ stage: 'images', done: i, total: uniqueImageIds.length })
    assertImageScope(scope)

    let entry = await cacheEntry(scope, imageId)
    if (!entry && doc.fileFormat === 'EPUB' && !restoredAttempted) {
      restoredAttempted = true
      try {
        await restoreImages(scope)
        entry = await cacheEntry(scope, imageId)
      } catch {
        /* 原文件缺失时继续走服务端图片副本 */
      }
    }

    if (!entry) {
      try {
        const blob = await api.getImage(docId, imageId)
        assertImageScope(scope)
        await cachePut(scope, imageId, blob, false)
        savedImages += 1
        imageBytes += blob.size
      } catch {
        // 单张图未上传或取回失败不阻断整书离线下载，如实计入 missingImages
        missingImages += 1
      }
    } else {
      savedImages += 1
      imageBytes += entry.bytes ?? entry.blob.size
    }
  }

  const record: OfflineBookRecord = {
    key,
    apiBase,
    userId,
    docId,
    doc,
    savedAt: new Date().toISOString(),
    contentSaved: true,
    totalImages: uniqueImageIds.length,
    savedImages,
    missingImages,
    bytes: contentBytes + imageBytes,
  }

  await tx(STORE_OFFLINE, 'readwrite', (s) => s.put(record))
  onProgress?.({ stage: 'done', done: uniqueImageIds.length, total: uniqueImageIds.length })
  return record
}

export async function removeOfflineBook(docId: string): Promise<void> {
  const userId = authStore.userId
  if (!userId) return
  const key = readerDocKey(docId, userId, getApiBase())
  await tx(STORE_OFFLINE, 'readwrite', (s) => s.delete(key))
  await unpinDocument(docId)
}
