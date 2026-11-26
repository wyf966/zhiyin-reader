import type { Paragraph } from '../../models/types'
import type { Sentence } from './splitSentences'

/**
 * 本机听书位置记忆与续听辅助（纯 TS，可单测）。
 *
 * 依据 docs/system-design.md §4 与 AGENTS.md §7.3：
 * 朗读高亮游标属于本机瞬态，**不参与跨端同步**。这里只在浏览器 localStorage
 * 里按「API 基址 + 读者 + docId」隔离记住上次听到的句子序号，刷新或重开时续听。
 */

const STORAGE_KEY = 'zhiyin.listenCursor'
const MAX_ENTRIES = 100

interface StoredEntry {
  sentenceIndex: number
  updatedAt: number
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readMap(storage: KeyValueStorage | null): Record<string, StoredEntry> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, StoredEntry> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue
      const row = v as Partial<StoredEntry>
      if (
        typeof row.sentenceIndex === 'number' &&
        Number.isInteger(row.sentenceIndex) &&
        row.sentenceIndex >= 0
      ) {
        out[k] = {
          sentenceIndex: row.sentenceIndex,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(storage: KeyValueStorage | null, map: Record<string, StoredEntry>): void {
  if (!storage) return
  try {
    const entries = Object.entries(map)
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      map = Object.fromEntries(entries.slice(0, MAX_ENTRIES))
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式或空间不足时静默忽略，不影响跟读本身
  }
}

export function listenScopeKey(apiBase: string, userId: string | null, docId: string): string {
  return JSON.stringify([apiBase, userId ?? '', docId])
}

export function readListenCursor(
  scopeKey: string,
  storage: KeyValueStorage | null = defaultStorage(),
): number | null {
  if (!scopeKey) return null
  const map = readMap(storage)
  const hit = map[scopeKey]
  return hit ? hit.sentenceIndex : null
}

export function writeListenCursor(
  scopeKey: string,
  sentenceIndex: number,
  storage: KeyValueStorage | null = defaultStorage(),
  now = Date.now,
): void {
  if (!scopeKey || !Number.isInteger(sentenceIndex) || sentenceIndex < 0) return
  const map = readMap(storage)
  map[scopeKey] = { sentenceIndex, updatedAt: now() }
  writeMap(storage, map)
}

/**
 * 找到指定阅读段落对应的起始句子序号。
 *
 * 当前段落可能是章节标题或图片段（它们不在 sentences 表里），
 * 此时顺着正文往后找最近一句；如果已经翻到文末图片段，则退回文末最后一句。
 */
export function firstSentenceIndexForParagraph(
  sentences: Sentence[],
  paraIndex: number,
): number | null {
  if (sentences.length === 0) return null
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].paraIndex >= paraIndex) return i
  }
  return sentences.length - 1
}

/**
 * 判定从当前句推进到下一句时，是否跨越了章节边界（中间存在 h1 / h2 标题段）。
 *
 * 标题段本身不进入 sentences，因此两句之间若有章节标题，
 * 其 paraIndex 必然严格落在 (currentParaIndex, nextParaIndex) 区间内。
 */
export function isChapterBoundary(
  paragraphs: Paragraph[],
  currentParaIndex: number,
  nextParaIndex: number,
): boolean {
  if (nextParaIndex <= currentParaIndex) return false
  for (const p of paragraphs) {
    if (p.paraIndex <= currentParaIndex) continue
    if (p.paraIndex >= nextParaIndex) break
    if (p.type === 'h1' || p.type === 'h2') return true
  }
  return false
}
