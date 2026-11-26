import { describe, expect, it } from 'vitest'
import type { Paragraph } from '../src/models/types'
import { searchInBook } from '../src/features/render/inBookSearch'
import { sliceTextSegments } from '../src/features/render/textSegments'

describe('书内搜索（searchInBook）', () => {
  const paragraphs: Paragraph[] = [
    { paraIndex: 0, type: 'h1', text: '第一章 境界说' },
    { paraIndex: 1, type: 'p', text: '词以境界为最上。有境界则自成高格，自有名句。' },
    { paraIndex: 2, type: 'img', text: '境界插图' },
    { paraIndex: 3, type: 'h2', text: '第二节 造境与写境' },
    { paraIndex: 4, type: 'p', text: '有造境，有写境，此理想与写实二派之所由分。English Word test.' },
  ]

  it('空白关键词返回空结果', () => {
    expect(searchInBook(paragraphs, '   ')).toEqual({
      query: '',
      hits: [],
      total: 0,
      truncated: false,
    })
  })

  it('命中标题与正文、跳过图片段，并正确归属章节标题', () => {
    const res = searchInBook(paragraphs, '境界')
    expect(res.total).toBe(3)
    expect(res.truncated).toBe(false)
    expect(res.hits.map((h) => h.paraIndex)).toEqual([0, 1, 1])
    expect(res.hits[0].chapterTitle).toBe('第一章 境界说')
    expect(res.hits[1].match).toBe('境界')
    expect(res.hits[1].before).toBe('词以')
  })

  it('英文大小写不敏感匹配且归属最近子标题', () => {
    const res = searchInBook(paragraphs, 'word')
    expect(res.total).toBe(1)
    expect(res.hits[0].paraIndex).toBe(4)
    expect(res.hits[0].match).toBe('Word')
    expect(res.hits[0].chapterTitle).toBe('第二节 造境与写境')
  })

  it('超过 maxHits 时截断列表但保留真实 total', () => {
    const many: Paragraph[] = Array.from({ length: 10 }, (_, i) => ({
      paraIndex: i,
      type: 'p',
      text: '知音知音知音',
    }))
    const res = searchInBook(many, '知音', 5)
    expect(res.hits).toHaveLength(5)
    expect(res.total).toBe(30)
    expect(res.truncated).toBe(true)
  })
})

describe('文本高亮与搜索区间切片（sliceTextSegments）', () => {
  it('无高亮无搜索时原样返回单段', () => {
    const segs = sliceTextSegments('山高水长', [], [])
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('山高水长')
    expect(segs[0].annotationId).toBeNull()
    expect(segs[0].searchMatch).toBe(false)
  })

  it('划线与搜索命中交叉时正确切分且保留双方标记', () => {
    const segs = sliceTextSegments(
      '词以境界为最上',
      [{ start: 0, end: 4, annotationId: 'an_1', color: 'amber', hasNote: true }],
      [{ start: 2, end: 5, active: true }],
    )
    expect(segs.map((s) => s.text)).toEqual(['词以', '境界', '为', '最上'])
    expect(segs[0]).toMatchObject({ annotationId: 'an_1', color: 'amber', hasNote: true, searchMatch: false })
    expect(segs[1]).toMatchObject({ annotationId: 'an_1', searchMatch: true, searchActive: true })
    expect(segs[2]).toMatchObject({ annotationId: null, searchMatch: true, searchActive: true })
    expect(segs[3]).toMatchObject({ annotationId: null, searchMatch: false })
  })
})
