import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ApiError,
  api,
  type Anchor,
  type AnnotationColor,
  type AnnotationDto,
} from '../../api/client'

export interface AnnotationsApi {
  items: AnnotationDto[]
  byPara: Map<number, AnnotationDto[]>
  loading: boolean
  error: string
  reload: () => Promise<void>
  add: (input: {
    anchor: Anchor
    endOffset: number
    quote: string
    note?: string | null
    color?: AnnotationColor
    chapterTitle?: string | null
  }) => Promise<AnnotationDto | null>
  update: (
    annotationId: string,
    patch: { note?: string | null; color?: AnnotationColor },
  ) => Promise<AnnotationDto | null>
  remove: (annotationId: string) => Promise<boolean>
}

export function useAnnotations(docId: string, enabled: boolean): AnnotationsApi {
  const [items, setItems] = useState<AnnotationDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (!enabled || !docId) return
    setLoading(true)
    try {
      const res = await api.listAnnotations(docId)
      setItems(res.items)
      setError('')
    } catch (e) {
      // 离线打开本地书籍时不因拉不到批注而打断阅读
      if (e instanceof ApiError && e.status === 0) {
        setError('')
      } else {
        setError(e instanceof ApiError ? e.message : '读取划线与批注失败')
      }
    } finally {
      setLoading(false)
    }
  }, [docId, enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  const byPara = useMemo(() => {
    const m = new Map<number, AnnotationDto[]>()
    for (const item of items) {
      const idx = item.anchor.paragraphIndex
      const list = m.get(idx)
      if (list) list.push(item)
      else m.set(idx, [item])
    }
    return m
  }, [items])

  const add = useCallback(
    async (input: {
      anchor: Anchor
      endOffset: number
      quote: string
      note?: string | null
      color?: AnnotationColor
      chapterTitle?: string | null
    }): Promise<AnnotationDto | null> => {
      try {
        const created = await api.createAnnotation({
          docId,
          anchor: input.anchor,
          endOffset: input.endOffset,
          quote: input.quote,
          note: input.note ?? null,
          color: input.color ?? 'amber',
          chapterTitle: input.chapterTitle ?? null,
        })
        setItems((prev) => [...prev, created])
        setError('')
        return created
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '保存划线失败，请检查网络后重试。')
        return null
      }
    },
    [docId],
  )

  const update = useCallback(
    async (
      annotationId: string,
      patch: { note?: string | null; color?: AnnotationColor },
    ): Promise<AnnotationDto | null> => {
      try {
        const updated = await api.patchAnnotation(annotationId, patch)
        setItems((prev) => prev.map((it) => (it.annotationId === annotationId ? updated : it)))
        setError('')
        return updated
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '更新批注失败，请稍后重试。')
        return null
      }
    },
    [],
  )

  const remove = useCallback(async (annotationId: string): Promise<boolean> => {
    try {
      await api.deleteAnnotation(annotationId)
      setItems((prev) => prev.filter((it) => it.annotationId !== annotationId))
      setError('')
      return true
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除摘录失败，请稍后重试。')
      return false
    }
  }, [])

  return { items, byPara, loading, error, reload, add, update, remove }
}
