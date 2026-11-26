/**
 * 正文片段切分（纯函数）。
 *
 * 一段正文（或一个句子 span）里可能同时存在：
 *   1. 多条划线批注（不同颜色，甚至局部重叠）
 *   2. 书内搜索的命中高亮（含「当前聚焦命中」）
 *
 * 把多个区间切成互不重叠的顺序切片，避免拼 HTML 字符串导致 XSS，
 * 也能在保留 `.sent` 结构的同时精准渲染 `<mark>`。
 */

export interface HighlightSpan {
  start: number
  end: number
  annotationId: string
  color: string
  hasNote: boolean
}

export interface SearchSpan {
  start: number
  end: number
  active: boolean
}

export interface TextSegment {
  text: string
  start: number
  end: number
  annotationId: string | null
  color: string | null
  hasNote: boolean
  searchMatch: boolean
  searchActive: boolean
}

export function sliceTextSegments(
  text: string,
  highlights: HighlightSpan[],
  searches: SearchSpan[],
): TextSegment[] {
  const len = text.length
  if (len === 0) return []
  if (highlights.length === 0 && searches.length === 0) {
    return [
      {
        text,
        start: 0,
        end: len,
        annotationId: null,
        color: null,
        hasNote: false,
        searchMatch: false,
        searchActive: false,
      },
    ]
  }

  const cuts = new Set<number>([0, len])
  for (const h of highlights) {
    const s = Math.max(0, Math.min(len, h.start))
    const e = Math.max(0, Math.min(len, h.end))
    if (e > s) {
      cuts.add(s)
      cuts.add(e)
    }
  }
  for (const r of searches) {
    const s = Math.max(0, Math.min(len, r.start))
    const e = Math.max(0, Math.min(len, r.end))
    if (e > s) {
      cuts.add(s)
      cuts.add(e)
    }
  }

  const points = [...cuts].sort((a, b) => a - b)
  const segments: TextSegment[] = []

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]
    const end = points[i + 1]
    if (end <= start) continue

    // 多个划线重叠时取最后创建的那一条覆盖颜色
    let hitHl: HighlightSpan | null = null
    for (const h of highlights) {
      if (h.start <= start && h.end >= end) hitHl = h
    }

    let searchMatch = false
    let searchActive = false
    for (const r of searches) {
      if (r.start <= start && r.end >= end) {
        searchMatch = true
        if (r.active) searchActive = true
      }
    }

    segments.push({
      text: text.slice(start, end),
      start,
      end,
      annotationId: hitHl?.annotationId ?? null,
      color: hitHl?.color ?? null,
      hasNote: hitHl?.hasNote ?? false,
      searchMatch,
      searchActive,
    })
  }

  return segments
}
