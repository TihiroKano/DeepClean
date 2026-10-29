/**
 * V0.3 分析层的四个**有界**累加器（Task 1）。
 *
 * 共同形状：`add`/`push` 一次 O(log k) 且**内存恒定**，读取时才整理成展示用的行。
 * 两条从这里守住的口径：
 *
 * 1. **有界的是清单，不是计数。** `TopK.seen` / `TopK.totalBytes` / `ExtTable` 的
 *    `fileCount`+`totalSize` / `ThresholdBuckets` 的 `count`+`totalBytes` 全都按"见过每一条"累加，
 *    与堆满没满、榜截没截无关。先例是 `core/scan/tree-store.ts` 的 `addError`
 *    （先 `c[kind]++` 再判 `deniedList.length`），以及同一份纪律的 `WarningSink`（`./warnings.ts`）。
 *    规格书 §2 要的「>100 MB 的文件有 150 个」在容量 100 的 `topHeap` 上永远数不出来，
 *    这正是本文件存在的理由（见计划「现状对照」下的"真缺陷"）。
 * 2. **派生数在读取时算，不在累加时算。** `averageSize` 不是 `ExtRow` 的字段：
 *    累加"平均值"是错的，而把它算出来存下去就会有一份可以被 `add` 改旧的真值。
 *    `shareOfRoot` 同理，住在 `engine.ts` 的读取侧。
 *
 * 本文件零 `node:` import（`tests/unit/analysis-engine.test.ts` 有一条静态断言）。
 */
import { MinHeap } from '../scan/heap'
import { extLabel } from './extkey'
import type { AnalysisFile } from './engine'

/** 定序要用的最小面：文件与目录行都能进来比，不需要为比较造第三种对象。 */
export interface SizePath {
  readonly size: number
  readonly path: string
}

/**
 * 同 size 时按 path 升序 —— 定序键必须全序，否则百万级数据上两次跑给出不同的榜，
 * 而两张榜长得一模一样。与 `dir-stats.ts` 的 `better`、`tree-store.ts` 的 `LEVEL_ORDER` 同一族判据
 * （那两条按 name 比，这里按 path 比：分析层的行是**全树**的，跨层同名目录会有并列，path 才唯一）。
 */
const better = <T extends SizePath>(a: T, b: T): boolean => a.size > b.size || (a.size === b.size && a.path < b.path)

/** 给引擎跟踪「最大文件」用的同一个全序判据 —— 榜与最大必须出自一户口径，不许各比一次。 */
export const betterFile = (a: AnalysisFile, b: AnalysisFile): boolean => better(a, b)

/**
 * Top-K 榜。`T` 默认是文件行（`AnalysisFile`），目录行（`DirEntry`）共用这一份堆逻辑 ——
 * `core/scan/heap.ts` 的 `MinHeap` 是仓库里唯一的堆，不许有第二个。
 */
export class TopK<T extends SizePath = AnalysisFile> {
  private readonly heap: MinHeap<T>
  /** 见过多少条 —— 与 `k` 无关，`k = 0` 也照样数。 */
  seen = 0
  /** 见过那些条的字节**全量**之和 —— 不是留下的那 k 条之和（那个数是 `engine.ts` 的 `topFilesTotalBytes`）。 */
  totalBytes = 0

  constructor(private readonly k: number) {
    this.heap = new MinHeap<T>(Math.max(0, k), (x) => x.size)
  }

  push(item: T): void {
    this.seen++
    this.totalBytes += item.size
    if (this.k > 0) this.heap.push(item)
  }

  /** 完整有序的榜（size 降序 → path 升序）。 */
  entries(): T[] {
    return this.heap.entries().sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0))
  }
}

export interface ExtRow {
  ext: string
  label: string
  fileCount: number
  totalSize: number
  largestFile: AnalysisFile | null
}

/** 读取侧的行：只有这时候才多出 `averageSize`。 */
export type ExtRowView = ExtRow & { averageSize: number }

/** 分母为 0 一律给 0，让 UI 显示 `—`（全局约束「不显示没算过的数字」）。 */
const withAvg = (r: ExtRow): ExtRowView => ({
  ...r,
  averageSize: r.fileCount > 0 ? Math.round(r.totalSize / r.fileCount) : 0
})

/**
 * 按扩展名的类型统计表（规格书 §3）。行数上限不在这里做 —— 真实 C 盘几千种扩展名，
 * 一张几千行的 Map 比它的宿主（树本身）小两个数量级，截断与「其余 N 种合计 X GB」是 Task 3 的事。
 */
export class ExtTable {
  private readonly m = new Map<string, ExtRow>()

  add(f: AnalysisFile): void {
    const cur = this.m.get(f.ext)
    if (!cur) {
      this.m.set(f.ext, { ext: f.ext, label: extLabel(f.ext), fileCount: 1, totalSize: f.size, largestFile: f })
      return
    }
    cur.fileCount++
    cur.totalSize += f.size
    if (cur.largestFile === null || betterFile(f, cur.largestFile)) cur.largestFile = f
  }

  /** 返回**副本**（`averageSize` 现算）：这份行要进 IPC，不许被下游改到表自己的账。 */
  get(ext: string): ExtRowView | undefined {
    const r = this.m.get(ext)
    return r ? withAvg(r) : undefined
  }

  /** 未排序（首见顺序），排序在 `engine.ts` 里做一次：总大小降序 → 扩展名升序。 */
  rows(): ExtRowView[] {
    return [...this.m.values()].map(withAvg)
  }
}

export interface ThresholdRow {
  minBytes: number
  count: number
  totalBytes: number
}

/**
 * 「≥ 该值」的独立计数档（规格书 §2）。**不是分箱**：一个 2 GB 的文件同时进
 * >100 MB / >500 MB / >1 GB 三档，所以每一档都是全量口径 —— 这正是"不能再在容量 100 的
 * `topHeap` 里过滤"那条真缺陷的解法。
 *
 * 内部按阈值**升序**存、`add` 一趟从头看到尾（`≥` 语义下大 size 过的档只会更多，提前 break 会漏计），
 * 输出按阈值降序，读起来像规格书 §9 那个例子。
 * 调用方传重复阈值时**按原样给两行相同答案**（那是"你问了两遍"，不是 bug），也不改调用方的数组。
 */
export class ThresholdBuckets {
  private readonly rows: ThresholdRow[]

  constructor(mins: readonly number[]) {
    this.rows = [...mins]
      .sort((a, b) => a - b)
      .map((minBytes) => ({ minBytes, count: 0, totalBytes: 0 }))
  }

  add(size: number): void {
    for (const r of this.rows) {
      if (size >= r.minBytes) {
        r.count++
        r.totalBytes += size
      }
    }
  }

  /** 阈值降序展示。给的是副本 —— 这份行直接进 IPC。 */
  rowsOut(): ThresholdRow[] {
    return [...this.rows].sort((a, b) => b.minBytes - a.minBytes).map((r) => ({ ...r }))
  }
}

/** 目录排行的一行（`AnalysisResult.directories` 去掉派生的 `shareOfRoot`）。 */
export interface DirEntry extends SizePath {
  readonly name: string
  readonly path: string
  readonly fileCount: number
  readonly directoryCount: number
}

/** 目录榜：与文件榜同一个 `TopK`，只是行里带 `finalizeDir` 已算好的两个聚合计数。 */
export type DirTopK = TopK<DirEntry>
