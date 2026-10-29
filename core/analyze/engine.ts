/**
 * V0.3 分析引擎骨架 —— **一次**内存遍历喂给四个有界累加器（Task 1）。
 *
 * 形状照 `core/analyze/dir-stats.ts`：纯函数 + 注入最小读面 + 预算 + `partial` + 全序比较器。
 * 三条不可让的口径都在这里落地：
 *
 * 1. **不走盘**。本文件零 `node:` / `electron` import（`tests/unit/analysis-engine.test.ts`
 *    末尾有一条静态断言）。树只有一个读面 `childrenOf`，而它是**计价口径的完整清单** ——
 *    `core/rules/engine.ts`、`core/dup/detect.ts`、`core/report/scan-report.ts` 都靠它取全量来计价，
 *    所以这里**只读不改**：不给它加 cap、不加过滤、不加参数。视图收窄是 `levelOf` 的事。
 * 2. **遍历是迭代的**。真实 C 盘聚合深度足以打穿递归栈（`finalizeDir` 自己就是递归的），
 *    `attachChild` 的环检测也不许被当成唯一防线 —— 显式栈 + `seenDir` 去重 + 双侧预算，三道。
 * 3. **计数绝不因截断变小**。榜（`topFiles` / `directories`）与告警清单都有界，
 *    `files` / `bytes` / `thresholds` / `dirs` / `warnings.total` 全是全量口径。
 *
 * 两个"合计"谁取什么（简报 Step 7 那句批注自相矛盾，这里定死，两条用例各钉一头）：
 * - `bytes` = 见过的**每一条**文件之和（`TopK.totalBytes` 与它恒等，所以不需要第三个字段）；
 * - `topFilesTotalBytes` = **留在榜上的那 k 条**之和 —— 规格书 §9 那句「Top 100 文件总占用」是它。
 *   拿 `TopK.totalBytes` 去填它，「Top 20 合计」会印出整盘容量。
 */
import { betterFile, ExtTable, ThresholdBuckets, TopK, type DirEntry, type ThresholdRow } from './accumulators'
import { extKeyOf } from './extkey'
import { normalizeBudget } from './dir-stats'
import { isDriveRootPath } from '../fs/pathutil'
import { WarningSink, type AnalysisWarnings } from './warnings'
import type { ChildView } from '../../shared/types'

/** 分析层眼里的一条文件。`ext` 是 `extKeyOf(name)` 的结果，`atimeMs` 是 Task 2 的活。 */
export interface AnalysisFile {
  name: string
  path: string
  size: number
  ext: string
  mtimeMs: number
}

/**
 * 引擎唯一依赖的读取面。`TreeStore` 结构上直接满足（`tests/unit/analysis-engine.test.ts`
 * 有一条 `const direct: AnalysisSource = s` 的编译期断言），所以不需要适配器 —— 与
 * `RuleTreeSource` / `DupSource` / `DirStatsNode` 同一模式。
 *
 * 三个必需成员是**遍历的下界**：`childrenOf` 给全量清单，`dirIdByPath` 用来核对
 * 「父链上的 dirId 与路径索引是否自相矛盾」（缺了它就无从判断 `dirId=9999` 是幽灵还是新目录），
 * `rootId` 是哨兵。可选的是**只读便利**：TreeStore 全都有，测试里的合成 source 可以不给，
 * 少给一个只会让对应的字段变成 0 / `''`，绝不会让结果说谎成"算过了"。
 */
export interface AnalysisSource {
  readonly rootId: number
  dirIdByPath(path: string): number | undefined
  childrenOf(dirId: number): readonly ChildView[]
  /** 目录 → 路径（根路径要用；不给就是 `''` → `rootIsDrive` 为 false）。 */
  pathOf?(dirId: number): string
  /** 目录 → 子树合计（`shareOfRoot` 的分母；不给则分母为 0，占比一律 0）。 */
  sizeOf?(dirId: number): number
  /** 节点存在性第二道核对（`childrenOf` 的 `dirId` 是否还挂在树上）。 */
  getDir?(dirId: number): unknown
  /** 扫描层 `maxFiles` 是否截断过存储列表 —— 截断过的树，榜与统计都只是那"一部分"。 */
  readonly truncated?: boolean
}

export interface AnalysisOptions {
  topK?: number
  dirTopK?: number
  thresholds?: readonly number[]
  budget?: number
}

export interface AnalysisExtensionRow {
  ext: string
  label: string
  fileCount: number
  totalSize: number
  averageSize: number
  largestFile: AnalysisFile | null
  shareOfRoot: number
}

export interface AnalysisDirectoryRow {
  path: string
  name: string
  size: number
  fileCount: number
  directoryCount: number
  shareOfRoot: number
}

export interface AnalysisResult {
  generatedAtMs: number
  rootPath: string
  rootSize: number
  rootIsDrive: boolean
  /** 见过的文件条数 —— 全量口径，与 `topK` 留没留无关。 */
  files: number
  /** 被分析过的目录数，**不含根**（根是 `rootSize` 那个分母，不是榜上的一项）。 */
  dirs: number
  /** 见过的文件字节之和 —— 全量口径。 */
  bytes: number
  /** 存储层因 `maxFiles` 丢过文件记录：走盘只存了一部分，上面这些数就只是那一部分。 */
  truncated: boolean
  /** 弹出的目录数。不变量 `visited <= budget`（UI 会引用这句）。 */
  visited: number
  /** 预算用尽、有子树没看完 —— 此时上面所有数都只是局部结论，UI 必须点名。 */
  partial: boolean
  topFiles: AnalysisFile[]
  largestFile: AnalysisFile | null
  /** **留下的**那 k 条之和（§9「Top 100 文件总占用」），不是全量 —— 全量叫 `bytes`。 */
  topFilesTotalBytes: number
  thresholds: ThresholdRow[]
  extensions: AnalysisExtensionRow[]
  directories: AnalysisDirectoryRow[]
  warnings: AnalysisWarnings
}

/** 规格书 §2 的五档预设，按档位升序写（展示顺序由 `ThresholdBuckets.rowsOut()` 反过来）。 */
export const DEFAULT_THRESHOLDS: readonly number[] = [100 * 1024 * 1024, 500 * 1024 * 1024, 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024, 10 * 1024 * 1024 * 1024]

/** §1 的默认榜长（UI 会显式给 20/50/100）。 */
export const DEFAULT_TOP_K = 100
/** §4 目录榜默认 20 行（「目录空间 Top 20」）。 */
export const DEFAULT_DIR_TOP_K = 20
/**
 * 默认节点预算。`dir-stats.ts` 的 `computeDirStats` 用的是同一个数、同一层含义
 * （「一次点一格」与「一次点全盘」在这里是同一类活），Task 7 的 1M 档 `partial === false`
 * 按它反推，跑完再调阈值是不许的。
 */
export const DEFAULT_ANALYSIS_BUDGET = 2_000_000

/**
 * 榜长的归一。判据与 `normalizeBudget` 同源：**非有限数一律不许当"无界"用**。
 * `NaN` 传进 `new MinHeap(NaN, …)` 会得到一个 `a.length < NaN` 恒假的堆 ——
 * 那条防线不是"变小"，是整条失效；所以 NaN/Infinity/负数都回落到默认值。
 * `0` 是**合法**输入（"我只要计数不要榜"，`TopK` 自己保证计数照走）。
 */
const normalizeCount = (v: number | undefined, dflt: number): number =>
  v === undefined || !Number.isFinite(v) || v < 0 ? dflt : Math.floor(v)

/**
 * 阈值档数组的归一。**只有"没给数组"才回落到默认**；给了但全是非有限数（或本来就该空）
 * 就是空表 —— 零行阈值是一个答案（"这档一行都不出"），不是崩溃，所以不替用户改回去。
 * 非有限数逐条剔掉：NaN 档会产出一行 UI 渲染不出的答案。
 */
const normalizeThresholds = (mins: readonly number[] | undefined): number[] => {
  if (!Array.isArray(mins)) return [...DEFAULT_THRESHOLDS]
  return mins.filter((m) => Number.isFinite(m))
}

/** 扩展名行的定序：总大小降序 → 扩展名升序（`ext` 在表里唯一 ⇒ 全序）。 */
const extOrder = (a: { totalSize: number; ext: string }, b: { totalSize: number; ext: string }): number =>
  b.totalSize - a.totalSize || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0)

/**
 * 一次遍历。`nowMs` 由调用方给（可复现：同一棵树 + 同一个 nowMs ⇒ 逐字节相同的输出，
 * 用例里就有一条 `JSON.stringify` 相等在钉这件事）。
 */
export function runAnalysis(source: AnalysisSource, rootId: number, o: AnalysisOptions, nowMs: number): AnalysisResult {
  const fileRank = new TopK<AnalysisFile>(normalizeCount(o.topK, DEFAULT_TOP_K))
  const dirRank = new TopK<DirEntry>(normalizeCount(o.dirTopK, DEFAULT_DIR_TOP_K))
  const ext = new ExtTable()
  const buckets = new ThresholdBuckets(normalizeThresholds(o.thresholds))
  const warn = new WarningSink()
  const max = normalizeBudget(o.budget ?? DEFAULT_ANALYSIS_BUDGET)

  const rootPath = source.pathOf?.(rootId) ?? ''
  const rawRootSize = source.sizeOf?.(rootId) ?? 0
  const rootSize = Number.isFinite(rawRootSize) && rawRootSize >= 0 ? rawRootSize : 0
  if (rootSize === 0 && rawRootSize !== 0) warn.add('negative-size', rootPath, `根目录 size=${String(rawRootSize)} 不是有限非负数，占比分母按 0 处理`)
  /** 分母为 0 一律给 0，让 UI 显示 `—`（不显示没算过的数字）。 */
  const share = (size: number): number => (rootSize > 0 ? (size / rootSize) * 100 : 0)

  let visited = 0
  let work = 0
  let partial = false
  let fileCount = 0
  let dirCount = 0
  let byteTotal = 0
  let largestFile: AnalysisFile | null = null

  // 显式栈，不是递归。`seenDir` 保证每个 dirId 至多被分析一次（入栈前就先登记），
  // 所以栈长 ≤ 树上的目录数，且预算一断就当场停 —— 双侧计费的理由见下面两处 `>= max`。
  const stack: Array<{ dirId: number; path: string }> = [{ dirId: rootId, path: rootPath }]
  const seenDir = new Set<number>([rootId])

  outer: while (stack.length > 0) {
    // 弹出侧计费：守 `visited <= max`（UI 要拿这个数说"看了多少个目录"）。
    // `max >= 1` 由 `normalizeBudget` 保证 ⇒ 至少走完被问的那个根自己，绝不空手报 partial。
    if (visited >= max) {
      partial = true
      warn.add('budget-exhausted', stack[stack.length - 1]!.path, `节点预算 ${max} 用尽，栈里还有 ${stack.length} 个目录没看`)
      break
    }
    const cur = stack.pop()!
    visited++
    let kids: readonly ChildView[] | undefined
    try {
      kids = source.childrenOf(cur.dirId)
    } catch (e) {
      warn.add('bad-child', cur.path, `读取子节点失败：${(e as Error).message}`)
      continue
    }
    // 坏读面（返回 undefined / 非数组）只记一条告警就跳过：`for…of` 在这里会 TypeError，
    // 那会把整轮分析炸掉，而 §13 要的是"异常数据不中断分析"。
    if (kids === null || kids === undefined || typeof (kids as { length?: unknown }).length !== 'number') {
      warn.add('bad-child', cur.path, 'childrenOf 返回的不是数组，该层未分析')
      continue
    }
    for (const c of kids) {
      if (c.kind === 'file') {
        // 先验后计：NaN 一旦进 `byteTotal`，整份报告的所有求和都会变成 NaN（那才是真炸）。
        if (!(c.size >= 0) || !Number.isFinite(c.size)) {
          warn.add('negative-size', c.path, `size=${String(c.size)} 不是有限非负数，未计入`)
          continue
        }
        const rec: AnalysisFile = { name: c.name, path: c.path, size: c.size, ext: extKeyOf(c.name), mtimeMs: c.mtimeMs }
        fileCount++
        byteTotal += c.size
        fileRank.push(rec)
        ext.add(rec)
        buckets.add(c.size)
        if (largestFile === null || betterFile(rec, largestFile)) largestFile = rec
        continue
      }
      if (c.kind !== 'directory') {
        warn.add('bad-child', c.path, `未知节点类型 ${String(c.kind)}，未计入`)
        continue
      }
      if (c.dirId === undefined) {
        warn.add('bad-child', c.path, '目录视图没带 dirId，无法下钻')
        continue
      }
      // 同一目录被两个父引用（疑似环 / 重复挂载）：只分析**第一次**，第二次点名。
      // 去重只作用在"同一个 dirId 被引用两次"这种损坏情形上 —— 父子目录同时进榜是刻意的
      // （规格书 §4 是全树排行），父子重复计入由页面上那句话点名，不在这里悄悄折叠。
      if (seenDir.has(c.dirId)) {
        warn.add('bad-child', c.path, '同一目录被两个父引用（疑似环或重复挂载），只分析第一次')
        continue
      }
      // 路径索引与父链必须自洽：`dirIdByPath(子路径) !== 子 dirId` 说明这棵树自己都对不上号。
      if (source.dirIdByPath(c.path) !== c.dirId || (source.getDir !== undefined && source.getDir(c.dirId) === undefined)) {
        warn.add('missing-node', c.path, `dirId=${c.dirId} 在树里不存在（路径索引对不上），该子树未分析`)
        continue
      }
      // 入栈侧计费：一个目录弹出的同时会往栈里放"它全部子目录"个条目，只按弹出计费的预算
      // 挡不住 `stack.length` 长到 O(预算 × 扇出)（V0.2 Task 4 评审抓的就是这个）。
      // 两条一起封死：`visited <= max` 且 `stack.length <= work <= max`。
      if (work >= max) {
        partial = true
        warn.add('budget-exhausted', cur.path, `节点预算 ${max} 用尽，${cur.path} 这一层的剩余子目录未分析`)
        break outer
      }
      work++
      seenDir.add(c.dirId)
      dirCount++
      if (!(c.size >= 0) || !Number.isFinite(c.size)) {
        // 聚合值坏了只影响"这条能不能进榜"，**不影响下钻**：里面的文件还要逐条看，
        // 漏计文件比少一行榜严重得多。点名，然后把子树照常走。
        warn.add('negative-size', c.path, `目录聚合 size=${String(c.size)} 不是有限非负数，未进榜但已分析`)
      } else {
        dirRank.push({ path: c.path, name: c.name, size: c.size, fileCount: c.fileCount, directoryCount: c.dirCount })
      }
      stack.push({ dirId: c.dirId, path: c.path })
    }
  }

  const topFiles = fileRank.entries()
  return {
    generatedAtMs: nowMs,
    rootPath,
    rootSize,
    rootIsDrive: isDriveRootPath(rootPath),
    files: fileCount,
    dirs: dirCount,
    bytes: byteTotal,
    truncated: source.truncated === true,
    visited,
    partial,
    topFiles,
    largestFile,
    // §9「Top 100 文件总占用」= **留下的**那些条之和；全量那一本叫 `bytes`。别混。
    topFilesTotalBytes: topFiles.reduce((s, x) => s + x.size, 0),
    thresholds: buckets.rowsOut(),
    extensions: ext.rows().sort(extOrder).map((r) => ({ ...r, shareOfRoot: share(r.totalSize) })),
    directories: dirRank.entries().map((d) => ({
      path: d.path,
      name: d.name,
      size: d.size,
      fileCount: d.fileCount,
      directoryCount: d.directoryCount,
      shareOfRoot: share(d.size)
    })),
    warnings: warn.snapshot()
  }
}
