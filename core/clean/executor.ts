/**
 * §18 清理任务执行器 —— 本仓库第一处**真的会删文件**的代码，所以它的主体不是删除，是**拒绝**。
 *
 * 六道硬闸（每条都在 `tests/unit/clean-executor.test.ts` 里被证伪过）：
 *
 * 1. **越界即拒**（§28 原则四）：每条路径经 `normalizeKey` 后必须**严格位于** `authorizedRoot` 之内。
 *    越界的那一条被拒并留痕；与它**重叠**的其余条目一起被拒 —— 绝不"把越界的那部分剔掉，剩下的照删"，
 *    因为一次删除请求的**范围**本身就是危险物：请求 `C:\Users` 时不会因为里面有几条在授权根里就变安全。
 * 2. **authorizedRoot 自己过三关**：不是盘符根、存在且 `statSync().isDirectory()`、
 *    不命中 Task 16 的 `FORBIDDEN_PATH_PATTERNS`（复用引擎的 `isForbiddenPath` / `pathIsUnder`，
 *    **不另立第三套"禁止"定义**；禁止根模板解析不出来时 fail-safe —— 看不见保护就等于没有保护）。
 * 3. **不递归**：只删列出来的文件；目录只在「已空 ∧ 在授权根内 ∧ 被显式列在请求里」时用**非递归** `rmdir`。
 *    代码里不存在 `recursive: true` 这个参数，所以"顺手递归删掉"在结构上写不出来。
 * 4. **重解析点不跟随**：目标最后一段是 reparse point ⇒ 拒；中间任何一段是 reparse point ⇒ 也拒
 *    （只查最后一段挡不住 `root\junc\file.bin` 这种文本上没出界、物理上已经出界的逃逸）。
 *    口径与 `core/fs` 一致：reparse point 归 `kind: 'other'`，不是可删对象。
 * 5. **§28 原则五**：删除失败逐条 try/catch，errno 记进 `failedCount` 与 `deleted[]`，批次继续；
 *    一个被锁的文件不许打断整批，更不许让进程崩。
 * 6. **§28 原则六**：`shouldCancel()` 在每个删除动作前判定；已删的不复活，剩下的一个都不碰，status='cancelled'。
 *
 * §19：清理前后各测一次授权根总字节（由调用方注入的 `measure` 提供，主进程接的是**现有扫描器**，只读），
 * 预估释放与实际释放**两个数字都报**，不一致就照实说不一致（簇大小、备用数据流、并发写都会造成差）。
 *
 * 上面那份"会造成差的原因"清单**漏过一条更要命的**：这两个数字会在硬链接参与时**假性相等**。
 * 两边都是"逐路径表观大小之和"—— `measure` 走扫描器（按路径累加 `size`，结构上没有 inode 概念），
 * `predictedFreedBytes` 是执行器自己对每条被接受路径 `lstat` 求来的和（`totalSize`），谁都不看 inode。
 * 删掉一个共享 inode 的名字，两笔账各少一份，`deltaBytes` 精确等于 0，而盘上那份字节一个没动
 * （`DeleteFileW` 只减链接计数）。**同口径的两个数互相印证不构成验证**：一个盲区会让单独一个数
 * 显眼地错，却让它俩一起"对" —— 那比单独错危险得多，因为它给错数发了可信的标签。
 * 磁盘那一侧唯一读得到的是卷可用空间（`freeBytesBefore` / `freeBytesAfter`，注入的 `measureFree`）。
 * 口径本身（那三个数怎么算出来的）在冻结面里，本轮没动；动的只有这里的说明与 `verification.note` 的措辞。
 *
 * §29：每一次删除（成功/失败）与每一条拒绝都写一行 `[CLEAN]`，注入 logger，不 import electron。
 *
 * §1.7 裁定 2：`deleted[]` 的每一行还带一个 `outcome`（`'ok' | 'failed' | 'cancelled'`），
 * 让「重试退避期间收到取消」那一条不必再靠 detail 里那句中文认出来。**它是只写不读的呈现字段**：
 * 本文件的六道闸、六个计数字段与 `status` 的算法都不看它一眼（`tests/unit/clean-journal.test.ts`
 * 里那两道静态 + 动态闸门钉着这件事）。写它没给这个模块增加任何删除能力 —— 它只是把已经发生的
 * 结局多记了一份形状。
 *
 * 时钟靠注入（`nowMs`），与规则引擎/预览同一口径，结果可复现。
 */
import { lstat as nodeLstat, rmdir as nodeRmdir, unlink as nodeUnlink } from 'node:fs/promises'
import { isForbiddenPath, pathIsUnder, resolvePattern } from '../rules/engine'
import { FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS } from '../rules/registry'
import { normalizeKey, parentOf, toFsPath } from '../fs/pathutil'
import type { RuleEnv } from '../rules/types'
import type {
  CleanBlocker,
  CleanBlockerReason,
  CleanExecuteRequest,
  CleanRefusal,
  CleanTask
} from '../../shared/types'

/* ------------------------------------------------------------------ *
 * I/O 面（注入式设计：单测用记账假 fs 证明「零删除」，生产用 node 实现）
 * ------------------------------------------------------------------ */

export interface CleanFsStat {
  isDirectory: boolean
  isFile: boolean
  /** true = 重解析点（symlink / junction）。**任何**一段命中都不许跟随（§28 原则四 + core/fs 的 'other' 口径）。 */
  isSymbolicLink: boolean
  size: number
}

export interface CleanFs {
  /** 必须是 lstat 语义：不许解析 reparse point。 */
  lstat(p: string): Promise<CleanFsStat>
  unlink(p: string): Promise<void>
  /** 非递归删空目录：目录非空必须抛 ENOTEMPTY（真实 fs 语义），这就是「只在空时才删」的执行者。 */
  rmdir(p: string): Promise<void>
}

export const nodeCleanFs: CleanFs = {
  async lstat(p: string): Promise<CleanFsStat> {
    const s = await nodeLstat(toFsPath(p))
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink(), size: s.size }
  },
  async unlink(p: string): Promise<void> {
    await nodeUnlink(toFsPath(p))
  },
  async rmdir(p: string): Promise<void> {
    await nodeRmdir(toFsPath(p))
  }
}

export type CleanFields = Record<string, string | number | boolean | undefined>
export interface CleanLog {
  clean(msg: string, fields?: CleanFields): void
}

export interface MeasureResult {
  bytes: number
  files: number
}
export type MeasureFn = (root: string) => Promise<MeasureResult>

export interface RunCleanOptions {
  /** 解析 `FORBIDDEN_PATH_PATTERNS` 用的环境表：由调用方注入，本模块不读 `process.env`（约束 7） */
  env: RuleEnv
  fs?: CleanFs
  /** 默认 = Task 16 的 `FORBIDDEN_PATH_PATTERNS`；传别的只增不减（不放松）。 */
  forbiddenPatterns?: readonly string[]
  /** 调用方追加的围栏（例如本项目自己的夹具根）。走的是**同一条** `isForbiddenPath`，不是第二套"禁止"语义。 */
  denyRoots?: readonly string[]
  /**
   * 「只上报不可删」清单，默认 = registry 的 `REPORT_ONLY_ROOT_PATTERNS`（回收站那一类）。
   * 规则引擎已经在认领阶段拦过一遍，这里是执行层的独立一道：就算有人手工拼出一份把回收站算成 🟢 的工作单，
   * 到了这里照样拒。传别的只增不减。
   */
  reportOnlyPatterns?: readonly string[]
  logger?: CleanLog
  /** §19：授权根的字节/文件数读数（主进程接现有 Scanner，只读） */
  measure?: MeasureFn
  /** §19「并重新计算可用空间」：可选，读不到就留 null，不猜。 */
  measureFree?: (root: string) => Promise<number | null>
  nowMs?: number
  id?: string
  /**
   * §26 Phase 5「失败重试」：有界重试，**只重试瞬态 errno**。
   * 默认 3 次尝试、间隔 50ms。EPERM / EACCES 不在其列 —— Task 18 已实测 Windows 的只读位
   * 根本不是护栏（libuv 会先清属性再 DeleteFileW），所以那两类失败是稳定失败，
   * 重试只会把一批清理拖成几分钟而照样删不掉。
   */
  retry?: { maxAttempts?: number; delayMs?: number }
  /** 重试之间的等待。注入是为了单测确定性（不靠真实计时器赌时序）；默认是 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** §28 原则六：每个删除动作前判定一次 */
  shouldCancel?: () => boolean
  /** §18 的进度回调（UI 侧要"正在清理 + 已释放 X"） */
  onProgress?: (task: CleanTask) => void
}

/* ------------------------------------------------------------------ *
 * §26 Phase 5「失败重试」
 * ------------------------------------------------------------------ */

/**
 * 只有这些 errno 值得再试一次 —— 全是"占用中 / 资源暂时不够"这类过一会儿可能就好了的。
 * **EPERM / EACCES 故意不在里面**：Task 18 实测 Windows 上只读位根本不是护栏（libuv 先清属性
 * 再 DeleteFileW），所以那两类是稳定失败；对它们重试只会把一批清理拖成几分钟而照样删不掉，
 * 还会把"这台机器上真有一个不让删的文件"这个信号冲淡。
 */
const TRANSIENT_ERRNOS: ReadonlySet<string> = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOTEMPTY'])
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 50

/* ------------------------------------------------------------------ *
 * 路径判定
 * ------------------------------------------------------------------ */

const segsOf = (p: string): string[] => p.replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)

/** 严格位于 root 之内（root 自己不算）。key / rootKey 都是 normalizeKey 的产物。 */
function isStrictlyInside(key: string, rootKey: string): boolean {
  const prefix = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`
  return key.length > prefix.length - 1 && key.startsWith(prefix)
}

/** 路径长什么样都不许：相对、带通配/引号、带 `\\?\` 前缀、带 `..` 段。 */
function pathShapeProblem(p: string): string | null {
  if (p.startsWith('\\\\?\\')) return '扩展长度前缀（\\\\?\\）不是合法请求路径'
  if (/["*?<>|]/.test(p)) return '含 shell 通配/引号字符'
  if (segsOf(p).some((s) => s === '.' || s === '..')) return '含 . 或 .. 段'
  return null
}

function isDriveRootLike(p: string): boolean {
  const t = p.replace(/\//g, '\\').replace(/\\+$/, '')
  return /^[A-Za-z]:$/.test(t)
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 禁止根模板 → 绝对路径。任一条解析不出来就返回 unresolved（fail-safe 用）。 */
function resolveForbidden(patterns: readonly string[], env: RuleEnv): { roots: string[]; unresolved: string[] } {
  const roots: string[] = []
  const unresolved: string[] = []
  for (const p of patterns) {
    const res = resolvePattern(p, env)
    if (res.concrete !== null) roots.push(res.concrete)
    else if (res.base !== null) roots.push(res.base)
    else unresolved.push(p)
  }
  return { roots, unresolved }
}

/* ------------------------------------------------------------------ *
 * 公开入口
 * ------------------------------------------------------------------ */

export async function runCleanTask(req: CleanExecuteRequest, o: RunCleanOptions): Promise<CleanTask> {
  const nowMs = o.nowMs ?? Date.now()
  const fs = o.fs ?? nodeCleanFs
  const log = o.logger

  /**
   * 一次删除 + 必要的有界重试。四种结局分开返回，因为「重试时发现文件已经不在了」
   * 既不是成功也不是失败 —— §9 / §29 要求它记成「跳过文件」，冒充删除失败会把
   * "本来就不该有"算成工具没本事。
   */
  const maxAttempts = Math.max(1, o.retry?.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS)
  const retryDelayMs = Math.max(0, o.retry?.delayMs ?? DEFAULT_RETRY_DELAY_MS)
  const sleep = o.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const tryRemove = async (
    p: string,
    op: (path: string) => Promise<void>
  ): Promise<{ outcome: 'ok' | 'failed' | 'vanished' | 'cancelled'; attempts: number; errno?: string; detail?: string }> => {
    let attempts = 0
    for (;;) {
      attempts++
      try {
        await op(p)
        return { outcome: 'ok', attempts }
      } catch (e) {
        const errno = code(e)
        const detail = message(e)
        if (errno === 'ENOENT' && attempts > 1) return { outcome: 'vanished', attempts, errno, detail }
        if (!TRANSIENT_ERRNOS.has(errno) || attempts >= maxAttempts) return { outcome: 'failed', attempts, errno, detail }
        if (o.shouldCancel?.() === true) return { outcome: 'cancelled', attempts, errno, detail }
        await sleep(retryDelayMs)
      }
    }
  }
  const startedAt = nowMs

  const task: CleanTask = {
    id: o.id ?? `clean-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending',
    progress: 0,
    totalSize: 0,
    cleanedSize: 0,
    successCount: 0,
    failedCount: 0,
    authorizedRoot: typeof req?.authorizedRoot === 'string' ? req.authorizedRoot : '',
    requestedPaths: Array.isArray(req?.paths) ? [...req.paths] : [],
    acceptedPaths: [],
    blockers: [],
    refusals: [],
    deleted: [],
    dirsRemoved: [],
    verification: null,
    digest: '',
    startedAtMs: startedAt,
    finishedAtMs: startedAt
  }
  const refuse = (path: string, reason: CleanRefusal['reason'], detail: string, bytes = 0, overlapOf?: string): void => {
    task.refusals.push({ path, reason, detail, bytes, overlapOf })
    log?.clean(path, { status: 'refused', reason, task: task.id })
  }

  log?.clean('clean start', { task: task.id, root: task.authorizedRoot, requested: task.requestedPaths.length })

  /* -------- 闸 2：authorizedRoot 三关 -------- */

  const patterns = o.forbiddenPatterns ?? FORBIDDEN_PATH_PATTERNS
  const resolved = resolveForbidden(patterns, o.env)
  const deny = resolveForbidden(o.denyRoots ?? [], o.env)
  const reportOnly = resolveForbidden(o.reportOnlyPatterns ?? REPORT_ONLY_ROOT_PATTERNS, o.env)

  /**
   * 命中哪一类阻断根。「为什么不能删」要说最狠的那个理由：禁止根 > 调用方围栏 > 只上报根，
   * 三者共用同一条 `isForbiddenPath`（段边界），只有名单不同 —— 不许出现第四套"禁止"语义。
   */
  const blockedHit = (p: string): { root: string; reason: CleanRefusal['reason']; label: string } | null => {
    const f = isForbiddenPath(p, resolved.roots)
    if (f !== null) return { root: f, reason: 'forbidden-root', label: '§16 🔴 禁止路径' }
    const d = isForbiddenPath(p, deny.roots)
    if (d !== null) return { root: d, reason: 'forbidden-root', label: '调用方追加的围栏' }
    const r = isForbiddenPath(p, reportOnly.roots)
    if (r !== null) return { root: r, reason: 'report-only-root', label: '只上报根（占用如实报告，但任何规则都不可删）' }
    return null
  }
  const guard = await guardAuthorizedRootAsync(task.authorizedRoot, { ...o, fs })
  if (guard !== null) {
    task.status = 'refused'
    task.blockers = guard
    for (const p of task.requestedPaths)
      refuse(
        typeof p === 'string' ? p : String(p),
        resolved.unresolved.length > 0 || reportOnly.unresolved.length > 0
          ? 'forbidden-roots-unresolved'
          : 'out-of-scope',
        `authorizedRoot 校验未通过（${guard.map((b) => b.reason).join('、')}）→ 整批拒绝，一个文件都不动`
      )
    task.finishedAtMs = o.nowMs ?? Date.now()
    log?.clean('clean end', { task: task.id, status: task.status, blocked: guard[0]?.reason ?? '', success: 0, failed: 0, cleanedSize: 0 })
    return task
  }

  const rootKey = normalizeKey(task.authorizedRoot)

  /* -------- 闸 1：越界 / 重叠 -------- */

  interface Item {
    path: string
    key: string
  }
  const survivors: Item[] = []
  const escapeSources: string[] = []

  for (const raw of task.requestedPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      refuse(typeof raw === 'string' ? raw : String(raw), 'malformed-path', '路径必须是非空字符串 → 这条不处理')
      continue
    }
    const p = raw.trim()
    const key = normalizeKey(p)
    const shape = pathShapeProblem(p)
    if (shape !== null) {
      refuse(p, 'parent-traversal', `${shape} → 拒绝，且**不做二次 normalize 后放行**（§28 原则四）`)
      escapeSources.push(key)
      continue
    }
    if (key === rootKey) {
      refuse(p, 'equals-authorized-root', '请求删除授权根本身 = 无上限的删除范围，一律拒绝（§28 原则四）')
      escapeSources.push(key)
      continue
    }
    if (!isStrictlyInside(key, rootKey)) {
      // 越界是主判据；但同一条路径如果还命中阻断根，就点名叫它 —— 
      // 「为什么不能删」要说最狠的那个理由，不许用一句笼统的"范围外"盖掉 System32 这种硬禁止。
      const h = blockedHit(p)
      if (h !== null) {
        refuse(p, h.reason, `命中 ${h.label} ${h.root}（且不在授权根 ${task.authorizedRoot} 内）→ 拒绝`)
        escapeSources.push(key)
        continue
      }
      refuse(p, 'out-of-scope', `不在授权根 ${task.authorizedRoot} 之内 → 拒绝（§28 原则四：清理范围必须明确）`)
      escapeSources.push(key)
      continue
    }
    survivors.push({ path: p, key })
  }

  /** 与越界请求重叠 ⇒ 一起拒：一次删除请求的**范围**才是危险物，不是它里面的某一行 */
  const inScope = survivors.filter((it) => {
    const hit = escapeSources.find((src) => isStrictlyInside(it.key, src) || it.key === src)
    if (hit === undefined) return true
    refuse(it.path, 'overlaps-out-of-scope', `与越界请求 ${hit} 重叠 → 不许只删这个批次里"看起来安全"的那部分`, 0, hit)
    return false
  })

  /* -------- 闸 2b / 闸 3 / 闸 4：逐条定性 -------- */

  const files: Item[] = []
  const dirs: Item[] = []
  const sizes = new Map<string, number>()
  const lstatCache = new Map<string, CleanFsStat | 'missing' | 'error'>()
  const seen = new Set<string>()

  async function statOf(p: string): Promise<CleanFsStat | 'missing' | 'error'> {
    const k = normalizeKey(p)
    const hit = lstatCache.get(k)
    if (hit !== undefined) return hit
    let out: CleanFsStat | 'missing' | 'error'
    try {
      out = await fs.lstat(p)
    } catch (e) {
      out = code(e) === 'ENOENT' ? 'missing' : 'error'
      lstatCache.set(k, out)
      return out
    }
    lstatCache.set(k, out)
    return out
  }

  for (const it of inScope) {
    if (seen.has(it.key)) continue // 同一路径重复出现只处理一次
    seen.add(it.key)

    const h = blockedHit(it.path)
    if (h !== null) {
      refuse(it.path, h.reason, `命中 ${h.label} ${h.root} → 即使在授权根内也不删（复用引擎的同一判据）`)
      continue
    }
    const st = await statOf(it.path)
    if (st === 'missing') {
      refuse(it.path, 'not-found', 'lstat 就 ENOENT：目标不存在 → 记「跳过文件」（§29），不冒充删除失败')
      continue
    }
    if (st === 'error') {
      refuse(it.path, 'unstatable', 'lstat 读不到（权限/IO 错误）：既证不出它是普通文件，也证不出它不是 reparse point → 拒绝')
      continue
    }
    if (st.isSymbolicLink) {
      refuse(it.path, 'reparse-point', '最后一段是重解析点（symlink/junction）→ 不跟随、不删除（与 core/fs 的 kind=other 同口径）')
      continue
    }
    /**
     * 中间段的 reparse 检查：只查最后一段挡不住 `root\junc\file.bin` ——
     * 文本上没出界，物理上整条路径已经跑到授权根外面了。
     */
    const ancestor = await firstReparseAncestor(it.path, rootKey, statOf)
    if (ancestor !== null) {
      refuse(
        it.path,
        'reparse-ancestor',
        `路径中间的 ${ancestor} 是重解析点 → 跟随它会删到授权根之外的真实位置，一律拒绝`,
        st.isFile ? st.size : 0,
        ancestor
      )
      continue
    }
    if (st.isFile) {
      files.push(it)
      sizes.set(it.key, st.size)
      continue
    }
    if (st.isDirectory) {
      dirs.push(it)
      sizes.set(it.key, 0) // 目录自己的"大小"不是可释放字节，不计入 totalSize（§19 的实际数字由 measure 给）
      continue
    }
    refuse(it.path, 'not-a-deletable-entry', '既不是文件也不是目录（管道/设备/reparse 之类）→ 无可删语义')
  }

  task.acceptedPaths = [...files, ...dirs].map((i) => i.path)
  task.digest = executionDigest(task.authorizedRoot, task.acceptedPaths)
  task.totalSize = files.reduce((a, i) => a + (sizes.get(i.key) ?? 0), 0)

  /* -------- 开删（§19 的 before 读数必须在删除之前取） -------- */

  const before = await safeMeasure(o, task.authorizedRoot, log, task.id)
  const freeBefore = await safeMeasureFree(o, task.authorizedRoot)

  task.status = 'running'
  const total = files.length + dirs.length
  let done = 0

  for (const it of files) {
    if (o.shouldCancel?.() === true) {
      task.status = 'cancelled'
      break
    }
    const size = sizes.get(it.key) ?? 0
    const r = await tryRemove(it.path, (p) => fs.unlink(p))
    if (r.outcome === 'ok') {
      task.successCount++
      task.cleanedSize += size
      // outcome 是 §1.7 裁定 2 的**仅呈现字段**：只写不读，判定路径一律不看它（唯一的读面是 core/clean/journal.ts）
      task.deleted.push({ path: it.path, kind: 'file', bytes: size, ok: true, attempts: r.attempts, outcome: 'ok' })
      log?.clean(it.path, { status: 'success', size, kind: 'file', attempts: r.attempts, task: task.id })
    } else if (r.outcome === 'vanished') {
      refuse(
        it.path,
        'not-found',
        `第 ${r.attempts} 次尝试时 ENOENT：文件已被其他程序删掉 → 记「跳过文件」（§9 / §29），不冒充删除失败`
      )
    } else {
      // §28 原则五：一个文件失败绝不许打断整批，也绝不许把异常抛出执行器
      task.failedCount++
      task.deleted.push({
        path: it.path,
        kind: 'file',
        bytes: 0,
        ok: false,
        errno: r.errno,
        detail: r.outcome === 'cancelled' ? `${r.detail}；重试到第 ${r.attempts} 次前收到取消 → 停手（§28 原则六）` : r.detail,
        attempts: r.attempts,
        // 裁定 2：把"这次没成"分成「真失败」与「退避期间收到取消」两类，写的是**已经发生的那个结局**，
        // 不改任何计数与 status —— 下面那行 `if (r.outcome === 'cancelled')` 是原有判定，读的是局部返回值
        outcome: r.outcome === 'cancelled' ? 'cancelled' : 'failed'
      })
      log?.clean(it.path, { status: 'failed', size, errno: r.errno, kind: 'file', attempts: r.attempts, task: task.id })
      if (r.outcome === 'cancelled') task.status = 'cancelled'
    }
    done++
    task.progress = total > 0 ? done / total : 1
    o.onProgress?.(task)
    if (task.status === 'cancelled') break
  }

  /** 目录在文件之后、按深度从深到浅：这样"父目录 + 子目录都在请求里"时子目录先变空。 */
  if (task.status !== 'cancelled') {
    const ordered = [...dirs].sort((a, b) => segsOf(b.path).length - segsOf(a.path).length || a.key.localeCompare(b.key))
    for (const it of ordered) {
      if (o.shouldCancel?.() === true) {
        task.status = 'cancelled'
        break
      }
      const r = await tryRemove(it.path, (p) => fs.rmdir(p)) // 非递归：里面还有东西就 ENOTEMPTY —— 「只在空时才删」由 OS 语义执行
      if (r.outcome === 'ok') {
        task.successCount++
        task.dirsRemoved.push(it.path)
        task.deleted.push({ path: it.path, kind: 'dir', bytes: 0, ok: true, attempts: r.attempts, outcome: 'ok' })
        log?.clean(it.path, { status: 'success', size: 0, kind: 'dir', attempts: r.attempts, task: task.id })
      } else if (r.outcome === 'vanished') {
        refuse(it.path, 'not-found', `第 ${r.attempts} 次尝试时目录已不存在（别的程序先删了它）→ 记「跳过」（§9），不冒充删除失败`)
      } else {
        task.failedCount++
        task.deleted.push({
          path: it.path,
          kind: 'dir',
          bytes: 0,
          ok: false,
          errno: r.errno,
          detail: r.outcome === 'cancelled' ? `${r.detail}；重试到第 ${r.attempts} 次前收到取消 → 停手（§28 原则六）` : r.detail,
          attempts: r.attempts,
          outcome: r.outcome === 'cancelled' ? 'cancelled' : 'failed' // 同文件那一处：仅呈现，不参与判定
        })
        log?.clean(it.path, { status: 'failed', size: 0, errno: r.errno, kind: 'dir', attempts: r.attempts, task: task.id })
        if (r.outcome === 'cancelled') task.status = 'cancelled'
      }
      done++
      task.progress = total > 0 ? done / total : 1
      o.onProgress?.(task)
    }
  }

  if (task.status !== 'cancelled') task.status = 'completed'
  if (total === 0 && task.blockers.length === 0) task.progress = 1
  task.finishedAtMs = o.nowMs ?? Date.now()

  /* -------- §19 清理后验证 -------- */

  if (before !== null) {
    const after = await safeMeasure(o, task.authorizedRoot, log, task.id)
    const freeAfter = await safeMeasureFree(o, task.authorizedRoot)
    if (after !== null) {
      const actual = before.bytes - after.bytes
      task.verification = {
        rootBytesBefore: before.bytes,
        rootBytesAfter: after.bytes,
        actualFreedBytes: actual,
        predictedFreedBytes: task.totalSize,
        deletedBytes: task.cleanedSize,
        deltaBytes: actual - task.totalSize,
        filesBefore: before.files,
        filesAfter: after.files,
        freeBytesBefore: freeBefore,
        freeBytesAfter: freeAfter,
        note:
          actual === task.totalSize
            ? `§19 对账：授权根表观大小 ${before.bytes} → ${after.bytes} 字节。预估 ${task.totalSize} 与前后差 ${actual} 在这套「逐路径表观大小之和」的口径下相等 ——` +
              ` 相等只证明两笔表观账互相吻合，不证明磁盘真省下了这些字节：硬链接的名字删掉只减链接计数、表观照样少一份，` +
              `簇大小与备用数据流同理。磁盘侧的读数看下面的可用空间`
            : `§19 对账：工作单表观合计 ${task.totalSize} 字节，授权根表观大小前后差 ${actual} 字节（差额 ${actual - task.totalSize}）。` +
              ` 两个数字都如实报告，而它们都是「逐路径表观大小之和」—— 磁盘簇占用、备用数据流、清理期间的并发写入都会造成差，` +
              `硬链接则会造成反方向的假性一致（两边同样都不看 inode）；磁盘上真省了多少看下面的可用空间（§35.2 已知偏差）`
      }
    }
  }

  log?.clean('clean end', {
    task: task.id,
    status: task.status,
    success: task.successCount,
    failed: task.failedCount,
    refused: task.refusals.length,
    cleanedSize: task.cleanedSize,
    actualFreedBytes: task.verification?.actualFreedBytes,
    ms: task.finishedAtMs - startedAt
  })
  return task
}

async function firstReparseAncestor(path: string, rootKey: string, statOf: (p: string) => Promise<CleanFsStat | 'missing' | 'error'>): Promise<string | null> {
  // 只走授权根**之内**的那些段；parentOf 到 rootKey 为止
  let cur = parentOf(path)
  const chain: string[] = []
  while (cur !== null && normalizeKey(cur).length > rootKey.length && normalizeKey(cur).startsWith(rootKey)) {
    chain.unshift(cur)
    cur = parentOf(cur)
  }
  for (const dir of chain) {
    const st = await statOf(dir)
    if (st !== 'missing' && st !== 'error' && st.isSymbolicLink) return dir
  }
  return null
}

async function safeMeasure(o: RunCleanOptions, root: string, log?: CleanLog, taskId = ''): Promise<MeasureResult | null> {
  if (o.measure === undefined) return null
  try {
    return await o.measure(root)
  } catch (e) {
    log?.clean('verify measure failed', { task: taskId, errno: code(e), detail: message(e), status: 'failed' })
    return null
  }
}

async function safeMeasureFree(o: RunCleanOptions, root: string): Promise<number | null | undefined> {
  if (o.measureFree === undefined) return undefined
  try {
    return await o.measureFree(root)
  } catch {
    return null
  }
}

/** authorizedRoot 的三关。返回 null = 通过；否则返回 blockers（整批拒绝）。 */
function guardAuthorizedRoot(
  root: string,
  forbidden: { roots: string[]; unresolved: string[] },
  deny: { roots: string[] },
  reportOnly: { roots: string[]; unresolved: string[] }
): CleanBlocker[] | null {
  const blockers: CleanBlocker[] = []
  const push = (reason: CleanBlockerReason, detail: string): CleanBlocker[] => {
    blockers.push({ reason, detail })
    return blockers
  }
  if (typeof root !== 'string' || root.trim() === '') return push('root-malformed', 'authorizedRoot 必须是非空字符串')
  const p = root.trim()
  const shape = pathShapeProblem(p)
  if (shape !== null) return push('root-malformed', `authorizedRoot ${shape} → 拒绝`)
  if (!/^[A-Za-z]:\\/.test(p.replace(/\//g, '\\')) && !/^\\\\[^\\]+\\[^\\]+/.test(p.replace(/\//g, '\\'))) {
    // 关 1：盘符根（裸 `C:` / `C:\`）。放在"是否绝对路径"之前判定 ——
    // 裸盘符既不匹配 `X:\` 也不匹配 UNC，先按"不是绝对路径"报会掩盖真正的危险点。
    if (isDriveRootLike(p)) return push('root-is-drive-root', `authorizedRoot「${p}」是盘符根 → 整批拒绝，零删除`)
    return push('root-not-absolute', `authorizedRoot「${p}」不是盘符绝对路径或 UNC 共享 → 拒绝（§28 原则四）`)
  }
  if (isDriveRootLike(p)) return push('root-is-drive-root', `authorizedRoot「${p}」是盘符根 → 整批拒绝，零删除`)
  // 关 2：禁止根（复用 Task 16 的清单与判据）。解析不出来 = 保护看不见 = fail-safe。
  // 「只上报不可删」那张表落不了地也算同一种失明：看不见回收站就会把它当普通目录删。
  const unresolvedGuards = [...forbidden.unresolved, ...reportOnly.unresolved]
  if (unresolvedGuards.length > 0)
    return push(
      'root-forbidden-unresolved',
      `禁止根模板解析不出来（${unresolvedGuards.join('、')}）→ 无法证明 ${p} 不在 System32/WinSxS/回收站里，宁可什么都不删`
    )
  const deniedHit = isForbiddenPath(p, deny.roots)
  if (deniedHit !== null)
    return push('root-denied-by-caller', `authorizedRoot ${p} 落在调用方追加的围栏 ${deniedHit} 之内 → 拒绝（单独点名，不与 §16 🔴 混写）`)
  const all = [...forbidden.roots, ...deny.roots, ...reportOnly.roots]
  const hit = isForbiddenPath(p, forbidden.roots)
  if (hit !== null) return push('root-forbidden', `authorizedRoot ${p} 命中 §16 🔴 禁止路径 ${hit} → 整批拒绝`)
  const roHit = isForbiddenPath(p, reportOnly.roots)
  if (roHit !== null)
    return push('root-report-only', `authorizedRoot ${p} 落在只上报根 ${roHit} 之内 → 回收站这类目录只许报告占用，整批拒绝（§16 🔴）`)
  const swept = all.find((f) => pathIsUnder(f, p) && normalizeKey(f) !== normalizeKey(p))
  if (swept !== undefined)
    return push('root-ancestor-of-forbidden', `authorizedRoot ${p} 套住了禁止/只上报路径 ${swept}，宽容器一律不认（§28 原则四）`)
  // 关 3：存在且是目录、且自己不是 reparse point（要一次 lstat → 见 guardAuthorizedRootAsync）
  return null
}

/**
 * `guardAuthorizedRoot` 只做同步能做完的部分；存在性/目录性/reparse 需要一次 lstat → 这里补上。
 * 单独导出便于单测直接问「这个根到底过不过」。
 */
export async function guardAuthorizedRootAsync(root: string, o: RunCleanOptions): Promise<CleanBlocker[] | null> {
  const fs = o.fs ?? nodeCleanFs
  const forbidden = resolveForbidden(o.forbiddenPatterns ?? FORBIDDEN_PATH_PATTERNS, o.env)
  const deny = resolveForbidden(o.denyRoots ?? [], o.env)
  const reportOnly = resolveForbidden(o.reportOnlyPatterns ?? REPORT_ONLY_ROOT_PATTERNS, o.env)
  const sync = guardAuthorizedRoot(root, forbidden, deny, reportOnly)
  if (sync !== null) return sync
  try {
    const st = await fs.lstat(root.trim())
    if (st.isSymbolicLink) return [{ reason: 'root-is-reparse-point', detail: `authorizedRoot ${root} 本身是重解析点 → 跟随它等于把授权根搬到别处` }]
    if (!st.isDirectory) return [{ reason: 'root-not-a-directory', detail: `authorizedRoot ${root} 存在但不是目录` }]
  } catch (e) {
    return code(e) === 'ENOENT'
      ? [{ reason: 'root-missing', detail: `authorizedRoot ${root} 不存在（ENOENT）→ 零删除` }]
      : [{ reason: 'root-unstatable', detail: `authorizedRoot ${root} 读不到属性（${code(e)}）→ 无法证明安全性，零删除` }]
  }
  return null
}

/** 任务指纹：覆盖 authorizedRoot + 接受路径集合（归一、升序）。IPC 侧用它复核"删的就是确认过的那批"。 */
export function executionDigest(root: string, paths: readonly string[]): string {
  const body = [normalizeKey(root), [...paths].map(normalizeKey).sort().join('\u0000')].join('\u0001')
  return fnv1a(body, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(body, 0x1000193).toString(16).padStart(8, '0')
}

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/* ------------------------------------------------------------------ *
 * §18 的 CleanupManager：任务队列 + 取消 + 查询
 * ------------------------------------------------------------------ */

export interface RunningTask {
  taskId: string
  done: Promise<CleanTask>
}

export class CleanupManager {
  private readonly tasks = new Map<string, CleanTask>()
  private readonly cancelled = new Set<string>()
  private seq = 0

  /** 入队并立刻开始跑（§18 的图就是"统一进入任务队列"；并发上限由调用方把守）。 */
  start(req: CleanExecuteRequest, o: RunCleanOptions): RunningTask {
    const id = o.id ?? `clean-${Date.now().toString(36)}-${(this.seq++).toString(36)}`
    const done = runCleanTask(req, {
      ...o,
      id,
      shouldCancel: () => this.cancelled.has(id) || (o.shouldCancel?.() ?? false),
      onProgress: (t) => {
        this.tasks.set(id, t)
        o.onProgress?.(t)
      }
    })
    void done.then((t) => this.tasks.set(id, t))
    return { taskId: id, done }
  }

  /** §28 原则六：取消已启动的任务 —— 已删的不复活，剩下的不再碰。 */
  cancel(taskId: string): boolean {
    if (!this.tasks.has(taskId)) return false
    this.cancelled.add(taskId)
    return true
  }

  get(taskId: string): CleanTask | null {
    return this.tasks.get(taskId) ?? null
  }

  list(): CleanTask[] {
    return [...this.tasks.values()]
  }
}
