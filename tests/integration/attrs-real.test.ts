/**
 * Task 15 的真实 NTFS 属性对账（把「别信计划里的位映射假设」固化成测试）。
 *
 * 为什么要有这个文件：`tests/unit/*` 里的 fake fs 只能证明**管道**通，
 * 证明不了 Windows 的 `stats.mode` 里到底有没有 HIDDEN / SYSTEM / ARCHIVE。
 * 权威口径用 PowerShell 的 `FileSystemInfo.Attributes`（与 scripts/oracle.mjs 同一纪律：
 * `\\?\` 前缀 + 枚举错误计数，因为本机 LongPathsEnabled=0、PS 5.1 会静默少计）。
 *
 * 跑法：npm run test:integration   （真实目录不存在时相关用例自己跳过并打印原因）
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import { win32 } from 'node:path'
import { nodeFs } from '../../core/fs/fslike'
import { Scanner } from '../../core/scan/scanner'
import { attrState, attrsFromStatMode } from '../../shared/classify'

const run = promisify(execFile)
const BS = String.fromCharCode(92)
/** 长路径机器上 PS 5.1 不加 \\?\ 会静默少计（scripts/oracle.mjs 的实测教训），这里一律加。 */
const ext = (absPath: string): string => (absPath.startsWith(BS + BS + '?' + BS) ? absPath : BS + BS + '?' + BS + absPath)
const quote = (s: string): string => s.replace(/'/g, "''")

async function ps(cmd: string): Promise<string | null> {
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true })
    return String(r.stdout).trim() || null
  } catch {
    return null
  }
}

/** 每个 Windows 10/11 都有的 Hidden+System 真实文件，取本机确实存在且能 stat 的那个。 */
const HIDDEN_SYSTEM_CANDIDATES = [
  'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\desktop.ini',
  'C:\\Users\\Public\\Desktop\\desktop.ini'
]

describe('真实 NTFS 上 st_mode ↔ FILE_ATTRIBUTE 的映射（PowerShell 为权威口径）', () => {
  it('PowerShell 认定为 Hidden+System 的真实文件，绝不允许被我们判成 hidden=set 或 hidden=clear', async () => {
    let checked = 0
    for (const cand of HIDDEN_SYSTEM_CANDIDATES) {
      const auth = await ps(`$i=Get-Item -LiteralPath '${quote(ext(cand))}' -Force -ErrorAction Stop; $i.Attributes.ToString()`)
      if (!auth || !auth.includes('Hidden') || !auth.includes('System')) continue
      const rawMode = statSync(cand).mode
      const attrs = attrsFromStatMode(rawMode)
      // 靶心：raw st_mode 里 bit 2/4/32 看着都"置位"了，其实那是 0o100666 的 POSIX 权限位。
      // 谁照抄「mode & 2」，谁就把这台机器上每个可写文件都报成隐藏文件。
      expect(rawMode & 0o222, '该文件可写 → mode 属于 0o100666 那一族').not.toBe(0)
      // 断言的是「诚实」：PowerShell 说它隐藏+系统，而这一次 stat 里读不出来 → 必须报 unknown。
      // 报 set 是假阳性；报 clear 是假阴性（§28 原则二「系统文件默认保护」，把 unknown 当 clear 等于当它可清理）。
      expect(attrState(attrs, 'hidden'), `${cand} 的 PowerShell 属性 = ${auth} / mode = ${rawMode}`).toBe('unknown')
      expect(attrState(attrs, 'system'), `${cand} 的 PowerShell 属性 = ${auth} / mode = ${rawMode}`).toBe('unknown')
      // 扫描器真正吃的是 nodeFs.stat 出来的那份解码，两边必须是同一个结论
      expect((await nodeFs.stat(cand)).attrs, 'nodeFs.stat 的解码 == attrsFromStatMode(raw mode)').toBe(attrs)
      checked++
    }
    expect(checked, '本机没找到可核对的真实 hidden+system 文件 → 这条测试什么都没测').toBeGreaterThan(0)
  }, 120_000)

  it('扫描器不遗漏隐藏文件本身（§4.1「扫描隐藏文件」= 枚举齐全，与能不能标出属性是两件事）', async () => {
    const target = win32.resolve(process.env.DC_ATTR_DIR ?? 'C:\\Users\\Public')
    if (!existsSync(target)) return console.warn(`目标目录不存在，跳过：${target}`)
    const out = await ps(
      "$ErrorActionPreference='Continue'; $e=$null; " +
        `$f=@(Get-ChildItem -LiteralPath '${quote(ext(target))}' -Recurse -Force -File -ErrorAction SilentlyContinue -ErrorVariable e); ` +
        `$h=@($f|Where-Object { ($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0 }).Count; ` +
        `$s=@($f|Where-Object { ($_.Attributes -band [IO.FileAttributes]::System) -ne 0 }).Count; ` +
        `$r=@($f|Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0 }).Count; ` +
        `$p=@($f|Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count; ` +
        `'{0}|{1}|{2}|{3}|{4}|{5}' -f [long]$f.Count,$h,$s,$r,$p,[long]@($e).Count`
    )
    if (!out) return console.warn('本机 PowerShell 不可用，跳过对账')
    const [files = -1, hidden = -1, system = -1, readonly = -1, reparse = -1, enumErrors = -1] =
      out.split(/\r?\n/).pop()!.split('|').map(Number)
    expect(enumErrors, 'PowerShell 枚举不完整 → 没资格当权威口径').toBe(0)
    expect(files, 'PowerShell 一个文件都没枚举到 → 这条测试什么都没测（PS 5.1 的 -File/-Directory 陷阱）').toBeGreaterThan(0)

    const sc = new Scanner({ fs: nodeFs, concurrency: 16, progressIntervalMs: 500, maxFiles: 3_000_000, maxDepth: 64 })
    const snap = await sc.start(target, () => undefined)
    expect(snap.status).toBe('completed')
    // 扫描器按 Task 5 的既定口径主动跳过重解析点 → 可比对的文件全集 = PS files − reparse
    expect(snap.files, `scanner=${snap.files} psFiles=${files} psReparse=${reparse}`).toBe(files - reparse)

    let readonlySet = 0, hiddenSet = 0, systemSet = 0, unknownHidden = 0
    const walk = (dirId: number): void => {
      for (const c of sc.children(dirId).children) {
        if (c.kind === 'directory' && c.dirId !== undefined) walk(c.dirId)
        if (c.attrs === null) continue // 目录：本轮不采属性
        if (attrState(c.attrs, 'readonly') === 'set') readonlySet++
        if (attrState(c.attrs, 'hidden') === 'set') hiddenSet++
        if (attrState(c.attrs, 'system') === 'set') systemSet++
        if (attrState(c.attrs, 'hidden') === 'unknown') unknownHidden++
      }
    }
    walk(sc.store.rootId)
    expect(readonlySet, '只读轴与 PowerShell 逐位相等（这条能过 = 属性管道在真实盘上是通的）').toBe(readonly)
    expect(hiddenSet + systemSet, '当前属性源判不出 hidden/system；一旦出现非 0 说明有人把 raw mode 位当属性用了').toBe(0)
    expect(unknownHidden, '每个扫到的文件都要如实标 unknown，而不是被静默当 clear').toBe(files - reparse)
    console.log(
      `[attrs-real] ${target}: PS files=${files} hidden=${hidden} system=${system} readonly=${readonly} ` +
        `reparse=${reparse} enumErrors=${enumErrors} | scanner files=${snap.files} readonly=${readonlySet} unknown=${unknownHidden}`
    )
  }, 300_000)
})
