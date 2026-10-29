import { describe, expect, it } from 'vitest'
import { MinHeap } from '../../core/scan/heap'

describe('MinHeap Top-N', () => {
  it('容量 3 时只留最大的 3 个，降序输出', () => {
    const h = new MinHeap<number>(3, (n) => n)
    for (const n of [5, 1, 9, 3, 7, 2, 8]) h.push(n)
    expect(h.entries().sort((a, b) => b - a)).toEqual([9, 8, 7])
  })
  it('未满容量时全部保留', () => {
    const h = new MinHeap<number>(5, (n) => n)
    h.push(1); h.push(2)
    expect(h.entries()).toEqual([1, 2])
  })
  it('重复 push 不改变容量不变量', () => {
    const h = new MinHeap<number>(2, (n) => n)
    for (let i = 0; i < 1000; i++) h.push(i)
    expect(h.entries().sort((a, b) => b - a)).toEqual([999, 998])
  })
})
