import { describe, expect, it } from 'vitest'
import { squarify, type LayoutItem } from '../../core/analyze/squarify'

const box = { x: 0, y: 0, w: 800, h: 600 }
const items = (weights: number[]): LayoutItem[] =>
  weights.map((w, i) => ({ key: `k${i}`, name: `n${i}`, value: w }))

const area = (r: { w: number; h: number }): number => r.w * r.h
const total = (rects: { value: number }[]): number => rects.reduce((s, r) => s + r.value, 0)

describe('squarify', () => {
  it('面积与 value 成正比（§10 矩形面积与占用空间成比例）', () => {
    const r = squarify(items([1, 3]), box)
    // 容器面积是 800*600 = 480000（计划原文误写成 4800，见本 Task 提交说明）
    expect(area(r[0]!)).toBeCloseTo(480000 * 0.25, 1)
    expect(area(r[1]!)).toBeCloseTo(480000 * 0.75, 1)
    expect(r[1]!.w * r[1]!.h).toBeGreaterThan(r[0]!.w * r[0]!.h)
  })

  it('全部矩形落在容器内', () => {
    for (const r of squarify(items([1, 2, 5, 3, 8, 13, 21]), box)) {
      expect(r.x).toBeGreaterThanOrEqual(-0.001)
      expect(r.y).toBeGreaterThanOrEqual(-0.001)
      expect(r.x + r.w).toBeLessThanOrEqual(800 + 0.001)
      expect(r.y + r.h).toBeLessThanOrEqual(600 + 0.001)
    }
  })

  it('矩形互不重叠', () => {
    const rs = squarify(items([5, 4, 3, 2, 1, 1, 1, 1]), box)
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i]!
        const b = rs[j]!
        const overlap =
          Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
        expect(overlap).toBeLessThan(1)
      }
  })

  it('面积之和 ≈ 容器面积（允许浮点余量 1%）', () => {
    const rs = squarify(items([1, 1, 2, 3, 5, 8]), box)
    const sum = rs.reduce((s, r) => s + area(r), 0)
    expect(Math.abs(sum - 480000) / 480000).toBeLessThan(0.01)
  })

  it('单个元素占满容器', () => {
    const rs = squarify(items([42]), box)
    expect(rs).toHaveLength(1)
    expect(rs[0]).toMatchObject({ x: 0, y: 0, w: 800, h: 600 })
  })

  it('零/负/NaN 值被丢弃（目录可能为 0 字节）', () => {
    const rs = squarify(
      [
        { key: 'a', name: 'a', value: 0 },
        { key: 'b', name: 'b', value: -5 },
        { key: 'c', name: 'c', value: NaN },
        { key: 'd', name: 'd', value: 10 }
      ],
      box
    )
    expect(rs.map((r) => r.key)).toEqual(['d'])
  })

  it('全部为 0 或空输入返回空数组，不抛', () => {
    expect(squarify([], box)).toEqual([])
    expect(squarify(items([0, 0]), box)).toEqual([])
  })

  it('退化容器（w=0 / h=0）返回空数组', () => {
    expect(squarify(items([1, 2]), { x: 0, y: 0, w: 0, h: 600 })).toEqual([])
    expect(squarify(items([1, 2]), { x: 0, y: 0, w: 800, h: 0 })).toEqual([])
  })

  it('长尾分布下长宽比仍可看（没有极端细长条主导）', () => {
    const w = Array.from({ length: 60 }, (_, i) => Math.pow(1.5, 60 - i))
    const rs = squarify(items(w), box)
    const ratio = (r: { w: number; h: number }): number => Math.max(r.w / r.h, r.h / r.w)
    const viewable = rs.filter((r) => area(r) > 400)
    expect(viewable.length).toBeGreaterThan(0)
    for (const r of viewable) expect(ratio(r)).toBeLessThan(6)
  })

  it('输入未排序也能得到正确比例', () => {
    const rs = squarify(items([1, 100, 10]), box)
    const byKey = Object.fromEntries(rs.map((r) => [r.key, area(r)]))
    expect(byKey.k1!).toBeGreaterThan(byKey.k2!)
    expect(byKey.k2!).toBeGreaterThan(byKey.k0!)
  })

  it('total() 辅助：value 之和保持（回归哨兵，防止缩放丢失元素）', () => {
    const inItems = items([7, 3, 1])
    const rs = squarify(inItems, box)
    expect(total(rs)).toBe(total(inItems))
  })
})
