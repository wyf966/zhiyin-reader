import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ApiError,
  getApiBase,
  type AnnotationColor,
  type AnnotationDto,
  type ContentImageRef,
  type DocumentDetail,
} from '../api/client'
import type { Paragraph } from '../models/types'
import { type Sentence } from '../features/readalong/splitSentences'
import { loadReaderDocument } from '../features/cache/readerDocument'
import {
  downloadBookForOffline,
  formatOfflineStatus,
  getOfflineBook,
  removeOfflineBook,
  type OfflineBookRecord,
} from '../features/cache/offlineBooks'
import { useReadAlong } from '../features/readalong/useReadAlong'
import { listenScopeKey } from '../features/readalong/listenMemory'
import { useProgress } from '../features/sync/useProgress'
import { useBookmarks } from '../features/sync/useBookmarks'
import { useReadingTime } from '../features/sync/useReadingTime'
import { useAnnotations } from '../features/annotations/useAnnotations'
import {
  downloadMarkdownFile,
  formatBookAnnotationsMarkdown,
} from '../features/annotations/exportMarkdown'
import { anchorAt, clampToParagraphs } from '../features/sync/anchor'
import {
  buildGeometry,
  computeWindow,
  offsetOf,
  paragraphAt,
  recomputeFrom,
  totalHeight,
} from '../features/render/virtualWindow'
import { tocIndexAt } from '../features/render/toc'
import { searchInBook } from '../features/render/inBookSearch'
import {
  sliceTextSegments,
  type HighlightSpan,
  type SearchSpan,
} from '../features/render/textSegments'
import { useGoUp } from '../features/app/useGoUp'

/**
 * 超过这个段落数才启用窗口化渲染。
 * 演示书只有十几段，走原来的"全部渲染"路径，行为与之前完全一致 ——
 * 不该为了长文档的性能把已经跑通的短文档体验换掉。
 */
const VIRTUAL_THRESHOLD = 150
import LazyImage from '../features/render/LazyImage'
import { useSession } from '../state/session'
import { useSettings } from '../features/settings/SettingsProvider'
import {
  BG_IMAGE_ID,
  backgroundUrl,
  clearBackground,
  getBackground,
  putBackground,
  releaseBackgroundUrl,
} from '../features/settings/readerBackground'
import PlaybackBar from './PlaybackBar'
import ConflictDialog from './ConflictDialog'
import BookmarkPanel from './BookmarkPanel'
import ReaderSettingsPanel from './ReaderSettingsPanel'
import ThemeToggle from '../features/settings/ThemeToggle'

/**
 * 翻页模式下前后两屏的重叠量（像素）。
 * 完全按一屏翻的话，跨屏的那一行会被切掉一半，读着容易丢行。
 */
const PAGE_OVERLAP = 48

const HIGHLIGHT_COLORS: { id: AnnotationColor; label: string }[] = [
  { id: 'amber', label: '琥珀黄' },
  { id: 'sage', label: '竹青绿' },
  { id: 'ink', label: '靛蓝墨' },
  { id: 'rose', label: '朱砂红' },
]

interface PendingSelection {
  paraIndex: number
  sentenceIndex: number
  startOffset: number
  endOffset: number
  quote: string
  top: number
  left: number
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

/** 计算容器内某个 Range 起点/终点对应的纯文本字符偏移（UTF-16 code unit） */
function textOffsetInElement(container: HTMLElement, targetNode: Node, targetOffset: number): number | null {
  if (!container.contains(targetNode)) return null
  if (targetNode.nodeType === Node.ELEMENT_NODE) {
    // 若浏览器把锚点落在元素节点上，统计前 targetOffset 个子节点内的文本长度
    let acc = 0
    const children = targetNode.childNodes
    for (let i = 0; i < Math.min(targetOffset, children.length); i++) {
      acc += children[i].textContent?.length ?? 0
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let before = 0
    let cur = walker.nextNode()
    while (cur) {
      const rel = targetNode.compareDocumentPosition(cur)
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) {
        before += cur.textContent?.length ?? 0
      } else {
        break
      }
      cur = walker.nextNode()
    }
    return before + acc
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let total = 0
  let cur = walker.nextNode()
  while (cur) {
    if (cur === targetNode) {
      return total + targetOffset
    }
    total += cur.textContent?.length ?? 0
    cur = walker.nextNode()
  }
  return null
}

export default function ReaderView() {
  const { docId = '' } = useParams()
  const navigate = useNavigate()
  // 顶栏的「返回」和手机的系统返回手势走同一条历史，别各退各的
  const goUp = useGoUp()
  const { user, ready, offline } = useSession()
  const [searchParams] = useSearchParams()
  const jumpPara = searchParams.get('para')

  const [book, setBook] = useState<DocumentDetail | null>(null)
  const [sentences, setSentences] = useState<Sentence[]>([])
  const loadSequence = useRef(0)
  const [paragraphs, setParagraphs] = useState<Paragraph[]>([])
  const [imageRefs, setImageRefs] = useState<ContentImageRef[]>([])
  const [fromOffline, setFromOffline] = useState(false)
  const [offlineRec, setOfflineRec] = useState<OfflineBookRecord | null>(null)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const { prefs, setPrefs } = useSettings()

  const [tocOpen, setTocOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeHitIndex, setActiveHitIndex] = useState(0)
  const [marksOpen, setMarksOpen] = useState(false)
  const [marksTab, setMarksTab] = useState<'bookmarks' | 'annotations'>('bookmarks')
  /**
   * 翻页时扫过的那一页（B6）。key 自增，换一次就把元素重挂一遍，
   * 动画从头播 —— 连点两下右侧也能连着卷两次。
   */
  const [curl, setCurl] = useState<{ dir: 'next' | 'prev'; key: number } | null>(null)
  const curlSeq = useRef(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 背景图的 object URL；空串 = 不画背景 */
  const [bgUrl, setBgUrl] = useState('')
  const [bgName, setBgName] = useState('')
  const [bgError, setBgError] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toast, setToast] = useState('')

  /** 选区划线悬浮条状态 */
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null)
  const [selColor, setSelColor] = useState<AnnotationColor>('amber')
  const [selNoteOpen, setSelNoteOpen] = useState(false)
  const [selNoteText, setSelNoteText] = useState('')
  /** 点击已划线片段弹出的批注气泡 */
  const [activeAnn, setActiveAnn] = useState<{ item: AnnotationDto; top: number; left: number } | null>(null)
  const [activeAnnNote, setActiveAnnNote] = useState('')

  /**
   * 朗读控制条是否收起。
   *
   * 收起是读者的显式动作，所以**不做**"播放中自动展开" —— 播出声音来就自己
   * 弹回去，等于把收起变成一个会自己撤销的开关。跟读在不在跑由胶囊自己报
   * （"跟读中 · 第 N / M 句"），信息不丢。
   */
  const [barHidden, setBarHidden] = useState(false)
  const restoreBarRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (barHidden) restoreBarRef.current?.focus()
  }, [barHidden])

  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const tocBtnRef = useRef<HTMLButtonElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const marksBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (ready && !user) navigate('/login', { replace: true })
  }, [ready, user, navigate])

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setError('')
    try {
      const loaded = await loadReaderDocument(docId)
      if (sequence !== loadSequence.current) return
      setSentences(loaded.sentences)
      setBook(loaded.doc)
      setParagraphs(loaded.content.paragraphs)
      setImageRefs(loaded.content.imageRefs)
      setFromOffline(loaded.fromOffline)
    } catch (e) {
      if (sequence === loadSequence.current) setError(e instanceof ApiError ? e.message : '加载正文失败，请稍后重试。')
    } finally {
      if (sequence === loadSequence.current) setLoading(false)
    }
  }, [docId])

  useEffect(() => {
    if (user) void load()
    return () => { loadSequence.current++ }
  }, [load, user])

  /** 读取当前书是否已加入本机离线书单 */
  useEffect(() => {
    if (!user || !docId) return
    let alive = true
    void getOfflineBook(docId)
      .then((rec) => { if (alive) setOfflineRec(rec) })
      .catch(() => { if (alive) setOfflineRec(null) })
    return () => { alive = false }
  }, [user, docId])

  const memoryKey = useMemo(
    () => (user && docId ? listenScopeKey(getApiBase(), user.userId, docId) : ''),
    [user, docId],
  )

  /** 句子由前端切分（docs/system-design.md §7 裁决 1：解析在前端） */
  /** 跟读编排：引擎选择、游标推进、本机听书记忆、读完本章停与定时停都在这里面 */
  const ra = useReadAlong(docId, sentences, paragraphs, memoryKey)

  // 读完本章 / 定时到期时给一条清晰的中文提示
  useEffect(() => {
    if (!ra.stopNotice) return
    setToast(ra.stopNotice)
    ra.clearStopNotice()
  }, [ra])

  /** 阅读进度：打开时恢复到上次位置，滚动时防抖上报（契约 §6） */
  const prog = useProgress(docId, !!user && !fromOffline)

  /** 书签：单项接口即时读写，冲突走 409 信封（契约 §7） */
  const bms = useBookmarks(docId, !!user && !fromOffline)

  /** 划线与批注 */
  const anns = useAnnotations(docId, !!user && !fromOffline)

  /**
   * A4：进页时若拉到了未决冲突（或本页当场撞上冲突），自动把对话框弹出来一次。
   */
  const conflictPrompted = useRef(false)
  useEffect(() => {
    if (conflictPrompted.current || bms.conflicts.length === 0) return
    conflictPrompted.current = true
    setDialogOpen(true)
  }, [bms.conflicts])

  /** 阅读时长：只累计"可见且聚焦"的时间（R7-5，契约 §6.4） */
  useReadingTime(docId, !!user && !fromOffline)

  const byPara = useMemo(() => {
    const m = new Map<number, Sentence[]>()
    for (const s of sentences) {
      const arr = m.get(s.paraIndex)
      if (arr) arr.push(s)
      else m.set(s.paraIndex, [s])
    }
    return m
  }, [sentences])

  /** 书内搜索命中结果 */
  const searchResult = useMemo(
    () => searchInBook(paragraphs, searchQuery),
    [paragraphs, searchQuery],
  )

  useEffect(() => {
    setActiveHitIndex(0)
  }, [searchQuery])

  /** 按段落索引搜索命中，渲染时 O(1) 查出本段命中区间 */
  const hitsByPara = useMemo(() => {
    const m = new Map<number, { start: number; end: number; hitIndex: number }[]>()
    for (const h of searchResult.hits) {
      const list = m.get(h.paraIndex)
      const item = { start: h.start, end: h.end, hitIndex: h.index }
      if (list) list.push(item)
      else m.set(h.paraIndex, [item])
    }
    return m
  }, [searchResult.hits])

  /** 长文档才启用窗口化渲染 */
  const virtual = paragraphs.length > VIRTUAL_THRESHOLD
  const geom = useMemo(() => buildGeometry(paragraphs, prefs.fontSize), [paragraphs, prefs.fontSize])
  const [win, setWin] = useState({ start: 0, end: VIRTUAL_THRESHOLD })

  const tocItems = useMemo(
    () => paragraphs.filter((p) => p.type === 'h1' || p.type === 'h2'),
    [paragraphs],
  )
  const [activeToc, setActiveToc] = useState(-1)
  const activeTocRef = useRef(-1)
  const tocPanelRef = useRef<HTMLElement>(null)

  const syncActiveToc = useCallback(
    (paraIndex: number) => {
      let next = tocIndexAt(tocItems, paraIndex)
      if (next < 0 && tocItems.length > 0) next = 0
      if (next === activeTocRef.current) return
      activeTocRef.current = next
      setActiveToc(next)
    },
    [tocItems],
  )

  /** 跳转落点闪一下墨晕（R3）：让人一眼看见"跳到了哪一段" */
  const [flashPara, setFlashPara] = useState(-1)
  const flashTimer = useRef(0)
  const flashAt = useCallback((index: number) => {
    setFlashPara(index)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashPara(-1), 1200)
  }, [])

  useEffect(() => () => window.clearTimeout(flashTimer.current), [])

  /** 跳到某一段。窗口化时不能靠 querySelector —— 目标段落可能还没渲染 */
  const gotoParagraph = useCallback(
    (index: number, smooth = true) => {
      const root = rootRef.current
      if (!root) return
      currentParaRef.current = index
      syncActiveToc(index)
      flashAt(index)
      if (!virtual) {
        root
          .querySelector(`[data-para="${index}"]`)
          ?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
        return
      }
      root.scrollTo({ top: offsetOf(geom, index), behavior: smooth ? 'smooth' : 'auto' })
      setWin(computeWindow(geom, offsetOf(geom, index), root.clientHeight || 600, index))
    },
    [virtual, geom, syncActiveToc, flashAt],
  )

  /** 跳到第 idx 处搜索命中 */
  const jumpToSearchHit = useCallback(
    (idx: number) => {
      const hits = searchResult.hits
      if (hits.length === 0) return
      const wrapped = ((idx % hits.length) + hits.length) % hits.length
      setActiveHitIndex(wrapped)
      gotoParagraph(hits[wrapped].paraIndex)
      ra.stopAutoScroll()
    },
    [searchResult.hits, gotoParagraph, ra],
  )

  /** 当前可见段落号，加书签与「从当前段开始跟读」都用它 */
  const currentParaRef = useRef(0)
  const resumedRef = useRef(false)

  /** B2：从书架「我的书签 / 我的摘录」点进来时，定位到锚点段落 */
  const jumpedRef = useRef(false)
  useEffect(() => {
    if (jumpedRef.current) return
    if (jumpPara === null || paragraphs.length === 0) return
    jumpedRef.current = true
    gotoParagraph(Number(jumpPara), false)
  }, [jumpPara, paragraphs, gotoParagraph])

  useEffect(() => {
    if (resumedRef.current) return
    if (!prog.ready || paragraphs.length === 0) return
    resumedRef.current = true
    if (jumpPara !== null) return
    if (prog.resumeParagraph <= 0) return
    const idx = clampToParagraphs({ ...anchorAt(prog.resumeParagraph) }, paragraphs)
    gotoParagraph(idx, false)
  }, [prog.ready, prog.resumeParagraph, paragraphs, gotoParagraph, jumpPara])

  useEffect(() => {
    if (paragraphs.length === 0) return
    syncActiveToc(currentParaRef.current)
  }, [paragraphs, syncActiveToc])

  /* 滚动停止后上报位置（防抖在 hook 里，契约 §6.3 要求 1500ms） */
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let pending = 0
    const onScroll = () => {
      if (pending) return
      pending = window.setTimeout(() => {
        pending = 0
        const viewport = root.clientHeight || 600
        let idx: number
        if (virtual) {
          idx = paragraphAt(geom, root.scrollTop + viewport * 0.3)
          setWin(computeWindow(geom, root.scrollTop, viewport, -1))
        } else {
          const top = root.scrollTop + viewport * 0.3
          idx = 0
          for (const el of Array.from(root.querySelectorAll('[data-para]'))) {
            const he = el as HTMLElement
            if (he.offsetTop <= top) idx = Number(he.dataset.para ?? 0)
            else break
          }
        }
        currentParaRef.current = idx
        syncActiveToc(idx)
        prog.report(anchorAt(idx, ra.cursor))
      }, 16)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (pending) window.clearTimeout(pending)
    }
  }, [prog, ra.cursor, virtual, geom, syncActiveToc])

  /* 高亮自动跟随 */
  useEffect(() => {
    if (!ra.autoScroll) return
    const el = rootRef.current?.querySelector(`[data-sentence="${ra.cursor}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [ra.cursor, ra.autoScroll])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(t)
  }, [toast])

  const imageByPara = useMemo(() => {
    const m = new Map<number, ContentImageRef[]>()
    for (const r of imageRefs) m.set(r.paraIndex, [...(m.get(r.paraIndex) ?? []), r])
    return m
  }, [imageRefs])

  const visibleParagraphs = useMemo(
    () => (virtual ? paragraphs.slice(win.start, win.end + 1) : paragraphs),
    [virtual, paragraphs, win.start, win.end],
  )

  useLayoutEffect(() => {
    if (!virtual) return
    const root = rootRef.current
    if (!root) return

    let changed = false
    for (let i = win.start; i <= win.end; i++) {
      const el = root.querySelector(`[data-para="${i}"]`) as HTMLElement | null
      if (!el) continue
      const actual = el.offsetHeight
      if (actual > 0 && Math.abs(actual - geom.heights[i]) > 1) {
        geom.heights[i] = actual
        changed = true
      }
    }
    if (changed) {
      recomputeFrom(geom, win.start)
      setWin((w) => ({ ...w }))
    }
  }, [virtual, win, geom])

  const lastFontRef = useRef(prefs.fontSize)
  useLayoutEffect(() => {
    const root = rootRef.current
    const fontChanged = lastFontRef.current !== prefs.fontSize
    lastFontRef.current = prefs.fontSize
    if (!fontChanged || !root) return

    const viewport = root.clientHeight || 600
    const idx = currentParaRef.current
    const top = Math.max(0, offsetOf(geom, idx) - viewport * 0.3)
    root.scrollTo({ top, behavior: 'auto' })
    if (virtual) setWin(computeWindow(geom, top, viewport, idx))
  }, [prefs.fontSize, geom, virtual])

  /* 打开「书内搜索」抽屉时自动聚焦输入框 */
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
  }, [searchOpen])

  /* 全局快捷键与 Esc 逐层收起 + 焦点归还 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen) return

      // Ctrl/Cmd + F 打开书内搜索（覆盖浏览器默认查找，专注书内上下文检索）
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        setTocOpen(false)
        setMarksOpen(false)
        setSettingsOpen(false)
        window.setTimeout(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }, 0)
        return
      }

      if (e.key === 'Escape') {
        if (pendingSel) {
          setPendingSel(null)
          setSelNoteOpen(false)
          return
        }
        if (activeAnn) {
          setActiveAnn(null)
          return
        }
        if (searchOpen) {
          setSearchOpen(false)
          searchBtnRef.current?.focus()
          return
        }
        if (tocOpen) {
          setTocOpen(false)
          tocBtnRef.current?.focus()
          return
        }
        if (settingsOpen) {
          setSettingsOpen(false)
          settingsBtnRef.current?.focus()
          return
        }
        if (marksOpen) {
          setMarksOpen(false)
          marksBtnRef.current?.focus()
          return
        }
        return
      }

      // 输入框或带修饰键时不拦截单键快捷键
      if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return

      if (e.key === '/') {
        e.preventDefault()
        setSearchOpen(true)
        setTocOpen(false)
        setMarksOpen(false)
        setSettingsOpen(false)
        return
      }

      if (e.key === ' ') {
        // 焦点落在按钮上时交给原生按钮激活，避免空格既触发按钮又误开关播放
        if (e.target instanceof HTMLElement && e.target.closest('button, a')) return
        e.preventDefault()
        ra.toggle()
        return
      }

      if (e.key === 'ArrowLeft' || e.key === '[') {
        e.preventDefault()
        ra.prev()
        return
      }

      if (e.key === 'ArrowRight' || e.key === ']') {
        e.preventDefault()
        ra.next()
        return
      }

      const lower = e.key.toLowerCase()
      if (lower === 't') {
        e.preventDefault()
        setTocOpen((v) => !v)
        setSearchOpen(false)
        setMarksOpen(false)
        setSettingsOpen(false)
        return
      }
      if (lower === 'b') {
        e.preventDefault()
        setMarksOpen((v) => !v)
        setTocOpen(false)
        setSearchOpen(false)
        setSettingsOpen(false)
        return
      }
      if (lower === 's') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
        setTocOpen(false)
        setSearchOpen(false)
        setMarksOpen(false)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, pendingSel, activeAnn, searchOpen, tocOpen, settingsOpen, marksOpen, ra])

  /* 滚动模式下 PageUp / PageDown 滚一屏并带卷角动画 */
  useEffect(() => {
    if (prefs.pageMode !== 'scroll') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return
      if (isEditableTarget(e.target)) return
      const root = rootRef.current
      if (!root) return
      e.preventDefault()
      const step = root.clientHeight - PAGE_OVERLAP
      root.scrollBy({ top: e.key === 'PageDown' ? step : -step, behavior: 'smooth' })
      curlSeq.current += 1
      setCurl({ dir: e.key === 'PageDown' ? 'next' : 'prev', key: curlSeq.current })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prefs.pageMode])

  useEffect(() => {
    if (!tocOpen || activeToc < 0) return
    const panel = tocPanelRef.current
    if (!panel) return
    const el = panel.querySelector(`[data-toc-index="${activeToc}"]`) as HTMLElement | null
    if (!el) return
    panel.scrollTop = Math.max(0, el.offsetTop - panel.clientHeight / 2 + el.clientHeight / 2)
  }, [tocOpen, activeToc])

  /* ---- 阅读背景图 ---- */

  useEffect(() => {
    let alive = true
    if (!prefs.bgImageId) {
      setBgUrl('')
      return
    }
    void getBackground().then((blob) => {
      if (!alive) return
      if (!blob) {
        setPrefs({ bgImageId: null })
        return
      }
      setBgUrl(backgroundUrl(blob))
    })
    return () => {
      alive = false
    }
  }, [prefs.bgImageId, setPrefs])

  useEffect(() => () => releaseBackgroundUrl(), [])

  const onPickBackground = useCallback(
    async (file: File) => {
      setBgError('')
      try {
        await putBackground(file)
        setBgName(file.name)
        setPrefs({ bgImageId: BG_IMAGE_ID })
      } catch (e) {
        setBgError(e instanceof Error ? e.message : '设置背景图失败。')
      }
    },
    [setPrefs],
  )

  const onClearBackground = useCallback(() => {
    setBgError('')
    setBgName('')
    void clearBackground()
    setPrefs({ bgImageId: null })
  }, [setPrefs])

  /* ---- 离线下载 / 移除 ---- */

  const onToggleOffline = useCallback(async () => {
    if (!book || offlineBusy) return
    setOfflineBusy(true)
    try {
      if (offlineRec) {
        await removeOfflineBook(book.docId)
        setOfflineRec(null)
        setToast('已从离线书单移除')
      } else {
        const rec = await downloadBookForOffline(book.docId)
        setOfflineRec(rec)
        setToast(`已下载离线：${formatOfflineStatus(rec)}`)
      }
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : '离线缓存操作失败，请稍后重试。')
    } finally {
      setOfflineBusy(false)
    }
  }, [book, offlineRec, offlineBusy])

  /* ---- 翻页模式：点左右两侧翻屏 ---- */

  const onReaderClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 点击空白区域收起已打开的批注气泡
      const t = e.target as HTMLElement
      if (activeAnn && !t.closest('.ann-popover, [data-ann-id]')) {
        setActiveAnn(null)
      }

      if (prefs.pageMode !== 'paged') return
      if (e.button !== 0 || e.defaultPrevented) return

      if (t.closest('.sent, button, a, input, select, textarea, img, figure, .sel-toolbar, .ann-popover')) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return

      const root = e.currentTarget
      const r = root.getBoundingClientRect()
      const x = e.clientX - r.left
      const step = root.clientHeight - PAGE_OVERLAP

      if (x > r.width * 0.7) {
        root.scrollBy({ top: step, behavior: 'smooth' })
        curlSeq.current += 1
        setCurl({ dir: 'next', key: curlSeq.current })
      } else if (x < r.width * 0.3) {
        root.scrollBy({ top: -step, behavior: 'smooth' })
        curlSeq.current += 1
        setCurl({ dir: 'prev', key: curlSeq.current })
      }
    },
    [prefs.pageMode, activeAnn],
  )

  /* ---- 划词选中：弹出划线 / 写批注工具条 ---- */

  const onContentMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPendingSel(null)
      setSelNoteOpen(false)
      return
    }

    const quote = sel.toString().trim()
    if (!quote) {
      setPendingSel(null)
      return
    }

    const range = sel.getRangeAt(0)
    const startEl = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement
    )?.closest('p.doc-p') as HTMLElement | null
    const endEl = (
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? (range.endContainer as HTMLElement)
        : range.endContainer.parentElement
    )?.closest('p.doc-p') as HTMLElement | null

    // 只支持单段内划词，避免跨段偏移歧义
    if (!startEl || startEl !== endEl) {
      setPendingSel(null)
      return
    }

    const paraBox = startEl.closest('[data-para]') as HTMLElement | null
    const paraIndex = Number(paraBox?.dataset.para ?? -1)
    if (!Number.isInteger(paraIndex) || paraIndex < 0) return

    const startOffset = textOffsetInElement(startEl, range.startContainer, range.startOffset)
    const endOffset = textOffsetInElement(startEl, range.endContainer, range.endOffset)
    if (startOffset === null || endOffset === null || endOffset <= startOffset) return

    const sentEl = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as HTMLElement)
        : range.startContainer.parentElement
    )?.closest('[data-sentence]') as HTMLElement | null
    const sentenceIndex = Number(sentEl?.dataset.sentence ?? 0)

    const bodyRect = bodyRef.current?.getBoundingClientRect()
    const rangeRect = range.getBoundingClientRect()
    if (!bodyRect) return

    const top = Math.max(10, rangeRect.top - bodyRect.top - 52)
    const left = Math.max(
      140,
      Math.min(bodyRect.width - 150, rangeRect.left - bodyRect.left + rangeRect.width / 2),
    )

    setActiveAnn(null)
    setSelNoteOpen(false)
    setSelNoteText('')
    setPendingSel({
      paraIndex,
      sentenceIndex: Number.isFinite(sentenceIndex) ? sentenceIndex : 0,
      startOffset,
      endOffset,
      quote,
      top,
      left,
    })
  }, [])

  const chapterTitleFor = useCallback(
    (paraIndex: number): string => {
      for (let i = Math.min(paraIndex, paragraphs.length - 1); i >= 0; i--) {
        const p = paragraphs[i]
        if (p && (p.type === 'h1' || p.type === 'h2')) return p.text
      }
      const first = paragraphs.find((p) => p.type === 'h1' || p.type === 'h2')
      return first?.text ?? book?.title ?? ''
    },
    [paragraphs, book],
  )

  const firstSentenceOf = useCallback(
    (paraIndex: number): string => {
      const p = paragraphs[paraIndex]
      if (p && (p.type === 'h1' || p.type === 'h2')) return ''
      const raw = (byPara.get(paraIndex) ?? [])[0]?.text ?? p?.text ?? ''
      const trimmed = raw.replace(/[。．.！!？?；;…]+$/, '')
      return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed
    },
    [byPara, paragraphs],
  )

  const defaultNameFor = useCallback(
    (paraIndex: number): string => {
      const parts = [chapterTitleFor(paraIndex), firstSentenceOf(paraIndex)].filter(Boolean)
      return parts.join(' · ')
    },
    [chapterTitleFor, firstSentenceOf],
  )

  const saveSelectionAnnotation = useCallback(
    async (withNote: string | null) => {
      if (!pendingSel) return
      if (fromOffline || offline) {
        setToast('离线模式下暂不支持新增划线，联网后再试。')
        return
      }
      const anchor = {
        chapterIndex: 0,
        paragraphIndex: pendingSel.paraIndex,
        sentenceIndex: pendingSel.sentenceIndex,
        charOffset: pendingSel.startOffset,
        scrollOffset: 0,
      }
      const created = await anns.add({
        anchor,
        endOffset: pendingSel.endOffset,
        quote: pendingSel.quote,
        note: withNote,
        color: selColor,
        chapterTitle: chapterTitleFor(pendingSel.paraIndex),
      })
      window.getSelection()?.removeAllRanges()
      setPendingSel(null)
      setSelNoteOpen(false)
      setSelNoteText('')
      if (created) {
        setToast(withNote ? '已保存划线与批注' : '已保存划线')
      }
    },
    [pendingSel, fromOffline, offline, anns, selColor, chapterTitleFor],
  )

  const onExportBookMarkdown = useCallback(() => {
    if (!book) return
    const md = formatBookAnnotationsMarkdown({ title: book.title, author: book.author }, anns.items)
    downloadMarkdownFile(`${book.title}-摘录`, md)
    setToast('已导出 Markdown 摘录')
  }, [book, anns.items])

  const openAnnotationPopover = useCallback(
    (e: React.MouseEvent<HTMLElement>, annotationId: string) => {
      e.stopPropagation()
      const found = anns.items.find((a) => a.annotationId === annotationId)
      const bodyRect = bodyRef.current?.getBoundingClientRect()
      if (!found || !bodyRect) return
      const rect = e.currentTarget.getBoundingClientRect()
      const top = Math.min(bodyRect.height - 180, Math.max(12, rect.bottom - bodyRect.top + 8))
      const left = Math.max(
        150,
        Math.min(bodyRect.width - 160, rect.left - bodyRect.left + rect.width / 2),
      )
      setPendingSel(null)
      setActiveAnn({ item: found, top, left })
      setActiveAnnNote(found.note ?? '')
    },
    [anns.items],
  )

  const onPlayFromCurrent = useCallback(() => {
    const ok = ra.playFromParagraph(currentParaRef.current)
    if (!ok) {
      setToast('当前位置附近没有可朗读的正文句子')
      return
    }
    setToast(`已从第 ${currentParaRef.current + 1} 段开始跟读`)
  }, [ra])

  if (!ready || !user || loading) {
    return <div className="reader-page"><div className="shelf-empty">正在加载正文…</div></div>
  }

  if (error || !book) {
    return (
      <div className="reader-page">
        <div className="shelf-empty">
          <p className="error-text">{error || '找不到这篇文档'}</p>
          <div className="shelf-empty-actions">
            <button className="btn btn-primary" onClick={() => void load()}>重试</button>
            <button className="btn btn-ghost" onClick={goUp}>回到书架</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="reader-page">
      {/* 进入正文时一道极淡的墨自上而下扫过（R1），只播一次 */}
      <span className="reader-scan" aria-hidden="true" />
      <header className="reader-topbar">
        <button className="btn btn-ghost" onClick={goUp}>返回</button>
        <div className="reader-title" title={book.title}>
          {book.title}
          {fromOffline && <span className="offline-pill">离线副本</span>}
        </div>
        {/* 四个侧栏互斥，同时开不会互相遮挡 */}
        <button
          ref={tocBtnRef}
          className={'btn btn-ghost' + (tocOpen ? ' is-active' : '')}
          aria-expanded={tocOpen}
          title="章节目录（快捷键：T）"
          onClick={() => {
            setTocOpen((v) => !v)
            setSearchOpen(false)
            setMarksOpen(false)
            setSettingsOpen(false)
          }}
        >
          目录
        </button>
        <button
          ref={searchBtnRef}
          className={'btn btn-ghost' + (searchOpen ? ' is-active' : '')}
          aria-expanded={searchOpen}
          title="书内搜索（快捷键：/ 或 Ctrl+F）"
          onClick={() => {
            setSearchOpen((v) => !v)
            setTocOpen(false)
            setMarksOpen(false)
            setSettingsOpen(false)
          }}
        >
          书内搜索
        </button>
        <button
          ref={settingsBtnRef}
          className={'btn btn-ghost' + (settingsOpen ? ' is-active' : '')}
          aria-expanded={settingsOpen}
          title="阅读设置（快捷键：S）"
          onClick={() => {
            setSettingsOpen((v) => !v)
            setTocOpen(false)
            setSearchOpen(false)
            setMarksOpen(false)
          }}
        >
          设置
        </button>
        <button
          ref={marksBtnRef}
          className={'btn btn-ghost' + (marksOpen ? ' is-active' : '')}
          aria-expanded={marksOpen}
          title="书签与摘录（快捷键：B）"
          onClick={() => {
            setMarksTab('bookmarks')
            setMarksOpen((v) => !v)
            setTocOpen(false)
            setSearchOpen(false)
            setSettingsOpen(false)
          }}
        >
          书签{bms.total > 0 ? `（${bms.total}）` : ''}
        </button>
        {!fromOffline && (
          <button
            className="btn btn-ghost"
            disabled={offlineBusy}
            onClick={() => void onToggleOffline()}
            title={offlineRec ? formatOfflineStatus(offlineRec) : '下载正文与插图，断网也能重新打开'}
          >
            {offlineBusy ? '下载中…' : offlineRec ? '已离线' : '下载离线'}
          </button>
        )}
        <button
          className={'btn btn-ghost btn-conflict' + (bms.conflicts.length > 0 ? ' has-conflict' : '')}
          onClick={() => {
            if (bms.conflicts.length === 0) {
              setToast('当前没有同步冲突')
              return
            }
            setDialogOpen(true)
          }}
        >
          同步冲突
          {bms.conflicts.length > 0 && <span className="badge">{bms.conflicts.length}</span>}
        </button>
        <ThemeToggle />
      </header>

      <div className="reader-body" ref={bodyRef}>
        {bgUrl && (
          <div
            className="reader-bg"
            style={{ backgroundImage: `url(${bgUrl})` }}
            aria-hidden="true"
          />
        )}
        {bgUrl && (
          <div
            className={'reader-bg-scrim' + (prefs.theme === 'dark' ? ' on' : '')}
            aria-hidden="true"
          />
        )}

        {settingsOpen && (
          <>
            <div className="toc-mask" onClick={() => setSettingsOpen(false)} aria-hidden="true" />
            <ReaderSettingsPanel
              prefs={prefs}
              setPrefs={setPrefs}
              bgName={bgName}
              bgError={bgError}
              onPickBackground={(f) => void onPickBackground(f)}
              onClearBackground={onClearBackground}
              onClose={() => {
                setSettingsOpen(false)
                settingsBtnRef.current?.focus()
              }}
            />
          </>
        )}

        {tocOpen && (
          <>
            <div className="toc-mask" onClick={() => setTocOpen(false)} aria-hidden="true" />
            <aside className="toc-panel drawer" ref={tocPanelRef} aria-label="目录">
              <div className="toc-head">目录</div>
              {tocItems.length === 0 && (
                <p className="muted marks-empty">
                  这篇文档没有章节标题，暂时没有目录。
                </p>
              )}
              {tocItems.map((p, i) => (
                <button
                  key={p.paraIndex}
                  data-toc-index={i}
                  className={
                    'toc-item' +
                    (p.type === 'h2' ? ' lv2' : '') +
                    (i === activeToc ? ' active' : '')
                  }
                  onClick={() => {
                    gotoParagraph(p.paraIndex)
                    ra.stopAutoScroll()
                  }}
                >
                  {p.text}
                </button>
              ))}
            </aside>
          </>
        )}

        {searchOpen && (
          <>
            <div className="toc-mask" onClick={() => setSearchOpen(false)} aria-hidden="true" />
            <aside className="toc-panel drawer search-panel" aria-label="书内搜索">
              <div className="toc-head toc-head-row">
                <span>书内搜索</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setSearchOpen(false)
                    searchBtnRef.current?.focus()
                  }}
                >
                  收起
                </button>
              </div>
              <div className="search-box">
                <input
                  ref={searchInputRef}
                  className="input search-input"
                  placeholder="输入关键词，回车跳下一处"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && searchResult.hits.length > 0) {
                      e.preventDefault()
                      jumpToSearchHit(activeHitIndex + (e.shiftKey ? -1 : 1))
                    }
                  }}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setSearchQuery('')
                      searchInputRef.current?.focus()
                    }}
                  >
                    清空
                  </button>
                )}
              </div>

              {searchQuery.trim() && (
                <div className="search-nav-bar">
                  <span className="muted">
                    {searchResult.hits.length > 0
                      ? `第 ${activeHitIndex + 1} / ${searchResult.hits.length} 处${searchResult.truncated ? `（共 ${searchResult.total} 处）` : ''}`
                      : '未找到匹配内容'}
                  </span>
                  <div className="search-nav-btns">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={searchResult.hits.length === 0}
                      onClick={() => jumpToSearchHit(activeHitIndex - 1)}
                    >
                      上一处
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={searchResult.hits.length === 0}
                      onClick={() => jumpToSearchHit(activeHitIndex + 1)}
                    >
                      下一处
                    </button>
                  </div>
                </div>
              )}

              {!searchQuery.trim() && (
                <p className="muted marks-empty">
                  输入词句即可在当前书籍全文中检索，点击结果直接跳到对应段落。
                </p>
              )}

              <div className="search-hit-list">
                {searchResult.hits.map((hit) => (
                  <button
                    key={`${hit.paraIndex}-${hit.start}`}
                    type="button"
                    className={'search-hit' + (hit.index === activeHitIndex ? ' active' : '')}
                    onClick={() => jumpToSearchHit(hit.index)}
                  >
                    <span className="search-hit-meta">
                      {hit.chapterTitle ? `${hit.chapterTitle} · ` : ''}第 {hit.paraIndex + 1} 段
                    </span>
                    <span className="search-hit-snippet">
                      {hit.before}
                      <mark className="search-mark">{hit.match}</mark>
                      {hit.after}
                    </span>
                  </button>
                ))}
              </div>
            </aside>
          </>
        )}

        {marksOpen && (
          <>
            <div className="toc-mask marks-mask" onClick={() => setMarksOpen(false)} aria-hidden="true" />
            <BookmarkPanel
              key={marksTab}
              initialTab={marksTab}
              items={bms.items}
              total={bms.total}
              page={bms.page}
              pageSize={bms.pageSize}
              sort={bms.sort}
              onSortChange={bms.setSort}
              onPageChange={bms.setPage}
              defaultAddName={defaultNameFor(currentParaRef.current)}
              onAdd={(name) => {
                const idx = currentParaRef.current
                void bms.add(
                  anchorAt(idx, ra.cursor),
                  name || defaultNameFor(idx),
                  chapterTitleFor(idx),
                )
              }}
              onRename={(id, name) => void bms.rename(id, name)}
              onRemove={(id) => void bms.remove(id)}
              onReorder={(ids) => void bms.reorder(ids)}
              onJump={(paraIndex) => {
                gotoParagraph(paraIndex)
                ra.stopAutoScroll()
              }}
              annotations={anns.items}
              onUpdateAnnotation={(id, patch) => void anns.update(id, patch)}
              onDeleteAnnotation={(id) => void anns.remove(id)}
              onExportAnnotations={onExportBookMarkdown}
            />
          </>
        )}

        {/* 划词悬浮工具条 */}
        {pendingSel && (
          <div
            className="sel-toolbar"
            style={{ top: pendingSel.top, left: pendingSel.left }}
            role="dialog"
            aria-label="划线与批注"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="sel-colors" role="group" aria-label="划线颜色">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`sel-color sel-color-${c.id}` + (selColor === c.id ? ' on' : '')}
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={selColor === c.id}
                  onClick={() => setSelColor(c.id)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void saveSelectionAnnotation(null)}
            >
              划线
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSelNoteOpen((v) => !v)}
            >
              写批注
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(pendingSel.quote).catch(() => {})
                setToast('已复制选中文字')
                setPendingSel(null)
              }}
            >
              复制
            </button>

            {selNoteOpen && (
              <div className="sel-note-box" onMouseDown={(e) => e.stopPropagation()}>
                <textarea
                  className="input ann-textarea"
                  rows={3}
                  autoFocus
                  placeholder="写下你的批注…"
                  value={selNoteText}
                  onChange={(e) => setSelNoteText(e.target.value)}
                />
                <div className="ann-edit-acts">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void saveSelectionAnnotation(selNoteText.trim() || null)}
                  >
                    保存批注
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSelNoteOpen(false)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 点击已划线文本后的批注气泡 */}
        {activeAnn && (
          <div
            className="ann-popover"
            style={{ top: activeAnn.top, left: activeAnn.left }}
            role="dialog"
            aria-label="批注详情"
          >
            <div className="ann-popover-head">
              <div className="sel-colors">
                {HIGHLIGHT_COLORS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`sel-color sel-color-${c.id}` + (activeAnn.item.color === c.id ? ' on' : '')}
                    title={c.label}
                    aria-label={c.label}
                    onClick={async () => {
                      const updated = await anns.update(activeAnn.item.annotationId, { color: c.id })
                      if (updated) setActiveAnn({ ...activeAnn, item: updated })
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setActiveAnn(null)}
              >
                关闭
              </button>
            </div>
            <p className="ann-popover-quote">「{activeAnn.item.quote}」</p>
            <textarea
              className="input ann-textarea"
              rows={3}
              placeholder="补充或修改批注…"
              value={activeAnnNote}
              onChange={(e) => setActiveAnnNote(e.target.value)}
            />
            <div className="ann-popover-foot">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={async () => {
                  const updated = await anns.update(activeAnn.item.annotationId, {
                    note: activeAnnNote.trim() || null,
                  })
                  if (updated) {
                    setToast('批注已更新')
                    setActiveAnn(null)
                  }
                }}
              >
                保存批注
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  const ok = await anns.remove(activeAnn.item.annotationId)
                  if (ok) {
                    setToast('已删除这条划线')
                    setActiveAnn(null)
                  }
                }}
              >
                删除
              </button>
            </div>
          </div>
        )}

        {curl && <span key={curl.key} className={'page-curl ' + curl.dir} aria-hidden="true" />}

        <div
          className={'reader-scroll' + (prefs.pageMode === 'paged' ? ' paged' : '')}
          ref={rootRef}
          onClick={onReaderClick}
        >
          <article
            className="reader-content"
            style={{ fontSize: `${prefs.fontSize}px` }}
            onMouseUp={onContentMouseUp}
          >
            {virtual && (
              <div
                style={{ height: geom.offsets[win.start] }}
                aria-hidden="true"
                data-spacer="top"
              />
            )}
            {visibleParagraphs.map((p) => {
              const refs = imageByPara.get(p.paraIndex) ?? []
              const images = refs.map((ref) => (
                <LazyImage
                  key={ref.imageId}
                  docId={docId}
                  imageId={ref.imageId}
                  alt={ref.alt ?? ''}
                  hasRemote={!!ref.imageUrl}
                  scrollRoot={rootRef}
                  keepResident={ra.playing}
                />
              ))
              const paraHits = hitsByPara.get(p.paraIndex) ?? []
              const paraAnns = anns.byPara.get(p.paraIndex) ?? []

              const block =
                p.type === 'img' ? (
                  images.length ? (
                    images
                  ) : (
                    <figure className="doc-figure">
                      <div className="figure-missing">这一段的图片引用缺失</div>
                    </figure>
                  )
                ) : p.type === 'h1' || p.type === 'h2' ? (
                  (() => {
                    const Tag = p.type
                    const headingSpans: SearchSpan[] = paraHits.map((h) => ({
                      start: h.start,
                      end: h.end,
                      active: h.hitIndex === activeHitIndex,
                    }))
                    const segs = sliceTextSegments(p.text, [], headingSpans)
                    return (
                      <Tag className={'doc-' + p.type + (flashPara === p.paraIndex ? ' para-flash' : '')}>
                        {segs.map((seg) =>
                          seg.searchMatch ? (
                            <mark
                              key={seg.start}
                              className={'search-mark' + (seg.searchActive ? ' search-mark-active' : '')}
                            >
                              {seg.text}
                            </mark>
                          ) : (
                            seg.text
                          ),
                        )}
                      </Tag>
                    )
                  })()
                ) : (
                  (() => {
                    const paraSents = byPara.get(p.paraIndex) ?? []
                    let renderOffset = 0
                    return (
                      <p className={'doc-p' + (flashPara === p.paraIndex ? ' para-flash' : '')}>
                        {paraSents.map((s) => {
                          const sentRenderStart = renderOffset
                          const sentRenderEnd = renderOffset + s.text.length
                          renderOffset = sentRenderEnd

                          const hlSpans: HighlightSpan[] = []
                          for (const ann of paraAnns) {
                            const hs = Math.max(sentRenderStart, ann.anchor.charOffset)
                            const he = Math.min(sentRenderEnd, ann.endOffset)
                            if (he > hs) {
                              hlSpans.push({
                                start: hs - sentRenderStart,
                                end: he - sentRenderStart,
                                annotationId: ann.annotationId,
                                color: ann.color,
                                hasNote: !!ann.note,
                              })
                            }
                          }

                          const searchSpans: SearchSpan[] = []
                          if (paraHits.length > 0) {
                            const directAligned = p.text.slice(s.startOffset, s.endOffset) === s.text
                            if (directAligned) {
                              for (const h of paraHits) {
                                const ss = Math.max(s.startOffset, h.start)
                                const se = Math.min(s.endOffset, h.end)
                                if (se > ss) {
                                  searchSpans.push({
                                    start: ss - s.startOffset,
                                    end: se - s.startOffset,
                                    active: h.hitIndex === activeHitIndex,
                                  })
                                }
                              }
                            } else if (searchResult.query) {
                              const needle = searchResult.query.toLocaleLowerCase()
                              const hay = s.text.toLocaleLowerCase()
                              let pos = 0
                              while (pos <= hay.length - needle.length) {
                                const f = hay.indexOf(needle, pos)
                                if (f < 0) break
                                searchSpans.push({
                                  start: f,
                                  end: f + needle.length,
                                  active: paraHits.some((h) => h.hitIndex === activeHitIndex),
                                })
                                pos = f + needle.length
                              }
                            }
                          }

                          const segs = sliceTextSegments(s.text, hlSpans, searchSpans)

                          return (
                            <span
                              key={s.sentenceIndex}
                              data-sentence={s.sentenceIndex}
                              className={'sent' + (s.sentenceIndex === ra.cursor ? ' sent-active' : '')}
                              onClick={() => {
                                const sel = window.getSelection()
                                if (sel && !sel.isCollapsed) return
                                ra.seek(s.sentenceIndex)
                              }}
                            >
                              {segs.length === 1 && !segs[0].annotationId && !segs[0].searchMatch
                                ? s.text
                                : segs.map((seg) => {
                                    if (!seg.annotationId && !seg.searchMatch) return seg.text
                                    const cls = [
                                      seg.annotationId ? `hl-mark hl-${seg.color}` : '',
                                      seg.hasNote ? 'hl-has-note' : '',
                                      seg.searchMatch ? 'search-mark' : '',
                                      seg.searchActive ? 'search-mark-active' : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')
                                    return (
                                      <mark
                                        key={seg.start}
                                        className={cls}
                                        data-ann-id={seg.annotationId ?? undefined}
                                        onClick={
                                          seg.annotationId
                                            ? (e) => openAnnotationPopover(e, seg.annotationId!)
                                            : undefined
                                        }
                                      >
                                        {seg.text}
                                      </mark>
                                    )
                                  })}
                            </span>
                          )
                        })}
                      </p>
                    )
                  })()
                )

              return (
                <div key={p.paraIndex} data-para={p.paraIndex}>
                  {block}
                  {p.type !== 'img' && images}
                </div>
              )
            })}
            {virtual && (
              <div
                style={{
                  height: Math.max(0, totalHeight(geom) - geom.offsets[win.end + 1]),
                }}
                aria-hidden="true"
                data-spacer="bottom"
              />
            )}
          </article>
        </div>

        {barHidden && (
          <button
            ref={restoreBarRef}
            className="pb-restore"
            onClick={() => setBarHidden(false)}
            title="展开朗读控制条"
            aria-label="展开朗读控制条"
          >
            🎧 {ra.playing ? `跟读中 · 第 ${ra.cursor + 1} / ${sentences.length} 句` : '朗读控制条'}
          </button>
        )}
      </div>

      {(ra.error || bms.error || anns.error) && (
        <div className="resume-hint resume-error">
          {ra.error || bms.error || anns.error}
          {bms.conflicts.length > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => setDialogOpen(true)}>
              查看冲突
            </button>
          )}
        </div>
      )}

      {!ra.autoScroll && (
        <div className="resume-hint">
          已暂停自动滚动（当前第 {ra.cursor + 1} 句）
          <button className="btn btn-primary btn-sm" onClick={ra.resume}>继续跟读</button>
        </div>
      )}

      {!barHidden && (
        <PlaybackBar
          total={sentences.length}
          ra={ra}
          onPlayFromCurrent={onPlayFromCurrent}
          onCollapse={() => setBarHidden(true)}
        />
      )}

      {dialogOpen && bms.conflicts.length > 0 && (
        <ConflictDialog
          conflicts={bms.conflicts}
          onClose={() => setDialogOpen(false)}
          onResolve={(c, choice) => void bms.resolve(c, choice)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
