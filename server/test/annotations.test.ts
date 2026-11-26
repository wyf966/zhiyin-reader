import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { auth, closeApp, importBody, makeApp, registerAndLogin } from './helpers'

let app: FastifyInstance

beforeAll(async () => {
  app = await makeApp()
})

afterAll(async () => {
  await closeApp(app)
})

describe('划线与批注接口（/api/annotations）与进度章节名', () => {
  it('创建、查询、改批注/颜色、跨书总览、软删除全链路 + 越权隔离', async () => {
    const u1 = await registerAndLogin(app, { account: 'ann_u1@example.com' })
    const u2 = await registerAndLogin(app, { account: 'ann_u2@example.com' })

    const impRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth(u1),
      payload: {
        ...importBody({
          fileName: '摘录测试.txt',
          title: '摘录测试书',
          paragraphs: [
            { paraIndex: 0, type: 'h1', text: '第一章 初见' },
            { paraIndex: 1, type: 'p', text: '山高水长，知音难觅。' },
            { paraIndex: 2, type: 'h2', text: '第二节 重逢' },
            { paraIndex: 3, type: 'p', text: '清风徐来，水波不兴。' },
          ],
        }),
        author: '作者甲',
      },
    })
    expect(impRes.statusCode).toBe(201)
    const docId = impRes.json().docId as string

    // 1. 新增划线（省略 chapterTitle 时服务端自动推导出所属章节）
    const created = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: auth(u1),
      payload: {
        docId,
        anchor: { chapterIndex: 0, paragraphIndex: 3, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
        endOffset: 4,
        quote: '清风徐来',
        note: '第一条批注',
        color: 'sage',
      },
    })
    expect(created.statusCode).toBe(201)
    const ann = created.json()
    expect(ann.quote).toBe('清风徐来')
    expect(ann.note).toBe('第一条批注')
    expect(ann.color).toBe('sage')
    expect(ann.chapterTitle).toBe('第二节 重逢')

    // 2. 参数非法被拒
    const badOffset = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: auth(u1),
      payload: {
        docId,
        anchor: { chapterIndex: 0, paragraphIndex: 1, sentenceIndex: 0, charOffset: 5, scrollOffset: 0 },
        endOffset: 3,
        quote: '山高',
      },
    })
    expect(badOffset.statusCode).toBe(400)

    const badColor = await app.inject({
      method: 'POST',
      url: '/api/annotations',
      headers: auth(u1),
      payload: {
        docId,
        anchor: { chapterIndex: 0, paragraphIndex: 1, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
        endOffset: 2,
        quote: '山高',
        color: 'neon-pink',
      },
    })
    expect(badColor.statusCode).toBe(400)

    // 3. 越权读写被拦（u2 无法读取或修改 u1 的摘录）
    const forbiddenList = await app.inject({
      method: 'GET',
      url: `/api/annotations?docId=${docId}`,
      headers: auth(u2),
    })
    expect(forbiddenList.statusCode).toBe(403)

    const forbiddenPatch = await app.inject({
      method: 'PATCH',
      url: `/api/annotations/${ann.annotationId}`,
      headers: auth(u2),
      payload: { note: '越权篡改' },
    })
    expect(forbiddenPatch.statusCode).toBe(403)

    // 4. 修改批注与颜色
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/annotations/${ann.annotationId}`,
      headers: auth(u1),
      payload: { note: '修改后的批注', color: 'ink' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().note).toBe('修改后的批注')
    expect(patched.json().color).toBe('ink')

    // 5. 跨书总览返回分组与作者
    const overview = await app.inject({
      method: 'GET',
      url: '/api/annotations/overview',
      headers: auth(u1),
    })
    expect(overview.statusCode).toBe(200)
    const ov = overview.json()
    expect(ov.total).toBe(1)
    expect(ov.groups[0].docTitle).toBe('摘录测试书')
    expect(ov.groups[0].docAuthor).toBe('作者甲')
    expect(ov.groups[0].items).toHaveLength(1)

    // 6. 软删除后单书列表与总览均不可见
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/annotations/${ann.annotationId}`,
      headers: auth(u1),
    })
    expect(del.statusCode).toBe(200)
    expect(del.json().deletedAt).toBeTruthy()

    const afterDel = await app.inject({
      method: 'GET',
      url: `/api/annotations?docId=${docId}`,
      headers: auth(u1),
    })
    expect(afterDel.statusCode).toBe(200)
    expect(afterDel.json().items).toHaveLength(0)
  })

  it('GET /api/documents 的 progress 返回当前章节标题 chapterTitle', async () => {
    const u = await registerAndLogin(app, { account: 'chapter_prog@example.com' })
    const impRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: auth(u),
      payload: importBody({
        fileName: '章名测试.txt',
        title: '章名测试书',
        paragraphs: [
          { paraIndex: 0, type: 'h1', text: '卷一 序曲' },
          { paraIndex: 1, type: 'p', text: '正文第一段。' },
          { paraIndex: 2, type: 'h2', text: '卷二 远行' },
          { paraIndex: 3, type: 'p', text: '正文第二段。' },
        ],
      }),
    })
    expect(impRes.statusCode).toBe(201)
    const docId = impRes.json().docId as string

    const put = await app.inject({
      method: 'PUT',
      url: `/api/documents/${docId}/progress`,
      headers: auth(u),
      payload: {
        deviceId: 'dev_test',
        anchor: { chapterIndex: 0, paragraphIndex: 3, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
        lastSentenceIndex: 1,
        updatedAt: new Date().toISOString(),
        baseVersion: 0,
      },
    })
    expect(put.statusCode).toBe(200)

    const list = await app.inject({
      method: 'GET',
      url: '/api/documents?category=recent',
      headers: auth(u),
    })
    expect(list.statusCode).toBe(200)
    const item = list.json().items[0]
    expect(item.docId).toBe(docId)
    expect(item.progress.chapterTitle).toBe('卷二 远行')
  })
})
