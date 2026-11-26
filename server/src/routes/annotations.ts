import type { FastifyInstance } from 'fastify'
import { requireUserId } from '../auth/require'
import { dal, newId, now, type AnnotationRow } from '../dao'
import { E } from '../errors'
import { normalizeAnchor, type Anchor } from '../sync/anchor'

/**
 * 划线与批注接口。
 *
 * 复用书签的标准 Anchor 结构（paragraphIndex + charOffset 为起始偏移）与 chapterTitle 章节定位；
 * 服务端追加独立表 T_Annotation，不影响既有表结构与同步链路。
 */

const ALLOWED_COLORS = new Set(['amber', 'sage', 'ink', 'rose'])
const MAX_QUOTE_LEN = 4000
const MAX_NOTE_LEN = 8000

function toDto(row: AnnotationRow) {
  return {
    annotationId: row.annotation_id,
    docId: row.doc_id,
    anchor: JSON.parse(row.anchor_json) as Anchor,
    endOffset: row.end_offset,
    quote: row.quote,
    note: row.note,
    color: row.color,
    chapterTitle: row.chapter_title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export default async function annotationRoutes(app: FastifyInstance) {
  /** 跨文档摘录总览（供书架「我的摘录」按书分组查看与导出 Markdown） */
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    '/api/annotations/overview',
    async (req) => {
      const userId = requireUserId(req)
      const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)) || 1)
      const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize ?? 20)) || 20))

      const { total, docs } = dal.listAnnotatedDocuments(userId, page, pageSize)
      const rows = dal.listAnnotationsByDocIds(
        userId,
        docs.map((d) => d.doc_id),
      )

      const byDoc = new Map<string, AnnotationRow[]>()
      for (const r of rows) {
        const list = byDoc.get(r.doc_id)
        if (list) list.push(r)
        else byDoc.set(r.doc_id, [r])
      }

      return {
        total,
        page,
        pageSize,
        groups: docs.map((d) => {
          const items = (byDoc.get(d.doc_id) ?? []).map(toDto)
          return {
            docId: d.doc_id,
            docTitle: d.doc_title ?? d.file_name,
            docAuthor: d.doc_author ?? '未知',
            annotationCount: items.length,
            items,
          }
        }),
      }
    },
  )

  /** 单文档的划线与批注列表 */
  app.get<{ Querystring: { docId?: string } }>('/api/annotations', async (req) => {
    const userId = requireUserId(req)
    const docId = req.query.docId?.trim()
    if (!docId) throw E.validation(['docId'])

    const doc = dal.getDocumentById(docId)
    if (!doc) throw E.notFound()
    if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

    const rows = dal.listAnnotationsByDocument(userId, docId)
    return {
      docId,
      items: rows.map(toDto),
    }
  })

  /** 新增划线或批注 */
  app.post<{
    Body: {
      annotationId?: string
      docId?: string
      anchor?: unknown
      endOffset?: number
      quote?: string
      note?: string | null
      color?: string
      chapterTitle?: string | null
    }
  }>('/api/annotations', async (req, reply) => {
    const userId = requireUserId(req)
    const b = req.body ?? {}

    if (!b.docId) throw E.validation(['docId'])
    const doc = dal.getDocumentById(b.docId)
    if (!doc) throw E.notFound()
    if (doc.owner_id !== userId) throw E.forbiddenNotOwner()

    const anchor = normalizeAnchor(b.anchor)
    if (!anchor) throw E.validation(['anchor'])

    if (
      typeof b.endOffset !== 'number' ||
      !Number.isInteger(b.endOffset) ||
      b.endOffset <= anchor.charOffset
    ) {
      throw E.validation(['endOffset'])
    }

    const quote = typeof b.quote === 'string' ? b.quote.trim() : ''
    if (!quote || quote.length > MAX_QUOTE_LEN) throw E.validation(['quote'])

    const noteRaw = b.note === null || b.note === undefined ? null : String(b.note).trim()
    if (noteRaw && noteRaw.length > MAX_NOTE_LEN) throw E.validation(['note'])
    const note = noteRaw || null

    const color = b.color ? String(b.color) : 'amber'
    if (!ALLOWED_COLORS.has(color)) throw E.validation(['color'])

    const chapterTitle =
      b.chapterTitle !== undefined
        ? b.chapterTitle?.trim() || null
        : dal.getChapterTitleAt(doc.doc_id, anchor.paragraphIndex)

    const ts = now()
    const annotationId =
      typeof b.annotationId === 'string' && b.annotationId.trim()
        ? b.annotationId.trim().slice(0, 64)
        : newId('an')

    const existing = dal.getAnnotationById(annotationId)
    if (existing) throw E.validation(['annotationId'])

    const inserted = dal.insertAnnotation({
      annotation_id: annotationId,
      user_id: userId,
      doc_id: doc.doc_id,
      anchor_json: JSON.stringify(anchor),
      end_offset: b.endOffset,
      quote,
      note,
      color,
      chapter_title: chapterTitle,
      created_at: ts,
      updated_at: ts,
      deleted_at: null,
    })

    return reply.code(201).send(toDto(inserted))
  })

  /** 修改批注内容或划线颜色 */
  app.patch<{
    Params: { annotationId: string }
    Body: { note?: string | null; color?: string }
  }>('/api/annotations/:annotationId', async (req) => {
    const userId = requireUserId(req)
    const cur = dal.getAnnotationById(req.params.annotationId)
    if (!cur || cur.deleted_at) throw E.notFound()
    if (cur.user_id !== userId) throw E.forbiddenNotOwner()

    const b = req.body ?? {}
    const fields: { note?: string | null; color?: string; updated_at: string } = {
      updated_at: now(),
    }

    if (b.note !== undefined) {
      const noteRaw = b.note === null ? null : String(b.note).trim()
      if (noteRaw && noteRaw.length > MAX_NOTE_LEN) throw E.validation(['note'])
      fields.note = noteRaw || null
    }
    if (b.color !== undefined) {
      const color = String(b.color)
      if (!ALLOWED_COLORS.has(color)) throw E.validation(['color'])
      fields.color = color
    }

    const updated = dal.updateAnnotation(cur.annotation_id, fields)
    if (!updated) throw E.notFound()
    return toDto(updated)
  })

  /** 软删除划线/批注 */
  app.delete<{ Params: { annotationId: string } }>(
    '/api/annotations/:annotationId',
    async (req) => {
      const userId = requireUserId(req)
      const cur = dal.getAnnotationById(req.params.annotationId)
      if (!cur || cur.deleted_at) throw E.notFound()
      if (cur.user_id !== userId) throw E.forbiddenNotOwner()

      const deletedAt = now()
      dal.softDeleteAnnotation(cur.annotation_id, deletedAt)
      return { annotationId: cur.annotation_id, deletedAt }
    },
  )
}
