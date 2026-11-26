import { describe, expect, it } from 'vitest'
import type { Paragraph } from '../src/models/types'
import type { Sentence } from '../src/features/readalong/splitSentences'
import {
  firstSentenceIndexForParagraph,
  isChapterBoundary,
  listenScopeKey,
  readListenCursor,
  writeListenCursor,
  type KeyValueStorage,
} from '../src/features/readalong/listenMemory'

function memStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v) },
  }
}

describe('本机听书记忆与续听辅助（listenMemory）', () => {
  it('按服务器 + 读者 + docId 隔离读写，损坏数据容错返回 null', () => {
    const st = memStorage()
    const k1 = listenScopeKey('/api', 'u1', 'doc_1')
    const k2 = listenScopeKey('/api', 'u2', 'doc_1')

    expect(readListenCursor(k1, st)).toBeNull()
    writeListenCursor(k1, 12, st, () => 1000)
    expect(readListenCursor(k1, st)).toBe(12)
    expect(readListenCursor(k2, st)).toBeNull()

    st.setItem('zhiyin.listenCursor', '{broken-json')
    expect(readListenCursor(k1, st)).toBeNull()
  })

  it('超过 100 本书时按最近时间淘汰最旧记录', () => {
    const st = memStorage()
    let t = 1000
    for (let i = 0; i < 105; i++) {
      writeListenCursor(listenScopeKey('/api', 'u1', `doc_${i}`), i, st, () => ++t)
    }
    expect(readListenCursor(listenScopeKey('/api', 'u1', 'doc_0'), st)).toBeNull()
    expect(readListenCursor(listenScopeKey('/api', 'u1', 'doc_104'), st)).toBe(104)
  })

  it('从当前段落定位首句：标题段向后顺延，文末图片段退回最后一句', () => {
    const sentences: Sentence[] = [
      { sentenceIndex: 0, paraIndex: 1, startOffset: 0, endOffset: 5, text: '第一段第一句' },
      { sentenceIndex: 1, paraIndex: 1, startOffset: 5, endOffset: 10, text: '第一段第二句' },
      { sentenceIndex: 2, paraIndex: 3, startOffset: 0, endOffset: 5, text: '第二章第一句' },
    ]
    expect(firstSentenceIndexForParagraph(sentences, 0)).toBe(0) // h1 标题段顺延到第 1 段
    expect(firstSentenceIndexForParagraph(sentences, 1)).toBe(0)
    expect(firstSentenceIndexForParagraph(sentences, 2)).toBe(2) // 章间标题顺延到下一章
    expect(firstSentenceIndexForParagraph(sentences, 5)).toBe(2) // 文末兜底
    expect(firstSentenceIndexForParagraph([], 0)).toBeNull()
  })

  it('准确识别两句之间是否跨越章节标题（读完本章停止）', () => {
    const paragraphs: Paragraph[] = [
      { paraIndex: 0, type: 'h1', text: '第一章' },
      { paraIndex: 1, type: 'p', text: '正文甲。' },
      { paraIndex: 2, type: 'p', text: '正文乙。' },
      { paraIndex: 3, type: 'h1', text: '第二章' },
      { paraIndex: 4, type: 'p', text: '正文丙。' },
      { paraIndex: 5, type: 'img', text: '插图' },
      { paraIndex: 6, type: 'p', text: '正文丁。' },
    ]
    expect(isChapterBoundary(paragraphs, 1, 2)).toBe(false)
    expect(isChapterBoundary(paragraphs, 2, 4)).toBe(true)
    expect(isChapterBoundary(paragraphs, 4, 6)).toBe(false)
  })
})
