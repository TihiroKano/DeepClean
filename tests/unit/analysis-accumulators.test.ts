/**
 * V0.3 Task 1 —— 四个**有界**累加器与告警清单的单元测试（先于引擎写，Step 1）。
 *
 * 这个文件钉的是四条口径，每条都对应一处"数错了没人发现"的事故面：
 * 1. **计数绝不因截断变小**（`TopK.seen/totalBytes`、`WarningSink.total/byKind`）：
 *    有界的只有"能点名哪些"，被截断的计数比没有计数更坏，因为它看起来像结论。
 *    原文先例是 `core/scan/tree-store.ts` 的 `addError`（先 `c[kind]++` 再判清单长度）
 *    与 `tests/unit/scan-denied-paths.test.ts` 30–63 行（含"上限钉在字面量 200、不自指"那条纪律）。
 * 2. **定序键必须全序**（size 降序 → path 升序）：同 size 交给访问顺序，百万级数据上
 *    两次跑会给出两张榜，而它们长得一样。
 * 3. **平均大小在读取时算**：`ExtRow` 里没有 `averageSize` 这个可写字段，只有 `withAvg()`。
 * 4. **阈值档是"≥ 该值"的独立计数**，不是分箱：一个 2 GB 的文件同时属于 >100MB / >500MB / >1GB 三档。
 *
 * `extKeyOf` 那组用例（含 `.gitignore`）是 Step 8 变异 #3 的**唯一**靶子 ——
 * `ExtTable` 的"无扩展名"用例手工传 `ext: ''`，喂不到判据上去。
 */
import { describe, expect, it } from 'vitest'
import { ExtTable, ThresholdBuckets, TopK } from '../../core/analyze/accumulators'
import { extKeyOf, extLabel, NO_EXT_LABEL } from '../../core/analyze/extkey'
import { MAX_WARNING_SAMPLE, WarningSink } from '../../core/analyze/warnings'
import { extOf } from '../../core/fs/pathutil'

const f = (name: string, path: string, size: number, mtimeMs = 1) => ({ name, path, size, ext: '', mtimeMs })

describe('TopK', () => {
  it('只留最大的 k 个，且按 size 降序、同 size 按 path 升序（全序，两次跑结果必须逐字节相同）', () => {
    const t = new TopK(3)
    for (const [n, s] of [['a', 10], ['b', 30], ['c', 20], ['d', 30], ['e', 5]] as const) t.push(f(n, `C:\\${n}`, s))
    expect(t.entries().map((x) => [x.name, x.size])).toEqual([['b', 30], ['d', 30], ['c', 20]])
  })
  it('k=0 时不保留任何东西，但 count/total 照常累加（计数绝不因截断变小）', () => {
    const t = new TopK(0)
    t.push(f('a', 'C:\\a', 10))
    t.push(f('b', 'C:\\b', 20))
    expect(t.entries()).toHaveLength(0)
    expect(t.seen).toBe(2)
    expect(t.totalBytes).toBe(30)
  })
  it('totalBytes 是**全量**口径，与留下的条数无关（k=1 时榜上只有 30 那条，totalBytes 仍是 60）', () => {
    const t = new TopK(1)
    t.push(f('a', 'C:\\a', 10))
    t.push(f('b', 'C:\\b', 20))
    t.push(f('c', 'C:\\c', 30))
    expect(t.entries().map((x) => x.name)).toEqual(['c'])
    expect(t.entries().reduce((s, x) => s + x.size, 0)).toBe(30)
    expect(t.totalBytes).toBe(60)
    expect(t.seen).toBe(3)
  })
  it('同一批数据换进入顺序，榜逐字节相同（tie-break 不许落到访问顺序上）', () => {
    const a = [f('x', 'C:\\x', 30), f('y', 'C:\\y', 30), f('z', 'C:\\z', 10)]
    const t1 = new TopK(2)
    for (const x of a) t1.push(x)
    const t2 = new TopK(2)
    for (const x of [...a].reverse()) t2.push(x)
    expect(JSON.stringify(t2.entries())).toBe(JSON.stringify(t1.entries()))
    expect(t1.entries().map((x) => x.name)).toEqual(['x', 'y'])
  })
})

describe('ExtTable', () => {
  it('大小写归一：.PAK / .pak / .Pak 合成一行，count/total/largest 都对', () => {
    const t = new ExtTable()
    t.add({ ...f('A.PAK', 'C:\\A.PAK', 100), ext: '.pak' })
    t.add({ ...f('b.pak', 'C:\\b.pak', 50), ext: '.pak' })
    t.add({ ...f('c.Pak', 'C:\\c.Pak', 500), ext: '.pak' })
    const row = t.get('.pak')!
    expect([row.fileCount, row.totalSize, row.averageSize]).toEqual([3, 650, Math.round(650 / 3)])
    expect(row.largestFile?.name).toBe('c.Pak')
  })
  it('无扩展名单独成一行，标签是 NO_EXT_LABEL 而不是空串', () => {
    const t = new ExtTable()
    t.add({ ...f('README', 'C:\\README', 7), ext: '' })
    expect(t.get('')?.label).toBe(NO_EXT_LABEL)
  })
  it('largestFile 在同 size 时按 path 升序分胜负（与 TopK 同一个全序判据）', () => {
    const t = new ExtTable()
    t.add({ ...f('b.log', 'C:\\b.log', 42), ext: '.log' })
    t.add({ ...f('a.log', 'C:\\a.log', 42), ext: '.log' })
    expect(t.get('.log')?.largestFile?.name).toBe('a.log')
  })
  it('rows() 每行都带读取时算出的 averageSize，且行本身是副本（改返回值不许污染表）', () => {
    const t = new ExtTable()
    t.add({ ...f('a.txt', 'C:\\a.txt', 10), ext: '.txt' })
    t.add({ ...f('b.txt', 'C:\\b.txt', 20), ext: '.txt' })
    const rows = t.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.averageSize).toBe(15)
    rows[0]!.totalSize = 999
    expect(t.get('.txt')!.totalSize).toBe(30)
  })
})

describe('extKeyOf（§6 的扩展名口径）', () => {
  it('大小写归一为小写并带点；多重扩展名取**最后一个**点', () => {
    expect(extKeyOf('game.PAK')).toBe('.pak')
    expect(extKeyOf('a.b.C')).toBe('.c')
    expect(extKeyOf('archive.tar.gz')).toBe('.gz')
    expect(extKeyOf('f.tmp.noext')).toBe('.noext')
  })
  it('无扩展名与点开头文件都归 \'\'；判据是 `i <= 0`，不是 `i < 0`', () => {
    expect(extKeyOf('README')).toBe('')
    // 这条守的是那个 `<= 0` 里的 0：写成 `i < 0` 时 `.gitignore` 会被当成"扩展名为 .gitignore 的文件"
    expect(extKeyOf('.gitignore')).toBe('')
    // 名字真以点结尾 —— 那既不是无扩展名也不是尾巴，原样给 '.'，不许被 `i <= 0` 顺手吃掉
    expect(extKeyOf('a.')).toBe('.')
  })
  it('与扫描层的 extOf 对同一个名字必须同解（一张表里不许两套"什么是 .gz"）', () => {
    for (const n of ['README', '.gitignore', 'a.', 'archive.tar.gz', 'game.PAK', '.env.local', 'x.y.Z', 'C:\\d\\a.tar.gz']) {
      expect(extKeyOf(n)).toBe(extOf(n))
    }
  })
  it('extLabel：空串走 NO_EXT_LABEL，其余原样', () => {
    expect(extLabel('')).toBe(NO_EXT_LABEL)
    expect(extLabel('.pak')).toBe('.pak')
  })
})

describe('ThresholdBuckets', () => {
  it('每个阈值都是「≥ 该值」的独立计数，且 totalBytes 与 count 同步增长', () => {
    const MB = 1024 * 1024
    const b = new ThresholdBuckets([100 * MB, 500 * MB, 1024 * MB])
    b.add(150 * MB)
    b.add(600 * MB)
    b.add(2 * 1024 * MB)
    b.add(50 * MB)
    // 内部按阈值升序累加、外部按阈值降序展示（">2GB" 排在 ">100MB" 前面，读起来像规格书 §9 那个例子）
    expect(b.rowsOut()).toEqual([
      { minBytes: 1024 * MB, count: 1, totalBytes: 2 * 1024 * MB },
      { minBytes: 500 * MB, count: 2, totalBytes: 600 * MB + 2 * 1024 * MB },
      { minBytes: 100 * MB, count: 3, totalBytes: 150 * MB + 600 * MB + 2 * 1024 * MB }
    ])
  })
  it('minBytes=0 那一档就是全量口径：count == 文件数、totalBytes == 总字节', () => {
    const b = new ThresholdBuckets([0])
    b.add(10)
    b.add(0)
    b.add(20)
    expect(b.rowsOut()).toEqual([{ minBytes: 0, count: 3, totalBytes: 30 }])
  })
  it('没有阈值时 add() 不炸、输出空数组（不是 undefined、也不是 null）', () => {
    const b = new ThresholdBuckets([])
    b.add(999)
    expect(b.rowsOut()).toEqual([])
  })
  it('入参数组不许被改动（调用方传的是常量档，排序只发生在我们自己那份上）', () => {
    const mins = [10, 5, 5]
    const b = new ThresholdBuckets(mins)
    b.add(7)
    expect(mins).toEqual([10, 5, 5])
    expect(b.rowsOut()).toEqual([
      { minBytes: 10, count: 0, totalBytes: 0 },
      { minBytes: 5, count: 1, totalBytes: 7 },
      { minBytes: 5, count: 1, totalBytes: 7 }
    ])
  })
})

describe('WarningSink（§13 异常不中断 + 计数不随清单截断）', () => {
  it('四类各自计数，total 是四类之和，byKind 的键集合固定', () => {
    const w = new WarningSink()
    w.add('missing-node', 'C:\\ghost', 'dirId 不存在')
    w.add('bad-child', 'C:\\a', '同一目录被两个父引用')
    w.add('bad-child', 'C:\\b', '读取子节点失败')
    w.add('negative-size', 'C:\\c', 'size 不是有限非负数')
    w.add('budget-exhausted', 'C:\\d', '预算用尽')
    const s = w.snapshot()
    expect(s.total).toBe(5)
    expect(s.byKind).toEqual({ 'missing-node': 1, 'bad-child': 2, 'negative-size': 1, 'budget-exhausted': 1 })
    expect(s.sample.map((x) => x.path)).toEqual(['C:\\ghost', 'C:\\a', 'C:\\b', 'C:\\c', 'C:\\d'])
    expect(s.sampleOverflow).toBe(0)
  })

  /**
   * Step 8 变异 #2 的靶子：把 `total++` 挪进"清单还装得下"那个分支，
   * 这里 `total` 会停在 200 而 sampleOverflow 变成 0 —— 一份被截断的告警计数。
   */
  it('上限就是字面上的 200 条（§16 内存预算，不随实现自我放宽）：清单不增长，计数照样数满', () => {
    expect(MAX_WARNING_SAMPLE).toBe(200)
    const w = new WarningSink()
    for (let i = 0; i < 5000; i++) w.add('missing-node', `C:\\盘\\目录\\${i}`, 'dirId 不存在')
    const s = w.snapshot()
    expect(s.total).toBe(5000)
    expect(s.byKind['missing-node']).toBe(5000)
    expect(s.sample).toHaveLength(200)
    expect(s.sampleOverflow).toBe(4800)
    expect(s.sample.length + s.sampleOverflow).toBe(s.total)
  })

  it('snapshot 给的是副本：改回来那份清单不许动到 sink 自己的账', () => {
    const w = new WarningSink()
    w.add('bad-child', 'C:\\x', 'why')
    const a = w.snapshot()
    a.sample.push({ kind: 'bad-child', path: 'C:\\伪造', why: '伪造' })
    a.byKind['bad-child'] = 99
    expect(w.snapshot().sample).toHaveLength(1)
    expect(w.snapshot().byKind['bad-child']).toBe(1)
  })

  it('total 这个读面与 snapshot().total 是同一个数（两处口径不许分叉）', () => {
    const w = new WarningSink()
    expect(w.total).toBe(0)
    w.add('negative-size', 'C:\\a', 'size=NaN')
    expect(w.total).toBe(1)
    expect(w.snapshot().total).toBe(1)
  })
})
