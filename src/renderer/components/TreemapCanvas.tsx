import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { basisNoun, useSizeBasis } from '../lib/size-basis'
import { rootShareLabel, toTiles, FOLD_NOTE, type ColorMode, type Tile } from '../../../core/analyze/treemap-data'
import { FIT, ZOOM_STEP, focusView, panBy, project, tileText, unproject, zoomAt, type View } from '../../../core/analyze/treemap-view'
import { formatBytes, formatCount } from '../../../shared/format'
import type { ChildView } from '../../../shared/types'
import { MapControls } from './MapControls'

interface Props {
  items: ChildView[]
  mode: ColorMode
  active: Tile | null
  /**
   * 视图 = 一层纯坐标变换（core/analyze/treemap-view.ts）。刻意**不**并进 `tiles` 的 memo：
   * 缩放/平移绝不重跑 squarify（§16 不阻塞 UI；§13 的放大是「同样的布局、更大的屏幕映射」）。
   * 状态归 SpaceMap 持有：Task 6 的 Top 面板也要能改它。
   */
  view: View
  /** 本层总容量：tooltip「占当前目录」的分母（来自主进程，渲染端算不出子树合计）。 */
  levelSize: number
  /** 主进程没回传的子项个数 —— 折成「其它 N 项」独立一格，不并进任何真块。 */
  foldedCount: number
  /** 那些子项的合计容量。 */
  foldedBytes: number
  /** 本次扫描根的容量：tooltip 第二个百分比的分母。 */
  rootSize: number
  /** 本次扫描的根路径：决定那一行叫「占全盘」还是「占扫描根」（判据与详情面板同一个函数）。 */
  rootPath?: string
  onPick: (t: Tile | null) => void
  onOpen: (t: Tile) => void
  onMenu: (t: Tile, x: number, y: number) => void
  onView: (v: View) => void
  /** 布局结果上抛给页面：Top 面板要按 key 找回对应的块。刻意不在页面里重算 toTiles —— 两处布局两处真相。 */
  onTiles?: (t: Tile[]) => void
  /**
   * 「重新布局」：重读本层 + 复位视图。Squarified 是确定性的，同一份数据不会排出另一种布局，
   * 按钮 title 里如实写明 —— 不做假随机来冒充"重排"。
   */
  onRelayout: () => void
}

/** Top 面板「点击定位」入口（Task 6）：把某块聚焦进视野。视图几何只有这里知道画布尺寸，所以句柄挂在 canvas 上。 */
export interface TreemapCanvasHandle {
  focus(tile: Tile): void
}

/** 小于这个像素数的块直接不画：1M 文件下会有成千上万个亚像素块，画了既看不见也拖慢渲染。 */
const MIN_DRAW_PX = 4
const PAD = 1

/**
 * 布局盒必须由 canvas 自己量：早期版本由 SpaceMap 传死 1000x640，
 * 结果是窗口实际 ~1010x760 时底部留一条黑带、右侧一列被裁掉。
 * 几何与绘制同源，才不会出现"算的框和画的框不是一回事"。
 */
export const TreemapCanvas = forwardRef<TreemapCanvasHandle, Props>(function TreemapCanvas(
  {
    items,
    mode,
    active,
    view,
    levelSize,
    foldedCount,
    foldedBytes,
    rootSize,
    rootPath,
    onPick,
    onOpen,
    onMenu,
    onView,
    onTiles,
    onRelayout
  }: Props,
  ref
): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<Tile | null>(null)
  const [tipAt, setTipAt] = useState({ x: 0, y: 0 })

  // 事件回调里要读**最新**视图（闭包里的 `view` 是挂 up 那一次渲染的旧值），所以走 ref。
  const viewRef = useRef(view)
  viewRef.current = view
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  /** 拖完那一下的 click 不算选中：按下→移动→抬起落在同一块上，用户做的是"平移"不是"点它"。 */
  const suppressClick = useRef(false)

  useImperativeHandle(
    ref,
    () => ({
      // §10 定位。focusView 只放大不缩小（Math.max(want, v.scale)）：40× 下点一块比屏还宽的父级大块，
      // 它投影后仍铺满（甚至溢出）视口，高亮框四条边全在屏外 —— 点了"没反应"。这不是定位，是死路。
      // 这里的判据：focusView 之后块仍撑破视口 → 这一层根本装不下它，退回 FIT 看整层，
      // 蓝框（active 已由页面的 locate 同步设上）圈出的正是那块占的**区域** —— 层级语义本来就对了。
      focus: (t: Tile) => {
        const v = viewRef.current
        const fv = focusView(v, t, size.w, size.h)
        const s = project(t, fv)
        onView(s.w >= size.w || s.h >= size.h ? FIT : fv)
      }
    }),
    [onView, size]
  )

  const tiles = useMemo(
    () => toTiles(items, { x: 0, y: 0, w: size.w, h: size.h }, mode, { foldedCount, foldedBytes, parentSize: levelSize, rootSize }),
    [items, size, mode, foldedCount, foldedBytes, levelSize, rootSize]
  )

  // 布局结果上抛（Top 面板按 key 找回 tile）。这条 effect 会不会成环，**只取决于 items 的引用稳不稳**：
  // 空层的 toTiles 每次都返回一个新的 []（不是 memo 命中），所以 items 一旦每渲染都变，链路就是
  // effect → setTiles(新引用) → 页面重渲染 → items 变 → memo 重算 → 又一个新 [] → 无界自旋。
  // dev 下 React 只会打一句「Maximum update depth exceeded」，生产构建连这个都没有 = 静默烧 CPU。
  // 收敛点在 hook 侧：空栈时 navView 返回模块级常量 NO_CHILDREN（core/analyze/tree-nav-state.ts），
  // items 引用恒定 → 其余依赖都是原始值 → memo 命中同一引用 → 第二圈不存在。
  // 页面回传的 onTiles 是 useState 的 setter（引用恒定），不构成第二个变数。
  useEffect(() => {
    onTiles?.(tiles)
  }, [tiles, onTiles])
  /** 第二个百分比的行名：只有扫描根真是盘符根时才叫「占全盘」（与详情面板同一个函数、同一个入参）。 */
  const shareLabel = rootShareLabel(rootPath)

  // dev-only 截图脚手架用（main/index.ts 的 --shot 的 34-file-detail）：
  // 块是 canvas 自绘的，DOM 里没有坐标可查 —— 不挂这个就只能对着 (600,400) 猜，
  // 而"点中一个**文件**格"恰恰是这次要验的东西，猜不得。
  // 依赖必须是 [tiles]（memo 过的）：这个组件是全应用最热的渲染点（每帧 hover 都在 setState），
  // 没有依赖数组等于每次渲染重新 map 一个 ≤1200 项的数组；卸载不擦除则会让截图脚本读到已消失层级的几何。
  useEffect(() => {
    const w = window as unknown as {
      __dcTiles?: { key: string; name: string; kind: string; x: number; y: number; w: number; h: number; folded: boolean }[]
    }
    // `folded` 必须带出来：合计块的 child.kind 也是 'directory'，截图脚本分不清就会去点它，
    // 而那一格没有 dirId（按契约不触发 §9 统计），点它等于什么都没验。
    // `key` 同理必须带：28 那一步要按 key 找回榜上那一格（name 会撞、也会随截断变化，
    // 按 name 匹配等于没在验 join 键 —— 那正是点行定位唯一依赖的东西）。
    w.__dcTiles = tiles.map((t) => ({
      key: t.key,
      name: t.child.name,
      kind: t.child.kind,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      folded: t.folded === true
    }))
    return () => {
      delete w.__dcTiles
    }
  }, [tiles])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 底图：tiles / view / size 变化时重画。view 只改坐标映射，tiles（squarify 的产物）原样不动。
  useEffect(() => {
    const cv = baseRef.current
    if (!cv || size.w <= 0 || size.h <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    // 变换矩阵只管 dpr；**缩放不走 ctx.scale** —— 坐标换算交给 project，
    // 这样字号/线宽按屏幕像素写死，缩到 40× 时一行字不会变成半屏高。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.font = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'top'
    for (const t of tiles) {
      const s = project(t, view)
      if (s.x > size.w || s.y > size.h || s.x + s.w < 0 || s.y + s.h < 0) continue // 视口外不画
      if (s.w < MIN_DRAW_PX || s.h < MIN_DRAW_PX) continue
      const x = s.x + PAD
      const y = s.y + PAD
      const w = Math.max(1, s.w - 2 * PAD)
      const h = Math.max(1, s.h - 2 * PAD)
      ctx.fillStyle = t.color
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = 'rgba(0,0,0,.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      // 字号不随 scale 走：变换矩阵只管 dpr，坐标换算交给 project。
      // 门槛由 tileText 按**屏幕**尺寸判：布局期被 toTiles 清成空串的格子，放大之后要拿 name/value 补回字。
      const text = tileText(t, view)
      if (text.label) {
        ctx.fillStyle = 'rgba(255,255,255,.95)'
        ctx.fillText(clip(ctx, text.label, w - 12), x + 6, y + 5)
        if (text.sub) {
          ctx.fillStyle = 'rgba(255,255,255,.72)'
          ctx.fillText(text.sub, x + 6, y + 21)
        }
      }
    }
  }, [tiles, view, size])

  // 高亮层：hover 只重画这张，代价与 tiles 数量无关。
  // 白框**必须也过 project** —— 不然放大后它钉在旧位置，框不住任何格子（本 Task 最容易漏的一处，25-zoom-4x.png 专拍它）。
  useEffect(() => {
    const cv = overRef.current
    if (!cv || size.w <= 0 || size.h <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(size.w * dpr)
    cv.height = Math.round(size.h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    // 选中框的颜色走 CSS 的 `--accent`（V0.9 S1 收口：原先这里硬写一份 `#4cc2ff`，
    // 与样式表里那份是同一语义的两个字面量）。每帧读一次，不在 per-tile 循环里读。
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4cc2ff'
    for (const t of [active, hover]) {
      if (!t) continue
      const s = project(t, view)
      if (s.w < MIN_DRAW_PX || s.h < MIN_DRAW_PX) continue
      ctx.strokeStyle = t === hover ? '#ffffff' : accent
      ctx.lineWidth = t === hover ? 2 : 3
      ctx.strokeRect(s.x + 1, s.y + 1, Math.max(1, s.w - 2), Math.max(1, s.h - 2))
    }
  }, [hover, active, view, size])

  // 命中按**布局**坐标判（先 unproject）；亚像素门槛按**屏幕**尺寸判（放大后小格就该点得中）。
  const hit = (mx: number, my: number): Tile | null => {
    const p = unproject({ x: mx, y: my }, view)
    for (const t of tiles) {
      const s = project(t, view)
      if (s.w < MIN_DRAW_PX || s.h < MIN_DRAW_PX) continue
      if (p.x >= t.x && p.x < t.x + t.w && p.y >= t.y && p.y < t.y + t.h) return t
    }
    return null
  }

  // MouseEvent 与 WheelEvent 都只要这三个字段（React 合成事件上 currentTarget 就是 canvas 本身）。
  const local = (e: { clientX: number; clientY: number; currentTarget: Element }): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  return (
    <div ref={wrapRef} className="dc-treemap">
      <canvas ref={baseRef} className="dc-canvas" />
      <canvas
        ref={overRef}
        className="dc-canvas dc-canvas-top"
        onWheel={(e) => {
          const p = local(e)
          // 注意：React 的 onWheel 在 Chromium 里是 passive 的，e.preventDefault() 会告警且无效。
          // 本页面没有可滚动容器（canvas 铺满，.dc-main/.dc-treemap 都是 overflow:hidden），
          // 滚轮滚不出页面位移，所以不 preventDefault —— 硬接非 passive 监听要 addEventListener 绕行，不值。
          onView(zoomAt(viewRef.current, p.x, p.y, Math.exp(-e.deltaY * 0.0015), size.w, size.h))
        }}
        onMouseDown={(e) => {
          if (e.button !== 0) return // 只认左键：右键按下是菜单手势，跟着移动不该变成平移
          const p = local(e)
          drag.current = { x: p.x, y: p.y, moved: false }
        }}
        onMouseMove={(e) => {
          const p = local(e)
          const d = drag.current
          if (d && (Math.abs(p.x - d.x) > 3 || Math.abs(p.y - d.y) > 3)) {
            d.moved = true
            onView(panBy(viewRef.current, p.x - d.x, p.y - d.y, size.w, size.h))
            drag.current = { x: p.x, y: p.y, moved: true }
            return
          }
          setTipAt(p)
          const t = hit(p.x, p.y)
          if (t?.key !== hover?.key) setHover(t)
        }}
        onMouseUp={() => {
          const d = drag.current
          drag.current = null
          suppressClick.current = d?.moved === true // 拖完那一下 click 不算选中
        }}
        onMouseLeave={() => {
          // 拖出画布后 mouseup 不在 canvas 上，不会产生 canvas 的 click（浏览器只发给共同祖先），
          // 所以这里只丢手势，**不**置 suppressClick —— 置了会吃掉下次重新进入后的真单击。
          setHover(null)
          drag.current = null
        }}
        onClick={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          const p = local(e)
          onPick(hit(p.x, p.y))
        }}
        onDoubleClick={(e) => {
          const p = local(e)
          const t = hit(p.x, p.y)
          // §6：双击只对**目录**钻取。文件格的双击在这之前已经过两次 onClick → onPick，
          // 详情面板就是"打开文件详情"的结果，所以这里必须什么都不做而不是钻进去。
          // 拖拽后双击同样能进：第一次 click 被 suppress 后标记即复位，第二次 click/up 是没移动的新手势。
          if (t && t.child.kind === 'directory' && t.child.dirId !== undefined) onOpen(t)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          const p = local(e)
          const t = hit(p.x, p.y)
          if (t) onMenu(t, p.x, p.y)
        }}
      />
      <MapControls
        scale={view.scale}
        onZoomIn={() => onView(zoomAt(viewRef.current, size.w / 2, size.h / 2, ZOOM_STEP, size.w, size.h))}
        onZoomOut={() => onView(zoomAt(viewRef.current, size.w / 2, size.h / 2, 1 / ZOOM_STEP, size.w, size.h))}
        onFit={() => onView(FIT)}
        onRelayout={onRelayout}
      />
      {hover && <Tooltip tile={hover} x={tipAt.x} y={tipAt.y} width={size.w} shareLabel={shareLabel} />}
    </div>
  )
})

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let s = text
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1)
  return `${s}…`
}

function Tooltip({ tile, x, y, width, shareLabel }: { tile: Tile; x: number; y: number; width: number; shareLabel: string }): JSX.Element {
  const flip = x > width - 300
  const c = tile.child
  const word = basisNoun(useSizeBasis())
  const sizeRowLabel = tile.folded ? `合计（${word}）` : c.kind === 'directory' ? `目录（${word}）` : `文件（${word}）`
  return (
    <div className="dc-tip" style={flip ? { right: width - x + 8, top: y + 14 } : { left: x + 14, top: y + 14 }}>
      <div className="dc-tip-name">{c.name}</div>
      {!tile.folded && <div className="dc-tip-path">{c.path}</div>}
      {tile.folded && (
        <div className="dc-tip-row">
          <span>说明</span>
          {/* 与详情面板同源（core/analyze/detail.ts 的 foldedNote）：同一格悬停与单击必须说同一句话 */}
          <b>{FOLD_NOTE}</b>
        </div>
      )}
      <div className="dc-tip-row">
        <span>{sizeRowLabel}</span>
        <b>{formatBytes(tile.value)}</b>
      </div>
      <div className="dc-tip-row">
        <span>占当前目录</span>
        <b>{tile.pctOfParent > 0 ? `${tile.pctOfParent.toFixed(1)}%` : '—'}</b>
      </div>
      <div className="dc-tip-row">
        <span>{shareLabel}</span>
        <b>{tile.pctOfRoot > 0 ? `${tile.pctOfRoot.toFixed(2)}%` : '—'}</b>
      </div>
      {!tile.folded && c.kind === 'directory' && (
        <div className="dc-tip-row">
          <span>子树文件数</span>
          <b>{formatCount(c.fileCount)}</b>
        </div>
      )}
      {c.scanning && (
        <div className="dc-tip-row">
          <span>状态</span>
          <b className="dc-live">正在扫描…</b>
        </div>
      )}
    </div>
  )
}
