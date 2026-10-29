/**
 * §18 清理任务执行器 —— **拒绝测试就是这个产品**。
 *
 * 本文件每一条都在问同一个问题：越界的删除请求有没有被**原样留在磁盘上**。
 * 凡是涉及"有没有真的没删"的断言，都对着真实文件系统（`mkdtemp(tmpdir())` + `node:fs`）
 * 断言那个文件**还在**，而不是只看返回结构。
 *
 * 唯一被授权的真实删除靶场 = OS 临时目录。盘符根 / 禁止路径一类"绝不能试"的用例用**记账型假 fs**：
 * 它把每一次 unlink/rmdir 点名录下来，所以"零删除"是可证的，不是相信的。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeCleanFs, runCleanTask, type CleanFs, type CleanFsStat, type CleanLog, type MeasureResult, type RunCleanOptions } from '../../core/clean/executor'
import { normalizeKey } from '../../core/fs/pathutil'

/* ------------------------------------------------------------------ *
 * 假 fs：记账 + 可注入 errno
 * ------------------------------------------------------------------ */

interface FakeSpec {
  files?: Record<string, number>
  dirs?: string[]
  /** 最后一段是重解析点（junction / symlink）的路径 */
  reparse?: string[]
  /** 命中即在删除动作上抛该 errno */
  failOn?: Record<string, string>
  /** 配合 failOn：只抛前 N 次，第 N+1 次放行（验「失败重试」） */
  failTimes?: Record<string, number>
  /** 配合 failTimes：被强制失败的那一次顺手把文件抹掉，于是重试时看到的是 ENOENT（§9） */
  failThenMissing?: string[]
}

class FakeFs implements CleanFs {
  readonly calls: string[] = []
  readonly files = new Map<string, number>()
  readonly dirs = new Set<string>()
  private readonly reparse = new Set<string>()
  private readonly failOn: Record<string, string>
  private readonly failTimes: Record<string, number>
  private readonly failThenMissing = new Set<string>()

  constructor(spec: FakeSpec) {
    for (const [p, s] of Object.entries(spec.files ?? {})) this.files.set(normalizeKey(p), s)
    for (const d of spec.dirs ?? []) this.dirs.add(normalizeKey(d))
    for (const r of spec.reparse ?? []) this.reparse.add(normalizeKey(r))
    this.failOn = Object.fromEntries(Object.entries(spec.failOn ?? {}).map(([k, v]) => [normalizeKey(k), v]))
    this.failTimes = Object.fromEntries(Object.entries(spec.failTimes ?? {}).map(([k, v]) => [normalizeKey(k), v]))
    for (const p of spec.failThenMissing ?? []) this.failThenMissing.add(normalizeKey(p))
  }

  private throwCode(code: string, op: string, p: string): never {
    const e = new Error(`${code}: ${op} ${p}`) as NodeJS.ErrnoException
    e.code = code
    throw e
  }

  private hit(p: string, op: string): void {
    this.calls.push(`${op} ${p}`)
    const k = normalizeKey(p)
    const code = this.failOn[k]
    if (code === undefined) return
    const left = this.failTimes[k]
    if (left !== undefined) {
      if (left <= 0) return // 配额用尽 → 这一次放行，重试该成功
      this.failTimes[k] = left - 1
      if (this.failThenMissing.has(k)) this.files.delete(k)
    }
    this.throwCode(code, op, p)
  }

  async lstat(p: string): Promise<CleanFsStat> {
    const k = normalizeKey(p)
    if (this.reparse.has(k)) return { isDirectory: false, isFile: false, isSymbolicLink: true, size: 0 }
    if (this.files.has(k)) return { isDirectory: false, isFile: true, isSymbolicLink: false, size: this.files.get(k)! }
    if (this.dirs.has(k)) return { isDirectory: true, isFile: false, isSymbolicLink: false, size: 0 }
    this.throwCode('ENOENT', 'lstat', p)
  }

  async unlink(p: string): Promise<void> {
    this.hit(p, 'unlink')
    const k = normalizeKey(p)
    if (!this.files.has(k)) this.throwCode('ENOENT', 'unlink', p)
    this.files.delete(k)
  }

  /** 非递归：里面有东西就 ENOTEMPTY（与真实 Windows 的 rmdir 同口径）。 */
  async rmdir(p: string): Promise<void> {
    this.hit(p, 'rmdir')
    const k = normalizeKey(p)
    if (!this.dirs.has(k)) this.throwCode('ENOENT', 'rmdir', p)
    const kids = [...this.files.keys(), ...this.dirs.keys()].filter((x) => x.startsWith(`${k}\\`))
    if (kids.length > 0) this.throwCode('ENOTEMPTY', 'rmdir', p)
    this.dirs.delete(k)
  }

  /** 删除尝试的次数与名录 —— "零删除"就断言这个。 */
  get deleteCalls(): string[] {
    return this.calls.filter((c) => c.startsWith('unlink') || c.startsWith('rmdir'))
  }
}

interface LogLine {
  msg: string
  fields: Record<string, string | number | boolean | undefined>
}

function collectLog(): { log: CleanLog; lines: LogLine[] } {
  const lines: LogLine[] = []
  return {
    lines,
    log: {
      clean(msg: string, fields?: Record<string, string | number | boolean | undefined>): void {
        lines.push({ msg, fields: { ...fields } })
      }
    }
  }
}

/** 合成机器（单测里绝不读真机 process.env —— 与规则引擎约束 7 同一口径）。 */
const ENV = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Users\\Kano\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Users\\Kano\\AppData\\Local',
  APPDATA: 'C:\\Users\\Kano\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\Kano',
  // CLEANUP-RULES §6 之后禁止根模板引用了 `%PROGRAMFILES%\`。缺这一键 ⇒ `resolveForbidden`
  // 记一条 unresolved ⇒ `forbidden-roots-unresolved` ⇒ 本文件 37 条执行器判据全红，
  // 而那是"夹具缺键"不是"闸坏了"（Rust 侧 `cleaner/src/gate.rs::tests::env` 同样补过这一键）。
  PROGRAMFILES: 'C:\\Program Files'
}

let TMP = ''
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'dc-clean-'))
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

/** 在真实临时目录里造一棵小树（唯一被授权的真实写入）。 */
function makeTree(dir: string, spec: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rel, size] of Object.entries(spec)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, Buffer.alloc(size, 0x61))
    out[rel.replace(/\\/g, '/')] = p
  }
  return out
}

const opts = (over: Partial<RunCleanOptions> = {}): RunCleanOptions => ({ env: ENV, nowMs: 1, ...over })

describe('只上报不可删根（回收站那一类）：执行层最后一道闸', () => {
  /** 合成"盘根"：把 SYSTEMDRIVE 指到临时目录里，`%SYSTEMDRIVE%\$Recycle.Bin` 就能落在真实可写的沙盒内。 */
  const driveRoot = (): string => join(TMP, 'report-only-drive')

  it('authorizedRoot 就是回收站的一个 SID 子目录 → 整批拒绝（root-report-only），文件事后一字未动', async () => {
    const base = driveRoot()
    const bin = join(base, '$Recycle.Bin', 'S-1-5-21-7')
    const t = makeTree(base, { '$Recycle.Bin\\S-1-5-21-7\\$Rphoto.jpg': 4096, 'keep.bin': 10 })
    const task = await runCleanTask(
      { authorizedRoot: bin, paths: [t['$Recycle.Bin/S-1-5-21-7/$Rphoto.jpg']!] },
      opts({ env: { ...ENV, SYSTEMDRIVE: `${base}\\` }, fs: nodeCleanFs })
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-report-only')
    expect(task.blockers[0]!.detail).toContain('$Recycle.Bin')
    expect(task.successCount).toBe(0)
    expect(existsSync(t['$Recycle.Bin/S-1-5-21-7/$Rphoto.jpg']!)).toBe(true)
    expect(statSync(t['$Recycle.Bin/S-1-5-21-7/$Rphoto.jpg']!).size).toBe(4096)
  })

  it('authorizedRoot 套住了回收站（宽容器）→ 同样整批拒绝，回收站里的字节一个都不许减', async () => {
    const base = join(driveRoot(), 'sweep')
    const t = makeTree(base, { '$Recycle.Bin\\S-1-5\\$Rbig.bin': 8192, 'a.bin': 5 })
    // 故意把禁止根名单收成只有 System32：否则合成盘根下的 `System Volume Information` 会先被 swept 抓到，
    // 那条断言就会"因为别的原因"通过，测不到只上报根这一道（变异验证时确实这样蒙混过关过一次）。
    const task = await runCleanTask(
      { authorizedRoot: base, paths: [t['a.bin']!, t['$Recycle.Bin/S-1-5/$Rbig.bin']!] },
      opts({
        env: { ...ENV, SYSTEMDRIVE: `${base}\\` },
        forbiddenPatterns: ['%WINDIR%\\System32'],
        fs: nodeCleanFs
      })
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-ancestor-of-forbidden')
    expect(task.blockers[0]!.detail, '必须点名到回收站那根，不许是别的保护顶包').toContain('$Recycle.Bin')
    expect(task.successCount).toBe(0)
    expect(existsSync(t['a.bin']!), '拒绝就是拒绝，不许"只删看起来安全的那部分"').toBe(true)
    expect(existsSync(t['$Recycle.Bin/S-1-5/$Rbig.bin']!)).toBe(true)
  })

  it('只上报根在授权根**之外**（同盘兄弟目录）→ 那条点名成 report-only-root，不用一句"范围外"盖过去；根内的照删', async () => {
    const base = join(TMP, 'report-only-item')
    const root = join(base, 'keep')
    const t = makeTree(base, { 'keep\\ok.tmp': 64, 'Protected\\do-not-touch.tmp': 4096 })
    const task = await runCleanTask(
      { authorizedRoot: root, paths: [t['Protected/do-not-touch.tmp']!, t['keep/ok.tmp']!] },
      opts({
        env: { ...ENV, TEMP: base },
        reportOnlyPatterns: ['%TEMP%\\Protected'],
        fs: nodeCleanFs
      })
    )
    expect(task.refusals.map((r) => r.reason)).toEqual(['report-only-root'])
    expect(task.refusals[0]!.detail).toContain('Protected')
    expect(task.successCount).toBe(1)
    expect(existsSync(t['Protected/do-not-touch.tmp']!)).toBe(true)
    expect(statSync(t['Protected/do-not-touch.tmp']!).size).toBe(4096)
    expect(existsSync(t['keep/ok.tmp']!)).toBe(false)
  })

  it('只上报根模板解析不出来（env 缺 SYSTEMDRIVE）→ 与禁止根同款的 fail-safe，整批不动', async () => {
    const base = join(TMP, 'report-only-unresolved')
    const t = makeTree(base, { 'a.bin': 10 })
    const { SYSTEMDRIVE: _dropped, ...noDrive } = ENV
    const task = await runCleanTask(
      { authorizedRoot: base, paths: [t['a.bin']!] },
      opts({ env: noDrive, fs: nodeCleanFs })
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-forbidden-unresolved')
    expect(task.successCount).toBe(0)
    expect(existsSync(t['a.bin']!)).toBe(true)
  })
})

describe('越界拒绝（真实 fs：断言那个文件还在）', () => {
  it('authorizedRoot 之外的路径被拒，且 sibling 目录里那个真实文件事后依然存在', async () => {
    const root = join(TMP, 'scope-1', 'root')
    mkdirSync(root, { recursive: true })
    const t = makeTree(join(TMP, 'scope-1'), { 'root\\inside-a.bin': 1000, 'outside\\victim.bin': 4096 })
    const victim = t['outside/victim.bin']!
    const inside = t['root/inside-a.bin']!

    const task = await runCleanTask({ authorizedRoot: root, paths: [victim, inside] }, opts({ fs: nodeCleanFs }))
    expect(task.refusals.map((r) => r.reason)).toContain('out-of-scope')
    expect(existsSync(victim)).toBe(true)
    expect(statSync(victim).size).toBe(4096)
    expect(task.successCount).toBe(1)
    expect(task.failedCount).toBe(0)
    expect(existsSync(inside)).toBe(false)
  })

  it('越界路径套住整个 authorizedRoot ⇒ 整批重叠项一起被拒，一个文件都不许删', async () => {
    const parent = join(TMP, 'scope-2')
    const root = join(parent, 'root')
    mkdirSync(root, { recursive: true })
    const t = makeTree(parent, { 'root\\a.bin': 10, 'root\\b.bin': 20, 'c.bin': 30 })
    const task = await runCleanTask(
      { authorizedRoot: root, paths: [t['c.bin']!, parent, t['root/a.bin']!, t['root/b.bin']!] },
      opts({ fs: nodeCleanFs })
    )
    expect(task.successCount).toBe(0)
    expect(task.cleanedSize).toBe(0)
    for (const p of [t['root/a.bin']!, t['root/b.bin']!, t['c.bin']!]) expect(existsSync(p)).toBe(true)
    const reasons = task.refusals.map((r) => r.reason)
    expect(reasons).toContain('out-of-scope')
    expect(reasons).toContain('overlaps-out-of-scope')
  })

  it('请求里出现 authorizedRoot 自己 ⇒ 拒绝（而不是"把根删掉"），根目录依然存在', async () => {
    const root = join(TMP, 'scope-3', 'root')
    mkdirSync(root, { recursive: true })
    const t = makeTree(root, { 'a.bin': 10 })
    const task = await runCleanTask({ authorizedRoot: root, paths: [root, t['a.bin']!] }, opts({ fs: nodeCleanFs }))
    expect(task.refusals.map((r) => r.reason)).toContain('equals-authorized-root')
    expect(existsSync(root)).toBe(true)
    expect(task.successCount).toBe(0)
    expect(existsSync(t['a.bin']!)).toBe(true)
  })

  it('含 `..` 的穿越路径：拒绝，不做二次 normalize 后放行', async () => {
    const root = join(TMP, 'scope-4', 'root')
    mkdirSync(join(root, 'sub'), { recursive: true })
    const t = makeTree(join(TMP, 'scope-4'), { 'root\\sub\\a.bin': 10, 'outside.bin': 20 })
    // 手写字符串：join() 会把 `..` 当场 normalize 掉，就测不到"路径里带着 .."这件事了
    const traversal = `${root}\\sub\\..\\..\\outside.bin`
    expect(traversal).toContain('..')
    const task = await runCleanTask(
      { authorizedRoot: root, paths: [traversal, t['root/sub/a.bin']!] },
      opts({ fs: nodeCleanFs })
    )
    expect(task.refusals.map((r) => r.reason)).toContain('parent-traversal')
    expect(existsSync(t['outside.bin']!)).toBe(true)
  })
})

describe('authorizedRoot 自身的三道检查（记账假 fs：零删除可证）', () => {
  it('盘符根 C:\\ ⇒ 整体拒绝，unlink/rmdir 一次都没被调用', async () => {
    const fs = new FakeFs({ dirs: ['C:\\'], files: { 'C:\\a.tmp': 10 } })
    const task = await runCleanTask({ authorizedRoot: 'C:\\', paths: ['C:\\a.tmp'] }, opts({ fs }))
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-is-drive-root')
    expect(fs.deleteCalls).toEqual([])
    expect(task.successCount).toBe(0)
    expect(fs.files.has(normalizeKey('C:\\a.tmp'))).toBe(true)
  })

  it('裸盘符写法 C: 同样按盘符根拒绝', async () => {
    const fs = new FakeFs({ files: { 'C:\\a\\b.bin': 5 } })
    const task = await runCleanTask({ authorizedRoot: 'C:', paths: ['C:\\a\\b.bin'] }, opts({ fs }))
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-is-drive-root')
    expect(fs.deleteCalls).toEqual([])
  })

  it('authorizedRoot 不存在 / 不是目录 ⇒ 拒绝，零删除', async () => {
    const fs = new FakeFs({ files: { 'D:\\f.bin': 1 } })
    const missing = await runCleanTask({ authorizedRoot: 'D:\\nope', paths: ['D:\\nope\\a.bin'] }, opts({ fs }))
    expect(missing.status).toBe('refused')
    expect(missing.blockers.map((b) => b.reason)).toContain('root-missing')
    const notDir = await runCleanTask({ authorizedRoot: 'D:\\f.bin', paths: ['D:\\f.bin'] }, opts({ fs }))
    expect(notDir.blockers.map((b) => b.reason)).toContain('root-not-a-directory')
    expect(fs.deleteCalls).toEqual([])
  })

  it('authorizedRoot 命中 Task 16 的 FORBIDDEN_PATH_PATTERNS（C:\\Windows\\System32）⇒ 拒绝', async () => {
    const fs = new FakeFs({ dirs: ['C:\\Windows\\System32'], files: { 'C:\\Windows\\System32\\cmd.exe': 100 } })
    const task = await runCleanTask(
      { authorizedRoot: 'C:\\Windows\\System32', paths: ['C:\\Windows\\System32\\cmd.exe'] },
      opts({ fs })
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-forbidden')
    expect(fs.deleteCalls).toEqual([])
    // 拒绝必须点名是哪个禁止根 —— 复用引擎那一个定义，不另立第三套「禁止」
    expect(task.blockers.some((b) => /System32/.test(b.detail))).toBe(true)
  })

  it('authorizedRoot 是禁止根的**祖先**（C:\\Windows）⇒ 也拒绝：宽容器会顺手扫走 System32', async () => {
    const fs = new FakeFs({ dirs: ['C:\\Windows'], files: { 'C:\\Windows\\a.txt': 1 } })
    const task = await runCleanTask({ authorizedRoot: 'C:\\Windows', paths: ['C:\\Windows\\a.txt'] }, opts({ fs }))
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-ancestor-of-forbidden')
    expect(fs.deleteCalls).toEqual([])
  })

  it('authorizedRoot 自己是 reparse point ⇒ 拒绝（不跟随别人的链接根）', async () => {
    const fs = new FakeFs({ reparse: ['D:\\t'], files: { 'D:\\elsewhere\\a.bin': 1 } })
    const task = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\elsewhere\\a.bin'] }, opts({ fs }))
    expect(task.blockers.map((b) => b.reason)).toContain('root-is-reparse-point')
    expect(fs.deleteCalls).toEqual([])
  })

  it('禁止根模板解析不出来（env 缺 WINDIR）⇒ fail-safe：整批拒绝，零删除', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 1, 'D:\\t\\b.bin': 2 } })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\b.bin'] },
      { env: { SYSTEMDRIVE: 'D:\\' }, fs, nowMs: 1 }
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-forbidden-unresolved')
    expect(fs.deleteCalls).toEqual([])
    expect(task.refusals.every((r) => r.reason === 'forbidden-roots-unresolved')).toBe(true)
  })

  it('in-scope 但落在禁止根里的路径 ⇒ 逐条拒绝（authorizedRoot 合法也拦得住）', async () => {
    const fs = new FakeFs({
      dirs: ['D:\\t', 'C:\\Windows\\System32'],
      files: { 'D:\\t\\ok.bin': 10, 'C:\\Windows\\System32\\cmd.exe': 999 }
    })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\ok.bin', 'C:\\Windows\\System32\\cmd.exe'] },
      opts({ fs })
    )
    expect(task.refusals.map((r) => r.reason)).toContain('forbidden-root')
    expect(fs.files.has(normalizeKey('C:\\Windows\\System32\\cmd.exe'))).toBe(true)
    expect(fs.deleteCalls).toEqual(['unlink D:\\t\\ok.bin'])
  })

  it('调用方追加的 denyRoots（本项目的夹具根目录）构成第二道围栏', async () => {
    const fs = new FakeFs({ dirs: ['D:\\deepclean-fixture\\f100k'], files: { 'D:\\deepclean-fixture\\f100k\\a.bin': 1 } })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\deepclean-fixture\\f100k', paths: ['D:\\deepclean-fixture\\f100k\\a.bin'] },
      opts({ fs, denyRoots: ['D:\\deepclean-fixture'] })
    )
    expect(task.status).toBe('refused')
    expect(task.blockers.map((b) => b.reason)).toContain('root-denied-by-caller')
    expect(fs.deleteCalls).toEqual([])
  })
})

describe('重解析点（symlink / junction）逃逸', () => {
  let RT = ''
  beforeAll(() => {
    RT = mkdtempSync(join(tmpdir(), 'dc-clean-junc-'))
  })
  afterAll(() => {
    rmSync(RT, { recursive: true, force: true })
  })

  it('路径列表里最后一段是 junction ⇒ 拒绝且不跟随：它指向的真实文件安然无恙', async () => {
    const root = join(RT, 'root')
    const target = join(RT, 'elsewhere')
    mkdirSync(root, { recursive: true })
    mkdirSync(target, { recursive: true })
    const victim = join(target, 'precious.bin')
    writeFileSync(victim, Buffer.alloc(2048, 0x62))
    const link = join(root, 'link')
    symlinkSync(target, link, 'junction')

    const task = await runCleanTask({ authorizedRoot: root, paths: [link] }, opts({ fs: nodeCleanFs }))
    expect(task.refusals.map((r) => r.reason)).toContain('reparse-point')
    expect(task.successCount).toBe(0)
    expect(existsSync(victim)).toBe(true)
    expect(statSync(victim).size).toBe(2048)
  })

  it('逃逸发生在**中间段**（root\\junc\\file.bin，文本上仍在 root 内）⇒ 同样拒绝', async () => {
    const root = join(RT, 'root2')
    const target = join(RT, 'elsewhere2')
    mkdirSync(root, { recursive: true })
    mkdirSync(target, { recursive: true })
    const victim = join(target, 'precious.bin')
    writeFileSync(victim, Buffer.alloc(1024, 0x63))
    symlinkSync(target, join(root, 'junc'), 'junction')

    const task = await runCleanTask(
      { authorizedRoot: root, paths: [join(root, 'junc', 'precious.bin')] },
      opts({ fs: nodeCleanFs })
    )
    expect(task.refusals.map((r) => r.reason)).toContain('reparse-ancestor')
    expect(existsSync(victim)).toBe(true)
    expect(task.successCount).toBe(0)
  })

  it('假 fs 版：reparse 那一条不产生任何删除调用', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 1 }, reparse: ['D:\\t\\junc'] })
    const task = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\junc', 'D:\\t\\a.bin'] }, opts({ fs }))
    expect(task.refusals.map((r) => r.reason)).toEqual(['reparse-point'])
    expect(fs.deleteCalls).toEqual(['unlink D:\\t\\a.bin'])
  })
})

describe('§28 原则五 —— 单个删除失败不许打断整批', () => {
  it('第 3 个文件 EPERM：批次跑完，failedCount=1，其余全删，errno 留痕', async () => {
    const locked = 'D:\\t\\cache\\c3.bin'
    const fs = new FakeFs({
      dirs: ['D:\\t', 'D:\\t\\cache'],
      files: {
        'D:\\t\\cache\\c1.bin': 10,
        'D:\\t\\cache\\c2.bin': 20,
        [locked]: 30,
        'D:\\t\\cache\\c4.bin': 40
      },
      failOn: { [locked]: 'EPERM' }
    })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\cache\\c1.bin', 'D:\\t\\cache\\c2.bin', locked, 'D:\\t\\cache\\c4.bin'] },
      opts({ fs })
    )
    expect(task.failedCount).toBe(1)
    expect(task.successCount).toBe(3)
    expect(task.status).toBe('completed')
    expect(task.deleted.find((d) => !d.ok)?.errno).toBe('EPERM')
    expect(fs.files.has(normalizeKey('D:\\t\\cache\\c1.bin'))).toBe(false)
    expect(fs.files.has(normalizeKey(locked))).toBe(true)
    expect(task.cleanedSize).toBe(70)
    expect(task.totalSize).toBe(100)
  })

  it('真实 fs：非空目录的 rmdir 以 ENOTEMPTY 失败，同批文件照删', async () => {
    const root = join(TMP, 'eperm-real')
    makeTree(root, { 'keep\\inner.bin': 5, 'keep\\gone.bin': 5 })
    const task = await runCleanTask(
      { authorizedRoot: root, paths: [join(root, 'keep'), join(root, 'keep', 'gone.bin')] },
      opts({ fs: nodeCleanFs })
    )
    expect(task.failedCount).toBe(1)
    expect(task.deleted.find((d) => !d.ok)?.errno).toBe('ENOTEMPTY')
    expect(existsSync(join(root, 'keep', 'inner.bin'))).toBe(true)
    expect(existsSync(join(root, 'keep', 'gone.bin'))).toBe(false)
    expect(existsSync(join(root, 'keep'))).toBe(true)
  })

  it('lstat 就 ENOENT ⇒ 记 refusal=not-found（跳过文件），不冒充删除失败', async () => {
    const root = join(TMP, 'notfound')
    mkdirSync(root, { recursive: true })
    const task = await runCleanTask({ authorizedRoot: root, paths: [join(root, 'ghost.bin')] }, opts({ fs: nodeCleanFs }))
    expect(task.failedCount).toBe(0)
    expect(task.refusals.map((r) => r.reason)).toContain('not-found')
  })
})

describe('§28 原则六 —— 批中途取消', () => {
  it('取消在第 2 个之后：已删的不复活，剩下的一个没被动过，status=cancelled', async () => {
    const fs = new FakeFs({
      dirs: ['D:\\t'],
      files: { 'D:\\t\\a.bin': 1, 'D:\\t\\b.bin': 2, 'D:\\t\\c.bin': 3, 'D:\\t\\d.bin': 4 }
    })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\b.bin', 'D:\\t\\c.bin', 'D:\\t\\d.bin'] },
      opts({ fs, shouldCancel: () => fs.deleteCalls.length >= 2 })
    )
    expect(task.status).toBe('cancelled')
    expect(task.successCount).toBe(2)
    expect(fs.deleteCalls.length).toBe(2)
    expect(fs.files.has(normalizeKey('D:\\t\\c.bin'))).toBe(true)
    expect(fs.files.has(normalizeKey('D:\\t\\d.bin'))).toBe(true)
    expect(task.progress).toBeGreaterThan(0)
    expect(task.progress).toBeLessThanOrEqual(1)
  })

  it('真实 fs 版：取消后剩余文件字节原样在盘上', async () => {
    const root = join(TMP, 'cancel-real')
    const t = makeTree(root, { 'a.bin': 100, 'b.bin': 200, 'c.bin': 300 })
    const a = t['a.bin']!
    const task = await runCleanTask(
      { authorizedRoot: root, paths: [a, t['b.bin']!, t['c.bin']!] },
      opts({ fs: nodeCleanFs, shouldCancel: () => !existsSync(a) })
    )
    expect(task.status).toBe('cancelled')
    expect(task.successCount).toBe(1)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(t['b.bin']!)).toBe(true)
    expect(statSync(t['b.bin']!).size).toBe(200)
    expect(existsSync(t['c.bin']!)).toBe(true)
    expect(statSync(t['c.bin']!).size).toBe(300)
  })
})

describe('§18 任务字段 / §29 日志 / 只删列出的东西', () => {
  it('任务带 §18 的六个字段；digest 覆盖 root + 路径集合（大小写/斜杠归一后同集合同指纹）', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 7 } })
    const a = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin'] }, opts({ fs }))
    expect(a).toMatchObject({ status: 'completed', progress: 1, totalSize: 7, cleanedSize: 7, successCount: 1, failedCount: 0 })
    const fs2 = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\b.bin': 7 } })
    const b = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\b.bin'] }, opts({ fs: fs2 }))
    expect(a.digest).not.toBe(b.digest)
    const fs3 = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 7 } })
    const c = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\A.BIN'] }, opts({ fs: fs3 }))
    expect(c.digest).toBe(a.digest)
    const fs4 = new FakeFs({ dirs: ['E:\\t'], files: { 'E:\\t\\a.bin': 7 } })
    const d = await runCleanTask({ authorizedRoot: 'E:\\t', paths: ['E:\\t\\a.bin'] }, opts({ fs: fs4 }))
    expect(d.digest).not.toBe(a.digest)
  })

  it('每个删除（成功与失败）写一条 [CLEAN]，越界也留痕，收尾写清理开始/结束', async () => {
    const fs = new FakeFs({
      dirs: ['D:\\t'],
      files: { 'D:\\t\\a.bin': 1, 'D:\\t\\bad.bin': 2 },
      failOn: { 'D:\\t\\bad.bin': 'EBUSY' }
    })
    const { log, lines } = collectLog()
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\bad.bin', 'E:\\outside\\x.bin'] },
      opts({ fs, logger: log })
    )
    const deletes = lines.filter((l) => normalizeKey(l.msg).startsWith('d:\\t\\'))
    expect(deletes.length).toBe(2)
    expect(deletes.some((l) => l.fields.status === 'success' && l.fields.size === 1)).toBe(true)
    expect(deletes.some((l) => l.fields.status === 'failed' && l.fields.errno === 'EBUSY')).toBe(true)
    expect(lines.some((l) => l.fields.status === 'refused' && /outside/.test(l.msg))).toBe(true)
    expect(lines.some((l) => l.msg === 'clean start' && l.fields.root === 'D:\\t')).toBe(true)
    expect(lines.some((l) => l.msg === 'clean end' && l.fields.cleanedSize === 1)).toBe(true)
    expect(task.successCount).toBe(1)
  })

  it('空路径列表 / 只请求目录：不许递归删任何东西', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t', 'D:\\t\\sub'], files: { 'D:\\t\\sub\\a.bin': 1 } })
    const empty = await runCleanTask({ authorizedRoot: 'D:\\t', paths: [] }, opts({ fs }))
    expect(empty.status).toBe('completed')
    expect(fs.deleteCalls).toEqual([])
    const dirOnly = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\sub'] }, opts({ fs }))
    expect(dirOnly.failedCount).toBe(1)
    expect(dirOnly.deleted[0]?.errno).toBe('ENOTEMPTY')
    expect(fs.files.has(normalizeKey('D:\\t\\sub\\a.bin'))).toBe(true)
  })

  it('请求的空目录被非递归 rmdir 删掉；目录不计入 totalSize/cleanedSize', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t', 'D:\\t\\empty'], files: { 'D:\\t\\x.bin': 8 } })
    const task = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\x.bin', 'D:\\t\\empty'] }, opts({ fs }))
    expect(task.totalSize).toBe(8)
    expect(task.cleanedSize).toBe(8)
    expect(fs.dirs.has(normalizeKey('D:\\t\\empty'))).toBe(false)
    expect(task.dirsRemoved).toEqual(['D:\\t\\empty'])
  })

  it('去重：同一路径重复出现在请求里只删一次', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 3 } })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\a.BIN', 'D:/t/a.bin'] },
      opts({ fs })
    )
    expect(task.successCount).toBe(1)
    expect(fs.deleteCalls).toEqual(['unlink D:\\t\\a.bin'])
  })
})

describe('§19 清理后验证 —— 预估值与实际值都要报', () => {
  it('measure 给 before/after；actualFreed 与 predicted 不一致时两个数字都留下', async () => {
    const fs = new FakeFs({
      dirs: ['D:\\t'],
      files: { 'D:\\t\\a.bin': 100, 'D:\\t\\b.bin': 50, 'D:\\t\\c.bin': 50 }
    })
    // 两次读数：清理前 4000 / 清理后 3880 —— 差 120，而预测是 200（簇大小、流、并发写都会造成差）
    const readings = [
      { bytes: 4000, files: 10 },
      { bytes: 3880, files: 7 }
    ]
    let i = 0
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\b.bin', 'D:\\t\\c.bin'] },
      opts({
        fs,
        measure: async (): Promise<MeasureResult> => readings[Math.min(i++, readings.length - 1)] ?? readings[1]!
      })
    )
    expect(task.verification).not.toBeNull()
    expect(task.verification!.rootBytesBefore).toBe(4000)
    expect(task.verification!.rootBytesAfter).toBe(3880)
    expect(task.verification!.actualFreedBytes).toBe(120)
    expect(task.verification!.predictedFreedBytes).toBe(200)
    expect(task.verification!.deletedBytes).toBe(200)
    expect(task.verification!.deltaBytes).toBe(-80)
    expect(task.verification!.note.length).toBeGreaterThan(10)
  })

  it('note 相等那支只许说自己比的是两笔表观账：点名硬链接这种"假性一致"', async () => {
    // 靶场量过的事实：`predictedFreedBytes` = 执行器对每条被接受路径 lstat 之和，
    // `actualFreedBytes` = measureRoot 重扫两次的表观差 —— 两边都是**逐路径表观大小之和，谁都不看 inode**。
    // 所以有硬链接参与时两个错口径互相印证，deltaBytes 正好为 0，而旧文案在旁边念
    // 「实际释放 X 与预估 Y 一致」—— 那是把"两笔表观账相等"宣布成"磁盘真省了这些字节"。
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 100, 'D:\\t\\b.bin': 100 } })
    const readings = [
      { bytes: 4000, files: 4 },
      { bytes: 3800, files: 2 }
    ]
    let i = 0
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\b.bin'] },
      opts({ fs, measure: async (): Promise<MeasureResult> => readings[Math.min(i++, readings.length - 1)] ?? readings[1]! })
    )
    expect(task.verification!.deltaBytes).toBe(0)
    const note = task.verification!.note
    expect(note).toContain('表观')
    expect(note, '旧口径：把表观相等念成磁盘核实过').not.toMatch(/实际释放 .*一致/)
    expect(note, '这个口径唯一的盲点必须被点名，否则读者以为它验的是占用').toContain('硬链接')
    expect(note, '光说"我不准"是把人晾着：要指到卡片上真有的那个磁盘读数').toContain('可用空间')
    expect(note).not.toContain('**')
  })

  it('note 不相等那支也说清两个数各自的口径，差额不许冒充磁盘占用变化', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 100, 'D:\\t\\b.bin': 50, 'D:\\t\\c.bin': 50 } })
    const readings = [
      { bytes: 4000, files: 10 },
      { bytes: 3880, files: 7 }
    ]
    let i = 0
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', 'D:\\t\\b.bin', 'D:\\t\\c.bin'] },
      opts({ fs, measure: async (): Promise<MeasureResult> => readings[Math.min(i++, readings.length - 1)] ?? readings[1]! })
    )
    expect(task.verification!.deltaBytes).toBe(-80)
    const note = task.verification!.note
    expect(note).toContain('表观')
    expect(note, '差额的成因里漏不掉同一个盲点').toContain('硬链接')
    expect(note).toContain('可用空间')
    expect(note).not.toContain('**')
  })

  it('文件头那份"会造成差的原因"清单必须同时列出"会造成假性一致"的那一种', async () => {
    // 为什么值得钉一条**散文**：`executor.ts` 的说明原本写了"簇大小、备用数据流、并发写都会造成差"，
    // 唯独漏掉硬链接 —— 而硬链接恰好是那两个数**一起错、还一起相等**的那种。漏在这一处不是少一句话：
    // 读了这段清单的人会得出"deltaBytes=0 就说明没有清单上的问题"，于是那个 0 比单独一个错数更可信。
    // 口径与判定都没动，动的只有说明，所以这条闸门的对象就是说明本身。
    const header = readFileSync('core/clean/executor.ts', 'utf8').split('*/')[0] ?? ''
    expect(header.length, '文件头那段注释没读到 = 这条断言在跟空气比').toBeGreaterThan(200)
    expect(header, '三种"会造成差"的原因原本都在，一条都不许掉').toMatch(/簇大小[\s\S]*备用数据流[\s\S]*并发写/)
    expect(header, '唯独"会造成假性一致"的那种必须点名').toContain('硬链接')
    expect(header).toMatch(/假性相等|假性一致/)
    expect(header, '要点明同口径互相印证不是验证').toMatch(/不构成验证|不是验证/)
    expect(header, '要指到磁盘那一侧的读数').toMatch(/可用空间|measureFree/)
  })

  it('没有注入 measure ⇒ verification 为 null，不许编造"释放了 X"', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 1 } })
    const task = await runCleanTask({ authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin'] }, opts({ fs }))
    expect(task.verification).toBeNull()
  })

  it('整批被拒（盘符根）时 verification 为 null 且零删除', async () => {
    const fs = new FakeFs({ dirs: ['C:\\'], files: { 'C:\\a.bin': 1 } })
    const task = await runCleanTask(
      { authorizedRoot: 'C:\\', paths: ['C:\\a.bin'] },
      opts({ fs, measure: async () => ({ bytes: 5, files: 1 }) })
    )
    expect(task.verification).toBeNull()
    expect(fs.deleteCalls).toEqual([])
  })
})

describe('执行器边界：非法输入一律拒绝，不抛', () => {
  const bad = ['', '   ', 'relative/a.bin', 'D:\\wild\\*', 'D:\\quote"1', '\\\\?\\D:\\t\\a.bin']
  it.each(bad)('authorizedRoot=%j 被拒且零删除', async (root) => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 1 } })
    const task = await runCleanTask({ authorizedRoot: root, paths: ['D:\\t\\a.bin'] }, opts({ fs }))
    expect(task.status).toBe('refused')
    expect(fs.deleteCalls).toEqual([])
  })

  it('paths 里有空串 / 非字符串 ⇒ 记 refusal=malformed-path，其余照做', async () => {
    const fs = new FakeFs({ dirs: ['D:\\t'], files: { 'D:\\t\\a.bin': 1 } })
    const task = await runCleanTask(
      { authorizedRoot: 'D:\\t', paths: ['D:\\t\\a.bin', '', '  '] as unknown as string[] },
      opts({ fs })
    )
    expect(task.refusals.map((r) => r.reason)).toContain('malformed-path')
    expect(task.successCount).toBe(1)
  })

  it('实测钉死：Windows 只读位**不是**护栏（libuv 的 unlink 会先清位再删）', async () => {
    const root = join(TMP, 'readonly')
    mkdirSync(root, { recursive: true })
    const p = join(root, 'ro.bin')
    writeFileSync(p, 'data')
    chmodSync(p, 0o444)
    const task = await runCleanTask({ authorizedRoot: root, paths: [p] }, opts({ fs: nodeCleanFs }))
    expect(task.deleted[0]?.ok).toBe(true)
    expect(existsSync(p)).toBe(false)
  })

  it('deletions 与请求一一对应（点名到路径，§29/约束 2 的"显式清单"）', async () => {
    const root = join(TMP, 'mapping')
    const t = makeTree(root, { 'a.bin': 32 })
    const task = await runCleanTask({ authorizedRoot: root, paths: [t['a.bin']!] }, opts({ fs: nodeCleanFs }))
    expect(task.requestedPaths).toEqual([t['a.bin']!])
    expect(task.acceptedPaths).toEqual([t['a.bin']!])
    expect(task.deleted.map((d) => normalizeKey(d.path))).toEqual([normalizeKey(t['a.bin']!)])
  })
})

/* ------------------------------------------------------------------ *
 * §26 Phase 5「失败重试」。口径是**有界重试、只重试瞬态错误**：
 * EBUSY / EAGAIN / EMFILE / ENFILE / ENOTEMPTY 这类"过一会儿可能就好了"的才重来；
 * EPERM / EACCES 在 Windows 上是稳定失败（Task 18 已实测只读位根本不是护栏），
 * 重试只是把一批清理拖成几分钟却照样失败 —— 所以明确不重试，并由测试钉住。
 * ------------------------------------------------------------------ */
describe('§26 Phase 5 失败重试（有界、只重试瞬态 errno、可被取消打断）', () => {
  const ROOT = 'D:\\t'
  const F = 'D:\\t\\cache\\locked.bin'

  const mk = (spec: FakeSpec) => new FakeFs({ dirs: [ROOT, `${ROOT}\\cache`], ...spec })

  it('EBUSY 一次后放行：记成功，attempts=2，unlink 被调两次', async () => {
    const fs = mk({ files: { [F]: 100 }, failOn: { [F]: 'EBUSY' }, failTimes: { [F]: 1 } })
    const task = await runCleanTask({ authorizedRoot: ROOT, paths: [F] }, opts({ fs, sleep: async () => undefined }))
    expect(task.successCount).toBe(1)
    expect(task.failedCount).toBe(0)
    expect(task.deleted.find((d) => d.path === F)?.attempts).toBe(2)
    expect(task.cleanedSize).toBe(100)
    expect(fs.calls.filter((c) => c.startsWith('unlink'))).toHaveLength(2)
  })

  it('一直 EBUSY：试到 maxAttempts 就停，失败留痕且**不**把批次拖长', async () => {
    const fs = mk({ files: { [F]: 100 }, failOn: { [F]: 'EBUSY' } })
    let slept = 0
    const task = await runCleanTask(
      { authorizedRoot: ROOT, paths: [F] },
      opts({ fs, retry: { maxAttempts: 3, delayMs: 40 }, sleep: async () => { slept++ } })
    )
    expect(task.failedCount).toBe(1)
    expect(task.deleted.find((d) => d.path === F)?.attempts).toBe(3)
    expect(task.deleted.find((d) => !d.ok)?.errno).toBe('EBUSY')
    expect(slept, '3 次尝试之间只该睡 2 次').toBe(2)
    expect(fs.files.has(normalizeKey(F)), '没删掉的东西不许从 fs 里消失').toBe(true)
  })

  it('EPERM / EACCES 不重试：只试一次就记失败（Windows 上权限失败是稳定的）', async () => {
    for (const errno of ['EPERM', 'EACCES']) {
      const fs = mk({ files: { [F]: 100 }, failOn: { [F]: errno } })
      const task = await runCleanTask({ authorizedRoot: ROOT, paths: [F] }, opts({ fs, sleep: async () => undefined }))
      expect(task.deleted.find((d) => !d.ok)?.errno).toBe(errno)
      expect(task.deleted.find((d) => d.path === F)?.attempts, `${errno} 不该重试`).toBe(1)
      expect(fs.calls.filter((c) => c.startsWith('unlink'))).toHaveLength(1)
    }
  })

  it('重试等待期间取消：立刻停手，剩下的一个都不碰，status=cancelled', async () => {
    const fs = mk({ files: { [F]: 100 }, failOn: { [F]: 'EBUSY' } })
    let slept = 0
    const task = await runCleanTask({ authorizedRoot: ROOT, paths: [F] }, {
      ...opts({
        fs,
        retry: { maxAttempts: 5, delayMs: 10 },
        sleep: async () => {
          slept++
        }
      }),
      shouldCancel: () => slept > 0
    })
    expect(task.status).toBe('cancelled')
    expect(slept, '睡过一次就该看见取消').toBe(1)
    expect(task.deleted.find((d) => d.path === F)?.attempts, '不该把 5 次配额烧完').toBe(2)
    expect(fs.files.has(normalizeKey(F))).toBe(true)
  })

  it('重试时文件已被别的程序删掉：记「跳过文件」（§9 / §29 同口径），不算删除失败', async () => {
    const fs = mk({ files: { [F]: 100 }, failOn: { [F]: 'EBUSY' }, failTimes: { [F]: 1 }, failThenMissing: [F] })
    const task = await runCleanTask({ authorizedRoot: ROOT, paths: [F] }, opts({ fs, sleep: async () => undefined }))
    expect(task.failedCount, '"本来就不在了"不许冒充删除失败').toBe(0)
    expect(task.successCount).toBe(0)
    expect(task.refusals.map((r) => r.reason)).toEqual(['not-found'])
    expect(task.cleanedSize).toBe(0)
  })

  it('重试不改 §19 的账：预估与实际仍然对得上，成功的那次才计字节', async () => {
    const other = 'D:\\t\\cache\\ok.bin'
    const fs = mk({
      files: { [F]: 100, [other]: 50 },
      failOn: { [F]: 'EBUSY' },
      failTimes: { [F]: 2 }
    })
    const task = await runCleanTask(
      { authorizedRoot: ROOT, paths: [other, F] },
      opts({ fs, sleep: async () => undefined, measure: async () => ({ bytes: 150, files: 2 }) })
    )
    expect(task.successCount).toBe(2)
    expect(task.cleanedSize).toBe(150)
    expect(task.verification?.predictedFreedBytes).toBe(150)
  })
})
