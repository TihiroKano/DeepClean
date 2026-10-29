import { baseName, extOf, joinWin, normalizeKey, parentOf } from '../fs/pathutil'
import { computeDirStats } from '../analyze/dir-stats'
import { MinHeap } from './heap'
import type { ChildView, DirStats, FileHit, ScanCounters, SkippedWire } from '../../shared/types'

export interface FileEntry {
  name: string
  size: number
  mtimeMs: number
  /**
   * 创建时间（§8 文件详情），与 size/mtime/attrs 同一次 stat 读出的。
   * 必需字段：可选就会诱导下游 `?? 0`，把「没采到」画成 1970-01-01。
   * 只用于展示，**绝不参与聚合**（见 addFilesToDir：这里一个 birthtime 都不读）。
   */
  birthtimeMs: number
  /**
   * 已证明的 FILE_ATTRIBUTE_* 位（§4.1），与 size/mtime 同一次 stat 读出的。
   * 只用于展示与分类判据，**绝不参与聚合**（见 addFilesToDir：这里一个属性都不读）。
   */
  attrs: number
}

export interface DirRecord {
  id: number
  name: string
  path: string
  parentId: number | null
  /** 后序聚合出来的总大小（直属文件 + 所有子孙）。 */
  size: number
  /** 只算本目录直属文件。 */
  directSize: number
  /**
   * 直属文件条数，与 files.length 分开维护：
   * 超过 maxFiles 之后 files 列表不再存（防 OOM），但计数必须真实（§28 不崩 + 统计仍对）。
   */
  directFileCount: number
  /** 聚合后的文件数（子树全部）。setLive 期间是中间值。 */
  fileCount: number
  /** 聚合后的子目录数（子树全部）。 */
  dirCount: number
  childIds: number[]
  files: FileEntry[]
  mtimeMs: number
  /** 本目录直属文件里最新的 mtime。目录自身的 mtimeMs 由 finalizeDir 取"子树内最新"。 */
  directMtimeMs: number
  scanned: boolean
  /** true = 正在扫描、数字是中间值（§7 增量出图）。 */
  live: boolean
}

const ZERO: ScanCounters = {
  files: 0,
  dirs: 0,
  totalBytes: 0,
  denied: 0,
  missing: 0,
  busy: 0,
  otherErrors: 0,
  skipped: 0
}

/**
 * 被拒路径清单上限：真实 C 盘一轮能撞上上千个 EPERM 目录，无界存会顶掉 §16 的内存预算。
 *
 * 这个数**只约束"能点名哪些"**：`denied` 计数器照旧数到 100,000（见 `addError`）。
 * 截断一个计数才是这一版最不该犯的错 —— 一份少报了几个 GB 的地图和量全了的地图长得一模一样，
 * 而 `sampleOverflow` 就是"还有多少没列出来"那句真话。
 * 200 × 平均 ~120 字节的绝对路径 ≈ 24 KB，一轮扫描一份，代价可以忽略。
 */
export const MAX_DENIED_SAMPLE = 200

/**
 * `levelOf` 的默认排除集。必须是模块级常量而不是 `new Set()` 默认实参：
 * 地图轮询本层时每 400ms 调一次 `levelOf`，默认实参每次新造一个 Set 就是白给 GC 挂活。
 */
const NO_EXCLUSIONS: ReadonlySet<number> = new Set<number>()

/** `TreeStore.excludedTotals()` 的空集返回。冻结的理由同上：`children()` 每 400ms 被轮一次。 */
const NO_EXCLUDED_TOTALS: Readonly<{ count: number; bytes: number }> = Object.freeze({ count: 0, bytes: 0 })

/**
 * **层级页排序的唯一口径**：size 降序，同 size 按 name 的 `localeCompare` 升序。
 *
 * `childrenOf`（完整计价口径的全量排序）与 `levelOf` 的有界快路径**共用这一个定义** ——
 * 两条路径各写一份比较器迟早会漂，而它们漂的那一刻就是「地图上少了一项、计价里还在」的那一刻。
 * 参数取 `{size, name}` 这个最小形状，所以 `ChildView` / `DirRecord` / `FileEntry` 三种实体都能直接进来比：
 * 快路径因此**不必为了比较而造视图对象**。
 */
export type LevelSortable = { readonly size: number; readonly name: string }
export const LEVEL_ORDER = (a: LevelSortable, b: LevelSortable): number =>
  b.size - a.size || a.name.localeCompare(b.name)

/**
 * 目录 → ChildView。**只有这一处**构造：`childrenOf` 与 `levelOf` 快路径的胜出项都走它。
 * 载荷是 `JSON.stringify` 出去的，键序也是契约的一部分，所以「两条路径造出的对象长得一样」
 * 必须由同一段字面量保证，而不是靠两个副本各自被记得改。
 */
function dirView(k: DirRecord, dirId: number): ChildView {
  return {
    kind: 'directory',
    name: k.name,
    path: k.path,
    dirId,
    size: k.size,
    mtimeMs: k.mtimeMs,
    fileCount: k.fileCount,
    dirCount: k.dirCount,
    scanning: k.live,
    // null = 目录本轮不 stat，属性与创建时间都"没采"，不是"采了且为空"
    attrs: null,
    birthtimeMs: null
  }
}

/** 文件 → ChildView。同上：唯一构造点，`path` 的拼法也只在这一处。 */
function fileView(parentPath: string, f: FileEntry): ChildView {
  return {
    kind: 'file',
    name: f.name,
    path: joinWin(parentPath, f.name),
    size: f.size,
    mtimeMs: f.mtimeMs,
    fileCount: 0,
    dirCount: 0,
    attrs: f.attrs,
    birthtimeMs: f.birthtimeMs
  }
}

/** 只换下标数组里的两个位置（选择算法唯一的写操作）。 */
function swapIdx(a: Int32Array, i: number, j: number): void {
  if (i === j) return
  const t = a[i]!
  a[i] = a[j]!
  a[j] = t
}

/** 两条选择算法的轮数预算：期望 ~10 轮收敛，64 轮是"随机主元失手"的保险丝，见下面两个函数。 */
const SELECT_ROUND_BUDGET = 64

/**
 * 选择算法的伪随机源。**不是** `Math.random()`：定种子的 xorshift32 ⟹ 同一棵树连调两次的
 * 划分序列逐字相同，"留哪 1,200 项必须可复现"那条用例要的就是这个（答案本来就与主元无关，
 * 但轮数可复现才能让基准第二遍与第一遍可比）。
 */
let selectRand = 0x2f6e2b1
function nextSpan(span: number): number {
  selectRand ^= selectRand << 13
  selectRand ^= selectRand >>> 17
  selectRand ^= selectRand << 5
  return (selectRand >>> 0) % span
}

/** 三个数/三个位置的中位数（三采样主元，见 `selectNthLargest`）。 */
function median3(a: number, b: number, c: number): number {
  const hi = a > c ? a : c
  const lo = a < c ? a : c
  return b < lo ? lo : b > hi ? hi : b
}

/**
 * 3 路（Dutch national flag）快速选择：只置换 `or`、只比 `sz[or[i]]` 这**一个数字**，
 * 返回降序第 `rank` 名（0 基）的 size；`or` 顺带被划分成 `>piv / ==piv / <piv` 三段。
 *
 * 为什么不是 `sort`：全排序正是本 Task 要省掉的那笔钱 —— 30 万项要 5.4M 次比较，
 * 而且同 size 档里每次比较还要跑一次 `localeCompare`。这里期望 ~2n 次纯数字比较、一次都不碰名字；
 * 大量同分（1M 夹具 30 万项只有 997 个不同 size）正是 3 路划分的主场：`==piv` 段含住 rank 就当场收工。
 *
 * **主元必须随机取，不能取 `lo/mid/hi` 三个端点**。这一条是被 1M 夹具实测打出来的第一版教训：
 * 夹具的 size 是 `1 + (i % 997)`，端点采样在"按周期循环"的数据上系统性采到带内最大值 ——
 * trace 出来是每轮 `piv` 恰好 +1、每轮只削掉一个 300 项的档，997 档要 997 轮，
 * 于是每次都撞穿预算掉进兜底（`levelOf` 实测 939 ms，比全排序还慢 3 倍）。
 * 三采样主元的分位数服从 Beta(2,2)（均值 0.5）⟹ 每轮期望把范围砍到 ~0.4 倍（30 万项期望个位数轮数收敛；
 * 这是按期望收缩率的推算，**不是实测读数**），而且对"输入有什么结构"不敏感 —— 端点采样会被循环分布挑死，随机采样不会。
 *
 * 仍带 `SELECT_ROUND_BUDGET` 轮预算：随机主元只是"坏得极快"的概率低，不是为零。
 * 超预算返回 `null`，调用方走**数值数组原生排序**的兜底（`Float64Array#sort` 无比较器 = 原生数字序，
 * 30 万项 ~20 ms，比在这里跑 5.4M 次 `cmpPos` 便宜一个数量级）——
 * **兜底只许换时间，不许换答案**，这条是这个函数唯一的正确性红线。
 */
function selectNthLargest(sz: Float64Array, or: Int32Array, n: number, rank: number): number | null {
  let lo = 0
  let hi = n - 1
  for (let round = 0; round < SELECT_ROUND_BUDGET; round++) {
    if (lo === hi) return sz[or[lo]!] ?? null
    if (lo > hi) return null // rank 越界（不该发生）：交给兜底，绝不猜
    const span = hi - lo + 1
    const piv = median3(
      sz[or[lo + nextSpan(span)]!]!,
      sz[or[lo + nextSpan(span)]!]!,
      sz[or[lo + nextSpan(span)]!]!
    )
    let gt = lo
    let i = lo
    let lt = hi
    while (i <= lt) {
      const v = sz[or[i]!]!
      if (v > piv) {
        swapIdx(or, gt, i)
        gt++
        i++
      } else if (v < piv) {
        swapIdx(or, i, lt)
        lt--
      } else i++
    }
    if (rank < gt) hi = gt - 1 // 目标在「严格更大」那一段
    else if (rank > lt) lo = lt + 1 // 目标在「更小」那一段（前面已放好的都比它大）
    else return piv // 目标落在 ==piv 带里：第 rank 大的值就是 piv
  }
  return null
}

/**
 * 把 `or[0..n)` 里 `cmp` 序最小的 `k` 个选到 `or[0..k)`（组内顺序不管，调用方自己排这 k 个）。
 * 返回 `false` = 超预算，调用方整段排序兜底（答案不变）。
 *
 * 这里的 `cmp` 是 `TreeStore` 里的 `cmpPos` = `LEVEL_ORDER` + 枚举序兜底，
 * 因此是**严格全序**（`cmpPos(x, y) === 0 ⟺ x === y`）⇒ `==piv` 段永远只有主元自己一个元素，
 * 三段划分在这条上退化成两段也不影响判定。这一条不是顺手的事实：正因为没有并列，
 * 「边界那一档里该留哪几个」才有唯一答案，选择才不可能多留一个或少留一个。
 * 主元同样随机三采样，理由见 `selectNthLargest`。
 */
function selectFirstBy(or: Int32Array, n: number, k: number, cmp: (x: number, y: number) => number): boolean {
  let lo = 0
  let hi = n - 1
  for (let round = 0; round < SELECT_ROUND_BUDGET; round++) {
    if (lo >= hi) return true
    const span = hi - lo + 1
    const p1 = or[lo + nextSpan(span)]!
    const p2 = or[lo + nextSpan(span)]!
    const p3 = or[lo + nextSpan(span)]!
    // 三个候选位置按 cmp 取中位（写成嵌套三目会糊成一团，这里最多 3 次比较）
    const piv = cmp(p1, p2) < 0 ? (cmp(p2, p3) < 0 ? p2 : cmp(p1, p3) < 0 ? p3 : p1) : cmp(p1, p3) > 0 ? p1 : cmp(p2, p3) > 0 ? p3 : p2
    let gt = lo
    let i = lo
    let lt = hi
    while (i <= lt) {
      const c = cmp(or[i]!, piv)
      if (c < 0) {
        swapIdx(or, gt, i)
        gt++
        i++
      } else if (c > 0) {
        swapIdx(or, i, lt)
        lt--
      } else i++
    }
    if (k <= gt) hi = gt - 1 // k 个最小的全在「比主元靠前」那一段
    else if (k <= lt + 1) return true // <piv ∪ ==piv 已经够 k 个（==piv 只有主元自己）
    else lo = lt + 1
  }
  return false
}

/**
 * 全量目录树存储：整棵树留在主进程内存，渲染进程只按层取 children。
 * 纯逻辑，不 import electron / node API（被 node + web 两个 tsconfig 共享）。
 */
export class TreeStore {
  private readonly dirs = new Map<number, DirRecord>()
  private readonly byKey = new Map<string, number>()
  /** nextId 必须从 0 起：Task 9 的 useTreeNav 用 dirId 0 作为 root 哨兵，两处必须一致。 */
  private nextId = 0
  private readonly c: ScanCounters = { ...ZERO }
  /**
   * §15：被拒目录的路径清单（**只有 denied**，最多 `MAX_DENIED_SAMPLE` 条，按发生顺序）。
   *
   * 为什么住在 store 而不是扫描进度事件里：这份清单必须和 `c.denied` 活在同一具身体上
   * （两者是同一个数字的两个面，分两处就会漂移），而取消/完成的扫描照样要能被问一句
   * "刚才跳过了哪些" —— 事件流在扫描结束后就不再有下一个了。
   */
  private readonly deniedList: string[] = []
  private readonly maxFiles: number
  /** 实际存进内存的文件条数，是截断的判据（与"见过多少文件"分开记）。 */
  private storedFiles = 0
  /**
   * 注入扩展名的**全量**计数（§3.6 AI 那一格的数从这里来）。
   *
   * `null` = 没人要这个统计，`addFilesToDir` 一趟连查都不查。集合的内容由调用方决定
   * （生产上是 `electron/services/scan-service.ts` 把 `core/analyze/model-files.ts` 的清单传进来）——
   * **扫描层不知道"模型文件"是什么**，它只按一串扩展名数数，依赖方向因此没有反转。
   *
   * 为什么站在这条路径上而不是"谁要谁现扫一遍树"：全树内存遍历在同一棵 30 万文件的树上要
   * 0.72–1.49 s（`scripts/_bench-model-tally.mjs`），而它跑在**主进程**上 —— 为一格文案钉住
   * 扫描事件流与 Treemap 的 400 ms 轮询不是一笔好买卖。顺带累加的代价落在噪声里（同一实测：
   * 建树耗时注入 2.44–2.66 s 对 不注入 2.69–2.74 s）。那份脚本是本地探针
   * （`scripts/_*.mjs` 按规矩不入库），所以这两个读数换机器要重跑，不是随克隆可复现。
   */
  private readonly countExts: Set<string> | null
  private extCount = 0
  private extBytes = 0
  readonly rootId: number
  readonly topHeap: MinHeap<FileHit>
  truncated = false

  constructor(opts: { rootPath: string; maxFiles: number; topN?: number; countExts?: readonly string[] }) {
    this.maxFiles = opts.maxFiles
    this.topHeap = new MinHeap<FileHit>(opts.topN ?? 100, (f) => f.size)
    // 键形状当场归一（补点 + 小写），与 `extOf` 的产物同形。不要求调用方传对：
    // 一个没点的键不会报错，只会**永远数出 0**，而 0 在界面上是一句看起来可信的话。
    this.countExts =
      opts.countExts === undefined || opts.countExts.length === 0
        ? null
        : new Set(opts.countExts.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()))
    this.rootId = this.beginDir(opts.rootPath)
  }

  /** 注入扩展名的条数与字节之和；没注入时是 `{0,0}` 而不是 `null`（"没要过"与"数出来是零"在界面上必须是两句话，那句话由调用方带着 `countExts` 存不存在来回答）。 */
  extTotals(): { count: number; bytes: number } {
    return { count: this.extCount, bytes: this.extBytes }
  }

  beginDir(path: string): number {
    const key = normalizeKey(path)
    const hit = this.byKey.get(key)
    if (hit !== undefined) return hit
    const rec: DirRecord = {
      id: this.nextId++,
      name: baseName(path) || path,
      path,
      parentId: null,
      size: 0,
      directSize: 0,
      directFileCount: 0,
      fileCount: 0,
      dirCount: 0,
      childIds: [],
      files: [],
      mtimeMs: 0,
      directMtimeMs: 0,
      scanned: false,
      live: false
    }
    this.dirs.set(rec.id, rec)
    this.byKey.set(key, rec.id)
    this.c.dirs++
    // 父级已经在树上就自动挂上去：新建的中间层立刻出现在父级 children 里（§7「发现 Users → 立即显示 Users」）。
    // 之后显式 attachChild 仍安全，靠 childIds 去重不双计。
    const pp = parentOf(path)
    const pid = pp === null ? undefined : this.byKey.get(normalizeKey(pp))
    if (pid !== undefined) this.attachChild(pid, rec.id)
    return rec.id
  }

  getDir(id: number): DirRecord | undefined {
    return this.dirs.get(id)
  }

  dirIdByPath(path: string): number | undefined {
    return this.byKey.get(normalizeKey(path))
  }

  attachChild(parentDirId: number, childDirId: number): void {
    const p = this.dirs.get(parentDirId)
    const k = this.dirs.get(childDirId)
    if (!p || !k || p.childIds.includes(childDirId)) return
    // 拒接自环 / 把父挂到子下面：finalizeDir 是递归的，成环会栈溢出
    for (let cur: number | null = parentDirId; cur !== null; cur = this.dirs.get(cur)?.parentId ?? null) {
      if (cur === childDirId) return
    }
    p.childIds.push(childDirId)
    k.parentId = parentDirId
    p.dirCount += 1
  }

  /**
   * 每看见一个文件就计一次。
   * 计数字段（c.files / c.totalBytes）必须走这里而不是 addFilesToDir：后者在 seed 子树
   * 扫完才调用，真实 C 盘上 `C:\Windows\WinSxS` 这种单个 seed 要跑几分钟，
   * 期间 HUD 的「已扫描文件 / 已发现空间」会整整冻住不动 —— 直接违反 §7。
   * （100k / 500k 夹具的 seed 都是毫秒级完成，所以那两档对账抓不到这个缺陷。）
   */
  noteSeenFile(size: number): void {
    this.c.files++
    this.c.totalBytes += size
  }

  addFilesToDir(dirId: number, files: FileEntry[]): void {
    const d = this.dirs.get(dirId)
    if (!d) return
    for (const f of files) {
      // 这里只吃 size / mtimeMs：f.attrs 供展示与分类判据、f.birthtimeMs 只供展示，两者原样存进 files，
      // **不参与任何求和/计数** —— §35.2 的 100k/500k 三轴精确对账就是这么保住不动的。
      d.directSize += f.size
      d.directFileCount++
      if (f.mtimeMs > d.directMtimeMs) d.directMtimeMs = f.mtimeMs
      // 扩展名只算一次，榜与注入计数共用（判据仍是那一份 `extOf`，不许有第二份）。
      const ext = extOf(f.name)
      // 截断/零字节都拦不住这一格：它在**截断闸之前**累加，与 `directFileCount` 同一侧。
      // 少了几个 G 的模型没被数，在界面上会伪装成"这台机器上没有"，那才是事故。
      if (this.countExts !== null && this.countExts.has(ext)) {
        this.extCount++
        this.extBytes += f.size
      }
      if (f.size > 0) {
        this.topHeap.push({
          name: f.name,
          path: joinWin(d.path, f.name),
          size: f.size,
          mtimeMs: f.mtimeMs,
          ext
        })
      }
      // 截断只看"实际存进内存的文件条数"（内存压力来自列表本身），
      // 且只丢 d.files 的存储：directSize / directFileCount / 计数继续累加
      if (this.storedFiles >= this.maxFiles) {
        this.truncated = true
        continue
      }
      d.files.push(f)
      this.storedFiles++
    }
  }

  setLive(dirId: number, size: number, fileCount: number, scanning: boolean): void {
    const d = this.dirs.get(dirId)
    if (!d) return
    d.size = size
    d.fileCount = fileCount
    d.live = scanning
  }

  setDirMtime(id: number, ms: number): void {
    const d = this.dirs.get(id)
    if (d) d.mtimeMs = ms
  }

  sizeOf(id: number): number {
    return this.dirs.get(id)?.size ?? 0
  }

  /**
   * 自底向上聚合：由 walk 的调用方保证子目录先 finalize（Task 5 的 walk 是后序返回的）；
   * 这里自带递归，所以顺序不对时结果仍然正确。
   */
  finalizeDir(dirId: number): { size: number; fileCount: number; dirCount: number } {
    const d = this.dirs.get(dirId)
    if (!d) return { size: 0, fileCount: 0, dirCount: 0 }
    let size = d.directSize
    let fc = 0
    // 以 childIds.length 起算而不是累加 d.dirCount：重复 finalize 才幂等
    let dc = d.childIds.length
    let mt = d.directMtimeMs
    for (const cid of d.childIds) {
      const sub = this.finalizeDir(cid)
      size += sub.size
      fc += sub.fileCount
      dc += sub.dirCount
      const cm = this.dirs.get(cid)?.mtimeMs ?? 0
      if (cm > mt) mt = cm
    }
    d.size = size
    // 计数用 directFileCount，不能用 files.length（截断后列表是残缺的）
    d.fileCount = d.directFileCount + fc
    d.dirCount = dc
    // 目录的"修改时间"取子树内最新，而不是目录项自己的 mtime：
    // 后者要每个目录多一次 stat（C 盘 ~8 万目录），代价不值，且"里面最近动了什么"更有用。
    d.mtimeMs = mt
    d.scanned = true
    d.live = false
    return { size: d.size, fileCount: d.fileCount, dirCount: d.dirCount }
  }

  stats(): ScanCounters {
    return {
      ...this.c,
      skipped: this.totalSkipped()
    }
  }

  /**
   * 「共跳过」的唯一算式：四个错误计数器之和。
   *
   * `stats().skipped` 与 `skipped().total` 曾经是两份逐字重复的求和，于是将来加第五种错误种类时
   * 只改一处就会让两个读面（快照计数器 / §15 那一栏）静默分叉 —— 这正是本 Task 在治的那类病。
   */
  private totalSkipped(): number {
    return this.c.denied + this.c.missing + this.c.busy + this.c.otherErrors
  }

  /**
   * 记一笔"这一项没算进来"。
   *
   * 两件事分开做，顺序也不能倒：**先无条件计数**，再考虑清单放不放得下。
   * 清单只是计数器的前若干项，绝不允许反过来决定计数长多大（`denied` 数到 100,000 而清单只有 200 条
   * 是正确状态；反过来让 `denied` 跟着清单停在 200 就是 §15 要治的那个病 —— 一个被截断的计数比没有计数更坏，
   * 因为它看起来像结论）。
   *
   * `path` 可选：所有既有调用点（拿不到路径的兜底 catch）保持兼容，那种情况下差额全部体现在
   * `sampleOverflow` 上，等式 `sample.length + sampleOverflow === denied` 照样闭合。
   * 只有 `denied` 收路径 —— 用户要问的是"哪些目录没被计量"；`missing`/`busy` 是瞬态（文件消失、被别人占着），
   * 点名它们没有可执行的意义，把它们混进这份"没算进来的目录"清单反而会稀释掉真正要看的那些。
   */
  addError(kind: 'denied' | 'missing' | 'busy' | 'otherErrors', path?: string): void {
    this.c[kind]++
    if (kind === 'denied' && path && this.deniedList.length < MAX_DENIED_SAMPLE) this.deniedList.push(path)
  }

  /**
   * §15「部分数据无法访问 · 共跳过 N 个」的那一份数据。
   * 返回的是**副本**：这条数组会直接进 IPC 与渲染端状态，不许外面改到 store 自己的清单。
   */
  skipped(): SkippedWire {
    return {
      total: this.totalSkipped(),
      denied: this.c.denied,
      missing: this.c.missing,
      busy: this.c.busy,
      otherErrors: this.c.otherErrors,
      sample: this.deniedList.slice(),
      sampleOverflow: Math.max(0, this.c.denied - this.deniedList.length)
    }
  }

  /**
   * 视图排除集（Task 7 的「排除该目录」）：只影响地图这一层回给渲染端的内容。
   *
   * 三件事它**不**做，都是要命的边界：
   * 1. **不改任何数字**：`size` / `fileCount` / `dirCount` 一律照旧是完整子树口径。
   *    父级显示的容量若被扣掉，地图就会与计数器、与 §35.2 的三轴对账同时分叉。
   * 2. **不碰 `childrenOf`**：那是计价路径（规则引擎 / 重复检测 / 扫描报告都读它），
   *    漏进去就等于「把目录从地图上藏起来、清理预估照旧删它的文件」这种隐藏式误删。
   *    守它的是 `tests/unit/rules-engine.test.ts` 末尾那条安全哨兵。
   * 3. **不是「扫描时跳过」**：那要重扫、会改计数、还会动 §15 的跳过账（Task 9 的 `SkippedWire`
   *    与此完全无关，两个面板的措辞也不许互相借用）。规格书 §7 要的是"这块噪音我先不看"。
   *
   * 归属：住在 store 上 = 跟着这次扫描任务活，任务没了它也就没了（不跨轮、不落盘）。
   * 视图状态的所有者必须是**这一轮扫描**，因为 `dirId` 只在本次扫描的树里有意义 ——
   * 存到渲染端会跨轮复活成别的树的 id，存到磁盘上更是把"我先不看这块"做成了永久配置。
   */
  private readonly viewExcluded = new Set<number>()

  /**
   * 这个目录现在**能不能**被排除：必须是真实存在的目录、且不是扫描根。
   * 排除根等于给用户一张空图（这一轮再也没有任何一层可看），所以结构性地拒掉。
   * 判据只有这一处（`setViewExcluded` 与 `Scanner.setExcluded` 都问它），不许在别处再写一遍 `rootId`。
   * 渲染端那三项菜单门不吃这条：文件与合计块没有 dirId、扫描根结构性地不进任何一层的 `children`，
   * 那三条用 payload 里已有的事实就答得出来（`SpaceMap.menuFor`）。
   */
  canExclude(dirId: number): boolean {
    return this.dirs.has(dirId) && dirId !== this.rootId
  }

  setViewExcluded(dirId: number, excluded: boolean): void {
    if (!this.canExclude(dirId)) return
    if (excluded) this.viewExcluded.add(dirId)
    else this.viewExcluded.delete(dirId)
  }

  clearViewExclusions(): void {
    this.viewExcluded.clear()
  }

  /** 升序：这份清单要变成 `levelOf` 的入参，也要能被日志逐字对账（不许随插入顺序变）。 */
  excludedIds(): number[] {
    return [...this.viewExcluded].sort((x, y) => x - y)
  }

  /**
   * **本轮累计**的视图排除记账（Task 7 修订 Fix 2）—— 与 `levelOf` 那两个字段是**两个口径**，
   * 不是它们的替代者：`excludedCount / excludedBytes` 仍是"本层直属"的那一份（守恒等式与
   * 截图判据都靠它们），这里回答的是"这一轮我一共让地图上少了哪几块、少了多少"。
   *
   * 为什么非要有这一份：`levelOf` 的计数按构造只数本层直属子项，于是「在 `C:\b` 里排除一个目录
   * → 退回根」之后本层数是 0，而承载「清除全部排除」的横幅就挂在那个 0 上 ——
   * **过滤器的唯一指示器和唯一撤销入口会随层级一起消失**。一个坐在真删除链路旁边的视图过滤器，
   * "看不见但生效中"就是它最坏的状态。横幅改读本处的数字，它就出现在任何一层，清除入口因此永远可达。
   *
   * 口径（两条都要，否则会撒谎）：
   * - 只数**没被更上层的排除吞掉**的那些：被排除的祖先已经把整棵子树从那一层拿走了，
   *   子级再排一次不会额外少一块面积，算进去就会报出"比地图真实少掉的更多"的容量；
   * - 容量取 `sizeOf`（完整子树合计，与 `payload.size` 同一个权威口径）—— 这里**只读**它，
   *   不改 `sizeOf`、不改 `childrenOf`、不改 `levelOf`。
   *
   * 空集返回模块级常量：`children()` 每 400ms 被轮一次，没排除时不该每次新造一个对象。
   */
  excludedTotals(): { count: number; bytes: number } {
    if (this.viewExcluded.size === 0) return NO_EXCLUDED_TOTALS
    let count = 0
    let bytes = 0
    for (const id of this.viewExcluded) {
      if (this.hasExcludedAncestor(id)) continue
      count += 1
      bytes += this.sizeOf(id)
    }
    return { count, bytes }
  }

  /** 这个目录的某一位**祖先**（不含自己）也被排除了 = 它已经被那一块面积计入过一次。 */
  private hasExcludedAncestor(dirId: number): boolean {
    // 祖先链必然终止：`attachChild` 既拒自环也拒把父挂到子下面（见那里的走链），树上没有环。
    for (let cur = this.dirs.get(dirId)?.parentId ?? null; cur !== null; cur = this.dirs.get(cur)?.parentId ?? null) {
      if (this.viewExcluded.has(cur)) return true
    }
    return false
  }

  childrenOf(dirId: number): ChildView[] {
    const d = this.dirs.get(dirId)
    if (!d) return []
    const out: ChildView[] = []
    for (const cid of d.childIds) {
      const k = this.dirs.get(cid)
      if (!k) continue
      out.push(dirView(k, cid))
    }
    for (const f of d.files) out.push(fileView(d.path, f))
    return out.sort(LEVEL_ORDER)
  }

  /**
   * 视图专用：取本层**最大的 cap 项**，其余只留容量数字。
   *
   * 为什么不直接给 childrenOf 加 cap：规则引擎（core/rules/engine.ts:45）、重复检测
   * （core/dup/detect.ts:29）、扫描报告（core/report/scan-report.ts:50）都靠 childrenOf 取
   * **完整**清单来计价。收窄一旦漏进那条路径，第 1201 个之后的文件会从清理预估里静默消失 ——
   * 少报是假象，多删才是事故。所以完整口径与视图口径在这里就是两个方法。
   *
   * `excluded`（Task 7 的视图排除集）同样**只**在这条视图路径上生效，而且只作用在
   * 「它是本层直属子项」的那一个事实上：排除一个深层目录不会让它的祖父少一项。
   * 默认那个空集是常量：`children()` 每 400ms 被轮一次，没排除时不该每次新造一个 Set。
   *
   * 三份账必须闭合（`tests/unit/tree-store-view.test.ts` 钉着）：
   * - `children.length + foldedCount + excludedCount === totalChildren`
   * - `Σchildren + foldedBytes + excludedBytes === ΣchildrenOf(dirId)`
   * 被排除的容量**点名**进 `excludedBytes`，绝不并进任何真块的 `size`（那是"让地图冒充它变大了"）。
   *
   * ### Task 10b：挑这 cap 项的钱必须与 cap 有关、与本层大小无关
   *
   * 1M 夹具实测（`docs/benchmarks/results.md` §2.2）：本层 300,000 个直属项时这里要 325.7 ms，
   * 阈值 30 ms，超 10.9 倍；而 97% 花在 `childrenOf` —— 为挑出 1,200 项先造 30 万个 `ChildView`
   * 再整个排一遍。封顶只封住了「画多少格」，没封住「为挑出这些格付多少钱」，而这条每 400ms 被轮一次。
   *
   * 现在走**有界选择**（三段，全程只在数字数组上工作，一个 ChildView 都不多造）：
   * 1. 一次线性枚举原始记录（目录先、文件后 —— 与 `childrenOf` 的枚举序逐字一致），
   *    把留下项的 size 抄进 `sz`、记录句柄抄进 `ky`；顺带把 `totalChildren / excludedCount /
   *    excludedBytes / keptSum` 四份账在这一次遍历里算完。
   * 2. `selectNthLargest` 用 3 路快速选择求「第 cap 大的 size」`t`（期望 ~2n 次**纯数字**比较，不碰名字）。
   * 3. 一次线性划分：`size > t` 的全留（不足 cap 个），剩下的名额给 `size === t` 那一档里
   *    `cmpPos` 最靠前的几个 —— 于是 `localeCompare` 只在这一小撮边界同分项上跑。
   *
   * **与全量排序逐字节同解**是这里的硬契约，靠三条撑住，缺一条就会漂：
   * - 排序口径是共享的 `LEVEL_ORDER`（不是快路径自己抄的一份），且比较的是原始记录的
   *   `{size, name}` —— 与视图对象上那两个字段同源同值；
   * - 兜底用**枚举序下标**（`cmpPos = LEVEL_ORDER || x - y`）：`Array#sort` 稳定，
   *   所以 comparator 相等的两项（同 size 且同名）在 `childrenOf` 里按枚举序排，快路径要复现的
   *   正是那一个前缀；带上枚举序后 `cmpPos` 还是严格全序，"边界档里留哪几个"才有唯一答案；
   * - `foldedBytes = keptSum - chosenSum`：size 全是 `fs.stat` 的整数字节且单层合计远小于 2^53，
   *   求和顺序无关（这条前提不是新引入的 —— `noteSeenFile`/`addFilesToDir` 累加 `totalBytes`
   *   早就是任意序整数求和，§35.2 的 bytes 轴对账建立在它上面）。
   *
   * `cap < 0` 沿用旧语义 = **不封顶**（`cut = kept.length`），与 `cap ≥ 本层留下项数` 走同一条
   * `limit >= n` 分支；那条分支只排 `limit` 项，所以"不封顶"照样是完整口径的同一个前缀。
   *
   * 峰值内存：三根数字数组各 `本层直属项数` 长度，共 **16 B/项**（`sz` 8 + `ky` 4 + `or` 4），
   * 30 万项那一层 4.8 MB，且按最大见过的那一层扩容后**常驻复用**（每 400ms 现造 4.8 MB 就是
   * 每分钟 72 MB 的垃圾）。对照被替换掉的旧路径：临时 30 万个 11 字段对象（≈60 MB）+ 排序缓冲。
   */
  levelOf(
    dirId: number,
    cap: number,
    excluded: ReadonlySet<number> = NO_EXCLUSIONS
  ): {
    children: ChildView[]
    totalChildren: number
    foldedCount: number
    foldedBytes: number
    excludedCount: number
    excludedBytes: number
  } {
    const d = this.dirs.get(dirId)
    if (!d) return { children: [], totalChildren: 0, foldedCount: 0, foldedBytes: 0, excludedCount: 0, excludedBytes: 0 }
    const childIds = d.childIds
    const files = d.files
    // 枚举数上界：childIds 里可能有本轮已不在树上的 id（只让真实数变小），files 一定全存
    const m = childIds.length + files.length
    const { sz, ky, or } = this.growPageWork(m)
    const hasExcluded = excluded.size > 0
    let n = 0 // 留下的（未被排除的）本层直属项数
    let total = 0 // childrenOf 会回的那一份条数（含被排除的），= totalChildren
    let exCount = 0
    let exBytes = 0
    let keptSum = 0
    for (let j = 0; j < childIds.length; j++) {
      const cid = childIds[j]!
      const k = this.dirs.get(cid)
      if (!k) continue // 与 childrenOf 同一个跳过条件，否则 totalChildren 会与完整口径差几项
      total++
      if (hasExcluded && excluded.has(cid)) {
        exCount++
        exBytes += k.size
        continue
      }
      sz[n] = k.size
      ky[n] = cid // 非负 = dirId
      keptSum += k.size
      n++
    }
    for (let j = 0; j < files.length; j++) {
      const f = files[j]!
      total++
      sz[n] = f.size
      ky[n] = ~j // 负数 = 文件下标（~j 与 dirId 的命名空间不重叠）
      keptSum += f.size
      n++
    }
    const limit = cap >= 0 && n > cap ? cap : n
    const aLen = this.selectPagePositions(sz, ky, files, or, n, limit)
    const children: ChildView[] = []
    let chosenSum = 0
    // 最终顺序 = or 的两段（见 selectPagePositions 的约定）：先"严格大于边界值"的那批，再边界档的前 need 个
    const emit = (pos: number): void => {
      const enc = ky[pos]!
      chosenSum += sz[pos]!
      // dirs.get(enc) 必定命中：本次调用全程同步，枚举那一趟已经验过，而树上没有任何删除目录的 API
      children.push(enc >= 0 ? dirView(this.dirs.get(enc)!, enc) : fileView(d.path, files[~enc]!))
    }
    for (let i = n - aLen; i < n; i++) emit(or[i]!)
    for (let i = 0; i < limit - aLen; i++) emit(or[i]!)
    return {
      children,
      totalChildren: total,
      foldedCount: n - limit,
      foldedBytes: keptSum - chosenSum,
      excludedCount: exCount,
      // 没被排除项时一次都不求和：0 是"没这一栏"，不是"这一栏算过且为 0"
      excludedBytes: exCount === 0 ? 0 : exBytes
    }
  }

  /**
   * `levelOf` 的复用工作区：三根只装数字的数组，按本层直属项数上界扩容。
   * - `sz` 每个留下项的 size（`childrenOf` 的枚举序，未被置换过 ⟹ 下标就是稳定序基准）
   * - `ky` 同一位置的记录句柄（≥0 = dirId，<0 = `~fileIndex`）
   * - `or` 位置下标数组：选择算法只置换**它**，所以 `sz`/`ky` 与枚举序全程对齐
   * 复用安全：`levelOf` 同步、无 await、不可能重入；容量只增不减，读到的都是自己刚写的 [0,n)。
   */
  private pageWork = { sz: new Float64Array(0), ky: new Int32Array(0), or: new Int32Array(0) }

  private growPageWork(m: number): { sz: Float64Array; ky: Int32Array; or: Int32Array } {
    const w = this.pageWork
    if (w.sz.length >= m) return w
    const grown = { sz: new Float64Array(m), ky: new Int32Array(m), or: new Int32Array(m) }
    this.pageWork = grown
    return grown
  }

  /**
   * 把「完整口径下的前 limit 项」的位置留在 `or` 里，返回边界之上那一段的长度 `aLen`：
   *
   * ```
   * 最终顺序 = or[n-aLen .. n)  ++  or[0 .. limit-aLen)
   *            size 严格 > 边界值     size === 边界值里 cmpPos 最靠前的那些
   * ```
   *
   * 两段都各自排好（`or` 的两个区不重叠：`aLen + tLen ≤ n`，`tLen` 是边界档的项数），
   * 所以调用方只管按这两段造视图，不需要第三次排序。
   * `aLen === 0` 退化成"一切都在 `or[0..limit)`"—— 不封顶那条（limit >= n）就是这一形状。
   *
   * `cmpPos` 是全类唯一的比较器 `LEVEL_ORDER` 加枚举序兜底，快路径与慢路径因此不可能各排一套。
   */
  private selectPagePositions(
    sz: Float64Array,
    ky: Int32Array,
    files: FileEntry[],
    or: Int32Array,
    n: number,
    limit: number
  ): number {
    if (limit <= 0) return 0
    /** 位置 → 原始记录（不造任何对象：拿的就是树上那两个已存在的记录本体）。 */
    const rec = (pos: number): LevelSortable => {
      const enc = ky[pos]!
      return enc >= 0 ? this.dirs.get(enc)! : files[~enc]!
    }
    const cmpPos = (x: number, y: number): number => LEVEL_ORDER(rec(x), rec(y)) || x - y
    for (let i = 0; i < n; i++) or[i] = i
    if (limit >= n) {
      or.subarray(0, n).sort(cmpPos)
      return 0
    }
    let t = selectNthLargest(sz, or, n, limit - 1)
    if (t === null) {
      // 兜底：只把 size 抄一份做**原生数值排序**（不给比较器 = 数字升序），读第 limit 大的值。
      // 走的就是"第 2 步只比数字"这条便宜路径，比在这里跑 n 次 cmpPos 便宜一个数量级；
      // 一次 8n 字节的临时数组只在失手时才有。答案与主元选取无关 ⟹ 兜底同解，只是慢。
      const sortedSizes = sz.slice(0, n)
      sortedSizes.sort()
      t = sortedSizes[n - limit]!
    }
    // 一次线性划分：边界档写头部 or[0..tLen)，"严格大于"写尾部 or[n-aLen..n)（≤ cap-1 个）
    let tLen = 0
    let aLen = 0
    for (let i = 0; i < n; i++) {
      const v = sz[i]!
      if (v > t) or[n - ++aLen] = i
      else if (v === t) or[tLen++] = i
    }
    const need = limit - aLen
    // `t` 是第 limit 大的值 ⟹ aLen < limit ≤ aLen + tLen ⟹ 0 < need ≤ tLen：
    // 名额一定够，而且不够分的时候正是"同分项谁能上页"唯一需要判名字的地方。
    if (tLen > need && !selectFirstBy(or, tLen, need, cmpPos)) or.subarray(0, tLen).sort(cmpPos)
    or.subarray(0, need).sort(cmpPos)
    or.subarray(n - aLen, n).sort(cmpPos)
    return aLen
  }

  /**
   * §9 目录统计：纯内存遍历，零 syscall。视图口径，不改任何聚合。
   *
   * 三条口径要写明白，因为它们都会被 UI 引用：
   * - `dirId` 不在树上就回落到根 —— 渲染端的哨兵是 `-1`（`useTreeNav`），
   *   一条查询链不该因为导航栈还没水合就报空统计；
   * - 扫描中的目录（`live`）给出的 size / files / dirs 与两个 largest 都是**此刻内存里的快照**，
   *   是中间值。`partial` **不**表示"还没扫完"（那是面板另一句「该目录仍在扫描中」负责的），
   *   它只表示下面那句：节点预算用尽了，两个 largest 只覆盖已访问的部分；
   * - `maxFiles` 截断后 `files` 列表是残缺的（directFileCount 才真实），所以截断盘的
   *   「最大文件」只覆盖留在内存里的那批文件。这一条由**详情面板**紧挨那行的一句话点名
   *   （`DetailPanel` 的 `truncated`，数据来自 `ScanSnapshot.truncated`）：`ScanHud` 只挂在首页，
   *   地图页看不见它，所以 HUD 那句不构成这里的免责。
   */
  dirStatsOf(dirId: number): DirStats {
    const id = this.dirs.has(dirId) ? dirId : this.rootId
    return computeDirStats((i) => this.dirs.get(i), id)
  }

  pathOf(dirId: number): string {
    return this.dirs.get(dirId)?.path ?? ''
  }
}
