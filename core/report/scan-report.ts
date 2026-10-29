/**
 * v0.1 清单最后一项：「输出标准化 JSON」。
 *
 * 一份 schema，两个出口 —— app 里点「导出 JSON」，以及 `scripts/smoke-real.mjs` 跑真实盘时
 * 落的产物，都是这里 `buildScanReport()` 出来的。之所以强调"一份"：如果脚本自己拼一套字段，
 * 那么真实盘那次跑出来的东西就没法和 app 的输出对照，标准化也就白做了。
 *
 * 纯函数：只吃已经扫好的树与快照，不 import fs / electron（与 core/ 其余模块同一约束）。
 */
import type { ChildView, FileHit, ScanSnapshot, SkippedWire } from '../../shared/types'

export const SCAN_REPORT_SCHEMA = 'deepclean.scan-report/1'

export interface DirSummary {
  path: string
  size: number
  files: number
  dirs: number
  /** 这一层还有多少个更小的兄弟目录没单独列出来（折进本条） */
  foldedDirs: number
  foldedBytes: number
  children?: DirSummary[]
}

export interface ScanReportJson {
  schema: typeof SCAN_REPORT_SCHEMA
  generatedAtMs: number
  app: { name: 'DeepClean'; version: string }
  scan: {
    scanId: string
    root: string
    status: ScanSnapshot['status']
    /** 净工作时间：暂停的时长不计入，否则「扫描速度」这个数字会被暂停污染 */
    elapsedMs: number
    truncated: boolean
    counters: { files: number; dirs: number; totalBytes: number }
    /**
     * `sample` / `sampleOverflow` 是 Task 9 的**纯增**字段（§15 要能点名"哪些目录没算进地图"）：
     * schema 仍是 `deepclean.scan-report/1`，老读者按名字取字段、多出来的键直接忽略，不受影响。
     * 两个方向都不许"用 0 或空数组冒充说过一句话"：
     * - 没有 denied → `sample` 整键缺席（不给 `[]`，那看起来像"这一栏是空的"而不是"根本没这一栏"）；
     * - 没有溢出 → `sampleOverflow` 整键缺席（不给 0）。
     * 有值时恒等式 `sample.length + (sampleOverflow ?? 0) === denied` 成立，见下面的构造处。
     */
    errors: {
      denied: number
      missing: number
      busy: number
      otherErrors: number
      skipped: number
      sample?: string[]
      sampleOverflow?: number
    }
    speed: { filesPerSec: number; bytesPerSec: number; dirsPerSec: number }
    peakRssBytes: number | null
  }
  topFiles: Array<{ path: string; name: string; size: number; mtimeMs: number }>
  tree: DirSummary
  /** 目录摘要的裁剪参数写出来，读的人才知道这份 JSON 不是全树 */
  treeLimits: { maxDepth: number; topPerLevel: number }
}

export interface BuildReportInput {
  snapshot: ScanSnapshot
  /**
   * 只需要读取面：`scanner.store` / `TreeStore` 结构上直接满足。
   * `skipped` 是 Task 9 起的**可选**读取面（§15 清单）：不给就当这次扫描没有清单可说，
   * 报告的 `errors` 于是回到改动之前的形状（两个键都不出现），不猜也不补空数组。
   */
  source: {
    rootId: number
    childrenOf(dirId: number): ChildView[]
    dirIdByPath?(path: string): number | undefined
    skipped?(): SkippedWire
  }
  topFiles: readonly FileHit[]
  appVersion: string
  nowMs: number
  peakRssBytes?: number | null
  maxDepth?: number
  topPerLevel?: number
}

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_TOP_PER_LEVEL = 12

export function buildScanReport(i: BuildReportInput): ScanReportJson {
  const maxDepth = i.maxDepth ?? DEFAULT_MAX_DEPTH
  const topPerLevel = i.topPerLevel ?? DEFAULT_TOP_PER_LEVEL
  const s = i.snapshot
  const elapsedMs = Math.max(1, s.elapsedMs)

  return {
    schema: SCAN_REPORT_SCHEMA,
    generatedAtMs: i.nowMs,
    app: { name: 'DeepClean', version: i.appVersion },
    scan: {
      scanId: s.scanId,
      root: s.root,
      status: s.status,
      elapsedMs: s.elapsedMs,
      truncated: s.truncated,
      counters: { files: s.files, dirs: s.dirs, totalBytes: s.totalBytes },
      errors: buildErrors(s, i.source),
      speed: {
        filesPerSec: round2((s.files * 1000) / elapsedMs),
        bytesPerSec: Math.round((s.totalBytes * 1000) / elapsedMs),
        dirsPerSec: round2((s.dirs * 1000) / elapsedMs)
      },
      peakRssBytes: i.peakRssBytes ?? null
    },
    topFiles: i.topFiles.map((f) => ({ path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs })),
    // rootId 在 source（TreeStore）上，不在快照上 —— 从快照取会拿到 undefined，
    // 于是 childrenOf 静默返回 []，报告里的目录树全空而计数照常（探针实测抓到过）
    tree: summarizeDir(i, s.root, i.source.rootId, 0, maxDepth, topPerLevel),
    treeLimits: { maxDepth, topPerLevel }
  }
}

/**
 * §15 的错误分账 +（有就说、没有就整键缺席的）被拒路径清单。
 *
 * 三份算术必须在这一个函数里闭合：
 * - 计数一律取**快照**的（本文件的头号纪律：报告导出的是同一次扫描，不是重算一遍）；
 * - 清单取 `source.skipped()`。两者读的是同一个 `TreeStore`，扫描结束后必然一致；
 *   扫描**仍在跑**时快照是稍早的那一次读，清单可能更长 → 清单按快照的 `denied` 截齐、
 *   溢出也从快照的 `denied` 出发，于是 `sample.length + (sampleOverflow ?? 0) === denied`
 *   在报告里恒成立（截掉的那几条本来就是快照之后才发生的）。
 * - 一个都没有 → 两个键都不出现。空数组/0 都会被读的人当成"这一栏说了句话"。
 */
function buildErrors(s: ScanSnapshot, source: BuildReportInput['source']): ScanReportJson['scan']['errors'] {
  const base = { denied: s.denied, missing: s.missing, busy: s.busy, otherErrors: s.otherErrors, skipped: s.skipped }
  const sk = source.skipped ? source.skipped() : undefined
  if (!sk || s.denied === 0 || sk.sample.length === 0) return base
  const sample = sk.sample.slice(0, s.denied)
  const overflow = s.denied - sample.length
  return {
    ...base,
    sample: sample.length > 0 ? sample : undefined,
    sampleOverflow: overflow > 0 ? overflow : undefined
  }
}

function summarizeDir(
  i: BuildReportInput,
  path: string,
  dirId: number,
  depth: number,
  maxDepth: number,
  topPerLevel: number
): DirSummary {
  const kids = i.source.childrenOf(dirId)
  const subDirs = kids
    .filter((k) => k.kind === 'directory')
    .sort((a, b) => b.size - a.size || cmpPath(a.path, b.path))
  const filesHere = kids.filter((k) => k.kind === 'file')

  const own: DirSummary = {
    path,
    size: filesHere.reduce((s, f) => s + f.size, 0) + subDirs.reduce((s, d) => s + d.size, 0),
    files: filesHere.length,
    dirs: subDirs.length,
    foldedDirs: 0,
    foldedBytes: 0
  }
  if (depth >= maxDepth || subDirs.length === 0) return own

  const kept = subDirs.slice(0, topPerLevel)
  const folded = subDirs.slice(topPerLevel)
  own.foldedDirs = folded.length
  own.foldedBytes = folded.reduce((s, d) => s + d.size, 0)
  // 递归顺序固定按大小降序 + 路径字典序，所以同一棵树跑两次，JSON 逐字节相同
  own.children = kept.map((d) => {
    const id = d.dirId ?? idOf(i, d)
    return id === undefined ? leafOf(d) : summarizeDir(i, d.path, id, depth + 1, maxDepth, topPerLevel)
  })
  return own
}

function idOf(i: BuildReportInput, k: ChildView): number | undefined {
  const withLookup = i.source as { dirIdByPath?: (p: string) => number | undefined }
  return withLookup.dirIdByPath ? withLookup.dirIdByPath(k.path) : undefined
}

/** 拿不到子树 id（source 没提供查找）时退化成一条叶子摘要，不猜内容。 */
function leafOf(k: ChildView): DirSummary {
  return { path: k.path, size: k.size, files: k.fileCount, dirs: k.dirCount, foldedDirs: 0, foldedBytes: 0 }
}

function cmpPath(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
