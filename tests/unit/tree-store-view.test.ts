import { describe, expect, it } from 'vitest'
import { TreeStore } from '../../core/scan/tree-store'
import { joinWin } from '../../core/fs/pathutil'
import { LEVEL_CAP } from '../../shared/constants'
import type { ChildView } from '../../shared/types'

/** 建一层 n 个直属文件、大小互不相同的目录，返回 dirId。 */
function fatDir(store: TreeStore, n: number): number {
  const id = store.beginDir('C:\\fat')
  const files = Array.from({ length: n }, (_, i) => ({
    name: `f${String(i).padStart(6, '0')}.bin`,
    size: n - i, // 唯一的 size，便于验证「留的是最大的那些」
    mtimeMs: 1,
    birthtimeMs: 2,
    attrs: 0
  }))
  store.addFilesToDir(id, files)
  return id
}

const totalOf = (kids: ChildView[]): number => kids.reduce((s, c) => s + c.size, 0)

describe('levelOf（§16 单层有界 + 面积守恒）', () => {
  it('超过 cap 时只回最大的 cap 项，其余折进 foldedBytes', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const id = fatDir(store, LEVEL_CAP + 500)
    const all = store.childrenOf(id)
    const page = store.levelOf(id, LEVEL_CAP)
    expect(page.children).toHaveLength(LEVEL_CAP)
    expect(page.totalChildren).toBe(all.length)
    expect(page.foldedCount).toBe(all.length - LEVEL_CAP)
    expect(totalOf(page.children) + page.foldedBytes).toBe(totalOf(all))
  })

  it('留哪 cap 项必须可复现：同一棵树连调两次，逐项同名', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const id = fatDir(store, LEVEL_CAP + 7)
    const a = store.levelOf(id, LEVEL_CAP)
    const b = store.levelOf(id, LEVEL_CAP)
    expect(a.children.map((c) => c.name)).toEqual(b.children.map((c) => c.name))
    expect(a.foldedBytes).toBe(b.foldedBytes)
  })

  it('未超 cap 时零折叠（空层与小层都不该出现"其它"块）', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const id = fatDir(store, 3)
    const page = store.levelOf(id, LEVEL_CAP)
    expect(page.foldedCount).toBe(0)
    expect(page.foldedBytes).toBe(0)
    expect(page.totalChildren).toBe(3)
  })

  it('哨兵：levelOf 收窄不会改动 childrenOf 的完整口径（计价路径共用后者）', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const n = LEVEL_CAP + 500
    const id = fatDir(store, n)
    const before = store.childrenOf(id)
    store.levelOf(id, 5)
    const after = store.childrenOf(id)
    // 绝对断言，不是「两次调用互相比」：只比 before/after 的话，把 cap 挪进 childrenOf
    // 会让两边同时变成 1200 条，用例照样绿 —— 那等于没守。规格书要的是 childrenOf 永远完整。
    expect(before).toHaveLength(n)
    expect(after).toHaveLength(n)
    expect(totalOf(after)).toBe((n * (n + 1)) / 2) // fatDir 给的 size 是 1..n
  })
})

/* ------------------------------------------------------------------ *
 * Task 7：视图排除集（地图上的「排除该目录」）。
 *
 * 一句话口径：**排除只改 `levelOf` 回给渲染端的那一份，`childrenOf` 一项不少。**
 * 后一条的承重断言在 `tests/unit/rules-engine.test.ts` 末尾那条安全哨兵里（三条计价口径），
 * 这里只测视图侧自己的行为。
 * ------------------------------------------------------------------ */

/** 在 `parentId` 下建一个直属子目录，里面放一个 `size` 字节的文件；返回新目录的 dirId。 */
function childDir(store: TreeStore, parentId: number, name: string, size: number): number {
  const id = store.beginDir(joinWin(store.pathOf(parentId), name))
  store.attachChild(parentId, id)
  if (size > 0) store.addFilesToDir(id, [{ name: 'f.bin', size, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
  return id
}

/** 根下挂 `sizes` 这几个兄弟目录（每个的容量 = 对应那个数），返回它们的 dirId（顺序同入参）。 */
function siblingsUnderRoot(sizes: number[]): { store: TreeStore; ids: number[] } {
  const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
  const ids = sizes.map((s, i) => childDir(store, store.rootId, `d${i}`, s))
  store.finalizeDir(store.rootId)
  return { store, ids }
}

describe('视图排除（Task 7：只影响这一层回给渲染端的内容）', () => {
  it('排除的目录从这一层消失，但容量点名进 excludedBytes（面积守恒仍成立）', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const root = store.rootId // 根由构造函数的 rootPath 建好，别再 beginDir 一次
    const a = store.beginDir('C:\\a')
    const b = store.beginDir('C:\\b')
    store.attachChild(root, a)
    store.attachChild(root, b)
    store.addFilesToDir(a, [{ name: 'x', size: 700, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
    store.addFilesToDir(b, [{ name: 'y', size: 300, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
    store.finalizeDir(root)
    store.setViewExcluded(a, true)
    const page = store.levelOf(root, 1200, new Set([a]))
    expect(page.children.map((c) => c.name)).toEqual(['b'])
    expect(page.excludedCount).toBe(1)
    expect(page.excludedBytes).toBe(700)
    const all = store.childrenOf(root)
    expect(all).toHaveLength(2) // 完整口径不受视图排除影响
    // 守恒：Σchildren + foldedBytes + excludedBytes == ΣchildrenOf（被藏掉的容量有名有姓，没并进任何真块）
    expect(totalOf(page.children) + page.foldedBytes + page.excludedBytes).toBe(totalOf(all))
  })

  it('诚实的面积：排除不改任何大小 —— 父级 size 仍是完整子树合计', () => {
    const { store, ids } = siblingsUnderRoot([500, 400, 300])
    const [a] = ids
    expect(store.sizeOf(store.rootId)).toBe(1200)
    store.setViewExcluded(a!, true)
    expect(store.sizeOf(store.rootId)).toBe(1200)
    expect(store.sizeOf(a!)).toBe(500)
    // 未采样的父级大小（payload.size）与 childrenOf 的清单都不因排除而变
    expect(store.childrenOf(store.rootId).map((c) => c.size)).toEqual([500, 400, 300])
  })

  it('排除集是**这一层**的事：深层目录被排除不会让它的祖父少一项', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const outer = childDir(store, store.rootId, 'outer', 0)
    const inner = childDir(store, outer, 'inner', 900)
    store.finalizeDir(store.rootId)
    store.setViewExcluded(inner, true)
    // 祖父（根）这一层看不见 inner，自然一项都不少
    expect(store.levelOf(store.rootId, 10, new Set([inner])).children.map((c) => c.name)).toEqual(['outer'])
    expect(store.levelOf(store.rootId, 10, new Set([inner])).excludedCount).toBe(0)
    // 父（outer）那一层才真的少一项
    const page = store.levelOf(outer, 10, new Set([inner]))
    expect(page.children).toHaveLength(0)
    expect([page.excludedCount, page.excludedBytes]).toEqual([1, 900])
  })

  it('排除与折叠同时存在时三份账要闭合：children + folded + excluded == totalChildren', () => {
    const { store, ids } = siblingsUnderRoot([500, 400, 300, 200, 100])
    store.setViewExcluded(ids[1]!, true)
    const all = store.childrenOf(store.rootId)
    const page = store.levelOf(store.rootId, 2, new Set([ids[1]!]))
    expect(page.children.map((c) => c.size)).toEqual([500, 300]) // 留下的仍是最大的 cap 项
    expect(page.totalChildren).toBe(5)
    expect(page.foldedCount).toBe(2)
    expect(page.foldedBytes).toBe(300)
    expect(page.excludedCount).toBe(1)
    expect(page.excludedBytes).toBe(400)
    expect(page.children.length + page.foldedCount + page.excludedCount).toBe(page.totalChildren)
    expect(totalOf(page.children) + page.foldedBytes + page.excludedBytes).toBe(totalOf(all))
  })

  it('没有排除时这两项是 0（UI 拿 0 当"没有这一栏"，不许印出来冒充算过）', () => {
    const { store } = siblingsUnderRoot([500, 400])
    const page = store.levelOf(store.rootId, 10)
    expect([page.excludedCount, page.excludedBytes]).toEqual([0, 0])
    // 传了空集与不传参等价：默认那个集合不许是"全排除"或任何别的隐式状态
    expect(store.levelOf(store.rootId, 10, new Set()).children).toHaveLength(2)
  })

  it('根目录不许被排除（排除根等于看空图）：canExclude 先拒，store 自己也不落集', () => {
    const { store } = siblingsUnderRoot([500, 400])
    expect(store.canExclude(store.rootId)).toBe(false)
    store.setViewExcluded(store.rootId, true)
    expect(store.excludedIds()).toEqual([])
    const page = store.levelOf(store.rootId, 10, new Set(store.excludedIds()))
    expect(page.children).toHaveLength(2)
    expect(page.excludedCount).toBe(0)
  })

  it('只有真实存在的目录可被排除：未知 id 与文件都不落集；重复排除不重复计数', () => {
    const { store, ids } = siblingsUnderRoot([500, 400])
    expect(store.canExclude(987_654)).toBe(false)
    store.setViewExcluded(987_654, true)
    store.setViewExcluded(ids[0]!, true)
    store.setViewExcluded(ids[0]!, true) // 幂等：同一目录排除两次仍是一个
    expect(store.excludedIds()).toEqual([ids[0]!])
    const page = store.levelOf(store.rootId, 10, new Set(store.excludedIds()))
    expect([page.excludedCount, page.excludedBytes]).toEqual([1, 500])
    // 取消排除 = 它回来（地图上的这一层与 childrenOf 重新一致）
    store.setViewExcluded(ids[0]!, false)
    expect(store.excludedIds()).toEqual([])
    expect(store.levelOf(store.rootId, 10, new Set()).children).toHaveLength(2)
  })

  it('clearViewExclusions() 一次清空；excludedIds() 升序可复现', () => {
    const { store, ids } = siblingsUnderRoot([100, 500, 300, 400, 200])
    for (const id of [ids[4]!, ids[0]!, ids[3]!]) store.setViewExcluded(id, true)
    // 升序（而不是插入序）：这份清单要进 Set、也要能被日志逐字对账
    expect(store.excludedIds()).toEqual([...[ids[0]!, ids[3]!, ids[4]!]].sort((a, b) => a - b))
    store.clearViewExclusions()
    expect(store.excludedIds()).toEqual([])
    expect(store.levelOf(store.rootId, 10).children).toHaveLength(5)
  })

  it('视图排除不许改 childrenOf（与计价哨兵同一件事的 store 侧绝对断言）', () => {
    const { store, ids } = siblingsUnderRoot([500, 400, 300])
    const before = store.childrenOf(store.rootId)
    store.setViewExcluded(ids[0]!, true)
    store.levelOf(store.rootId, 1, new Set(store.excludedIds()))
    const after = store.childrenOf(store.rootId)
    expect(after).toHaveLength(3)
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name))
    expect(totalOf(after)).toBe(1200)
  })
})

/* ------------------------------------------------------------------ *
 * Task 10b：层级页的**有界选择**必须与「全量 ChildView + 排序」逐字节同解。
 *
 * 触发这条的是实测：1M 夹具那一层 300,000 个直属项，`levelOf` 325.7 ms（阈值 30 ms），
 * 其中 97% 是 `childrenOf` 为挑出 1,200 项而造的 30 万个 `ChildView` + 全量排序。
 * 快路径（原始记录上先选前 K、只为胜出者造视图）省的是时间，
 * **代价一分钱都不许付在结果上**：留哪 1,200 项、它们的顺序、四份账必须一模一样。
 *
 * 为什么这里的参照实现是「把旧代码再抄一遍」而不是「断言几个名字」：
 * 契约不是"某个手挑的正确答案"，而是**与改动前可观察的行为完全一致**（同一总序的同一前缀）。
 * 所以独立事实源就是 Task 10b 之前的 `levelOf` 本体，逐字抄在下面；
 * 快路径与它比的是**逐字节**（`JSON.stringify`），不只比结构 —— 载荷要走 IPC，键序与数字的文本形态也是契约的一部分。
 *
 * 但"两个实现互比"有一条藏得住的失效形状：若两条路径**都**按码点序（`<`）比名字，
 * 等价用例照样绿，而真盘上的排序结果与 `childrenOf`（`localeCompare`）在别的机器/别的语言下会分叉。
 * 所以除了互比，这里还单独钉了 locale 口径那一条（见「name 的比较口径」用例）。
 * ------------------------------------------------------------------ */

/** 参照实现 = Task 10b **之前**的 `levelOf` 本体，一字不改地抄在这里当独立事实源。 */
function levelOfFullScanPath(
  store: TreeStore,
  dirId: number,
  cap: number,
  excluded: ReadonlySet<number> = new Set()
): {
  children: ChildView[]
  totalChildren: number
  foldedCount: number
  foldedBytes: number
  excludedCount: number
  excludedBytes: number
} {
  const all = store.childrenOf(dirId) // 已按 size 降序、同 size 按 name 升序
  const cutExcluded = (c: ChildView): boolean =>
    !(c.kind === 'directory' && c.dirId !== undefined && excluded.has(c.dirId))
  const kept = excluded.size === 0 ? all : all.filter(cutExcluded)
  const cut = cap >= 0 && kept.length > cap ? cap : kept.length
  const rest = kept.slice(cut)
  const gone = all.length - kept.length
  return {
    children: kept.slice(0, cut),
    totalChildren: all.length,
    foldedCount: rest.length,
    foldedBytes: rest.reduce((s, c) => s + c.size, 0),
    excludedCount: gone,
    excludedBytes: gone === 0 ? 0 : all.reduce((s, c) => (cutExcluded(c) ? s : s + c.size), 0)
  }
}

/** 快路径与参照实现必须**逐字节**同解：结构等价 + JSON 文本等价（键序也算）。 */
function expectPageIdentical(store: TreeStore, dirId: number, cap: number, excluded: ReadonlySet<number> = new Set()): void {
  const fast = store.levelOf(dirId, cap, excluded)
  const slow = levelOfFullScanPath(store, dirId, cap, excluded)
  expect(fast).toEqual(slow)
  expect(JSON.stringify(fast)).toBe(JSON.stringify(slow))
}

/**
 * 造一层：`dirSizes` 个直属子目录（名 d0/d1…，容量=size）+ `fileSpecs` 个直属文件。
 * 目录先、文件后 —— 这条枚举序就是 `childrenOf` 的稳定序基准，同 size 且同名时胜出者由它决定。
 */
function buildLevel(dirSizes: number[], fileSpecs: Array<[name: string, size: number]>): { store: TreeStore; id: number } {
  return buildNamedLevel(
    dirSizes.map((s, i) => [`d${i}`, s]),
    fileSpecs
  )
}

/** 名字可控版：让目录与文件重名（= 同 size 且同名的**可观察**等价类：目录带 dirId、文件带 attrs）。 */
function buildNamedLevel(
  dirs: Array<[name: string, size: number]>,
  files: Array<[name: string, size: number]>
): { store: TreeStore; id: number } {
  const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
  const id = store.beginDir('C:\\level')
  store.attachChild(store.rootId, id)
  for (const [name, size] of dirs) childDir(store, id, name, size)
  if (files.length > 0)
    store.addFilesToDir(
      id,
      files.map(([name, size]) => ({ name, size, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }))
    )
  store.finalizeDir(store.rootId)
  return { store, id }
}

/** 各种 cap（含 0 / 负数 = 不封顶 / 恰好等于层宽 / 超过层宽）的等价矩阵。 */
const CAP_MATRIX = [-1, 0, 1, 2, 3, 5, 7, 11, 13, LEVEL_CAP - 1, LEVEL_CAP, LEVEL_CAP + 1, 3000, 9999]

describe('levelOf 有界选择 = 全量排序（Task 10b 等价性）', () => {
  it('哨兵：levelOf 走原始记录快路径，一次都不退回 childrenOf', () => {
    // 分配断言而非计时断言：计时在 CI 上会因机器抖动假绿/假红，"有没有为整层造 ChildView"才是可复现的那一条。
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const id = fatDir(store, 20_000)
    let built = 0
    const spy = store.childrenOf.bind(store)
    store.childrenOf = (d: number) => {
      built++
      return spy(d)
    }
    const page = store.levelOf(id, 100)
    expect(page.children).toHaveLength(100)
    expect(built).toBe(0) // 走的是原始记录快路径，不该退回完整口径
    // 快路径不许以"少几项"为代价：这一层的账照样得闭合
    expect(page.totalChildren).toBe(20_000)
    expect(page.foldedCount).toBe(19_900)
    expect(page.children.map((c) => c.size)).toEqual(Array.from({ length: 100 }, (_, i) => 20_000 - i))
  })

  it('边界同分：cap 恰好切在一档同 size 的中间，留哪几项必须与全量排序一致', () => {
    // 900 个更大的目录（9000..9899）把名额用到 900，剩下 300 个名额要在 400 个**同 size** 的文件里挑 →
    // 第 1,200/1,201 名之间就是"同 size 同名不同"的分界线，阈值法最容易在这里悄悄多留/少留一个。
    //
    // 名字**故意打乱入树**（slot×137 mod 400，137 与 400 互素 ⟹ 双射）：若名字序恰好等于枚举序，
    // "取枚举序的前 need 个"与"取名字最靠前的 need 个"给出同一批答案，这条用例就抓不到
    // "边界档没比名字"那条 mutation（第一版就是这么漏的 —— 见 task-10b-report §4 的 M1）。
    const { store, id } = buildLevel(
      Array.from({ length: 900 }, (_, i) => 9_000 + i),
      Array.from({ length: 400 }, (_, slot) => [`t${String((slot * 137) % 400).padStart(4, '0')}`, 5_000])
    )
    const page = store.levelOf(id, LEVEL_CAP)
    expect(page.children).toHaveLength(LEVEL_CAP)
    // 前 900 名是全目录（size 9000..9899），后 300 名必须是同分档里名字最靠前的 300 个
    expect(page.children.slice(0, 900).map((c) => c.kind)).toEqual(Array.from({ length: 900 }, () => 'directory'))
    expect(page.children.slice(900).map((c) => c.name)).toEqual(
      Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(4, '0')}`)
    )
    expect(page.children.at(-1)?.name).toBe('t0299')
    expect(page.foldedCount).toBe(100)
    expect(page.foldedBytes).toBe(100 * 5_000)
    for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap)
  })

  it('1M 夹具同分布（size = 1 + i%7，每档 ~428 项同分）：cap=1200 切在第 3 档中间', () => {
    // 夹具里 30 万直属项只有 997 个不同 size → 每一档约 300 项同分。这里取同样的"一档几百项同分"形状
    // 并把档数压到 7，让 cap=1200 的切点落在 size=5 那一档的**正中**（428 项里只留 344）：
    // 同一条边界在单位用例里就能判红绿，不必等 13 分钟的基准。
    // 入树顺序同样打乱（slot×137 mod 3000 是双射）：名字里编的就是 i，所以"该留哪 344 个"的期望值不变，
    // 但"按枚举序前 344 个"从此给出另一批答案 —— 这条才是 M1 的抓网。
    const { store, id } = buildLevel(
      [],
      Array.from({ length: 3_000 }, (_, slot) => {
        const i = (slot * 137) % 3_000
        return [`k${String(i).padStart(7, '0')}.bin`, 1 + (i % 7)] as [string, number]
      })
    )
    const page = store.levelOf(id, LEVEL_CAP)
    expect(page.children).toHaveLength(LEVEL_CAP)
    // size 7/6/5 各 428 项：前 856 名是 7 与 6，第 857..1200 名是 size=5 档里名字最靠前的 344 个
    expect(page.children[855]?.size).toBe(6)
    expect(page.children[856]?.size).toBe(5)
    expect(page.children[1199]?.size).toBe(5)
    expect(page.children[1199]?.name).toBe(`k${String(4 + 7 * 343).padStart(7, '0')}.bin`) // k0002405.bin
    expect(page.children[856]?.name).toBe('k0000004.bin')
    expect(page.foldedCount).toBe(3_000 - LEVEL_CAP)
    // 折叠算术：整层 = 428×(7+6+5) + 429×(4+3+2+1) = 11,994；留下 = 428×7 + 428×6 + 344×5 = 7,284
    expect(page.foldedBytes).toBe(11_994 - 7_284)
    for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap)
  })

  it('name 的比较口径必须是 localeCompare，不是码点序（否则两条路径各排一套）', () => {
    // 全层同 size = 1,200 整层都是边界档：这一刻名字口径就是唯一口径。
    // 本机 localeCompare（zh 默认排序）把 `_a.bin` 排在 `-a.bin` 前，而码点序把 `-a.bin` 排最前、
    // 并把大写整段插到 `_` 之前 —— 两种口径留下的 6 个名字**完全不同**。
    const tricky: Array<[string, number]> = [
      ['-a.bin', 4],
      ['_a.bin', 4],
      ['.hidden', 4],
      ['1.bin', 4],
      ['A.bin', 4],
      ['a.bin', 4],
      ['B.bin', 4],
      ['b.bin', 4],
      ['Z.bin', 4],
      ['z.bin', 4],
      ['ü.bin', 4],
      ['u.bin', 4],
      ['á.bin', 4]
    ]
    const { store, id } = buildLevel([], tricky)
    const page = store.levelOf(id, 6)
    const byLocale = page.children.map((c) => c.name)
    expect(byLocale).toEqual([...tricky.map(([n]) => n)].sort((a, b) => a.localeCompare(b)).slice(0, 6))
    // 反向断言：码点序给的是另一批名字。快路径若改用 `<`，上面两条就会同时成立不了，而"与 childrenOf 互比"的
    // 等价用例在两条路径都改成 `<` 时会一起绿掉 —— 这一条才是那条 mutation 的真哨兵。
    const byCodePoint = [...tricky.map(([n]) => n)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 6)
    expect(byCodePoint).not.toEqual(byLocale)
    for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap)
  })

  it('同 size 且同名（comparator 相等）：胜出的是先枚举的那一个 = 稳定排序的前缀', () => {
    // Array#sort 稳定 ⇒ childrenOf 里 comparator 相等的两项按枚举序排列。目录 d0 与文件 d0 同 size 同名，
    // 就是这个等价类里**可观察**的一对（目录带 dirId/scanning、文件带 attrs，两者视图不同）。
    // 快路径的下标兜底必须落在同一个枚举序上，否则留的是文件、或整对顺序反过来。
    const { store, id } = buildLevel([7, 7, 3], [
      ['d0', 7],
      ['same', 7],
      ['same', 7],
      ['same', 7],
      ['other', 1]
    ])
    const d0s = store.childrenOf(id).filter((c) => c.name === 'd0')
    expect(d0s.map((c) => c.kind)).toEqual(['directory', 'file']) // 同名同 size，谁在前由枚举序决定
    for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap)
    // 逐字节：目录项带 dirId、文件项带 attrs，交错时键序也不许变
    const page = store.levelOf(id, 4)
    expect(page.children.map((c) => [c.kind, c.name])).toEqual([
      ['directory', 'd0'],
      ['file', 'd0'],
      ['directory', 'd1'],
      ['file', 'same']
    ])
    expect(JSON.stringify(page)).toBe(JSON.stringify(levelOfFullScanPath(store, id, 4)))
  })

  it('排除集与折叠同时在场：任何 cap、任何排除组合都与参照实现同解', () => {
    const { store, id } = buildLevel(
      [9_000, 8_000, 5_000, 5_000, 5_000, 4_000, 1],
      [['a', 5_000], ['b', 5_000], ['c', 5_000], ['d', 9_000], ['e', 0], ['f', 0]]
    )
    const dirs = store.childrenOf(id).filter((c) => c.kind === 'directory')
    const ids = dirs.map((c) => c.dirId!)
    const sets: Array<ReadonlySet<number>> = [
      new Set(),
      new Set([ids[0]!]), // 最大的那个
      new Set([ids[2]!, ids[3]!, ids[4]!]), // 整档同分的全排掉 → 边界换到另一档
      new Set(ids), // 全排除 = 空层
      new Set([ids[6]!, 987_654]) // 含 0 容量与不在本层的 id
    ]
    for (const ex of sets) {
      for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap, ex)
    }
  })

  it('空层 / 只有一项 / 不存在的 dirId：快路径的零值形状不许与参照实现不同', () => {
    const { store, id } = buildLevel([], [])
    const empty = store.levelOf(id, LEVEL_CAP)
    expect(empty).toEqual(levelOfFullScanPath(store, id, LEVEL_CAP))
    expect(JSON.stringify(empty)).toBe(JSON.stringify(levelOfFullScanPath(store, id, LEVEL_CAP)))
    const missing = store.levelOf(987_654, LEVEL_CAP)
    expect(missing).toEqual(levelOfFullScanPath(store, 987_654, LEVEL_CAP))
    for (const cap of CAP_MATRIX) expectPageIdentical(store, id, cap)
    const one = buildLevel([42], [])
    for (const cap of CAP_MATRIX) expectPageIdentical(one.store, one.id, cap)
  })

  it('同一层连调两次、以及中途改排除集后重调：结果必须可复现（工作区复用不许带出上一次的残渣）', () => {
    const { store, id } = buildLevel(
      Array.from({ length: 2_500 }, (_, i) => 1 + (i % 97)),
      Array.from({ length: 2_500 }, (_, i) => [`x${String(i).padStart(5, '0')}`, 1 + (i % 89)])
    )
    const a = JSON.stringify(store.levelOf(id, LEVEL_CAP))
    store.levelOf(id, 3) // 中间插一次不同 cap 的调用
    store.levelOf(id, 7, new Set([id]))
    expect(JSON.stringify(store.levelOf(id, LEVEL_CAP))).toBe(a)
    expectPageIdentical(store, id, LEVEL_CAP)
    const ex = new Set(store.childrenOf(id).slice(0, 50).map((c) => c.dirId ?? -1))
    expectPageIdentical(store, id, LEVEL_CAP, ex)
    expectPageIdentical(store, id, 11, ex)
  })

  it('随机差分（固定种子 400 层）：任意形状 × 任意 cap × 任意排除集，逐字节同解且三份账闭合', () => {
    // 上面每条用例都只钉一种形状；这一条的作用是把"人想不到的形状"扫一遍。
    // 种子写死：任何一次变红都必须能原地逐字复现，不许"我这跑得好好的"。
    let s = 20260927
    const rand = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const randInt = (n: number): number => Math.floor(rand() * n)
    for (let iter = 0; iter < 400; iter++) {
      const classes = 1 + randInt(5)
      // size 档数 1..5 而层宽可到 ~50 ⟹ 大量同分；名字从极小的池子里抽 ⟹ 同 size 且同名也常被抽到。
      // 池子里刻意混了大小写与带音标的名字：只有它们能抓到"边界档改用码点序"这条 mutation
      // （'B' 与 'a' 在 localeCompare 与 `<` 下的先后是反的，纯 ASCII 小写名则两种口径同解）。
      const dirs = Array.from({ length: randInt(25) }, (_, i) => [
        randInt(4) === 0 ? 'shared' : randInt(8) === 0 ? 'B' : `d${i}`,
        1 + randInt(classes)
      ] as [string, number])
      const files = Array.from({ length: randInt(25) }, () => [
        randInt(4) === 0 ? 'shared' : randInt(8) === 0 ? 'b' : `f${randInt(3)}`,
        1 + randInt(classes)
      ] as [string, number])
      const { store, id } = buildNamedLevel(dirs, files)
      const all = store.childrenOf(id)
      const dirIds = all.filter((c) => c.kind === 'directory').map((c) => c.dirId!)
      const ex = new Set(dirIds.filter(() => rand() < 0.3))
      const cap = randInt(24) - 2 // 覆盖 -1（不封顶）/ 0 / 正常 / 大于层宽
      expectPageIdentical(store, id, cap, ex)
      // Task 1 / Task 7 那两条守恒等式在随机形状上也必须成立（参照实现只是旧行为，不是又一份权威）
      const page = store.levelOf(id, cap, ex)
      expect(page.children.length + page.foldedCount + page.excludedCount).toBe(page.totalChildren)
      expect(page.children.reduce((sum, c) => sum + c.size, 0) + page.foldedBytes + page.excludedBytes).toBe(
        all.reduce((sum, c) => sum + c.size, 0)
      )
    }
  })
})

/* ------------------------------------------------------------------ *
 * Task 7 修订 Fix 2：**本轮累计**的排除记账（跨层那一份，`excludedTotals()`）。
 *
 * 上面那一段的口径一个字都没改：`levelOf` 的 `excludedCount / excludedBytes` 仍是"这一层直属子项"
 * 那一份（守恒等式与截图判据都靠它）。这里钉的是另一件事 —— 侧栏那句「已排除 N 个目录」与
 * 「清除全部排除」这个唯一撤销入口挂的必须是**跨层**那份，否则「在 `C:\b` 里排除一个目录 → 退回根」
 * 之后地图上看不见这一轮挂着过滤器，而撤销入口还在刚离开的那一层。
 * ------------------------------------------------------------------ */
describe('本轮累计的排除记账 excludedTotals()（Task 7 修订 Fix 2）', () => {
  it('深层排除：本层那份在祖父层是 0，本轮累计那份仍是 1（横幅与撤销入口因此不随层级消失）', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const outer = childDir(store, store.rootId, 'outer', 100)
    const inner = childDir(store, outer, 'inner', 900)
    store.finalizeDir(store.rootId)
    store.setViewExcluded(inner, true)
    const ex = new Set(store.excludedIds())
    // 对照：本层那份按构造只数直属子项 —— 祖父那一层看不见 inner，自然 0（这条一字未改）
    expect(store.levelOf(store.rootId, 10, ex).excludedCount).toBe(0)
    expect(store.levelOf(outer, 10, ex).excludedCount).toBe(1)
    // 而"这一轮一共藏了几块、少了多少"在任何一层问都是同一个答案，且走 sizeOf 权威口径
    expect(store.excludedTotals()).toEqual({ count: 1, bytes: 900 })
  })

  it('跨层各排一块：本轮那份是两者的和，两份口径同时在场且互不替换', () => {
    const { store, ids } = siblingsUnderRoot([500, 400, 300])
    const deep = childDir(store, ids[2]!, 'deep', 100) // d2 里面再挂一层
    store.finalizeDir(store.rootId)
    store.setViewExcluded(ids[0]!, true) // 根这一层的直属子项
    store.setViewExcluded(deep, true) // 另一层的直属子项
    expect(store.excludedTotals()).toEqual({ count: 2, bytes: 600 })
    // 本层那份仍是各层自己的账（600 这个数在**任何单独一层**都算不出来 —— 两份口径没被互相覆盖）
    const ex = new Set(store.excludedIds())
    expect(store.levelOf(store.rootId, 10, ex).excludedBytes).toBe(500)
    expect(store.levelOf(ids[2]!, 10, ex).excludedBytes).toBe(100)
  })

  it('嵌套排除不许把同一块面积数两次：祖先整块藏掉时子级不再额外少一块', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 5_000_000, topN: 10 })
    const outer = childDir(store, store.rootId, 'outer', 100)
    const inner = childDir(store, outer, 'inner', 900)
    const other = childDir(store, store.rootId, 'other', 50)
    store.finalizeDir(store.rootId)
    expect(store.sizeOf(outer)).toBe(1000) // 完整子树合计：outer 自己 100 + inner 900
    store.setViewExcluded(outer, true)
    store.setViewExcluded(inner, true)
    // outer 已经把整棵子树（含 inner 那 900）从根那一层拿走了；再数 inner 就报出
    // "比地图真实少掉的更多"的容量 —— 这一句的失效形状与静默蒸发同样糟。
    expect(store.excludedTotals()).toEqual({ count: 1, bytes: 1000 })
    // 兄弟不受牵连：被吞的只有"祖先也在集合里"的那一个
    store.setViewExcluded(other, true)
    expect(store.excludedTotals()).toEqual({ count: 2, bytes: 1050 })
    // 倒过来只排子级：outer 那一层还在图上，藏掉的就只有 inner 那 900
    store.clearViewExclusions()
    store.setViewExcluded(inner, true)
    expect(store.excludedTotals()).toEqual({ count: 1, bytes: 900 })
  })

  it('没有排除时回 0 且不新造对象（`children()` 每 400ms 被轮一次）；清空后立刻归零', () => {
    const { store, ids } = siblingsUnderRoot([500, 400])
    expect(store.excludedTotals()).toEqual({ count: 0, bytes: 0 })
    expect(store.excludedTotals()).toBe(store.excludedTotals()) // 同一个常量对象（冻结过）
    store.setViewExcluded(ids[0]!, true)
    expect(store.excludedTotals()).toEqual({ count: 1, bytes: 500 })
    store.setViewExcluded(ids[0]!, false) // 撤销那一个 = 记账当场减掉
    expect(store.excludedTotals()).toEqual({ count: 0, bytes: 0 })
    store.setViewExcluded(ids[1]!, true)
    store.clearViewExclusions()
    expect(store.excludedTotals()).toEqual({ count: 0, bytes: 0 })
  })

  it('它只是读者：excludedTotals() 不改 childrenOf / sizeOf / levelOf 的任何数字', () => {
    const { store, ids } = siblingsUnderRoot([500, 400, 300])
    store.setViewExcluded(ids[0]!, true)
    const before = { root: store.sizeOf(store.rootId), first: store.sizeOf(ids[0]!), all: store.childrenOf(store.rootId).length }
    expect(store.excludedTotals()).toEqual({ count: 1, bytes: 500 })
    expect(store.sizeOf(store.rootId)).toBe(before.root) // 1200：容量没被扣，面积诚实那条不动
    expect(store.sizeOf(ids[0]!)).toBe(before.first)
    expect(store.childrenOf(store.rootId)).toHaveLength(before.all)
    expect(store.levelOf(store.rootId, 10, new Set(store.excludedIds())).excludedBytes).toBe(500)
  })
})
