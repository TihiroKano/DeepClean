import { describe, expect, it } from 'vitest'
import { summarizeGroups } from '../../shared/group-summary'
import { WIN_ATTR } from '../../shared/classify'
import type { ChildView } from '../../shared/types'

/**
 * 夹具按真实线格式造：目录 attrs / birthtimeMs 恒为 null（本轮不 stat 目录，见 ChildView.attrs 的注释），
 * 文件带 attrs、没有 dirId。dirId 自增而不是复用 size —— 与 tests/unit/top-rows.test.ts 同一先例。
 */
const GB = 1024 ** 3
let nextId = 1
const base = (p: string): string => p.slice(p.lastIndexOf('\\') + 1)
const dir = (path: string, size: number): ChildView => ({
  kind: 'directory', name: base(path), path, dirId: nextId++, size, mtimeMs: 1,
  fileCount: 0, dirCount: 0, attrs: null, birthtimeMs: null
})
const file = (path: string, size: number, attrs: number | null = 0): ChildView => ({
  kind: 'file', name: base(path), path, size, mtimeMs: 1,
  fileCount: 0, dirCount: 0, attrs, birthtimeMs: 1
})

interface Bucketish {
  group: string
  bytes: number
  items: number
}
const bytesOf = (s: { buckets: Bucketish[] }): number => s.buckets.reduce((sum, b) => sum + b.bytes, 0)
const bucketOf = (group: string, s: { buckets: Bucketish[] }): Bucketish | undefined =>
  s.buckets.find((b) => b.group === group)

describe('summarizeGroups（首页「空间概览」的档位账）', () => {
  it('混合根：系统 / 应用 / 用户 三个目录各归各档，文件另开一档，各档字节就是自己那一项', () => {
    const kids = [
      dir('C:\\Windows', 12 * GB),
      dir('C:\\Program Files', 8 * GB),
      dir('C:\\Users', 5 * GB),
      file('C:\\Users\\Kano\\Videos\\clip.mp4', 2 * GB)
    ]
    const s = summarizeGroups(kids, 0, 0, 27 * GB)
    expect(bucketOf('system', s)?.bytes).toBe(12 * GB)
    expect(bucketOf('app', s)?.bytes).toBe(8 * GB)
    // 那个 .mp4 明明在 Users 下也必须被扩展名规则先抢走：user 档 5 GB、video 档 2 GB。
    // 并进 user 之后「用户文件」那一行报的大小是错的、报的性质也是错的。
    expect(bucketOf('user', s)?.bytes).toBe(5 * GB)
    expect(bucketOf('video', s)?.bytes).toBe(2 * GB)
    expect(bytesOf(s)).toBe(27 * GB)
    expect(s.buckets).toHaveLength(4)
    // 对账恒等式（卡片敢印百分比就靠这一条）：四段加起来一个字节不多、一个字节不少
    expect(bytesOf(s) + s.foldedBytes + s.excludedBytes + s.unaccountedBytes).toBe(s.rootBytes)
  })

  it('文件 attrs 证明出 SYSTEM 时收紧成 system 档（目录 attrs 恒 null，这条只有文件测得到）', () => {
    const s = summarizeGroups(
      [file('C:\\Users\\Kano\\Desktop\\notes.txt', 9 * GB, WIN_ATTR.system | WIN_ATTR.hidden), dir('C:\\Windows', 1)],
      0, 0,
      10 * GB
    )
    // 路径本该判成 document（§28 原则二：属性只收紧、不放松路径判据）。实现里一旦把 attrs 丢掉，这行就红。
    expect(bucketOf('document', s)).toBeUndefined()
    expect(bucketOf('system', s)?.bytes).toBe(9 * GB + 1)
    expect(bucketOf('system', s)?.items).toBe(2)
  })

  it('降序排列；bytes 为 0 的档整档不上榜（连带它的项数也看不见）', () => {
    const s = summarizeGroups(
      [
        dir('C:\\Users', 3 * GB),
        dir('C:\\Windows', 9 * GB),
        dir('C:\\Program Files', 5 * GB),
        file('C:\\Downloads\\empty.zip', 0)
      ],
      0, 0,
      20 * GB
    )
    expect(s.buckets.map((b) => b.bytes)).toEqual([9 * GB, 5 * GB, 3 * GB])
    expect(s.buckets.every((b) => b.bytes > 0)).toBe(true)
    // archive 档只有这一个 0 字节的 zip → 不上榜：这张卡报的是「这一档占了多少空间」，不是「盘上有几项」
    expect(bucketOf('archive', s)).toBeUndefined()
    expect(bucketOf('user', s)?.bytes).toBe(3 * GB)
  })

  it('同容量按档位键字典序收尾：不跟着 children 的来序走（拆掉 tiebreak 这行就红）', () => {
    const a = summarizeGroups([dir('C:\\Windows', 4 * GB), dir('C:\\Program Files', 4 * GB)], 0, 0, 8 * GB)
    const b = summarizeGroups([dir('C:\\Program Files', 4 * GB), dir('C:\\Windows', 4 * GB)], 0, 0, 8 * GB)
    expect(a.buckets.map((x) => x.group)).toEqual(['app', 'system'])
    expect(b.buckets.map((x) => x.group)).toEqual(['app', 'system'])
  })

  it('items 数的是归进这一档的子项个数（文件与目录都算，0 字节那几项也算）', () => {
    const s = summarizeGroups(
      [dir('C:\\Users\\Kano\\Documents', 6 * GB), dir('C:\\Users\\Kano\\Empty', 0), file('C:\\Users\\Kano\\.bashrc', 1)],
      0, 0,
      7 * GB
    )
    expect(bucketOf('user', s)?.items).toBe(3)
    expect(bucketOf('user', s)?.bytes).toBe(6 * GB + 1)
  })

  // ↓↓ 本文件最要紧的一条：maxFiles 截断吃掉的那段容量必须原样点名。
  it('残差：rootBytes 大于 Σchildren + folded + excluded 时，差额进 unaccountedBytes，一字节都不许并进任何档', () => {
    const kids = [dir('C:\\Windows', 200), dir('C:\\Program Files', 100)]
    const s = summarizeGroups(kids, 50, 30, 1000)
    expect(s.unaccountedBytes).toBe(1000 - 300 - 50 - 30)
    // 「并进最大档」（卡片看着刚好 100%）与「按比例摊平各档」（每档都虚胖）都必须被这两行拦住
    expect(bytesOf(s)).toBe(300)
    expect(bucketOf('system', s)?.bytes).toBe(200)
    expect(bucketOf('app', s)?.bytes).toBe(100)
    expect(s.foldedBytes).toBe(50)
    expect(s.excludedBytes).toBe(30)
    expect(s.rootBytes).toBe(1000)
    expect(s.coveredRatio).toBe(0.3)
    // 截断形状最坏的那种：折叠与排除都是 0，缺口 100% 来自 maxFiles —— 残差照样点名
    const trunc = summarizeGroups([dir('C:\\Windows', 40)], 0, 0, 900)
    expect(trunc.unaccountedBytes).toBe(860)
    expect(trunc.coveredRatio).toBe(40 / 900)
    expect(bytesOf(trunc)).toBe(40)
  })

  it('coveredRatio：rootBytes 为 0 给 0（不是 NaN / Infinity），全部容量都归得了档时给 1', () => {
    const zero = summarizeGroups([dir('C:\\Windows', 100)], 0, 0, 0)
    expect(zero.coveredRatio).toBe(0)
    expect(Number.isFinite(zero.coveredRatio)).toBe(true)
    expect(Number.isFinite(zero.unaccountedBytes)).toBe(true)

    const full = summarizeGroups([dir('C:\\Windows', 100), dir('C:\\Users', 300)], 0, 0, 400)
    expect(full.coveredRatio).toBe(1)
    expect(full.unaccountedBytes).toBe(0)

    // 折叠那 150 B「在账上但归不了档」：残差是 0，coveredRatio 却只有 1/3 —— 两个字段各说各的事，
    // 谁也不许替对方补位（拿 1 − coveredRatio 去造一个档位就是把这句话印成谎）。
    const folded = summarizeGroups([dir('C:\\Windows', 300)], 150, 0, 450)
    expect(folded.unaccountedBytes).toBe(0)
    expect(folded.coveredRatio).toBe(300 / 450)
  })

  it('空 children：buckets 为 []，残差就是 rootBytes 减掉 foldedBytes 与 excludedBytes', () => {
    const s = summarizeGroups([], 120, 30, 500)
    expect(s.buckets).toEqual([])
    expect(s.unaccountedBytes).toBe(500 - 120 - 30)
    expect(s.coveredRatio).toBe(0)
    expect(s.rootBytes).toBe(500)
  })

  it('foldedBytes + excludedBytes 超过 rootBytes：不产 NaN，残差夹到 0，coveredRatio 不越 1，三个账照原样点名', () => {
    const kids = [dir('C:\\Windows', 100)]
    const s = summarizeGroups(kids, 400, 300, 500)
    for (const v of [s.unaccountedBytes, s.coveredRatio]) expect(Number.isFinite(v)).toBe(true)
    // 夹到 0 而不是 −300：负的「未计入字节」印不出，还会被读成「还有一块正向的账没算」，比 0 更误导
    expect(s.unaccountedBytes).toBe(0)
    // 夹到 1 而不是让它冒出去：超 1 的百分比没有对应的物理事实，画出来只会是一根冲出边框的条
    expect(s.coveredRatio).toBeLessThanOrEqual(1)
    // 但透传的三个数一个都不改写：那是上游给的账，这里没资格替它圆场（改写等于替上游把对不上账藏起来）
    expect(s.foldedBytes).toBe(400)
    expect(s.excludedBytes).toBe(300)
    expect(s.rootBytes).toBe(500)
    // 档位本身不受上游对不上账的影响
    expect(bytesOf(s)).toBe(100)
    expect(bucketOf('system', s)?.bytes).toBe(100)
  })

  it('另一侧的 absurd：children 合计大于 rootBytes 时 coveredRatio 夹在 1、残差 0、档位字节不动', () => {
    const s = summarizeGroups([dir('C:\\Windows', 900), dir('C:\\Program Files', 400)], 0, 0, 1000)
    expect(s.coveredRatio).toBe(1)
    expect(Number.isFinite(s.coveredRatio)).toBe(true)
    expect(s.unaccountedBytes).toBe(0)
    // 夹的只是那根比例条，不是字节：1300 这仍是 100% 覆盖解释不了的账，得靠上面那句残差去说
    expect(bytesOf(s)).toBe(1300)
  })

  it('脏 size 与脏 folded（NaN / Infinity / 负数）不污染整栏：按 0 字节计，但照样数进 items，派生两个数仍是有限数', () => {
    const s = summarizeGroups(
      [
        dir('C:\\Windows', 700),
        file('C:\\Windows\\a.dll', Number.NaN),
        file('C:\\Windows\\b.dll', Number.POSITIVE_INFINITY),
        file('C:\\Windows\\c.dll', -50)
      ],
      Number.NaN,
      -20,
      1000
    )
    for (const v of [s.unaccountedBytes, s.coveredRatio, ...s.buckets.map((b) => b.bytes)]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(s.buckets).toEqual([{ group: 'system', bytes: 700, items: 4 }])
    // NaN 的 folded 不参与减法（按 0 计），所以残差就是 1000 − 700，而不是跟着变 NaN
    expect(s.unaccountedBytes).toBe(300)
    expect(s.coveredRatio).toBe(0.7)
    // 负 size 取 0 而不是让 coveredBytes 倒扣：倒扣的话残差会报成 1050，那是在无中生有
    expect(summarizeGroups([dir('C:\\Windows', -50)], 0, 0, 1000).unaccountedBytes).toBe(1000)
  })
})
