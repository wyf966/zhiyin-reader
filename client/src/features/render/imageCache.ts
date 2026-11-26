/**
 * 图片本地缓存。
 *
 * 依据 docs/system-design.md §6.2 / §8：
 *   · 图片缓存上限 200MB 或单文档 300 张（先到者为准）
 *   · 超出时按最后访问时间淘汰最早的条目
 *
 * 本地副本按服务器、读者、文档、图片隔离；object URL 由每个 LazyImage 独立持有并撤销。
 *
 * 存储细节见 features/cache/db.ts，与音频缓存共用同一个 IndexedDB。
 */

import { authStore } from '../../api/authStore'
import { ApiError, getApiBase } from '../../api/client'
import {
  STORE_IMAGES,
  evictByLru,
  tx,
} from '../cache/db'

export const MAX_IMAGES_PER_DOC = 300
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024 // 200MB

export interface ImageScope { server: string; userId: string; docId: string }

export function imageScope(docId: string): ImageScope {
  const base = getApiBase()
  const server = typeof location === 'undefined' ? base : new URL(base, location.href).href
  return { server, userId: authStore.userId ?? '', docId }
}

export function imageKey(scope: ImageScope, imageId: string): string {
  return JSON.stringify([scope.server, scope.userId, scope.docId, imageId])
}

export function assertImageScope(scope: ImageScope): void {
  if (!scope.userId || imageKey(scope, '') !== imageKey(imageScope(scope.docId), '')) {
    throw new ApiError('READER_CONTEXT_CHANGED', '账号或服务端已切换，请重新打开书籍。', 409)
  }
}

export interface CachedImage {
  key: string
  needsUpload: boolean
  fromOriginal: boolean
  imageId: string
  docId: string
  blob: Blob
  bytes: number
  lastAccess: number
}

/* ------------------------------------------------------------- 对外接口 */

export async function cachePut(
  scope: ImageScope,
  imageId: string,
  blob: Blob,
  needsUpload = true,
): Promise<void> {
  assertImageScope(scope)
  await tx(STORE_IMAGES, 'readwrite', (s) =>
    s.put({
      key: imageKey(scope, imageId),
      needsUpload,
      fromOriginal: needsUpload,
      imageId,
      docId: imageKey(scope, ''),
      blob,
      bytes: blob.size,
      lastAccess: Date.now(),
    } satisfies CachedImage),
  )
  void enforceLimits()
}

/** 读取时携带补传状态，防止把恢复自原文件的正确图片误认为服务端已有。 */
export async function cacheEntry(scope: ImageScope, imageId: string): Promise<CachedImage | null> {
  assertImageScope(scope)
  const row = await tx<CachedImage | undefined>(STORE_IMAGES, 'readwrite', s => {
    const req = s.get(imageKey(scope, imageId))
    // 在同一事务内刷新当前记录，避免一次旧的读取覆盖并发恢复出的新图片。
    req.addEventListener('success', () => {
      if (req.result) s.put({ ...req.result, lastAccess: Date.now() })
    })
    return req
  })
  assertImageScope(scope)
  if (!row) return null
  return row
}

export async function cacheGet(scope: ImageScope, imageId: string): Promise<Blob | null> {
  const row = await cacheEntry(scope, imageId)
  if (!row) return null
  return row.blob
}

export async function markUploaded(scope: ImageScope, imageId: string): Promise<void> {
  const row = await cacheEntry(scope, imageId)
  if (row) await tx(STORE_IMAGES, 'readwrite', s => s.put({ ...row, needsUpload: false, lastAccess: Date.now() }))
}

export async function cacheHas(scope: ImageScope, imageId: string): Promise<boolean> {
  return !!(await cacheEntry(scope, imageId))
}

export async function cacheDelete(scope: ImageScope, imageId: string): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', s => s.delete(imageKey(scope, imageId)))
}

export async function cacheClear(): Promise<void> {
  await tx(STORE_IMAGES, 'readwrite', (s) => s.clear())
}

export interface CacheStats {
  count: number
  bytes: number
}

export async function cacheStats(): Promise<CacheStats> {
  const rows = (await tx<CachedImage[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())) ?? []
  return {
    count: rows.length,
    bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
  }
}

/** 按 docs/system-design.md §6.2 / §8 的两条上限淘汰，返回淘汰条数 */
export async function enforceLimits(): Promise<number> {
  const rows = (await tx<CachedImage[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())) ?? []
  return evictByLru<CachedImage>(
    STORE_IMAGES,
    (r) => r.key,
    rows,
    MAX_IMAGES_PER_DOC,
    MAX_TOTAL_BYTES,
  )
}
