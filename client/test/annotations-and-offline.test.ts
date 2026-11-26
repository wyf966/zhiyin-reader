import { describe, expect, it } from 'vitest'
import type { AnnotationDto } from '../src/api/client'
import {
  formatAllAnnotationsMarkdown,
  formatBookAnnotationsMarkdown,
} from '../src/features/annotations/exportMarkdown'
import {
  filterOfflineRecords,
  formatBytes,
  formatOfflineStatus,
  type OfflineBookRecord,
} from '../src/features/cache/offlineBooks'

describe('摘录导出 Markdown（exportMarkdown）', () => {
  const sample: AnnotationDto[] = [
    {
      annotationId: 'an_2',
      docId: 'doc_1',
      anchor: { chapterIndex: 0, paragraphIndex: 5, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
      endOffset: 8,
      quote: '古今之成大事业、大学问者',
      note: '三境界之始',
      color: 'amber',
      chapterTitle: '第二章 三境界',
      createdAt: '2026-11-20T08:00:00.000Z',
      updatedAt: '2026-11-20T08:00:00.000Z',
    },
    {
      annotationId: 'an_1',
      docId: 'doc_1',
      anchor: { chapterIndex: 0, paragraphIndex: 1, sentenceIndex: 0, charOffset: 0, scrollOffset: 0 },
      endOffset: 7,
      quote: '词以境界为最上',
      note: null,
      color: 'sage',
      chapterTitle: '第一章 境界说',
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:00:00.000Z',
    },
  ]

  it('按正文段落先后排序、按章节分组，并正确输出引用与批注', () => {
    const md = formatBookAnnotationsMarkdown({ title: '人间词话', author: '王国维' }, sample)
    expect(md).toContain('# 《人间词话》摘录与批注')
    expect(md).toContain('- 作者：王国维')
    expect(md).toContain('- 共 2 条摘录')
    const idx1 = md.indexOf('## 第一章 境界说')
    const idx2 = md.indexOf('## 第二章 三境界')
    expect(idx1).toBeGreaterThan(-1)
    expect(idx2).toBeGreaterThan(idx1)
    expect(md).toContain('> 词以境界为最上')
    expect(md).toContain('**批注**：三境界之始')
  })

  it('跨书总览导出包含书名与总计', () => {
    const md = formatAllAnnotationsMarkdown([
      {
        docId: 'doc_1',
        docTitle: '人间词话',
        docAuthor: '王国维',
        annotationCount: 2,
        items: sample,
      },
    ])
    expect(md).toContain('# 知音漫卷 · 阅读摘录与批注')
    expect(md).toContain('共 1 本书，2 条摘录')
    expect(md).toContain('## 《人间词话》 — 王国维')
  })
})

describe('离线书单纯函数（offlineBooks）', () => {
  it('如实展示正文与插图保存状态及体积', () => {
    expect(formatOfflineStatus({ contentSaved: true, totalImages: 0, savedImages: 0, missingImages: 0 })).toBe(
      '正文已保存 · 无插图',
    )
    expect(formatOfflineStatus({ contentSaved: true, totalImages: 4, savedImages: 4, missingImages: 0 })).toBe(
      '正文已保存 · 插图 4/4 已保存',
    )
    expect(formatOfflineStatus({ contentSaved: true, totalImages: 4, savedImages: 2, missingImages: 2 })).toBe(
      '正文已保存 · 插图 2/4（2 张待联网补齐）',
    )
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('按服务器与读者严格隔离并按下载时间降序排列', () => {
    const make = (apiBase: string, userId: string, docId: string, savedAt: string): OfflineBookRecord => ({
      key: JSON.stringify([apiBase, userId, docId]),
      apiBase,
      userId,
      docId,
      doc: {
        docId,
        title: docId,
        author: '作者',
        fileName: `${docId}.txt`,
        fileFormat: 'TXT',
        fileSize: 100,
        contentHash: 'sha256:abc',
        importedAt: savedAt,
        paragraphCount: 10,
        imageCount: 0,
        bookmarkCount: 0,
        resourceUrl: null,
      },
      savedAt,
      contentSaved: true,
      totalImages: 0,
      savedImages: 0,
      missingImages: 0,
      bytes: 1000,
    })

    const rows = [
      make('/api', 'u1', 'doc_old', '2026-11-20T01:00:00.000Z'),
      make('/api', 'u1', 'doc_new', '2026-11-20T05:00:00.000Z'),
      make('/api', 'u2', 'doc_other_user', '2026-11-20T06:00:00.000Z'),
      make('http://other/api', 'u1', 'doc_other_srv', '2026-11-20T07:00:00.000Z'),
    ]

    const list = filterOfflineRecords(rows, '/api', 'u1')
    expect(list.map((r) => r.docId)).toEqual(['doc_new', 'doc_old'])
    expect(filterOfflineRecords(rows, '/api', null)).toEqual([])
  })
})
