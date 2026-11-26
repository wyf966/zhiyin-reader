import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppLogo from '../features/brand/AppLogo'
import LineIcon, { type LineIconName } from '../features/brand/LineIcon'
import InkField from '../features/motion/InkField'
import InkBrush from '../features/motion/InkBrush'
import InkSeal from '../features/motion/InkSeal'
import InkText from '../features/motion/InkText'
import GuidePeaks from '../features/motion/GuidePeaks'
import { hasFinePointer } from '../features/motion/motionEnv'
import guideMountain from '../assets/guide-mountain.jpg'

interface Slide {
  volume: string
  caption: string
  title: string
  subtitle: string
  accent: string
  cards: { icon: LineIconName; title: string; desc: string }[]
}

const SLIDES: Slide[] = [
  {
    volume: '卷一',
    caption: '云山入卷 · 图文一体',
    title: '知音漫卷',
    subtitle: '把插图放回文字里，把朗读对上句子',
    accent: '#285478',
    cards: [
      { icon: 'image', title: '图文一体', desc: '插图内联在引用位置，滚动到才加载' },
      { icon: 'headphones', title: '逐句跟读', desc: '读一句、亮一句，位置永远对得上' },
      { icon: 'bookmark', title: '书签与摘录', desc: '随手标记与批注，随时回到上次读的地方' },
    ],
  },
  {
    volume: '卷二',
    caption: '声随字行 · 视听同步',
    title: '视听同步',
    subtitle: '听一句，看一句，睡前也能安心续听',
    accent: '#4a5578',
    cards: [
      { icon: 'clock', title: '句子级切分', desc: '按中文标点切句，索引稳定不漂移' },
      { icon: 'headphones', title: '多引擎发声', desc: '支持本地语音与在线音色，断联自动降级' },
      { icon: 'sliders', title: '睡前定时', desc: '从当前段起播，支持读完本章停与定时停止' },
    ],
  },
  {
    volume: '卷三',
    caption: '跨端续读 · 离线常伴',
    title: '多端续读',
    subtitle: '换设备接着读，断网也能翻开书卷',
    accent: '#2f6556',
    cards: [
      { icon: 'cloud', title: '进度同步', desc: '阅读位置在多端之间保持一致，不回退' },
      { icon: 'puzzle', title: '冲突保留', desc: '两端改同一处时，两份都留下供裁决' },
      { icon: 'wifi', title: '离线书单', desc: '正文与插图整本缓存，断网亦可重新打开' },
    ],
  },
]

export default function GuidingUI() {
  const [index, setIndex] = useState(0)
  // 切页时从这一处晕开的一团墨（A4）。key 换一次就重播一遍
  const [blot, setBlot] = useState<{ x: number; y: number; key: number } | null>(null)
  const navigate = useNavigate()
  const pageRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pointerStart = useRef<number | null>(null)
  const finePointer = hasFinePointer()
  const slide = SLIDES[index]

  const localOf = (clientX: number, clientY: number) => {
    const rect = pageRef.current?.getBoundingClientRect()
    if (!rect) return undefined
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const goTo = (next: number, origin?: { x: number; y: number }) => {
    const target = Math.max(0, Math.min(SLIDES.length - 1, next))
    if (target === index) return
    const rect = pageRef.current?.getBoundingClientRect()
    setBlot({
      x: origin ? origin.x : rect ? rect.width * 0.5 : 0,
      y: origin ? origin.y : rect ? rect.height * 0.42 : 0,
      key: Date.now(),
    })
    setIndex(target)
  }

  return (
    <div className="guide-page" ref={pageRef}>
      {finePointer && <InkField className="guide-field" />}
      {finePointer && <GuidePeaks className="guide-peaks" />}
      <div className="guide-light" aria-hidden="true" />
      <div className="guide-vignette" aria-hidden="true" />
      <div className="guide-grain" aria-hidden="true" />

      <div
        className="guide-stage guide-spread"
        ref={stageRef}
        style={{ ['--accent' as string]: slide.accent }}
      >
        {/* 左栏：书卷扉页排版（品牌眉题 + 衬线主标 + 编号要点清单 + 行动入口） */}
        <section className="guide-editorial">
          <div className="guide-masthead">
            <div className="guide-brand-pill">
              <AppLogo size={34} />
              <span>知音漫卷</span>
            </div>
            <span className="guide-vol">
              {slide.volume} · 0{index + 1} / 0{SLIDES.length}
            </span>
          </div>

          <h1 className="guide-title">
            <InkText key={`title-${index}`} text={slide.title} stagger={110} duration={500} />
          </h1>

          <p className="guide-subtitle" key={`sub-${index}`}>{slide.subtitle}</p>

          <ul className="guide-points" key={`cards-${index}`}>
            {slide.cards.map((c, i) => (
              <li
                className="guide-point"
                key={c.title}
                style={{ animationDelay: `${80 + i * 80}ms` }}
              >
                <span className="guide-point-icon" aria-hidden="true">
                  <LineIcon name={c.icon} size={18} />
                </span>
                <div className="guide-point-body">
                  <div className="guide-point-title">{c.title}</div>
                  <div className="guide-point-desc">{c.desc}</div>
                </div>
              </li>
            ))}
          </ul>

          <div className="guide-actions">
            <button className="btn btn-primary" onClick={() => navigate('/login')}>
              开始阅读
            </button>
            <button className="btn btn-ghost" onClick={() => navigate('/shelf')}>
              进入书架
            </button>
          </div>

          <div className="guide-pager">
            <div className="guide-dots">
              {SLIDES.map((s, i) => (
                <button
                  key={s.volume}
                  className={'guide-dot' + (i === index ? ' active' : '')}
                  aria-label={`第 ${i + 1} 页`}
                  onClick={(e) => goTo(i, localOf(e.clientX, e.clientY))}
                />
              ))}
            </div>
            <span className="guide-hint">点击圆点或拖动右侧画卷翻页</span>
          </div>
        </section>

        {/* 右栏：竖幅装裱山水画卷（整屏只留这一方朱印，克制留白） */}
        <div
          className="guide-figure"
          onPointerDown={(e) => {
            pointerStart.current = e.clientX
          }}
          onPointerUp={(e) => {
            if (pointerStart.current === null) return
            const dx = e.clientX - pointerStart.current
            pointerStart.current = null
            if (Math.abs(dx) > 60) goTo(index + (dx < 0 ? 1 : -1), localOf(e.clientX, e.clientY))
          }}
        >
          <img
            className="guide-figure-photo"
            src={guideMountain}
            alt="云雾中的群山"
            draggable={false}
          />
          <div className="guide-figure-shade" aria-hidden="true" />
          <div className="guide-figure-colophon">
            <span className="guide-figure-vol">{slide.volume}</span>
            <span className="guide-figure-cap">{slide.caption}</span>
          </div>
          <InkSeal className="guide-seal" text="知音" delay={180} />
          <span className="guide-figure-hint" aria-hidden="true">左右拖动翻卷</span>
        </div>
      </div>

      {finePointer && <InkBrush className="guide-brush" trail splash />}

      {blot && (
        <span
          key={blot.key}
          className="guide-blot"
          aria-hidden="true"
          style={{ left: blot.x, top: blot.y }}
        />
      )}
    </div>
  )
}
