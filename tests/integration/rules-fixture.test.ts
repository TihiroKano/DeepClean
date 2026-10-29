/**
 * Task 16 集成账：规则引擎跑在**真实扫描出来的 100k 夹具树**上，必须满足两条：
 *
 * 1. §35.2 的三条对账坐标（files / dirs / bytes）一字不动 —— 规则只是只读叠加层，
 *    不重新走盘（约束 1）、不写盘（约束 4）。期望值现场从 oracle 取，与 fixture-scan.test.ts 同一套算式。
 * 2. 评估两次结果逐字节相同（报告不依赖 Map 迭代顺序），且任何一条 finding 的采样路径
 *    都不许落在被扫描器静默跳过的 `System Volume Information` 或 🔴 禁止根之下。
 *
 * 跑法与 fixture-scan.test.ts 相同（缺 oracle 环境变量时整体 skip，不会把 CI 变红灯）：
 *   DC_ORACLE="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k')" \
 *   DC_ORACLE_EXCLUDED="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k/System Volume Information')" \
 *   npm run test:integration
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { Scanner } from '../../core/scan/scanner'
import { nodeFs } from '../../core/fs/fslike'
import { evaluateRules } from '../../core/rules/engine'
import { BUILTIN_RULES } from '../../core/rules/registry'
import type { RuleEnv } from '../../core/rules/types'
import type { ScanSnapshot } from '../../shared/types'

interface Oracle {
  files: number
  dirs: number
  bytes: number
  enumErrors: number
  root: string
}
const parse = (raw?: string): Oracle | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Oracle
  } catch {
    return null
  }
}
const ORACLE = parse(process.env.DC_ORACLE)
const EXCLUDED = parse(process.env.DC_ORACLE_EXCLUDED)
const FIXTURE = process.env.DC_FIXTURE ?? 'D:/deepclean-fixture/f100k'

const win = (p: string): string => {
  let s = win32.resolve(p).replace(/\//g, '\\')
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s
}
const ROOT = win(FIXTURE)
const ready = existsSync(ROOT) && !!ORACLE && !!EXCLUDED
/** 与 fixture-scan.test.ts 同一套差异口径：全树 − 被静默跳过的子树，根按扫描器约定挪 1。 */
const expFiles = ORACLE && EXCLUDED ? ORACLE.files - EXCLUDED.files : -1
const expDirs = ORACLE && EXCLUDED ? ORACLE.dirs - (EXCLUDED.dirs + 1) + 1 : -1
const expBytes = ORACLE && EXCLUDED ? ORACLE.bytes - EXCLUDED.bytes : -1

/**
 * 夹具不是真的 Windows 配置目录，所以这里把规则的地盘**指到夹具里真实存在的分支上**
 * （TEMP → `__Temp__`，WINDIR → `Windows`，PROGRAMDATA → `ProgramData`）。
 * 其余浏览器/缩略图路径在夹具里不存在 → 引擎应当记 `not-scanned`，而不是编造命中。
 */
const envFor = (root: string): RuleEnv => ({
  SYSTEMDRIVE: `${root}\\`,
  WINDIR: join(root, 'Windows'),
  TEMP: join(root, '__Temp__'),
  LOCALAPPDATA: join(root, 'AppData'),
  APPDATA: join(root, 'AppData', 'Roaming'),
  PROGRAMDATA: join(root, 'ProgramData'),
  USERPROFILE: join(root, 'Users')
})
const FORBIDDEN = ['%WINDIR%\\System32', '%SYSTEMDRIVE%\\System Volume Information']

describe.skipIf(!ready)('规则引擎 × 100k 夹具（只读叠加层，§35.2 不许动）', () => {
  let snap: ScanSnapshot
  let sc: Scanner
  const opts = { fs: nodeFs, concurrency: 16, progressIntervalMs: 500, maxFiles: 3_000_000, maxDepth: 64 }

  beforeAll(async () => {
    sc = new Scanner(opts)
    snap = await sc.start(ROOT, () => undefined)
  }, 600_000)

  it('扫描器自身仍是那三个数（先把基线钉住，再谈规则有没有动它）', () => {
    expect(snap.status).toBe('completed')
    expect(snap.files).toBe(expFiles)
    expect(snap.dirs).toBe(expDirs)
    expect(snap.totalBytes).toBe(expBytes)
  }, 600_000)

  it('评估前后 TreeStore 的 files / dirs / totalBytes / 根聚合大小逐字段相同', () => {
    const before = { ...sc.store.stats(), rootSize: sc.store.sizeOf(sc.store.rootId) }
    const report = evaluateRules({
      source: sc.store,
      env: envFor(ROOT),
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN,
      nowMs: 1_700_000_000_000
    })
    expect(report.safetyBlocked).toBe(false)
    // 表上 23 条 ⇒ 22 条 finding：空 appFacts 表下 `orphan-app-data` 整条弃权不出 finding，
    // 第 23 条 gpu-driver-leftovers 的地盘不在夹具里，照旧出 0 字节 finding（与 Rust engine_real 同口径）。
    expect(report.findings.length).toBe(BUILTIN_RULES.length - 1)
    expect({ ...sc.store.stats(), rootSize: sc.store.sizeOf(sc.store.rootId) }).toEqual(before)
    // 快照对象也不能被评估改写（它已经被发过一遍了）
    expect(snap.files).toBe(before.files)
    expect(snap.totalBytes).toBe(before.totalBytes)
  }, 600_000)

  it('夹具里存在的地盘确实被认出来，不存在的路径记 not-scanned 而不是 0 命中沉默', () => {
    const report = evaluateRules({
      source: sc.store,
      env: envFor(ROOT),
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN,
      nowMs: 1_700_000_000_000
    })
    const temp = report.findings.find((f) => f.ruleId === 'windows-temp')!
    expect(temp.matchedRoots).toEqual([`${ROOT}\\__Temp__`])
    expect(temp.fileCount).toBeGreaterThan(0)
    expect(temp.totalBytes).toBeGreaterThan(0)
    // 浏览器缓存那种夹具里没有的路径：一条不认，但要留下点名记录
    const chrome = report.findings.find((f) => f.ruleId === 'browser-cache')!
    expect(chrome.fileCount).toBe(0)
    expect(report.exclusions.some((e) => e.ruleId === 'browser-cache' && e.reason === 'not-scanned')).toBe(true)
    // 🔴：回收站在夹具里根本没有 → 0 进账，但记录在案；且没有任何**采样路径**钻进被跳过的那棵树
    //（samplePaths 有条数上限，这条断言的口径就是"采到样里不许出现"，不是全量证明）
    expect(report.findings.find((f) => f.ruleId === 'recycle-bin')!.totalBytes).toBe(0)
    for (const f of report.findings)
      for (const p of f.samplePaths) expect(p.path).not.toContain('System Volume Information')
  }, 600_000)

  it('报告是纯函数：连跑两次逐字节相同（不依赖 Map / 对象迭代顺序）', () => {
    const run = (): string =>
      JSON.stringify(
        evaluateRules({
          source: sc.store,
          env: envFor(ROOT),
          rules: BUILTIN_RULES,
          forbiddenPatterns: FORBIDDEN,
          nowMs: 1_700_000_000_000
        })
      )
    expect(run()).toBe(run())
  }, 600_000)

  it('规则总进账不可能超过整棵树（只读叠加层的下界自检）', () => {
    const report = evaluateRules({
      source: sc.store,
      env: envFor(ROOT),
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN,
      nowMs: 1_700_000_000_000
    })
    const sum = report.findings.reduce((a, f) => a + f.totalBytes, 0)
    expect(sum).toBeLessThanOrEqual(snap.totalBytes)
    // 采样层互不重复（全量去重由引擎的 claimed 表负责，单元用例已锁）
    const claimed = report.findings.flatMap((f) => f.samplePaths.map((p) => p.path.toLowerCase()))
    expect(new Set(claimed).size).toBe(claimed.length)
  }, 600_000)
})
