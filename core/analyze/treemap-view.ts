import { formatBytes } from '../../shared/format'
import type { Box } from './squarify'

/**
 * 视图层就是一层仿射变换，刻意与布局解耦：
 * 缩放/平移**不**重跑 squarify。squarify 的输入是「本层 ≤1200 项 + 一个盒子」，
 * 每次滚轮都重算会把 §16 的「不阻塞 UI」直接赔进去；而放大真正要的是
 * 「同样的布局、更大的屏幕映射」，再加上按屏幕尺寸重判 label/最小可见块。
 *
 * 纯函数约束（本文件被 tsconfig.node 与 tsconfig.web 同时编译）：
 * 禁止 import 任何 `node:*` / `electron` / DOM API。
 *
 * 几何参数用 `Box`（x/y/w/h）而不是 `Rect`：squarify 的 `Rect` 额外带 key/name/value
 * （那是「布局产物」的身份），视图变换既不生产也不消费这些字段。`Tile extends Rect`，
 * 结构上就是一个带附加字段的 Box，所以调用方把 Tile 传进来毫无问题。
 */
export interface View {
  scale: number
  ox: number
  oy: number
}

export const FIT: View = { scale: 1, ox: 0, oy: 0 }
export const MIN_SCALE = 1
export const MAX_SCALE = 40
/** 一次按钮点击的倍率。1.25 是手感值：2 太跳，1.1 要点七八次才看得出变化。 */
export const ZOOM_STEP = 1.25

export const project = (r: Box, v: View): Box => ({
  x: r.x * v.scale + v.ox,
  y: r.y * v.scale + v.oy,
  w: r.w * v.scale,
  h: r.h * v.scale
})

export const unproject = (p: { x: number; y: number }, v: View): { x: number; y: number } => ({
  x: (p.x - v.ox) / v.scale,
  y: (p.y - v.oy) / v.scale
})

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** 内容比画布小时不许拖出白边；比画布大时不许拖出内容外的空白。 */
export function clampView(v: View, w: number, h: number): View {
  const loX = Math.min(0, w - w * v.scale)
  const loY = Math.min(0, h - h * v.scale)
  return { scale: v.scale, ox: Math.min(0, Math.max(loX, v.ox)), oy: Math.min(0, Math.max(loY, v.oy)) }
}

/** 以屏幕点 (px,py) 为锚缩放：该点下的布局坐标在缩放前后不动。 */
export function zoomAt(v: View, px: number, py: number, factor: number, w: number, h: number): View {
  const scale = clampScale(v.scale * factor)
  if (scale === v.scale) return clampView(v, w, h)
  const k = scale / v.scale
  return clampView({ scale, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k }, w, h)
}

export function panBy(v: View, dx: number, dy: number, w: number, h: number): View {
  return clampView({ scale: v.scale, ox: v.ox + dx, oy: v.oy + dy }, w, h)
}

/** Top 面板「点击定位」用：把某块放到约 60% 边长并居中，够不着就停在 MAX_SCALE。 */
export function focusView(v: View, r: Box, w: number, h: number): View {
  const want = r.w > 0 && r.h > 0 ? Math.min((w * 0.6) / r.w, (h * 0.6) / r.h) : MAX_SCALE
  const scale = clampScale(Math.max(want, v.scale))
  const cx = (r.x + r.w / 2) * scale
  const cy = (r.y + r.h / 2) * scale
  return clampView({ scale, ox: w / 2 - cx, oy: h / 2 - cy }, w, h)
}

/** 文字门槛（**屏幕**像素）：与 brief §13 一致，宽度 >56 才写主名，高度 >18 / >34 分别决定两行。 */
const LABEL_MIN_SCREEN_W = 56
const LABEL_MIN_SCREEN_H = 18
const SUB_MIN_SCREEN_H = 34

/** `tileText` 只消费这四个字段，所以调用方传 `Tile` 或任何等价对象都行。 */
export interface TileTextFields {
  /** `toTiles` 按**布局**尺寸给的字（放不下就是空串）—— 非空时优先沿用，保证文案与布局期一致。 */
  label: string
  /** 同上，第二行。 */
  sub: string
  /** 真实名字：布局期被清成空 label 后，放大时就靠它补回来（折叠格的 name 已是「其它 N 项」，本身就是正确文案）。 */
  name: string
  /** 字节数：`sub` 为空时用它格式化出第二行。 */
  value: number
}

export interface TileText {
  label: string
  sub: string
}

/**
 * 一格在当前视图下到底写不写字、写什么。**门槛一律用 `project` 之后的屏幕尺寸**（§13）：
 *
 * `toTiles` 在布局期就把 62×22 以下格子的 `label`/`sub` 清成空串，那是「100% 时挤不挤得下」的答案，
 * 而缩放刻意**不**重跑布局（见本文件头）—— 于是那份空串会永远留在 Tile 上。若继续拿
 * 「`t.label` 非空」当*有没有字*的判据，放大后几何出来了、文字却永远不出来（只解放了本来就有字的格），
 * 恰好是这条约束想防的半吊子。所以：屏幕尺寸够了就用真字段兜底（`name` / `formatBytes(value)`）。
 *
 * 纯函数，DOM 侧只管画：canvas 拿到 `{label, sub}` 后自己决定 clip 与字号。
 */
export function tileText(t: TileTextFields & Box, v: View): TileText {
  const s = project(t, v)
  if (s.w <= LABEL_MIN_SCREEN_W || s.h <= LABEL_MIN_SCREEN_H) return { label: '', sub: '' }
  return {
    label: t.label || t.name,
    sub: s.h > SUB_MIN_SCREEN_H ? t.sub || formatBytes(t.value) : ''
  }
}
