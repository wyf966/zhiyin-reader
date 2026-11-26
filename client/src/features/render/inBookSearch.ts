import type { Paragraph } from '../../models/types'

/**
 * 书内搜索（纯 TS，脱离 DOM 可单测）。
 *
 * 在已加载的段落数组里做大小写不敏感匹配，生成带章节名与前后上下文的命中清单，
 * 供阅读器「书内搜索」抽屉展示与上下跳转。
 */

export interface BookSearchHit {
  /** 在本次搜索结果里的序号，0 基 */
  index: number
  paraIndex: number
  /** 段内起始偏移（UTF-16 code unit） */
  start: number
  /** 段内结束偏移（UTF-16 code unit，不含） */
  end: number
  before: string
  match: string
  after: string
  chapterTitle: string
}

export interface BookSearchResult {
  query: string
  hits: BookSearchHit[]
  /** 实际命中的总数（超过 maxHits 时仍如实计数） */
  total: number
  truncated: boolean
}

const CONTEXT_BEFORE = 18
const CONTEXT_AFTER = 28

export function searchInBook(
  paragraphs: Paragraph[],
  rawQuery: string,
  maxHits = 500,
): BookSearchResult {
  const query = rawQuery.trim()
  if (!query || paragraphs.length === 0) {
    return { query, hits: [], total: 0, truncated: false }
  }

  const needle = query.toLocaleLowerCase()
  const needleLen = needle.length
  const firstHeading = paragraphs.find((p) => p.type === 'h1' || p.type === 'h2')?.text ?? ''

  let currentChapter = firstHeading
  const hits: BookSearchHit[] = []
  let total = 0

  for (const p of paragraphs) {
    if (p.type === 'h1' || p.type === 'h2') {
      currentChapter = p.text
    }
    if (p.type === 'img' || !p.text) continue

    const haystack = p.text.toLocaleLowerCase()
    let pos = 0
    while (pos <= haystack.length - needleLen) {
      const found = haystack.indexOf(needle, pos)
      if (found < 0) break

      total += 1
      if (hits.length < maxHits) {
        const end = found + needleLen
        const rawBefore = p.text.slice(Math.max(0, found - CONTEXT_BEFORE), found)
        const rawAfter = p.text.slice(end, Math.min(p.text.length, end + CONTEXT_AFTER))
        hits.push({
          index: hits.length,
          paraIndex: p.paraIndex,
          start: found,
          end,
          before: found > CONTEXT_BEFORE ? `…${rawBefore}` : rawBefore,
          match: p.text.slice(found, end),
          after: end + CONTEXT_AFTER < p.text.length ? `${rawAfter}…` : rawAfter,
          chapterTitle: currentChapter,
        })
      }

      pos = found + needleLen
    }
  }

  return {
    query,
    hits,
    total,
    truncated: total > hits.length,
  }
}
