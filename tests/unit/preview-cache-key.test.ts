/**
 * 预览缓存键的判据（2026-10-25）。
 *
 * **这条钉的是一个真实报过的缺陷**：人类伙伴「只勾一个 4 MB 的条目，清完之后那个条目
 * 还是 4 MB，但日志里有记录，切回清理预览它还在」。
 *
 * 根因是两件事叠在一起：
 * 1. `refreshNonce` 当时住在 `Cleanup` 的本地 `useState` 里，而那一页是条件渲染、
 *    切页即卸载 ⇒ 从清理页切到清理日志再切回来，nonce 从 1 归 0；
 * 2. 缓存键里含 nonce，于是**归零后的键与清理前那一份逐字相同** ⇒ 模块级
 *    `previewCache` 命中 ⇒ 把清理前的旧值原样拿回来显示。
 *
 * 修法是把 nonce 提到 `App`（与勾选同一处，活过切页）。而这条判据守的是第二半：
 * **键里必须有 nonce**。少了它，哪怕 nonce 提上去了也不会触发重算。
 */
import { describe, expect, it } from 'vitest'
import { previewCacheKey } from '../../src/renderer/hooks/usePreview'

const base = {
  scanId: 'scan-1',
  selected: ['a', 'b'],
  tiles: ['C:\\x.tmp'],
  status: 'completed' as const,
  nonce: 0,
}

const keyOf = (over: Partial<typeof base> = {}): string => {
  const o = { ...base, ...over }
  return previewCacheKey(o.scanId, o.selected, o.tiles, o.status, o.nonce)
}

describe('预览缓存键', () => {
  it('清完一次之后键必须变（nonce 是键的一部分）', () => {
    const before = keyOf({ nonce: 0 })
    const after = keyOf({ nonce: 1 })
    expect(after).not.toBe(before)
  })

  it('nonce 归零会让键回到清理前那一份 —— 这正是那个缺陷的形状', () => {
    // 清完：nonce = 1
    const cleaned = keyOf({ nonce: 1 })
    // 切页回来：nonce 归 0（旧实现下就是这样）
    const backToPage = keyOf({ nonce: 0 })
    // 它与「清理前」逐字相同 ⇒ 命中旧缓存。这条用例把这个形状**记录下来**：
    // 一旦哪天有人把 nonce 从键里拿掉，上面第一条会红；而这条说明为什么不能只依赖
    // "nonce 会变"——它必须活过切页（由 App 持有），键才不会再撞上。
    expect(backToPage).toBe(keyOf({ nonce: 0 }))
    expect(cleaned).not.toBe(backToPage)
  })

  it('换扫描必须换键', () => {
    expect(keyOf({ scanId: 'scan-2' })).not.toBe(keyOf())
  })

  it('勾选变化必须换键，且顺序无关', () => {
    expect(keyOf({ selected: ['b', 'a'] })).toBe(keyOf({ selected: ['a', 'b'] }), '排序后相同')
    expect(keyOf({ selected: ['a'] })).not.toBe(keyOf())
    expect(keyOf({ selected: ['a', 'b', 'c'] })).not.toBe(keyOf())
  })

  it('tilePaths 变化必须换键', () => {
    expect(keyOf({ tiles: [] })).not.toBe(keyOf())
  })

  it('扫描状态变化必须换键（running → completed 时树上多了东西）', () => {
    expect(keyOf({ status: 'running' })).not.toBe(keyOf({ status: 'completed' }))
  })
})
