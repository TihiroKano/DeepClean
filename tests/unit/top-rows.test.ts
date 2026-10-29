import { describe, expect, it } from 'vitest'
import { toTiles } from '../../core/analyze/treemap-data'
import { topRows } from '../../core/analyze/top-rows'
import type { ChildView } from '../../shared/types'

// dirId 与 size 解耦（自增）：早期这里写的是 `dirId: size`，于是同容量的两项共享同一个 key
// `directory:50` —— 在「检查行身份」的测试里造出重复 React key，key 冲突回归反而测不出来。
// 与 tests/unit/treemap-data.test.ts 同一先例（toTiles 的 tile key 也认 dirId）。
let nextId = 1
const dir = (name: string, size: number): ChildView => ({
  kind: 'directory', name, path: `C:\\${name}`, dirId: nextId++, size, mtimeMs: 1, birthtimeMs: null, fileCount: 0, dirCount: 0, attrs: null
})
const file = (name: string, size: number): ChildView => ({
  kind: 'file', name, path: `C:\\${name}`, size, mtimeMs: 1, birthtimeMs: 1, fileCount: 0, dirCount: 0, attrs: 0
})

describe('topRows（§10 Top 大空间）', () => {
  it('按 size 降序取前 n，目录与文件同榜（规格书的例子就是 Users / Program Files / Temp 混排）', () => {
    const rows = topRows([dir('a', 10), file('b.pak', 90), dir('c', 50)], 2)
    expect(rows.map((r) => r.name)).toEqual(['b.pak', 'c'])
  })

  it('0 容量项不进榜（空目录占位没有意义，且它点不出面积）', () => {
    expect(topRows([dir('empty', 0), dir('x', 5)], 10).map((r) => r.name)).toEqual(['x'])
  })

  it('折叠项作为最后一行点名，且 kind 是 folded（没有 dirId，点它不该假装能进）', () => {
    const rows = topRows([dir('x', 5)], 10, { foldedCount: 12, foldedBytes: 40 })
    expect(rows[1]?.kind).toBe('folded')
    expect(rows[1]?.name).toBe('其它 12 项')
    expect(rows[1]?.dirId).toBeUndefined()
  })

  it('n 小于条目数时截断；n 大于时不补空行', () => {
    expect(topRows([dir('a', 1), dir('b', 2)], 10)).toHaveLength(2)
    expect(topRows([dir('a', 1), dir('b', 2)], 1)).toHaveLength(1)
  })

  // 下面两条各钉住实现里的一个守卫 —— 守卫一旦被拆，这里必须变红（Task 6 的变异验证点名要求）。

  it('foldedBytes 为 0 时不许凭空多出一行（折叠记账没字节 = 什么都没折，「其它 0 项」是谎报）', () => {
    expect(topRows([dir('x', 5)], 10, { foldedCount: 12, foldedBytes: 0 })).toHaveLength(1)
  })

  it('同容量按名字升序：与 toTiles 的排序口径逐字相同，两处榜单不许各排各的', () => {
    // V8 的 sort 是稳定的：拆掉 `|| a.name.localeCompare(b.name)` 之后输入序原样保留 → 这行变红。
    expect(topRows([dir('zeta', 50), dir('alpha', 50)], 10).map((r) => r.name)).toEqual(['alpha', 'zeta'])
  })

  it('同容量的两项 key 各不相同（榜单行的 React key / 点行定位都按它寻址）', () => {
    const rows = topRows([dir('zeta', 50), dir('alpha', 50)], 10)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  // 下面两条钉住 Task 6 评审的 Fix 2 / Fix 3 —— 判据变了就必须变红，不是复述实现。

  it('榜单的 key 必须能在同一批 children 的 tiles 里找回（点行定位的 join；两份 keyOf 一旦分叉这里就红）', () => {
    const kids = [dir('a', 10), file('b.pak', 90), dir('c', 50), dir('empty', 0)]
    const tiles = toTiles(kids, { x: 0, y: 0, w: 1000, h: 700 }, 'type')
    const rows = topRows(kids, 10)
    expect(rows).toHaveLength(3) // 0 容量项两边口径一致：都不上榜
    for (const r of rows) expect(tiles.some((t) => t.key === r.key)).toBe(true)
  })

  it('预算：最多 n 个真项 + 至多一行合计块 = n+1 行；满榜也不许把折叠行的披露挤掉', () => {
    const twelve = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((n, i) => dir(n, 100 - i))
    const rows = topRows(twelve, 10, { foldedCount: 40, foldedBytes: 7 })
    expect(rows).toHaveLength(11)
    expect(rows.filter((r) => r.kind !== 'folded')).toHaveLength(10)
    expect(rows[10]?.key).toBe('__fold__')
    // 折叠行的 key 同样 join 得上合计块（合计块一定在布局里，它带着 foldedBytes）
    const tiles = toTiles(twelve, { x: 0, y: 0, w: 1000, h: 700 }, 'type', { foldedCount: 40, foldedBytes: 7 })
    expect(tiles.some((t) => t.key === rows[10]!.key && t.folded === true)).toBe(true)
  })
})
