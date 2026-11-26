import type { AnnotationDto, AnnotationGroup } from '../../api/client'

/**
 * 划线与批注导出为 Markdown（纯函数，可脱离浏览器单测）。
 *
 * 按书籍与章节归类，顺序遵循正文先后（paragraphIndex → charOffset → createdAt）。
 */

function sortAnnotations(items: AnnotationDto[]): AnnotationDto[] {
  return [...items].sort((a, b) => {
    const pDiff = (a.anchor.paragraphIndex ?? 0) - (b.anchor.paragraphIndex ?? 0)
    if (pDiff !== 0) return pDiff
    const cDiff = (a.anchor.charOffset ?? 0) - (b.anchor.charOffset ?? 0)
    if (cDiff !== 0) return cDiff
    return Date.parse(a.createdAt) - Date.parse(b.createdAt)
  })
}

function formatSection(items: AnnotationDto[], headingLevel: '##' | '###'): string[] {
  const ordered = sortAnnotations(items)
  const chapters = new Map<string, AnnotationDto[]>()
  for (const it of ordered) {
    const ch = it.chapterTitle?.trim() || '未分章'
    const list = chapters.get(ch)
    if (list) list.push(it)
    else chapters.set(ch, [it])
  }

  const lines: string[] = []
  for (const [chapter, list] of chapters) {
    lines.push(`${headingLevel} ${chapter}`)
    lines.push('')
    for (const it of list) {
      const quoteLines = it.quote.replace(/\r\n?/g, '\n').split('\n')
      for (const ql of quoteLines) {
        lines.push(`> ${ql}`)
      }
      lines.push('')
      if (it.note?.trim()) {
        lines.push(`**批注**：${it.note.trim()}`)
        lines.push('')
      }
      const pos = `第 ${(it.anchor.paragraphIndex ?? 0) + 1} 段`
      const dateStr = it.createdAt.slice(0, 10)
      lines.push(`*位置：${pos} · 记录于 ${dateStr}*`)
      lines.push('')
    }
  }
  return lines
}

export function formatBookAnnotationsMarkdown(
  book: { title: string; author?: string | null },
  items: AnnotationDto[],
): string {
  const lines: string[] = [`# 《${book.title}》摘录与批注`, '']
  if (book.author && book.author !== '未知') {
    lines.push(`- 作者：${book.author}`)
  }
  lines.push(`- 共 ${items.length} 条摘录`)
  lines.push('')

  if (items.length === 0) {
    lines.push('暂无划线或批注。')
    lines.push('')
    return lines.join('\n')
  }

  lines.push(...formatSection(items, '##'))
  return lines.join('\n').trimEnd() + '\n'
}

export function formatAllAnnotationsMarkdown(groups: AnnotationGroup[]): string {
  const totalCount = groups.reduce((n, g) => n + g.items.length, 0)
  const lines: string[] = [
    '# 知音漫卷 · 阅读摘录与批注',
    '',
    `- 共 ${groups.length} 本书，${totalCount} 条摘录`,
    '',
  ]

  for (const g of groups) {
    lines.push(`## 《${g.docTitle}》${g.docAuthor && g.docAuthor !== '未知' ? ` — ${g.docAuthor}` : ''}`)
    lines.push('')
    lines.push(...formatSection(g.items, '###'))
  }

  return lines.join('\n').trimEnd() + '\n'
}

/** 清理文件名中的非法字符并触发浏览器下载 .md 文件 */
export function downloadMarkdownFile(rawName: string, markdown: string): void {
  const safe = rawName.replace(/[\\/:*?"<>|]+/g, '_').trim() || '阅读摘录'
  const fileName = safe.endsWith('.md') ? safe : `${safe}.md`
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
