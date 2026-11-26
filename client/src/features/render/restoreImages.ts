import { ApiError, api } from '../../api/client'
import { parseFile, type ParseOutcome } from '../parse'
import { assertImageScope, cachePut, imageKey, type ImageScope } from './imageCache'

const restoring = new Map<string, Promise<Map<string, Blob> | undefined>>()

export async function cacheParsedImages(scope: ImageScope, parsed: ParseOutcome): Promise<void> {
  assertImageScope(scope)
  for (const [id, blob] of parsed.imageBlobs ?? []) await cachePut(scope, id, blob)
}

/** 原文件是图片真值来源；恢复的图片即使服务端已有副本也必须重新补传。 */
export async function restoreImages(scope: ImageScope, selected?: File): Promise<Map<string, Blob> | undefined> {
  assertImageScope(scope)
  const key = imageKey(scope, '')
  const existing = restoring.get(key)
  if (existing && !selected) return existing
  const task = (async () => {
    const doc = await api.getDocument(scope.docId)
    assertImageScope(scope)
    if (doc.fileFormat !== 'EPUB') return
    const file = selected ?? new File([await api.getOriginalFile(scope.docId)], doc.fileName)
    assertImageScope(scope)
    const parsed = await parseFile(file)
    assertImageScope(scope)
    const hash = doc.contentHash?.startsWith('sha256-v2:') ? parsed.payload.contentHash : parsed.legacyContentHash
    if (!hash || hash !== doc.contentHash) throw new Error('原文件与这本书不匹配，请选择导入时使用的 EPUB。')
    if (selected) {
      await api.putOriginalFile(scope.docId, selected)
      assertImageScope(scope)
    }
    await cacheParsedImages(scope, parsed)
    // 缓存不可写或受容量限制时，当前视口仍直接使用刚验证过的原图。
    return parsed.imageBlobs
  })().catch(e => {
    if (e instanceof ApiError && e.status === 404) {
      throw new ApiError('ORIGINAL_FILE_MISSING', '原 EPUB 未保存，无法核验插图。请选择原文件恢复。', 404)
    }
    throw e
  }).finally(() => { if (restoring.get(key) === task) restoring.delete(key) })
  restoring.set(key, task)
  return task
}

/** 旧哈希只能定位候选。必须重新解析原文件，才能判断是否真的是重复书籍。 */
export async function migrateLegacyHash(scope: ImageScope, legacyHash?: string): Promise<void> {
  if (!legacyHash) return
  const candidate = await api.findDocumentByHash(legacyHash)
  assertImageScope(scope)
  if (!candidate) return
  try {
    const doc = await api.getDocument(candidate.docId)
    if (doc.fileFormat !== 'EPUB') return
    const original = await api.getOriginalFile(candidate.docId)
    assertImageScope(scope)
    const parsed = await parseFile(new File([original], doc.fileName))
    assertImageScope(scope)
    if (parsed.legacyContentHash !== legacyHash) throw new Error('已保存的原文件与旧书正文不匹配，无法安全升级，请先补传正确原文件。')
    // 同时留下恢复用的正确图片；不会从旧缓存往服务端补传。
    await cacheParsedImages({ ...scope, docId: candidate.docId }, parsed)
    await api.upgradeContentHash(candidate.docId, legacyHash, parsed.payload.contentHash)
  } catch (e) {
    // 原文件缺失时无法证明重复，允许新导入，不能再凭正文与路径返回 409。
    if (!(e instanceof ApiError && (e.status === 404 || e.code === 'DOCUMENT_CHANGED' || e.code === 'CONFLICT_DOCUMENT_DUPLICATE'))) throw e
  }
}
