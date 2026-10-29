/**
 * V0.3 Task 1 —— 分析引擎骨架（一次内存遍历喂四个有界累加器）。
 *
 * 这个文件要钉死的是五件事，每件都对应"数错了看起来仍然正确"的那类事故：
 * 1. **不重走盘**：`runAnalysis` 只经由注入的 `AnalysisSource` 读内存树，
 *    三个新文件里出现 `node:` import 即为缺陷（最后一条用例静态可查，规格书 §12）。
 * 2. **计数绝不因截断变小**：`topK` 再小，`files` / `bytes` / `thresholds` 都是全量口径；
 *    告警清单再截断，`warnings.total` 也照样数满。
 * 3. **两个"合计"不许混**：`topFilesTotalBytes` 是**留下的那 k 条**之和（规格书 §9
 *    那句「Top 100 文件总占用」），`bytes` 才是全量。两者各有用例。
 * 4. **预算是硬闸**：`visited`（弹出的目录数）与被接受的子目录数双双 `<= budget`，
 *    断在哪条路径上要点名进 `warnings`，`partial` 必须为真 —— 不许把截断结果冒充全量结论。
 * 5. **坏数据不炸**：childIds 指向不存在的 id、同一目录被两个父引用、`childrenOf` 抛错、
 *    `size` 是 NaN/负数 —— 全部只记一条告警，其余数据照常分析完。
 *
 * `childrenOf` 是**计价口径的完整清单**（`core/rules/engine.ts`、
 * `core/report/scan-report.ts` 都靠它），本文件只读它、不改它、不给它加任何 cap。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_THRESHOLDS, runAnalysis, type AnalysisSource } from '../../core/analyze/engine'
import { MAX_WARNING_SAMPLE } from '../../core/analyze/warnings'
import { TreeStore } from '../../core/scan/tree-store'
import type { ChildView } from '../../shared/types'

const MB = 1024 * 1024
const GB = 1024 * MB

/**
 * 夹具树（`C:\` 三目录四文件）：
 *   root  ← pagefile.sys 4 GB
 *   Users ← Kano ← { disk.vhdx 18 GB, game.pak 14 GB, README 10 B }
 * `Users` 与 `Kano` 的聚合 size 相同（Users 自己没有直属文件），这正好是一组 tie-break 样本。
 */
function store(): TreeStore {
  const s = new TreeStore({ rootPath: 'C:\\', maxFiles: 1_000_000 })
  const root = s.rootId
  const users = s.beginDir('C:\\Users')
  s.attachChild(root, users)
  const kano = s.beginDir('C:\\Users\\Kano')
  s.attachChild(users, kano)
  s.addFilesToDir(root, [{ name: 'pagefile.sys', size: 4 * GB, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
  s.addFilesToDir(kano, [
    { name: 'disk.vhdx', size: 18 * GB, mtimeMs: 2, birthtimeMs: 2, attrs: 0 },
    { name: 'game.pak', size: 14 * GB, mtimeMs: 3, birthtimeMs: 3, attrs: 0 },
    { name: 'README', size: 10, mtimeMs: 4, birthtimeMs: 4, attrs: 0 }
  ])
  s.finalizeDir(root)
  return s
}

/** 只给 TreeStore 本身：结构上就满足 AnalysisSource，不需要适配器 —— 与 rules/dup 同一模式。 */
const asSource = (s: TreeStore): AnalysisSource => s as unknown as AnalysisSource

/** 覆盖 `childrenOf` 的返回：只包装读面，绝不改 store 自己。 */
function patched(s: TreeStore, onChildren: (id: number, real: ChildView[]) => ChildView[]): AnalysisSource {
  return {
    rootId: s.rootId,
    dirIdByPath: (p) => s.dirIdByPath(p),
    pathOf: (id) => s.pathOf(id),
    sizeOf: (id) => s.sizeOf(id),
    getDir: (id) => s.getDir(id),
    truncated: s.truncated,
    childrenOf: (id) => onChildren(id, s.childrenOf(id))
  }
}

const ghost = (i: number): ChildView => ({
  kind: 'directory',
  name: `ghost${i}`,
  path: `C:\\ghost${i}`,
  dirId: 9_000 + i,
  size: 5,
  mtimeMs: 1,
  fileCount: 0,
  dirCount: 0,
  attrs: null,
  birthtimeMs: null
})

describe('runAnalysis', () => {
  it('一次遍历得到 Top-K、最大文件、阈值档、扩展名表与目录榜，且全部来自内存树', () => {
    const s = store()
    const o = { topK: 2, dirTopK: 10, thresholds: [100 * MB, 1 * GB, 10 * GB], budget: 100_000 }
    const r = runAnalysis(asSource(s), s.rootId, o, 1_700_000_000_000)
    expect(r.topFiles.map((x) => x.name)).toEqual(['disk.vhdx', 'game.pak'])
    expect(r.largestFile?.name).toBe('disk.vhdx')
    expect(r.thresholds.find((x) => x.minBytes === 100 * MB)?.count).toBe(3)
    // 简报这里写的是 3，那是 `≥1 GB` 的数：pagefile.sys 是 **4 GB**，够不到 10 GB 档。
    // ≥10 GB 只有 disk.vhdx(18) 与 game.pak(14) 两条 —— 凑成 3 就是在阈值档上撒谎。
    expect(r.thresholds.find((x) => x.minBytes === 10 * GB)?.count).toBe(2)
    expect(r.thresholds.find((x) => x.minBytes === 1 * GB)?.count).toBe(3)
    expect(r.thresholds.find((x) => x.minBytes === 10 * GB)?.totalBytes).toBe(18 * GB + 14 * GB)
    expect(r.extensions.find((x) => x.ext === '.vhdx')?.fileCount).toBe(1)
    expect(r.extensions.find((x) => x.ext === '')?.label).toBe('[无扩展名]')
    // 父子目录**同时进榜**是刻意的（规格书 §4 全树排行），代价由页面上那句"重复计入"点名 ——
    // 见计划 Global Constraints「目录排行的双重计入必须点名」。根自己不进榜：它是分母。
    expect(r.directories.map((d) => d.path)).toEqual(['C:\\Users', 'C:\\Users\\Kano'])
    expect(r.directories[0]!.size).toBe(r.directories[1]!.size)
    expect(r.directories[0]!.fileCount).toBe(3)
    expect(r.directories[0]!.directoryCount).toBe(1)
    expect(r.files).toBe(4)
    expect(r.dirs).toBe(2) // 不含根：根是 `rootSize` 那个分母，不是榜上的一项
    expect(r.visited).toBe(3) // 根 + Users + Kano 各弹出一次
    expect(r.rootPath).toBe('C:\\')
    expect(r.rootSize).toBe(4 * GB + 18 * GB + 14 * GB + 10)
    expect(r.rootIsDrive).toBe(true)
    expect(r.truncated).toBe(false)
    expect(r.partial).toBe(false)
    expect(r.generatedAtMs).toBe(1_700_000_000_000)
  })

  it('TreeStore 结构上直接满足 AnalysisSource（不给它写适配器 —— 与 RuleTreeSource/DupSource 同一模式）', () => {
    const s = store()
    const direct: AnalysisSource = s
    expect(direct.childrenOf(s.rootId).length).toBeGreaterThan(0)
    expect(direct.rootId).toBe(s.rootId)
  })

  it('Top-K 只留 k 条，但 files / bytes 计数是全量口径（计数绝不因截断变小）', () => {
    const s = store()
    const r = runAnalysis(asSource(s), s.rootId, { topK: 1, thresholds: [0], budget: 100_000 }, 1)
    expect(r.topFiles).toHaveLength(1)
    expect(r.files).toBe(4)
    expect(r.bytes).toBe(4 * GB + 18 * GB + 14 * GB + 10)
    expect(r.thresholds[0]!.count).toBe(4)
    expect(r.thresholds[0]!.totalBytes).toBe(r.bytes)
  })

  /**
   * 简报 Step 7 那句批注自己矛盾（先说 `topFilesTotalBytes` 取 `topK.totalBytes`，
   * 又说 §9 要的是留下的 k 条之和所以取 `entries().reduce`）。两个数都要、且**不是一回事**：
   * `TopK.totalBytes` 恒等于全量 `bytes`（累加器见过每一条），§9 那句「Top 100 文件总占用」
   * 要的是**留下的 k 条**之和。搞混的表现是「Top 20 合计」印出整盘容量。
   */
  it('topFilesTotalBytes 是留下的 k 条之和，不是全量（全量那一本叫 bytes）', () => {
    const s = store()
    const top2 = runAnalysis(asSource(s), s.rootId, { topK: 2, budget: 100_000 }, 1)
    expect(top2.topFilesTotalBytes).toBe(18 * GB + 14 * GB)
    expect(top2.bytes).toBe(4 * GB + 18 * GB + 14 * GB + 10)
    expect(top2.topFilesTotalBytes).toBe(top2.topFiles.reduce((x, y) => x + y.size, 0))
    expect(top2.topFilesTotalBytes).toBeLessThan(top2.bytes)
    // k 大到装得下全部文件时两本账必须合上（否则说明其中一本在偷偷丢东西）
    const all = runAnalysis(asSource(s), s.rootId, { topK: 99, budget: 100_000 }, 1)
    expect(all.topFiles).toHaveLength(4)
    expect(all.topFilesTotalBytes).toBe(all.bytes)
    // k=0：榜是空的，但合计必须是 0 而不是"没算过"的 undefined/NaN
    const none = runAnalysis(asSource(s), s.rootId, { topK: 0, budget: 100_000 }, 1)
    expect(none.topFiles).toEqual([])
    expect(none.topFilesTotalBytes).toBe(0)
    expect(none.files).toBe(4)
  })

  it('预算用尽 → partial=true 且 visited 如实；不许把截断结果冒充全量结论', () => {
    const s = store()
    const r = runAnalysis(asSource(s), s.rootId, { topK: 10, budget: 1 }, 1)
    expect(r.partial).toBe(true)
    expect(r.visited).toBeLessThanOrEqual(1)
    expect(r.warnings.byKind['budget-exhausted']).toBeGreaterThan(0)
    // 预算同时按"入栈"计费：断掉之后不许再有第二条目录进栈（V0.2 Task 4 抓的就是只按弹出计费）
    expect(r.dirs).toBeLessThanOrEqual(1)
    expect(r.directories.length).toBeLessThanOrEqual(1)
  })

  it('宽而浅的树：budget 卡住的是被接受的目录数，不是扇出（栈不会长成 O(预算 × 扇出)）', () => {
    const s = new TreeStore({ rootPath: 'C:\\', maxFiles: 1_000_000 })
    for (let i = 0; i < 500; i++) {
      const d = s.beginDir(`C:\\d${i}`)
      s.addFilesToDir(d, [{ name: 'a.bin', size: 10 + i, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
    }
    s.finalizeDir(s.rootId)
    const r = runAnalysis(asSource(s), s.rootId, { topK: 5, budget: 4 }, 1)
    expect(r.partial).toBe(true)
    expect(r.visited).toBeLessThanOrEqual(4)
    expect(r.dirs).toBeLessThanOrEqual(4)
    expect(r.warnings.byKind['budget-exhausted']).toBe(1)
  })

  it('同一棵树连跑两次结果逐字节相同（所有定序键都是全序，包括并列 size）', () => {
    const s = store()
    const o = { topK: 4, dirTopK: 4, thresholds: [10 * GB, 500 * GB], budget: 1000 }
    const a = runAnalysis(asSource(s), s.rootId, o, 7)
    const b = runAnalysis(asSource(s), s.rootId, o, 7)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    // 并列 10 GB 档的两条目录靠 path 分胜负，不靠访问顺序
    expect(a.directories.map((d) => d.path)).toEqual(['C:\\Users', 'C:\\Users\\Kano'])
  })

  it('阈值档默认值就是规格书 §2 那五档（100MB/500MB/1GB/5GB/10GB），输出按档位降序', () => {
    expect(DEFAULT_THRESHOLDS).toEqual([100 * MB, 500 * MB, 1 * GB, 5 * GB, 10 * GB])
    const s = store()
    const r = runAnalysis(asSource(s), s.rootId, { budget: 1000 }, 1)
    expect(r.thresholds.map((t) => t.minBytes)).toEqual([10 * GB, 5 * GB, 1 * GB, 500 * MB, 100 * MB])
    expect(r.thresholds.map((t) => t.count)).toEqual([2, 2, 3, 3, 3])
  })

  it('损坏的扫描数据（childIds 指向不存在的 id）只记一条 warning，不抛、不中断', () => {
    const s = store()
    const broken: AnalysisSource = {
      rootId: s.rootId,
      dirIdByPath: (p) => s.dirIdByPath(p),
      childrenOf: (id) => {
        if (id === s.rootId) {
          const kids = s.childrenOf(id)
          return [...kids, { kind: 'directory', name: 'ghost', path: 'C:\\ghost', dirId: 9999, size: 5, mtimeMs: 1, birthtimeMs: null, fileCount: 0, dirCount: 0, attrs: null }]
        }
        return s.childrenOf(id)
      }
    }
    const r = runAnalysis(broken, s.rootId, { topK: 10, budget: 1000 }, 1)
    expect(r.warnings.total).toBeGreaterThan(0)
    expect(r.warnings.sample.length).toBeGreaterThan(0)
    expect(r.warnings.byKind['missing-node']).toBe(1)
    expect(r.files).toBeGreaterThan(0) // 其它数据照常分析完
    expect(r.files).toBe(4)
    expect(r.dirs).toBe(2) // ghost 既没进 `dirs` 也没进榜
    expect(r.partial).toBe(false)
    // 这个 source 没给 sizeOf → rootSize 是 0 → 所有占比一律 0（UI 显示 —），不许出现 NaN/Infinity
    expect(r.rootSize).toBe(0)
    expect(r.extensions.every((e) => Number.isFinite(e.shareOfRoot) && e.shareOfRoot === 0)).toBe(true)
    expect(r.directories.every((d) => Number.isFinite(d.shareOfRoot) && d.shareOfRoot === 0)).toBe(true)
    expect(r.truncated).toBe(false)
  })

  it('同一目录被两个父引用：只分析第一次，另一处记 bad-child，文件不被双计', () => {
    const s = new TreeStore({ rootPath: 'C:\\', maxFiles: 1_000_000 })
    const a = s.beginDir('C:\\A')
    const b = s.beginDir('C:\\A\\B')
    s.addFilesToDir(b, [{ name: 'x.bin', size: 7, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }])
    s.attachChild(a, b)
    s.attachChild(s.rootId, b) // 手工把 B 同时挂到根上 —— 真实扫描给不出这个形状，损坏的树可以
    s.finalizeDir(s.rootId)
    const r = runAnalysis(asSource(s), s.rootId, { topK: 10, budget: 1000 }, 1)
    expect(r.files).toBe(1) // 双计的话这里是 2
    expect(r.bytes).toBe(7)
    expect(r.dirs).toBe(2) // A 与 B 各计一次，B 不因第二次引用再计一次
    expect(r.visited).toBe(3) // 根、A、B 各弹一次；B 只被分析一次
    expect(r.warnings.byKind['bad-child']).toBe(1)
    expect(r.warnings.sample.some((w) => w.kind === 'bad-child' && w.path.includes('B'))).toBe(true)
    expect(r.directories.filter((d) => d.path === 'C:\\A\\B')).toHaveLength(1)
  })

  it('childrenOf 抛错 → bad-child 一条，其余照常，不向上冒泡', () => {
    const s = store()
    const users = s.dirIdByPath('C:\\Users')!
    const r = runAnalysis(
      patched(s, (id, real) => {
        if (id === users) throw new Error('炸了')
        return real
      }),
      s.rootId,
      { topK: 10, budget: 1000 },
      1
    )
    expect(r.warnings.byKind['bad-child']).toBe(1)
    expect(r.warnings.sample[0]!.why).toContain('炸了')
    expect(r.files).toBe(1) // 只剩根上的 pagefile.sys：Users 子树确实没看到
    expect(r.bytes).toBe(4 * GB)
    expect(r.partial).toBe(false) // 这是"数据坏了"，不是"预算用尽"
    expect(r.directories.map((d) => d.path)).toEqual(['C:\\Users'])
  })

  it('size 不是有限非负数的文件：记 negative-size、不计入 files/bytes，兄弟照常', () => {
    const s = store()
    const r = runAnalysis(
      patched(s, (id, real) =>
        id === s.rootId
          ? [...real, { kind: 'file', name: '坏.NAN', path: 'C:\\坏.NAN', size: Number.NaN, mtimeMs: 1, fileCount: 0, dirCount: 0, attrs: null, birthtimeMs: null } as ChildView]
          : real
      ),
      s.rootId,
      { topK: 10, budget: 1000 },
      1
    )
    expect(r.warnings.byKind['negative-size']).toBe(1)
    expect(r.files).toBe(4) // NaN 那条没进来
    expect(r.bytes).toBe(4 * GB + 18 * GB + 14 * GB + 10) // 求和没被 NaN 污染
    expect(r.topFiles.some((x) => x.name === '坏.NAN')).toBe(false)
  })

  it('目录聚合 size 坏了：点名一条 negative-size，但**照样走进去**（子树里的文件不能因此漏计）', () => {
    const s = store()
    const r = runAnalysis(
      patched(s, (id, real) =>
        id === s.rootId
          ? real.map((c) => (c.path === 'C:\\Users' ? ({ ...c, size: Number.NaN } as ChildView) : c))
          : real
      ),
      s.rootId,
      { topK: 10, budget: 1000 },
      1
    )
    expect(r.warnings.byKind['negative-size']).toBe(1)
    expect(r.files).toBe(4)
    expect(r.dirs).toBe(2)
    expect(r.directories.map((d) => d.path)).toEqual(['C:\\Users\\Kano']) // size 是 NaN 的那条不进榜
  })

  it('告警清单有界而计数无界：250 个 ghost 子目录 → total 250、sample 200、overflow 50，其余数据照常', () => {
    const s = store()
    const r = runAnalysis(
      patched(s, (id, real) => (id === s.rootId ? [...real, ...Array.from({ length: 250 }, (_, i) => ghost(i))] : real)),
      s.rootId,
      { topK: 10, budget: 100_000 },
      1
    )
    expect(r.warnings.total).toBe(250)
    expect(r.warnings.byKind['missing-node']).toBe(250)
    expect(r.warnings.sample).toHaveLength(MAX_WARNING_SAMPLE)
    expect(r.warnings.sampleOverflow).toBe(50)
    expect(r.warnings.sample.length + r.warnings.sampleOverflow).toBe(r.warnings.total)
    expect(r.files).toBe(4) // 计数侧完全不受影响
  })

  it('maxFiles 截断过的树：truncated 如实带出（走盘只存了一部分，榜与统计就是那一部分）', () => {
    const s = new TreeStore({ rootPath: 'C:\\', maxFiles: 1 })
    const d = s.beginDir('C:\\d')
    s.addFilesToDir(d, [
      { name: 'a.bin', size: 100, mtimeMs: 1, birthtimeMs: 1, attrs: 0 },
      { name: 'b.bin', size: 200, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }
    ])
    s.finalizeDir(s.rootId)
    expect(s.truncated).toBe(true)
    const r = runAnalysis(asSource(s), s.rootId, { topK: 10, budget: 1000 }, 1)
    expect(r.truncated).toBe(true)
    expect(r.files).toBe(1) // 内存里只留了一条 —— 这就是 truncated 必须点名的原因
    expect(r.bytes).toBe(100)
  })

  it('`.gitignore` 与 README 落进同一行『[无扩展名]』，而不是各成一行', () => {
    const s = new TreeStore({ rootPath: 'C:\\', maxFiles: 1_000_000 })
    const d = s.beginDir('C:\\d')
    s.addFilesToDir(d, [
      { name: 'README', size: 5, mtimeMs: 1, birthtimeMs: 1, attrs: 0 },
      { name: '.gitignore', size: 7, mtimeMs: 1, birthtimeMs: 1, attrs: 0 },
      { name: 'a.TMP', size: 9, mtimeMs: 1, birthtimeMs: 1, attrs: 0 },
      { name: 'b.tmp', size: 11, mtimeMs: 1, birthtimeMs: 1, attrs: 0 }
    ])
    s.finalizeDir(s.rootId)
    const r = runAnalysis(asSource(s), s.rootId, { topK: 10, budget: 1000 }, 1)
    const noext = r.extensions.find((e) => e.ext === '')!
    expect(noext.label).toBe('[无扩展名]')
    expect(noext.fileCount).toBe(2)
    expect(noext.largestFile?.name).toBe('.gitignore')
    expect(r.extensions.find((e) => e.ext === '.tmp')?.fileCount).toBe(2)
    // 总大小降序 → 扩展名升序（全序），且每行占比都是有限数
    expect(r.extensions.map((e) => e.ext)).toEqual(['.tmp', ''])
  })

  it('扩展名表的占比以 rootSize 为分母；rootSize 为 0 时一律 0（不显示没算过的数字）', () => {
    const s = store()
    const r = runAnalysis(asSource(s), s.rootId, { topK: 2, budget: 1000 }, 1)
    const vhdx = r.extensions.find((e) => e.ext === '.vhdx')!
    expect(vhdx.shareOfRoot).toBeCloseTo(((18 * GB) / r.rootSize) * 100, 9)
    const zero = runAnalysis(
      { rootId: s.rootId, dirIdByPath: (p) => s.dirIdByPath(p), childrenOf: (id) => s.childrenOf(id), sizeOf: () => 0 },
      s.rootId,
      { topK: 2, budget: 1000 },
      1
    )
    expect(zero.rootSize).toBe(0)
    expect(zero.extensions.every((e) => e.shareOfRoot === 0)).toBe(true)
    expect(zero.directories.every((d) => d.shareOfRoot === 0)).toBe(true)
    expect(zero.extensions.every((e) => e.averageSize > 0)).toBe(true)
  })

  it('静态可查：分析层不碰文件系统 —— core/analyze/ 下**每个** .ts 里都不许出现 node: 前缀的 import', async () => {
    // 只有这条用例读盘，读的是**源码文本**：测试不是交付物，不会被打包进主进程，
    // 所以 `node:fs` 出现在这里不构成"分析层走盘"。判据反过来才成立：
    // core/analyze 里的 shipping code 出现 `node:` 就是缺陷。
    //
    // 为什么用目录枚举而不是点名文件：点名的那份清单是**计划里写死的**，
    // 后来 Task 2-7 每加一个文件都要记得回来补一行；忘了就悄悄留一个洞
    // （评审实测：原先只列了 3 个文件，恰好漏掉唯一往 `core/fs` 伸手的那个 `extkey.ts`）。
    const { readFileSync, readdirSync } = await import('node:fs')
    const files = readdirSync('core/analyze').filter((f) => f.endsWith('.ts')).sort()
    //  glob 落空会让这条断言永真 —— 先证明它确实枚举到了东西，且至少含这两个已知的名字。
    expect(files.length).toBeGreaterThanOrEqual(5)
    expect(files).toContain('engine.ts')
    expect(files).toContain('extkey.ts')
    for (const f of files) {
      expect(readFileSync(`core/analyze/${f}`, 'utf8'), `core/analyze/${f} 里出现了 node: import`).not.toMatch(
        /from ['"]node:/
      )
    }
  })
})
