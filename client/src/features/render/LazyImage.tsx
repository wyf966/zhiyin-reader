import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ApiError, api } from '../../api/client'
import { useSession } from '../../state/session'
import { assertImageScope, cacheEntry, cachePut, imageScope, markUploaded } from './imageCache'
import { restoreImages } from './restoreImages'

/**
 * 单张图片的按需加载。
 *
 * 依据 docs/system-design.md §6.2 / §8：
 *   1. 图片未进入视口时不发起任何网络请求（IntersectionObserver 控制）
 *   2. 缓存命中直接读本地 Blob；未命中才向服务端取
 *   3. 图片离开视口时清空对象地址、释放 Blob，但 IndexedDB 里的副本保留
 *
 * 依据契约 §4.3：图片是**懒上传**的 —— 服务端还没有这张图（imageUrl 为空或
 * 取回 404）而本地有 Blob 时，先上传再由服务端提供给其他设备。
 */

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; fromCache: boolean; warning?: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

interface Props {
  docId: string
  imageId: string
  alt: string
  /** 服务端上已有这张图（来自 /content 的 imageRefs.imageUrl） */
  hasRemote: boolean
  /** 滚动容器，作为 IntersectionObserver 的 root */
  scrollRoot: RefObject<HTMLDivElement>
  /** 已进过视口就不再释放，避免来回滚动反复请求 */
  keepResident?: boolean
  /** 段落号，供目录跳转用 */
  dataPara?: number
}

export default function LazyImage({
  docId,
  imageId,
  alt,
  scrollRoot,
  keepResident = false,
  dataPara,
}: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const holderRef = useRef<HTMLDivElement>(null)
  const { user } = useSession()
  const scope = useMemo(() => imageScope(docId), [docId, user?.userId])
  const startedRef = useRef(false)
  const generation = useRef(0)
  const ownedUrl = useRef<string | null>(null)

  function release() {
    generation.current++
    if (ownedUrl.current) URL.revokeObjectURL(ownedUrl.current)
    ownedUrl.current = null
    startedRef.current = false
  }

  async function load(selected?: File) {
    release()
    startedRef.current = true
    const run = generation.current
    setState({ kind: 'loading' })
    try {
      let restored = selected ? await restoreImages(scope, selected) : undefined
      let row = await cacheEntry(scope, imageId)
      let warning = ''
      if (!row?.fromOriginal && !restored) {
        try { restored = await restoreImages(scope) }
        catch (e) {
          // 离线阅读时（网络不可达 status=0）如果本地已有缓存图，直接展示本地副本，不阻断离线图文混排
          if (e instanceof ApiError && e.status === 0 && row?.blob) {
            warning = ''
          } else if (e instanceof ApiError && e.code === 'ORIGINAL_FILE_MISSING') {
            warning = e.message
          } else {
            throw e
          }
        }
        row = await cacheEntry(scope, imageId)
      }
      const original = restored?.get(imageId)
      let blob = original ?? row?.blob
      if (!blob) {
        blob = await api.getImage(docId, imageId)
        assertImageScope(scope)
        await cachePut(scope, imageId, blob, false)
      }
      assertImageScope(scope)
      if (generation.current !== run) return
      // 每个组件独立持有 URL；别的文档或同图的另一处引用不能撤销它。
      ownedUrl.current = URL.createObjectURL(blob)
      setState({ kind: 'ready', url: ownedUrl.current, fromCache: !!row, warning })
      if (original || row?.needsUpload) {
        try {
          assertImageScope(scope)
          await api.putImage(docId, imageId, blob)
          await markUploaded(scope, imageId)
        } catch { /* 本地仍可显示，保留 needsUpload，下次进入视口再补传。 */ }
      }
    } catch (e) {
      if (generation.current !== run) return
      setState({ kind: 'error', message: e instanceof Error ? e.message : '图片加载失败' })
    }
  }

  useEffect(() => {
    const el = holderRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && !startedRef.current) void load()
        else if (!entry.isIntersecting && startedRef.current && !keepResident) {
          release()
          setState({ kind: 'idle' })
        }
      }
    }, { root: scrollRoot.current ?? null, rootMargin: '200px 0px', threshold: 0.01 })
    io.observe(el)
    return () => { io.disconnect(); release() }
  }, [scope, imageId, keepResident])

  const retry = () => { void load() }

  return (
    <figure className="doc-figure" data-para={dataPara}>
      <div className="figure-holder" ref={holderRef}>
        {state.kind === 'ready' && (
          <img className="figure-img" src={state.url} alt={alt} />
        )}
        {state.kind === 'ready' && state.warning && <div className="figure-missing-hint">
          {state.warning}
          <label className="btn btn-ghost btn-sm">选择原 EPUB 恢复插图
            <input type="file" accept=".epub" hidden onChange={e => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void load(file)
            }} />
          </label>
        </div>}

        {(state.kind === 'idle' || state.kind === 'loading') && (
          <div className="figure-skeleton" aria-label="图片加载中">
            <span className="figure-spinner" />
          </div>
        )}

        {state.kind === 'missing' && (
          <div className="figure-missing">
            <span>图片不可用</span>
            <span className="figure-missing-hint">
              这张图还没有被任何设备上传到服务端
            </span>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="figure-missing">
            <span>{state.message}</span>
            <button className="btn btn-ghost btn-sm" onClick={retry}>
              重试
            </button>
            <label className="btn btn-ghost btn-sm">
              选择原 EPUB 恢复插图
              <input type="file" accept=".epub" hidden onChange={e => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void load(file)
              }} />
            </label>
          </div>
        )}
      </div>
      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  )
}
