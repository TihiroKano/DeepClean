/**
 * 莫比乌斯环加载动画（2026-10-27，人类伙伴：「点击激活出现校验中加一个莫比乌斯环的加载动画」）。
 *
 * ## 为什么是"一条轮廓 + 一个渐变"
 *
 * 前四版都试过、都被真机截图否掉了（完整对照表在 `mobius-geometry.ts` 文件头）。
 * 根因是同一个：**把连续的明暗场切成了有限片**，每片一个 `opacity`，
 * 片边界必然可见 —— 表现为一圈放射状条纹或扇贝，越细越密。
 *
 * 这一版结构上就没有"片"这个东西：
 *  - 带子是**一条闭合路径**（外沿走一圈 + 内沿走回来），中间没有任何内部边界；
 *  - 明暗用 `linearGradient` 给 —— 渐变天生连续，不可能有缝；
 *  - 翻面那处（`u = π`）用一道细的暗色路径标出来，读作"它在这里拧了一下"。
 *
 * ## 三条不许含糊的地方
 *
 * 1. **不许用 `stroke-dasharray` 假装流转**。那种做法让一条静态曲线看起来在动，
 *    而没有"绕圈"这个语义 —— 莫比乌斯环的读法恰恰是"一直在绕、绕不完"。
 *    这里整条 `<g>` 绕自身中心旋转。
 * 2. **`prefers-reduced-motion` 必须停**。持续旋转对前庭敏感的人是真实的不适来源，
 *    而"加载中"这件事用静止的一帧 + 文案同样说得出。
 * 3. **`role="status"` + 文案在 DOM 里**。纯图形对读屏是空的。
 */
import { outlinePath, twistSeamPath, type Mobius3D } from './mobius-geometry'

export interface MobiusSpinnerProps {
  /** 边长（px）。默认 46 —— 与 `.dc-license-busy` 那行字的高度成比例。 */
  size?: number
  /** 中径（相对边长的比例）。 */
  radius?: number
  /** 半带宽（相对边长的比例）。 */
  width?: number
  /** 斜投影系数。0.55 是"看得出它立着、又不破形"的那一档。 */
  tilt?: number
  /** 一句话（给读屏与视觉都在）。文案由调用方给 —— 这一格的语义是调用方决定的。 */
  label: string
  /**
   * 挂在文案后面的装饰节点（2026-10-27：三个会动的点）。
   *
   * 放成 prop 而不是写死在这里：这个环是通用加载件，句子后面跟什么由调用方决定。
   * 它必须落在 `.dc-mobius-label` **里面**，否则读屏会把它当成独立节点念一遍。
   */
  trailing?: React.ReactNode
}

/**
 * 默认几何：`radius 0.28` / `width 0.105` / `tilt 0.55`。
 * 三个数各档都截过图对过，理由见 `mobius-geometry.ts` 里 `project` 与 `Mobius3D` 的注释。
 */
const DEFAULT_RADIUS = 0.28
const DEFAULT_WIDTH = 0.105
const DEFAULT_TILT = 0.55

/**
 * 轮廓采样段数。**80** —— 单一路径没有"片段"这个概念，所以可以取密一点换平滑；
 * 80 段在 46 px 上每段约 1.8 px，肉眼看不出折线，SVG 体积也就多几百字节。
 */
const SEGMENTS = 80

export function MobiusSpinner({
  size = 46,
  radius = DEFAULT_RADIUS,
  width = DEFAULT_WIDTH,
  tilt = DEFAULT_TILT,
  label,
  trailing
}: MobiusSpinnerProps): JSX.Element {
  const geo: Mobius3D = {
    R: size * radius,
    halfWidth: size * width,
    tilt,
    cx: size / 2,
    cy: size / 2
  }
  const body = outlinePath(geo, SEGMENTS)
  const seam = twistSeamPath(geo)
  /**
   * 渐变 id 必须**每个实例唯一**：同页两个环（比如以后别处也放一个）用同一个 id 时，
   * 后渲染的 `<defs>` 会盖掉先渲染的，两个环会共享同一份渐变坐标 ——
   * 表现是其中一个环的明暗对不上自己的位置。用尺寸+半径拼一个够用的 key。
   */
  const gid = `dc-mobius-g${size}-${Math.round(radius * 1000)}`

  return (
    <span className="dc-mobius" role="status" aria-live="polite">
      <svg
        className="dc-mobius-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          {/*
            明暗：`x1=0 y1=0 → x2=0 y2=1` 是从上到下。
            带子绕到下半圈时立起来（`z = w·sin(u/2)`），那半圈在屏幕上被压扁、且更暗 ——
            所以渐变在下端更暗。斜向（`x1=0.2`）而不是纯竖直，是为了让明暗带一点
            方向感：纯竖直读起来像"打了个顶光"，斜一点才像"这圈东西自己在转"。
          */}
          <linearGradient id={gid} x1="0.2" y1="0" x2="0.6" y2="1">
            <stop offset="0%" stopColor="var(--accent-2)" stopOpacity="1" />
            <stop offset="45%" stopColor="var(--accent-2)" stopOpacity="0.86" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {/*
          旋转套在 `<g>` 上而不是 `<svg>` 上：`<svg>` 的 `transform-origin` 在部分 WebView2
          版本上按 `border-box` 解析，会绕左上角转 —— 那看起来是"环在绕屏幕右上角飞"。
          `<g>` 上的 `transform-box: fill-box` + `transform-origin: center` 是稳的（写在 CSS 里）。
        */}
        <g className="dc-mobius-ring">
          {/* 带子本体：一条闭合轮廓，填充渐变。结构上没有内部边界 ⇒ 不可能有缝。 */}
          <path className="dc-mobius-body" d={body} fill={`url(#${gid})`} />
          {/* 翻面那道脊：`u = π` 附近的一小片，暗一档。没有它整条带子是一个色块，
              读不出"扭"。 */}
          <path className="dc-mobius-seam" d={seam} />
        </g>
      </svg>
      <span className="dc-mobius-label">
        {label}
        {trailing}
      </span>
    </span>
  )
}
