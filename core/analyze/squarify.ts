/**
 * squarify —— Treemap 布局纯函数（§10 / 已锁定决策 3）
 *
 * 实现 Bruls, Huizing, van Wijk (1991) 的 squarified treemap 原式：
 * 每一「行」始终沿剩余矩形的**较短边**铺开，使新增矩形的长宽比尽可能接近 1。
 *
 * 纯函数约束（本文件会被 tsconfig.node 与 tsconfig.web 同时编译，并被渲染端 import）：
 * 禁止 import 任何 `node:*` / `electron` / DOM API。
 */

export interface LayoutItem {
  key: string
  name: string
  value: number
}

export interface Rect {
  key: string
  name: string
  value: number
  x: number
  y: number
  w: number
  h: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Sized extends LayoutItem {
  area: number
  /** 输入下标，用于把结果按输入顺序回读（布局顺序只决定坐标，不决定数组顺序）。 */
  order: number
}

/** 布局产物：Rect + 输入下标。 */
interface Placed extends Rect {
  order: number
}

/**
 * 把 items 按 value 占总面积的比例铺进 box。
 * 返回值**按输入顺序**给出（第 i 个 Rect 对应第 i 个合法入参），坐标才是布局结果；
 * 数组顺序稳定，便于渲染端按 children 原始顺序绘制与命中测试。
 * value <= 0 / 非有限数的元素被丢弃（0 字节目录在真实盘上很常见）。退化容器返回空数组。
 */
export function squarify(items: LayoutItem[], box: Box): Rect[] {
  const out: Placed[] = []
  if (!(box.w > 0) || !(box.h > 0)) return out
  const valid = items.filter((i) => Number.isFinite(i.value) && i.value > 0)
  const sum = valid.reduce((s, i) => s + i.value, 0)
  if (valid.length === 0 || sum <= 0) return out
  const boxArea = box.w * box.h
  const scaled: Sized[] = valid
    .map((i, idx) => ({ ...i, area: (i.value / sum) * boxArea, order: idx }))
    .sort((a, b) => b.area - a.area)
  strip(scaled, box, out)
  return out
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ key: p.key, name: p.name, value: p.value, x: p.x, y: p.y, w: p.w, h: p.h }))
}

/**
 * 一行（row）沿长度为 side 的边铺开时，行内最坏（最偏离正方形）的长宽比。
 * worst = max( side²·rmax / s² , s² / (side²·rmin) )，s = 行内面积之和。
 */
function worst(row: number[], side: number): number {
  let rmax = 0
  let rmin = Infinity
  let s = 0
  for (const a of row) {
    if (a > rmax) rmax = a
    if (a < rmin) rmin = a
    s += a
  }
  if (rmin === Infinity || s === 0) return Infinity
  const s2 = s * s
  const side2 = side * side
  return Math.max((side2 / s2) * rmax, s2 / (side2 * rmin))
}

/** 递归铺一层：先切出一条 row，剩下的矩形继续递归。 */
function strip(items: Sized[], box: Box, out: Placed[]): void {
  if (items.length === 0) return
  // 浮点余量可能把剩余矩形压成 0 宽/0 高，此时无法再放任何东西。
  if (!(box.w > 0) || !(box.h > 0)) return
  if (items.length === 1) {
    const it = items[0]!
    out.push({
      key: it.key,
      name: it.name,
      value: it.value,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      order: it.order
    })
    return
  }

  // row 沿较短边铺：宽是较短边 → 顶部横排一条；高是较短边 → 左侧竖排一条。
  const alongTop = box.h > box.w
  const side = alongTop ? box.w : box.h

  const row: Sized[] = []
  let rowAreas: number[] = []
  let i = 0
  for (; i < items.length; i++) {
    const cand = [...rowAreas, items[i]!.area]
    if (row.length === 0 || worst(cand, side) <= worst(rowAreas, side)) {
      row.push(items[i]!)
      rowAreas = cand
    } else break
  }

  const rowSum = row.reduce((s, r) => s + r.area, 0)
  const thickness = rowSum / side
  let cursor = 0
  for (const r of row) {
    const length = r.area / thickness
    out.push(
      alongTop
        ? { key: r.key, name: r.name, value: r.value, x: box.x + cursor, y: box.y, w: length, h: thickness, order: r.order }
        : { key: r.key, name: r.name, value: r.value, x: box.x, y: box.y + cursor, w: thickness, h: length, order: r.order }
    )
    cursor += length
  }

  const rest: Box = alongTop
    ? { x: box.x, y: box.y + thickness, w: box.w, h: Math.max(0, box.h - thickness) }
    : { x: box.x + thickness, y: box.y, w: Math.max(0, box.w - thickness), h: box.h }
  strip(items.slice(i), rest, out)
}
