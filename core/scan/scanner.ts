import { SKIP_ALWAYS, classifyFsError, type ScanErrorKind } from '../fs/errors'
import { lookupFindDataEntry, type FindDataEntry, type FindDataLister } from '../fs/finddata'
import type { FsLike } from '../fs/fslike'
import { baseName, joinWin, normalizeKey, parentOf } from '../fs/pathutil'
import { LEVEL_CAP } from '../../shared/constants'
import { Semaphore } from './semaphore'
import { TreeStore, type FileEntry } from './tree-store'
import { walkSubtree, type WalkEvent, type WalkNode } from './walk'
import type {
  ChildrenPayload,
  DirStatsWire,
  FileHit,
  ScanEvent,
  ScanSnapshot,
  ScanStatus,
  SkippedWire
} from '../../shared/types'

export interface ScanLogger {
  scan(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export interface ScannerOpts {
  fs: FsLike
  /** 同时在途的 fs 请求上限（§6「并发数量必须受到限制」）。 */
  concurrency: number
  progressIntervalMs: number
  maxFiles: number
  maxDepth: number
  topN?: number
  /**
   * 透传给 `TreeStore` 的**注入扩展名计数**清单（§3.6 那一格）。扫描层不解释它是什么，
   * 只做"名字落在这串扩展名里的文件，见一个数一个"；生产上由
   * `electron/services/scan-service.ts` 把 `core/analyze/model-files.ts` 的口径传进来 ——
   * 于是 `core/scan/**` 没有反过来依赖分析层，而那条计数也不必等谁来看一眼树现算一趟。
   */
  countExts?: readonly string[]
  /** 注入而非 import：core/ 不得依赖 electron，否则纯 node 下无法加载与单测。 */
  logger?: ScanLogger
  /**
   * 目录枚举兜底（`core/fs/finddata.ts`）：**不需要管理员**就能拿到被 ACL 挡住的文件大小。
   * 只在 `stat` 报 `denied` 之后按目录惰性调用。不给这个注入点，行为与今天逐字相同
   * （那些文件如实记"未计入"）—— 注入它不是让数字变脏，而是让 C:\ 根上那 9 GB 从
   * "少算"变成"算进地图且来源可指"。
   */
  findData?: FindDataLister
}

const SEED_DEPTH = 2

/** `excludedView()` 在"本轮一个都没排除"时复用的那个空集（见该方法上的频率说明）。 */
const EMPTY_EXCLUDED: ReadonlySet<number> = new Set<number>()

export interface SeedPlan {
  /** 并行扫描的单元：每个都由 walkSubtree 完整覆盖（含其直属文件）。 */
  seeds: string[]
  /** 被"展开"过的目录（根 + 中间层）。它们的**直属文件不在任何 seed 里**，必须单独收，否则整批丢失。 */
  shallow: string[]
}

/**
 * 把盘切成若干个「种子目录」并行扫。取深度 2 而不是深度 1：
 * `C:\Users` 这种巨无霸若整体当一个单元，长尾会拖死总耗时（§6）。
 * 根目录读不了 → 抛（整次扫描无从进行）；中间层读不了 → 就地当单元收下，继续往下（§8）。
 */
export async function buildSeeds(
  rootPath: string,
  o: { fs: FsLike; maxDepth: number; isCancelled?: () => boolean; waitWhilePaused?: () => Promise<void> }
): Promise<SeedPlan> {
  let frontier: string[] = [rootPath]
  const shallow: string[] = []
  for (let d = 0; d < o.maxDepth; d++) {
    const next: string[] = []
    let expanded = false
    for (const p of frontier) {
      if (o.isCancelled?.() === true) break
      // 这一步是**预遍历**，真实 C 盘上要读 ~7.3 万个目录：不查门的话"暂停"在规划阶段完全没反应
      if (o.waitWhilePaused) await o.waitWhilePaused()
      if (o.isCancelled?.() === true) break
      let ents
      try {
        ents = await o.fs.readdir(p)
      } catch (e) {
        if (normalizeKey(p) === normalizeKey(rootPath)) throw e
        next.push(p)
        continue
      }
      const subs = ents
        .filter((e) => e.kind === 'dir' && !SKIP_ALWAYS.has(e.name.toLowerCase()))
        .map((e) => joinWin(p, e.name))
      if (subs.length === 0) next.push(p)
      else {
        shallow.push(p)
        next.push(...subs)
        expanded = true
      }
    }
    if (!expanded) break
    frontier = next
  }
  // 二者天然不相交：进 shallow 的目录本身不会进 next，进 next 的没被展开过
  return { seeds: [...new Set(frontier)], shallow: [...new Set(shallow)] }
}

export class Scanner {
  store: TreeStore
  private readonly o: ScannerOpts
  private status: ScanStatus = 'idle'
  private currentPath = ''
  private startedAt = 0
  /** 与 `startedAt` 同族但**语义不同**：0 = 还没收尾。给渲染端的是 `number | null`，这里不在边界上偷懒。 */
  private finishedAt = 0
  private elapsed = 0
  private lastEmit = 0
  private cancelRequested = false
  /** v0.1 暂停：协作式门 + 净工作时间账本 */
  private paused = false
  private pausedAt = 0
  private pausedMs = 0
  private waiters: Array<() => void> = []
  private emitFn: ((e: ScanEvent) => void) | null = null
  private scanId = ''
  private rootPath = ''
  /** 本轮靠目录枚举兜底补回来的文件数与字节数（没注入 `findData` 就恒 0）。 */
  private findDataFiles = 0
  private findDataBytes = 0

  /**
   * `stat` 被拒之后的一次兜底查询。拿不到就返回 `null`，调用方照今天的路子记"未计入"。
   *
   * 只在 `denied` 时调用：`missing`（readdir 之后文件被删）与 `busy` 兜底也救不了，
   * 而一次 powershell 是 150–460 ms，把它花在没收益的地方是纯亏。
   */
  private async recoverByFindData(dir: string, name: string): Promise<FindDataEntry | null> {
    const hit = await lookupFindDataEntry(this.o.findData, dir, name)
    if (hit === null) return null
    this.findDataFiles++
    this.findDataBytes += hit.size
    return hit
  }

  /** 不用 TS 参数属性（`constructor(private readonly o: X)`）：Node 的 strip-only 模式不支持，
   *  scripts/bench.mjs 与 smoke-real.mjs 要靠它直接跑 core/*.ts，加了就得引入 tsx/vitest。 */
  constructor(o: ScannerOpts) {
    this.o = o
    this.store = new TreeStore({ rootPath: '', maxFiles: o.maxFiles, topN: o.topN ?? 100, countExts: o.countExts })
  }

  cancel(): void {
    this.cancelRequested = true
    // 暂停状态下按取消必须立刻放行，否则整批 waiter 永远等不到 resume → 扫描挂死
    this.drainWaiters()
  }

  async start(rootPath: string, emit: (e: ScanEvent) => void): Promise<ScanSnapshot> {
    this.rootPath = rootPath
    this.scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.store = new TreeStore({
      rootPath,
      maxFiles: this.o.maxFiles,
      topN: this.o.topN ?? 100,
      countExts: this.o.countExts
    })
    this.status = 'running'
    this.startedAt = Date.now()
    this.finishedAt = 0
    this.lastEmit = 0
    this.currentPath = rootPath
    this.cancelRequested = false
    this.paused = false
    this.pausedAt = 0
    this.pausedMs = 0
    this.waiters = []
    this.emitFn = emit
    this.o.logger?.scan('start', { root: rootPath, concurrency: this.o.concurrency, maxFiles: this.o.maxFiles })

    let plan: SeedPlan
    try {
      plan = await buildSeeds(rootPath, {
        fs: this.o.fs,
        maxDepth: SEED_DEPTH,
        isCancelled: () => this.cancelRequested,
        waitWhilePaused: () => this.waitWhilePaused()
      })
    } catch (e) {
      this.count(classifyFsError(e), rootPath)
      return this.finish('failed', emit)
    }
    const seeds = plan.seeds

    // 先把种子到根的中间层全部挂上树，再开始扫描：
    // 这样即使中途取消，已发现的层级照样能出图（§7 + §28 原则六）。
    const seedIds = seeds.map((s) => ({ seed: s, dirId: this.ensureChain(s) }))

    // 被展开过的目录（根 + 中间层）的直属文件不属于任何 seed 的子树，必须在这里单独收一遍。
    // 漏了这一步 = C:\ 根下的 pagefile.sys / hiberfil.sys、以及 C:\Windows 顶层那批文件全部不计。
    await this.collectShallowFiles(plan.shallow)
    this.maybeEmit(emit, true)

    const units = Math.max(1, Math.min(4, this.o.concurrency))
    const seedSem = new Semaphore(units)
    const perSeed = Math.max(2, Math.floor(this.o.concurrency / units))

    await Promise.all(
      seedIds.map(({ seed, dirId }) =>
        seedSem.run(async () => {
          try {
            const node = await walkSubtree(seed, {
              fs: this.o.fs,
              concurrency: perSeed,
              maxDepth: this.o.maxDepth,
              isCancelled: () => this.cancelRequested,
              waitWhilePaused: () => this.waitWhilePaused(),
              findData: this.o.findData,
              onEvent: (ev) => this.onWalkEvent(seed, ev, emit)
            })
            this.mergeWalkNode(dirId, node)
            // 子树的兜底计数已经在 walk 里向上聚合到 seed 根，这里只加顶层那一份。
            // 在 mergeWalkNode 内部加会把每个后代节点各加一遍（父节点本身就含后代）。
            this.findDataFiles += node.findDataFiles
            this.findDataBytes += node.findDataBytes
          } catch (e) {
            // seed 子树整体抛（walk 自己不该抛，真抛了这一路也要计数 + 点名）
            this.count(classifyFsError(e), seed)
            this.store.setLive(dirId, 0, 0, false)
          }
        })
      )
    )

    this.store.finalizeDir(this.store.rootId)
    return this.finish(this.cancelRequested ? 'cancelled' : 'completed', emit)
  }

  private onWalkEvent(seedPath: string, ev: WalkEvent, emit: (e: ScanEvent) => void): void {
    switch (ev.kind) {
      case 'current':
        this.currentPath = ev.path
        break
      case 'file':
        this.addLive(seedPath, ev.size)
        break
      case 'error':
        // 事件本来就带 path，是**这里**曾经把它扔掉的（Task 26 记的不足）。
        // 捡回来只花一个实参：§15 要能点名"哪些目录没算进地图"，靠的就是它。
        this.count(ev.err, ev.path)
        break
      case 'dir':
      default:
        break
    }
    this.maybeEmit(emit)
  }

  /**
   * 中间值直接累加到「种子 + 各级祖先」：
   * 否则扫描期间 `C:\Users` 会显示 0，只有它下面的目录在涨 —— §7 要的正是 Users 自己在长。
   * 种子扫完后 finalizeDir 会用真值覆盖，而真值与累加的中间值相等，所以不漂移。
   */
  private addLive(seedPath: string, size: number): void {
    this.store.noteSeenFile(size)
    let cur: number | undefined = this.store.dirIdByPath(seedPath)
    const seen = new Set<number>()
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur)
      const d = this.store.getDir(cur)
      if (!d) break
      d.size += size
      d.fileCount += 1
      d.live = true
      const pp = parentOf(d.path)
      cur = pp === null ? undefined : this.store.dirIdByPath(pp)
    }
  }

  /** 收「被展开过的目录」自己的直属文件：这些目录的子树由 seed 负责，但它们头上的文件没人管。 */
  private async collectShallowFiles(dirs: string[]): Promise<void> {
    const sem = new Semaphore(Math.max(1, Math.min(4, this.o.concurrency)))
    await Promise.all(
      dirs.map((dir) =>
        sem.run(async () => {
          if (this.cancelRequested) return
          await this.waitWhilePaused() // 暂停要停住一切，不只是 seed 子树 —— 根上那批文件也一样是 I/O
          if (this.cancelRequested) return
          const dirId = this.store.dirIdByPath(dir)
          if (dirId === undefined) return
          let ents
          try {
            ents = await this.o.fs.readdir(dir)
          } catch (e) {
            this.count(classifyFsError(e), dir)
            return
          }
          const files: FileEntry[] = []
          for (const ent of ents) {
            if (this.cancelRequested) return
            if (ent.kind !== 'file') continue
            try {
              const st = await this.o.fs.stat(joinWin(dir, ent.name))
              // 浅层目录（R:\ 这类）的直属文件走的是这条 stat，属性与创建时间同样零成本带出，
              // 不能只给 seed 子树里的文件补 —— 那样 C:\ 根上的 pagefile.sys 就是特例。
              files.push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, attrs: st.attrs })
              this.addLive(dir, st.size)
            } catch (e) {
              const kind = classifyFsError(e)
              const fd = kind === 'denied' ? await this.recoverByFindData(dir, ent.name) : null
              if (fd === null) {
                this.count(kind, joinWin(dir, ent.name))
                continue
              }
              files.push({ name: ent.name, size: fd.size, mtimeMs: fd.mtimeMs, birthtimeMs: fd.birthtimeMs, attrs: fd.attrs })
              this.addLive(dir, fd.size)
            }
          }
          this.o.fs.release?.(dir)
          this.store.addFilesToDir(dirId, files)
        })
      )
    )
  }

  /**
   * 一笔"没算进来"。`path` 每个调用点都带得上（walk 的 error 事件本来就带；三处兜底 catch 手上就是那个路径），
   * 参数留 optional 是为了对齐 `TreeStore.addError` 的签名 —— 带不到路径也**照样计数**，计数永不为清单让路。
   */
  private count(kind: ScanErrorKind, path?: string): void {
    this.store.addError(kind === 'denied' || kind === 'missing' || kind === 'busy' ? kind : 'otherErrors', path)
  }

  /**
   * 只从本次扫描的根往下建链。
   * 用 seedPath.split('\\') 从头拼会在根之上凭空造出 `D:\`、`D:\DeepClean` 这类父链节点，
   * 并把真正的子目录挂到那条假链下面 —— 总量仍能对上（finalize 会顺着假链加），
   * 但 SpaceMap 打开根只会看到一个假的上级目录，钻取直接废掉（§5.1 树形）。
   */
  private ensureChain(seedPath: string): number {
    const rel = seedPath.slice(this.rootPath.length).replace(/^\\+/, '')
    let cur = this.store.rootId
    let acc = this.rootPath
    for (const seg of rel.split('\\').filter(Boolean)) {
      acc = joinWin(acc, seg)
      const id = this.store.beginDir(acc)
      this.store.attachChild(cur, id)
      cur = id
    }
    return cur
  }

  private mergeWalkNode(parentId: number, node: WalkNode): number {
    const id = this.store.beginDir(node.path)
    this.store.attachChild(parentId, id)
    for (const sub of node.dirs) this.mergeWalkNode(id, sub)
    this.store.addFilesToDir(id, node.files)
    this.store.setDirMtime(id, node.mtimeMs)
    this.store.finalizeDir(id)
    return id
  }

  private maybeEmit(emit: (e: ScanEvent) => void, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < this.o.progressIntervalMs) return
    this.lastEmit = now
    emit({ kind: 'progress', snapshot: this.snapshot() })
  }

  private finish(status: ScanStatus, emit: (e: ScanEvent) => void): ScanSnapshot {
    // 收尾时若还停在暂停中（例如暂停中按了取消），把这段暂停计入净时间，
    // 否则 elapsedMs 会把"用户按了暂停去喝咖啡"算成扫描耗时
    if (this.paused) {
      this.pausedMs += Date.now() - this.pausedAt
      this.paused = false
    }
    this.status = status
    this.finishedAt = Date.now()
    this.elapsed = this.liveElapsed()
    const snap = this.snapshot()
    this.o.logger?.scan('end', {
      root: this.rootPath,
      status,
      files: snap.files,
      dirs: snap.dirs,
      bytes: snap.totalBytes,
      skipped: snap.skipped,
      findDataFiles: this.findDataFiles,
      findDataBytes: this.findDataBytes,
      ms: this.elapsed
    })
    emit({ kind: 'done', snapshot: snap })
    return snap
  }

  /**
   * 本轮靠目录枚举兜底补回来的量。服务层与测试用它确认"这些字节是从哪条路来的"，
   * 而不是只看总数 —— 总数对上了不代表来源干净。
   */
  findDataRecovery(): { files: number; bytes: number } {
    return { files: this.findDataFiles, bytes: this.findDataBytes }
  }

  snapshot(): ScanSnapshot {
    return {
      scanId: this.scanId,
      root: this.rootPath,
      status: this.status,
      currentPath: this.currentPath,
      elapsedMs: this.status === 'running' || this.status === 'paused' ? this.liveElapsed() : this.elapsed,
      startedAtMs: this.startedAt === 0 ? null : this.startedAt,
      finishedAtMs: this.finishedAt === 0 ? null : this.finishedAt,
      truncated: this.store.truncated,
      ...this.store.stats()
    }
  }

  /**
   * §15：这次扫描跳过了什么（四类计数 + 被拒路径的有界清单）。
   *
   * 读的是 `store`，所以它的寿命 = 这次扫描任务的寿命：`cancelled` / `failed` 之后照样问得出，
   * 而且**只读不走盘**（一个 syscall 都没有，更不会重新遍历）。
   * 故意不在 `ScanSnapshot` 里带 —— 快照每 250ms 推一次，200 条路径乘上那个频率就是白送的 IPC 负担，
   * 见 `shared/types.ts` 的 `SkippedWire` 注释。
   */
  skipped(): SkippedWire {
    return this.store.skipped()
  }

  /**
   * 「扫了多久」必须是净工作时间：暂停 3 分钟不能算成扫描慢，
   * 否则 v0.1 清单里那条「扫描速度」的数字就被暂停污染了。
   */
  private liveElapsed(): number {
    const pausedNow = this.paused ? Date.now() - this.pausedAt : 0
    return Math.max(0, Date.now() - this.startedAt - this.pausedMs - pausedNow)
  }

  /** v0.1 暂停：只在真的在跑的时候有效。 */
  pause(): void {
    if (this.paused || this.status !== 'running') return
    this.paused = true
    this.pausedAt = Date.now()
    this.status = 'paused'
    this.o.logger?.scan('pause', { root: this.rootPath, files: this.store.stats().files })
    this.emitFn?.({ kind: 'progress', snapshot: this.snapshot() })
  }

  resume(): void {
    if (!this.paused) return
    this.pausedMs += Date.now() - this.pausedAt
    this.pausedAt = 0
    this.paused = false
    this.status = 'running'
    this.o.logger?.scan('resume', { root: this.rootPath })
    this.drainWaiters()
    this.emitFn?.({ kind: 'progress', snapshot: this.snapshot() })
  }

  private drainWaiters(): void {
    const w = this.waiters
    this.waiters = []
    for (const r of w) r()
  }

  /**
   * walk 的暂停门。`cancel()` 会 drain 这些 waiter，所以「暂停中按取消」不会永久挂住 ——
   * 这一点单独有测试，因为挂死比不能暂停严重得多。
   */
  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.cancelRequested) await new Promise<void>((r) => this.waiters.push(r))
  }

  /** dirId 不在树上时回落到根：渲染端不必自己维护 root 哨兵值。 */
  children(dirId: number, cap: number = LEVEL_CAP): ChildrenPayload {
    const id = this.store.getDir(dirId) ? dirId : this.store.rootId
    // 排除集只在这条**视图**路径上递给 levelOf。计价（规则引擎 / 重复检测 / 报告）
    // 走的是 store.childrenOf，永远看不到这个集合 —— 见 `tests/unit/rules-engine.test.ts` 末尾的哨兵。
    const page = this.store.levelOf(id, cap, this.excludedView())
    // 本轮累计的那一份与上面那两个是**两个口径**：page.* 是"这一层直属"，session* 是"这一轮一共藏了几块"。
    // 横幅读后者（否则钻到别的层就看不见过滤器、也没有撤销入口），折叠那句读前者（它讲的是这一层的账）。
    const session = this.store.excludedTotals()
    return {
      dirId: id,
      rootId: this.store.rootId,
      rootSize: this.store.sizeOf(this.store.rootId),
      path: this.store.pathOf(id),
      size: this.store.sizeOf(id),
      children: page.children,
      totalChildren: page.totalChildren,
      foldedCount: page.foldedCount,
      foldedBytes: page.foldedBytes,
      excludedCount: page.excludedCount,
      excludedBytes: page.excludedBytes,
      sessionExcludedCount: session.count,
      sessionExcludedBytes: session.bytes,
      status: this.status
    }
  }

  /**
   * 本轮的视图排除集（Set 形状，`levelOf` 的入参）。
   *
   * 每次现取而不是在 Scanner 上再存一份：两份集合迟早漂移。
   * 空集复用模块常量 —— `children()` 在扫描期间每 400ms 被轮一次，没排除时不该每次新造一个 Set。
   */
  private excludedView(): ReadonlySet<number> {
    const ids = this.store.excludedIds()
    return ids.length === 0 ? EMPTY_EXCLUDED : new Set(ids)
  }

  /**
   * V0.2 规格书 §7 右键菜单的「排除该目录」：**纯视图**动作，只让那个目录从地图的相应层消失。
   * 不停止扫描、不改计数、不删任何东西，也不影响清理预估（那条链读的是 `childrenOf`）。
   *
   * 回 false = 这一条没被接受（扫描根不许排除 = 排除等于给用户一张空图；id 不在树上）。
   * 必须把拒说出来而不是静默成功：渲染端据此决定要不要重画这一层。
   */
  setExcluded(dirId: number, excluded: boolean): boolean {
    if (!this.store.canExclude(dirId)) return false
    this.store.setViewExcluded(dirId, excluded)
    return true
  }

  /** 一次性清掉本轮全部排除（侧栏那句「清除全部排除」）。 */
  clearExcluded(): void {
    this.store.clearViewExclusions()
  }

  /**
   * §9 目录统计（最大文件 / 最大子目录）。**只读**：吃的是已经在内存里的那棵树，
   * 一次点击一趟遍历，零 syscall、不新开任何 I/O（§28 原则一）。
   * 与 `children()` 同一条回落约定：dirId 不在树上时统计根。
   */
  dirStats(dirId: number): DirStatsWire {
    return this.store.dirStatsOf(dirId)
  }

  /**
   * Top-N 由 addFilesToDir 在 merge 时喂堆，所以它随「种子单元完成」而刷新，不是每个文件。
   * live 路径故意不入堆 —— 同一文件会被计两次。§14 口径本就是"扫描完成后建立 Top 100"。
   * 今天只剩扫描报告在用它（`report.rs` / `scan-report.ts` 的 `topFiles` 那一格），
   * 页面级的「大文件表」已经下线。
   */
  topRaw(): FileHit[] {
    return this.store.topHeap.entries().sort((a, b) => b.size - a.size)
  }

  /**
   * shell.openItem / reveal 的白名单（§28）。
   * 截断后文件列表已被丢弃、无从核对，退化为「父目录在树上即放行」—— 这是只读工具，打开不等于删除。
   */
  knowsPath(absPath: string): boolean {
    const parent = parentOf(absPath)
    if (parent === null) return false
    const dirId = this.store.dirIdByPath(parent)
    if (dirId === undefined) return false
    const d = this.store.getDir(dirId)
    if (!d) return false
    const name = baseName(absPath).toLowerCase()
    if (d.childIds.some((c) => baseName(this.store.pathOf(c)).toLowerCase() === name)) return true
    if (this.store.truncated) return true
    return d.files.some((f) => f.name.toLowerCase() === name)
  }
}
