import { SKIP_ALWAYS, classifyFsError, type ScanErrorKind } from '../fs/errors'
import { lookupFindDataEntry, type FindDataLister } from '../fs/finddata'
import { baseName, joinWin } from '../fs/pathutil'
import type { DirentLite, FsLike } from '../fs/fslike'
import { Semaphore } from './semaphore'

export interface WalkFile {
  name: string
  size: number
  mtimeMs: number
  /** 创建时间；与 size/mtime/attrs 来自同一次 stat（零额外 syscall）。 */
  birthtimeMs: number
  /** 已证明的 FILE_ATTRIBUTE_* 位；与 size/mtime 来自同一次 stat（零额外 syscall）。 */
  attrs: number
}

export interface WalkNode {
  path: string
  name: string
  files: WalkFile[]
  dirs: WalkNode[]
  size: number
  fileCount: number
  dirCount: number
  mtimeMs: number
  /** 本节点 + 所有后代的错误计数（向上合并过），root 上就能读到整棵子树的 denied/missing。 */
  errors: Record<ScanErrorKind, number>
  /**
   * 本节点 + 所有后代里"靠目录枚举兜底才拿到大小"的文件数与字节数。
   * 必须向上聚合：调用方（`scanner.ts`）自己那条浅层路也有一份计数，两边相加才是
   * 一整轮的总数。只报其中一条路 = 一个会被当成总数引用的半数数字。
   */
  findDataFiles: number
  findDataBytes: number
}

export type WalkEvent =
  | { kind: 'file'; path: string; size: number; mtimeMs: number }
  | { kind: 'dir'; path: string; size: number }
  | { kind: 'error'; path: string; err: ScanErrorKind }
  | { kind: 'current'; path: string }

export interface WalkOptions {
  fs: FsLike
  concurrency: number
  maxDepth: number
  isCancelled: () => boolean
  /**
   * v0.1「暂停」：每个目录入口 await 一次。做成协作式而不是掐线程 —— 掐线程会让已经发出去的
   * readdir/stat 变成孤儿，而这里要的是"手上这一层做完就不再往下走"。
   * 契约：取消时它必须自己返回（否则暂停中按取消就永久挂住），由调用方保证。
   */
  waitWhilePaused?: () => Promise<void>
  onEvent?: (e: WalkEvent) => void
  /**
   * 目录枚举兜底（`core/fs/finddata.ts`，不需要管理员）。只在 `stat` 报 `denied` 之后
   * 按目录惰性调用，每个目录至多一次。不给它，行为与今天逐字相同。
   */
  findData?: FindDataLister
}

const KINDS: ScanErrorKind[] = ['denied', 'missing', 'busy', 'tooManyHandles', 'notDir', 'cycle', 'unknown']

const noErrors = (): Record<ScanErrorKind, number> => ({
  denied: 0,
  missing: 0,
  busy: 0,
  tooManyHandles: 0,
  notDir: 0,
  cycle: 0,
  unknown: 0
})

function mergeInto(dst: Record<ScanErrorKind, number>, src: Record<ScanErrorKind, number>): void {
  for (const k of KINDS) dst[k] += src[k]
}

function leaf(path: string): WalkNode {
  return {
    path,
    name: baseName(path),
    files: [],
    dirs: [],
    size: 0,
    fileCount: 0,
    dirCount: 0,
    mtimeMs: 0,
    errors: noErrors(),
    findDataFiles: 0,
    findDataBytes: 0
  }
}

/** 单个目录子树的完整遍历，后序聚合。取消/出错时返回 null，由调用方合并错误。 */
interface VisitResult {
  node: WalkNode | null
  errors: Record<ScanErrorKind, number>
}

/**
 * 有界并发异步遍历（§6）：
 * 目录内每个文件的 stat、每个兄弟目录的 readdir 全部丢给同一个 Semaphore 限流，
 * 因此既有真实并发（libuv 线程池并行 I/O），又不会把磁盘拉满。
 * 任何 errno 都只是「记录 + 跳过 + 继续」（§8/§9），本函数永不因单个错误失败。
 */
export async function walkSubtree(rootPath: string, opts: WalkOptions): Promise<WalkNode> {
  const sem = new Semaphore(opts.concurrency)
  const r = await visit(rootPath, 0, sem, opts)
  if (r.node) return r.node
  // root 自己就被拒 / 深度为 0 处取消：仍要返回一个带错误计数的空节点，让上层能出图
  const n = leaf(rootPath)
  mergeInto(n.errors, r.errors)
  return n
}

async function visit(path: string, depth: number, sem: Semaphore, opts: WalkOptions): Promise<VisitResult> {
  const errs = noErrors()
  /** 记一笔错误：既进本节点的错误表（随后向上合并），也即时推给 onEvent（§7 实时统计）。 */
  const note = (at: string, kind: ScanErrorKind): void => {
    errs[kind]++
    opts.onEvent?.({ kind: 'error', path: at, err: kind })
  }

  if (opts.isCancelled()) return { node: null, errors: errs }
  // 暂停门放在 readdir 之前：这一层不再往下走，但已发出的请求不会被掐断
  if (opts.waitWhilePaused) {
    await opts.waitWhilePaused()
    if (opts.isCancelled()) return { node: null, errors: errs }
  }
  if (depth > opts.maxDepth) {
    note(path, 'cycle')
    return { node: null, errors: errs }
  }
  opts.onEvent?.({ kind: 'current', path })

  let ents: DirentLite[]
  try {
    ents = await sem.run(() => opts.fs.readdir(path))
  } catch (e) {
    note(path, classifyFsError(e))
    return { node: null, errors: errs }
  }

  const n = leaf(path)
  const dirJobs: Array<Promise<VisitResult>> = []
  const fileJobs: Array<Promise<void>> = []

  for (const ent of ents) {
    if (opts.isCancelled()) break
    const childPath = joinWin(path, ent.name)
    if (ent.kind === 'dir') {
      // 名单内的目录（System Volume Information 等）连 readdir 都不发：不属主、必 EPERM，纯浪费 I/O
      if (SKIP_ALWAYS.has(ent.name.toLowerCase())) continue
      // 目录**不 stat**，所以目录属性与创建时间这一轮都不采（ChildView.attrs / ChildView.birthtimeMs = null）。
      // 为了拿它们而给每个目录加一次 lstat = 真实 C 盘多 ~7.3 万次 I/O（实测 dirs=73,120），
      // 而本文件的设计红线是"属性必须零成本"。宁可留空，也不用 directory 权限位假装读出过属性。
      // 暂停门必须放在**创建 job 之前**：兄弟目录的 readdir 就是在这一行被发起的，
      // 只在 visit() 入口等门的话，根层那一拥而下的几十个目录照样会把整层读穿才停。
      // 每个子目录让出一个微任务（真实 C 盘 ≈7.3 万次，成本可忽略），换来"暂停真能停住"。
      if (opts.waitWhilePaused) {
        await opts.waitWhilePaused()
        if (opts.isCancelled()) break
      }
      // 先创建 Promise（= 立刻开始 readdir），稍后才逐个 await → 兄弟目录并行展开，这是并发度的主要来源
      dirJobs.push(visit(childPath, depth + 1, sem, opts))
    } else if (ent.kind === 'file') {
      fileJobs.push(
        sem
          .run(async () => {
            try {
              // 属性与创建时间来自这次 stat 本身（st_mode 的只读位 / birthtimeMs）→ 零额外 syscall。
              // attrs、birthtimeMs 只往 ChildView / 分类判据走，**不参与 size / fileCount / mtime 聚合**，
              // 所以 §35.2 那三份对账数字必须一个都不动（tests/unit/walk.test.ts 有哨兵）。
              const st = await opts.fs.stat(childPath)
              n.files.push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, attrs: st.attrs })
              opts.onEvent?.({ kind: 'file', path: childPath, size: st.size, mtimeMs: st.mtimeMs })
            } catch (e) {
              const kind = classifyFsError(e)
              // 被 ACL 挡住 ≠ 这个文件没有大小：目录项的查找记录里有，而且是同一条 NTFS 记录，
              // 不需要管理员。取不到就照今天的路子如实记一笔。
              const fd = kind === 'denied' ? await lookupFindDataEntry(opts.findData, path, ent.name) : null
              if (fd === null) {
                note(childPath, kind)
                return
              }
              n.files.push({ name: ent.name, size: fd.size, mtimeMs: fd.mtimeMs, birthtimeMs: fd.birthtimeMs, attrs: fd.attrs })
              n.findDataFiles++
              n.findDataBytes += fd.size
              opts.onEvent?.({ kind: 'file', path: childPath, size: fd.size, mtimeMs: fd.mtimeMs })
            }
          })
          .then(() => undefined)
      )
    }
    // kind === 'other'（软链接 / junction / 重解析点 / 设备）静默忽略：不跟随、不计数
  }

  await Promise.all(fileJobs)
  // 这个目录的条目已全部消费（文件都 stat 过；子目录各持自己的缓存）→ 释放缓存型 fs 的条目。
  // 取消路径也走到这里：消费了多少就释放多少，缓存不欠账。
  opts.fs.release?.(path)
  for (const j of dirJobs) {
    const sub = await j
    // 子树即使整个失败（node 为 null），它的 errors 也必须冒泡到父级，最终在 root 上聚合可见
    mergeInto(errs, sub.errors)
    if (sub.node) n.dirs.push(sub.node)
  }

  // 后序聚合（§2.1 获取目录总大小）
  let size = 0,
    fc = 0,
    dc = 0,
    mt = 0,
    fdFiles = n.findDataFiles,
    fdBytes = n.findDataBytes
  for (const d of n.dirs) {
    fdFiles += d.findDataFiles
    fdBytes += d.findDataBytes
  }
  for (const f of n.files) {
    size += f.size
    fc++
    mt = Math.max(mt, f.mtimeMs)
  }
  for (const d of n.dirs) {
    size += d.size
    fc += d.fileCount
    dc += 1 + d.dirCount
    mt = Math.max(mt, d.mtimeMs)
  }
  n.size = size
  n.fileCount = fc
  n.dirCount = dc
  n.mtimeMs = mt
  n.errors = errs
  n.findDataFiles = fdFiles
  n.findDataBytes = fdBytes
  opts.onEvent?.({ kind: 'dir', path, size })
  return { node: n, errors: errs }
}
