import { useEffect, useRef, useState } from 'react'
import type { ReadAlongApi } from '../features/readalong/useReadAlong'
import type { VoiceOption } from '../features/readalong/engines'

export const RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
export const SLEEP_OPTIONS = [
  { minutes: 0, label: '关闭' },
  { minutes: 15, label: '15 分' },
  { minutes: 30, label: '30 分' },
  { minutes: 45, label: '45 分' },
  { minutes: 60, label: '60 分' },
]

/** 中文音色排在前面 —— 本项目的正文都是中文。chinese 未知时退回看 lang */
function isChinese(v: VoiceOption): boolean {
  return v.chinese ?? (v.lang ?? '').toLowerCase().startsWith('zh')
}

/**
 * 选项文字。本机没装的挂上原因（契约 §9.4），
 * 否则读者只会看到一个不能点的灰条，不知道该怎么办。
 */
function voiceLabel(v: VoiceOption): string {
  return v.available === false && v.note ? `${v.label} — ${v.note}` : v.label
}

function formatRemaining(sec: number): string {
  const mins = Math.floor(sec / 60)
  const rem = sec % 60
  if (mins >= 1) return `${mins}分${rem > 0 ? `${String(rem).padStart(2, '0')}秒` : ''}`
  return `${rem}秒`
}

function VoiceGroup({ label, items }: { label: string; items: VoiceOption[] }) {
  return (
    <optgroup label={label}>
      {items.map((v) => (
        <option
          key={v.voice}
          value={v.voice}
          disabled={v.available === false}
          title={v.available === false ? v.note : v.label}
        >
          {voiceLabel(v)}
        </option>
      ))}
    </optgroup>
  )
}

interface Props {
  total: number
  ra: ReadAlongApi
  /** 从当前正在阅读的段落开始跟读 */
  onPlayFromCurrent: () => void
  /** 收起控制条。状态由 ReaderView 持有 —— 收起后浮出来的那个恢复胶囊
      要渲染在 PlaybackBar 之外，状态自然归共同父级 */
  onCollapse: () => void
}

/**
 * 朗读控制条。
 *
 * 主条突出高频控制：上一句 / 跟读·暂停 / 下一句 / 从当前段开始 + 进度；
 * 语速、音色、引擎、离线音色包与降级详情、睡前定时（读完本章停止 / 定时停止）
 * 收进二级面板，既清爽又不藏掉任何关键说明。
 */
export default function PlaybackBar({ total, ra, onPlayFromCurrent, onCollapse }: Props) {
  const [panelOpen, setPanelOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstControlRef = useRef<HTMLSelectElement>(null)

  const noSentence = total === 0
  const busy = !ra.ready

  // 渲染用完整目录；万一目录没取到（服务端 §9.4 那条挂了），退回可用音色，界面照常能用
  const catalog = ra.voiceCatalog.length > 0 ? ra.voiceCatalog : ra.voiceOptions
  const missing = catalog.filter((v) => v.available === false)
  const zhVoices = catalog.filter(isChinese)
  const otherVoices = catalog.filter((v) => !isChinese(v))

  const percent = noSentence ? 0 : Math.round(((ra.cursor + 1) / total) * 100)
  /* 长篇（剑来 8.7 万句）刚开读时百分比是 0，墨线会一根都看不见，
     所以给一个最小可见宽度，让「已开始」这件事有反馈 */
  const railWidth = noSentence ? 0 : Math.max(percent, 0.8)
  const percentText = noSentence ? '' : percent < 1 ? '不足 1%' : `${percent}%`

  const rateText = `${ra.rate.toFixed(2).replace(/0$/, '')}x`
  const hasTimer = ra.stopAfterChapter || ra.sleepRemainingSec !== null
  const timerBadge =
    ra.sleepRemainingSec !== null
      ? `剩余 ${Math.ceil(ra.sleepRemainingSec / 60)} 分`
      : ra.stopAfterChapter
        ? '读完本章止'
        : ''

  // 打开二级面板时聚焦首个控件；点外部或按 Esc 收起并把焦点还给触发按钮
  useEffect(() => {
    if (!panelOpen) return
    firstControlRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setPanelOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [panelOpen])

  return (
    <footer className="playbar">
      {/* 顶部一条极细的墨线进度：不占高度，扫一眼就知道读到哪儿了 */}
      <span className="pb-rail" aria-hidden="true">
        <i style={{ width: `${railWidth}%` }} />
      </span>

      <div className="pb-transport">
        <button
          className="pb-btn pb-step"
          onClick={ra.prev}
          disabled={busy || noSentence || ra.cursor <= 0}
          title="回到上一句（快捷键：←）"
        >
          上一句
        </button>

        <button
          className={'pb-btn pb-btn-main' + (ra.playing ? ' is-playing' : '')}
          onClick={ra.toggle}
          disabled={busy || noSentence}
          title={ra.playing ? '暂停跟读（快捷键：空格）' : '从当前句开始跟读（快捷键：空格）'}
        >
          {ra.playing ? '暂停' : '跟读'}
          {/* 发声时才有的声纹，紧贴在按钮文字后面（纯装饰，不进无障碍名） */}
          {ra.playing && (
            <span className="pb-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </button>

        <button
          className="pb-btn pb-step"
          onClick={ra.next}
          disabled={busy || noSentence || ra.cursor >= total - 1}
          title="跳到下一句（快捷键：→）"
        >
          下一句
        </button>

        <button
          className="pb-btn pb-here"
          onClick={onPlayFromCurrent}
          disabled={busy || noSentence}
          title="从当前正在阅读的段落开始跟读"
        >
          从当前段开始
        </button>
      </div>

      <div className="pb-progress">
        <span className="pb-counter">{noSentence ? '无正文' : `第 ${ra.cursor + 1} / ${total} 句`}</span>
        {!noSentence && <span className="pb-percent">{percentText}</span>}
        {ra.restoredFromMemory && !ra.playing && (
          <span className="pb-memory-tag" title="已自动回到本机上次听到的句子">
            已续上次
          </span>
        )}
      </div>

      <div className="pb-actions-right">
        {timerBadge && (
          <span className="pb-chip pb-chip-timer" title="睡前听书自动停止已开启">
            {timerBadge}
          </span>
        )}
        {ra.degraded && (
          <span
            className="pb-chip pb-chip-warn"
            title="服务端的语音合成服务当前不可用，点右侧「声音与定时」查看详情"
          >
            设备发声
          </span>
        )}

        <div className="pb-popover-anchor">
          <button
            ref={triggerRef}
            type="button"
            className={'pb-btn pb-more-btn' + (panelOpen ? ' is-open' : '') + (hasTimer ? ' has-timer' : '')}
            aria-expanded={panelOpen}
            aria-haspopup="dialog"
            onClick={() => setPanelOpen((v) => !v)}
            title="调整语速、音色、引擎与睡前定时"
          >
            声音与定时 · {rateText}
            {(ra.degraded || missing.length > 0) && <i className="pb-dot" aria-hidden="true" />}
          </button>

          {panelOpen && (
            <div
              ref={popoverRef}
              className="pb-popover"
              role="dialog"
              aria-label="声音与定时设置"
            >
              <div className="pb-pop-head">
                <span>声音与定时</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setPanelOpen(false)
                    triggerRef.current?.focus()
                  }}
                >
                  完成
                </button>
              </div>

              {(missing.length > 0 || ra.degraded) && (
                <div className="pb-pop-notes">
                  {ra.degraded && (
                    <span
                      className="pb-note"
                      title="服务端的语音合成服务当前不可用，已改用设备本地语音合成"
                    >
                      已降级为设备发声
                    </span>
                  )}
                  {missing.length > 0 && (
                    <span
                      className="pb-note"
                      title="这些音色在音色目录里，但这台机器还没装对应的离线音色包"
                    >
                      {missing.length} 个音色需安装离线音色包
                    </span>
                  )}
                </div>
              )}

              <div className="pb-pop-grid">
                <label className="pb-pop-field">
                  <span>语速</span>
                  <select
                    ref={firstControlRef}
                    className="select"
                    value={ra.rate}
                    onChange={(e) => ra.setRate(Number(e.target.value))}
                    title="跟读速度"
                  >
                    {RATES.map((r) => (
                      <option key={r} value={r}>
                        {r.toFixed(2).replace(/0$/, '')}x
                      </option>
                    ))}
                  </select>
                </label>

                <label className="pb-pop-field">
                  <span>音色</span>
                  <select
                    className="select"
                    value={ra.voice}
                    onChange={(e) => ra.setVoice(e.target.value)}
                    disabled={ra.voiceOptions.length === 0}
                    title="朗读音色"
                  >
                    {ra.voiceOptions.length === 0 && <option value="">（无可用音色）</option>}
                    {zhVoices.length > 0 && <VoiceGroup label="中文音色" items={zhVoices} />}
                    {otherVoices.length > 0 && <VoiceGroup label="其他语言" items={otherVoices} />}
                  </select>
                </label>

                {/* 只有多个引擎时才给选择器；契约 §9.1 说不可用的引擎不进列表 */}
                {ra.engineOptions.length > 1 && (
                  <label className="pb-pop-field">
                    <span>引擎</span>
                    <select
                      className="select"
                      value={ra.engineId}
                      onChange={(e) => ra.setEngine(e.target.value)}
                      title="发声引擎"
                    >
                      {ra.engineOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <div className="pb-pop-section">
                <div className="pb-pop-section-head">
                  <span>睡前听书</span>
                  {ra.sleepRemainingSec !== null && (
                    <span className="muted">剩余 {formatRemaining(ra.sleepRemainingSec)}</span>
                  )}
                </div>

                <label className="pb-check-row">
                  <input
                    type="checkbox"
                    checked={ra.stopAfterChapter}
                    onChange={(e) => ra.setStopAfterChapter(e.target.checked)}
                  />
                  <span>读完本章后自动停止</span>
                </label>

                <div className="pb-timer-row" role="group" aria-label="定时停止">
                  {SLEEP_OPTIONS.map((opt) => (
                    <button
                      key={opt.minutes}
                      type="button"
                      className={'pb-timer-pill' + (ra.sleepMinutes === opt.minutes ? ' on' : '')}
                      aria-pressed={ra.sleepMinutes === opt.minutes}
                      onClick={() => ra.setSleepTimer(opt.minutes)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <button
          className="pb-btn pb-collapse"
          onClick={onCollapse}
          title="收起朗读控制条"
          aria-label="收起朗读控制条"
        >
          收起
        </button>
      </div>
    </footer>
  )
}
