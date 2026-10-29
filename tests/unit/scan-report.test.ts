/**
 * v0.1「输出标准化 JSON」的验收。
 *
 * 三条要紧的：
 * 1. 报告里的计数必须**等于快照的计数** —— 导出的是同一次扫描，不是重新算一遍；
 * 2. 目录摘要是裁剪过的，所以折叠掉的目录数与字节必须点名（读的人才知道少了什么）；
 * 3. 同一棵树跑两次，JSON 必须逐字节相同 —— 否则"标准化"只是名字好听。
 */
import { describe, expect, it } from 'vitest'
import { Scanner } from '../../core/scan/scanner'
import { MAX_DENIED_SAMPLE, TreeStore } from '../../core/scan/tree-store'
import { buildScanReport, SCAN_REPORT_SCHEMA } from '../../core/report/scan-report'
import type { DirentLite, FsLike } from '../../core/fs/fslike'
import type { ScanSnapshot } from '../../shared/types'

const tree: Record<string, DirentLite[]> = {
  'R:\\': [
    { name: 'Users', kind: 'dir' },
    { name: 'Windows', kind: 'dir' },
    { name: 'Secret', kind: 'dir' },
    { name: 'pagefile.sys', kind: 'file' }
  ],
  'R:\\pagefile.sys': [],
  'R:\\Users': [{ name: 'Kano', kind: 'dir' }],
  'R:\\Users\\Kano': [{ name: 'a.bin', kind: 'file' }],
  'R:\\Users\\Kano\\a.bin': [],
  'R:\\Windows': [{ name: 'System32', kind: 'dir' }],
  'R:\\Windows\\System32': [{ name: 'nt.dll', kind: 'file' }],
  'R:\\Windows\\System32\\nt.dll': []
  // 故意不给 'R:\\Secret' 这一项：readdir 它必 EPERM，这才是 §8 要的"权限异常被跳过并记账"
}
const SIZES: Record<string, number> = { 'R:\\pagefile.sys': 9000, 'R:\\Users\\Kano\\a.bin': 1000, 'R:\\Windows\\System32\\nt.dll': 5000 }

const fs: FsLike = {
  async readdir(p) {
    const e = tree[p]
    if (!e) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    return e
  },
  async stat(p) {
    if (!(p in tree)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (p === 'R:\\Secret') throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' })
    return { size: SIZES[p] ?? 0, mtimeMs: 7, birthtimeMs: 6, attrs: 0 }
  }
}

async function scanned(): Promise<Scanner> {
  const s = new Scanner({ fs, concurrency: 4, progressIntervalMs: 5, maxFiles: 1_000_000, maxDepth: 64 })
  await s.start('R:\\', () => undefined)
  return s
}

const build = (s: Scanner, nowMs = 1_700_000_000_000) =>
  buildScanReport({
    snapshot: s.snapshot(),
    source: s.store,
    topFiles: [...s.topRaw()],
    appVersion: '0.1.0',
    nowMs,
    peakRssBytes: 123456,
    maxDepth: 2,
    topPerLevel: 2
  })

/**
 * Task 9：报告里的 `errors.sample`。
 * 两个方向都要守住 —— 有 denied 时清单与计数同源，没 denied 时**不给一个空数组冒充「有这一栏」**。
 * 两份假 fs 只差一个目录：`locked` 那个 readdir 必 EACCES，干净那份什么都能读。
 */
function fsWithLocked(locked: boolean): FsLike {
  return {
    async readdir(p: string) {
      if (locked && p === 'R:\\locked') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      if (p === 'R:\\') {
        return [
          { name: 'open', kind: 'dir' },
          ...(locked ? [{ name: 'locked', kind: 'dir' as const }] : []),
          { name: 'a.txt', kind: 'file' }
        ]
      }
      if (p === 'R:\\open') return [{ name: 'b.txt', kind: 'file' }]
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async stat() {
      return { size: 1, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }
    }
  }
}

async function scannedWith(locked: boolean): Promise<Scanner> {
  const s = new Scanner({ fs: fsWithLocked(locked), concurrency: 2, progressIntervalMs: 5, maxFiles: 1000, maxDepth: 8 })
  await s.start('R:\\', () => undefined)
  return s
}

/** 报告是给人读的 JSON：`undefined` 字段必须**整键消失**，不能留一个 `"sample": null` 或空数组。 */
const jsonKeys = (r: ReturnType<typeof build>): string[] => Object.keys(JSON.parse(JSON.stringify(r)).scan.errors)

describe('v0.1 标准化扫描报告', () => {
  it('带 schema 版本，且计数与快照逐项相等（导出的是同一次扫描，不是重算）', async () => {
    const s = await scanned()
    const snap = s.snapshot()
    const r = build(s)
    expect(r.schema, '单个目录被拒不许把整次扫描判失败（§8）').toBe(SCAN_REPORT_SCHEMA)
    expect(r.app).toEqual({ name: 'DeepClean', version: '0.1.0' })
    expect(r.scan.counters).toEqual({ files: snap.files, dirs: snap.dirs, totalBytes: snap.totalBytes })
    expect(r.scan.root).toBe('R:\\')
    expect(r.scan.status).toBe('completed')
    expect(r.scan.elapsedMs).toBe(snap.elapsedMs)
    expect(r.scan.peakRssBytes).toBe(123456)
  })

  it('权限异常被记进 errors 分账，而不是消失或让扫描失败', async () => {
    const s = await scanned()
    const r = build(s)
    expect(r.scan.status).toBe('completed')
    expect(r.scan.errors.denied + r.scan.errors.busy + r.scan.errors.otherErrors).toBeGreaterThan(0)
    expect(r.scan.errors.skipped).toBe(r.scan.errors.denied + r.scan.errors.missing + r.scan.errors.busy + r.scan.errors.otherErrors)
  })

  it('速度字段与「计数 ÷ 净时间」自洽（不是另算一套口径）', async () => {
    const s = await scanned()
    const r = build(s)
    const sec = Math.max(1, r.scan.elapsedMs) / 1000
    expect(r.scan.speed.filesPerSec).toBeCloseTo(r.scan.counters.files / sec, 1)
    expect(r.scan.speed.bytesPerSec).toBeCloseTo(r.scan.counters.totalBytes / sec, -6)
  })

  it('目录摘要不是空的：根节点必须等于快照总量，且裁剪掉的目录数与字节都点名', async () => {
    const s = await scanned()
    const r = build(s)
    // 这一条是承重断言：曾经 rootId 取错来源，childrenOf(undefined) 静默返回 []，
    // 于是 tree.size=0 / dirs=0 而计数照常 —— 而"kept + folded === dirs"在空树上是 0===0 空过的。
    expect(r.tree.path).toBe('R:\\')
    expect(r.tree.size).toBe(r.scan.counters.totalBytes)
    expect(r.tree.dirs).toBeGreaterThan(0)
    expect(r.treeLimits).toEqual({ maxDepth: 2, topPerLevel: 2 })
    const kept = r.tree.children ?? []
    expect(kept.length + r.tree.foldedDirs).toBe(r.tree.dirs)
    expect(kept.length).toBeLessThanOrEqual(2)
    expect(r.tree.foldedBytes).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(build(s))).toEqual(JSON.stringify(r))
  })

  it('topFiles 是具体路径 + 大小 + mtime，按大小降序（大文件分析能直接复用）', async () => {
    const s = await scanned()
    const r = build(s)
    expect(r.topFiles.length).toBeGreaterThan(0)
    const sizes = r.topFiles.map((f) => f.size)
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes)
    expect(r.topFiles[0]!.path).toContain('R:\\')
    expect(r.topFiles[0]!.mtimeMs).toBe(7)
  })
})

/**
 * Task 9 §15：报告要能点名"哪些目录没算进来"。
 * 加字段是**纯增**的：schema 仍是 `deepclean.scan-report/1`，两个生产者（app 导出、smoke-real 脚本）
 * 都走同一个 `buildScanReport`，所以这条链只需在此处钉一次。
 */
describe('报告里的被拒路径清单（errors.sample / sampleOverflow）', () => {
  it('errors.sample 与 skipped() 同源；只有 denied 一种错误时两个数必须相等', async () => {
    const s = await scannedWith(true)
    const report = build(s)
    expect(report.scan.errors.denied).toBeGreaterThan(0)
    // 只有 denied 一种错误 → skipped 就是 denied（防止将来加新错误种类时把 skipped 的口径改松）
    expect(report.scan.errors.denied).toBe(report.scan.errors.skipped)
    expect(report.scan.errors.sample).toEqual(s.skipped().sample)
    expect(report.scan.errors.sample).toContain('R:\\locked')
    expect(report.scan.errors.sample!.length).toBe(report.scan.errors.denied)
    expect(report.scan.errors.sampleOverflow).toBeUndefined() // 没溢出就不给这个键
    // 报告是 JSON：没溢出不许留键（`"sampleOverflow": null` 也算"说了一句假话"）
    expect(jsonKeys(report)).toEqual(['denied', 'missing', 'busy', 'otherErrors', 'skipped', 'sample'])
    expect(report.schema).toBe(SCAN_REPORT_SCHEMA)
  })

  it('溢出时清单与溢出数加起来等于 denied（报告自己就得能对上账）', () => {
    const s = new TreeStore({ rootPath: 'R:\\', maxFiles: 10, topN: 1 })
    for (let i = 0; i < MAX_DENIED_SAMPLE + 30; i++) s.addError('denied', `R:\\d${i}`)
    const snap: ScanSnapshot = {
      scanId: 'x',
      root: 'R:\\',
      status: 'completed',
      currentPath: 'R:\\',
      elapsedMs: 10,
      startedAtMs: 1_700_000_000_000,
      finishedAtMs: 1_700_000_000_010,
      truncated: false,
      ...s.stats()
    }
    const report = buildScanReport({
      snapshot: snap,
      source: s,
      topFiles: [],
      appVersion: 'test',
      nowMs: 1,
      peakRssBytes: null
    })
    expect(report.scan.errors.denied).toBe(MAX_DENIED_SAMPLE + 30)
    expect(report.scan.errors.sample).toHaveLength(MAX_DENIED_SAMPLE)
    expect(report.scan.errors.sampleOverflow).toBe(30)
    expect((report.scan.errors.sample?.length ?? 0) + (report.scan.errors.sampleOverflow ?? 0)).toBe(
      report.scan.errors.denied
    )
  })

  it('无 denied 时不给空数组冒充「有这一栏」', async () => {
    const s = await scannedWith(false)
    const report = build(s)
    expect(report.scan.errors.denied).toBe(0)
    expect(report.scan.errors.sample).toBeUndefined()
    expect(report.scan.errors.sampleOverflow).toBeUndefined()
    expect(jsonKeys(report)).toEqual(['denied', 'missing', 'busy', 'otherErrors', 'skipped'])
  })
})
