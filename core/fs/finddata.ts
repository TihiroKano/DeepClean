/**
 * 目录枚举的"查找记录"兜底 —— **不需要管理员**就能拿到被 ACL 挡住的文件大小。
 *
 * ## 为什么需要它
 *
 * `fs.stat('C:\\pagefile.sys')` 在不提权时是 **EPERM**：Node 打开文件句柄查属性，而
 * 那个 ACL 不允许。于是扫描器把根上这几个文件记成"没权限、未计入"，地图合计比盘上已用
 * **少 9.05 GB**（2026-10-09 实测）。
 *
 * 但 NTFS 的大小本来就写在目录项里：Win32 的 `FindFirstFile/FindNextFile` 返回的
 * `WIN32_FIND_DATA.nFileSize*` 只要对**父目录**有"列出内容"权限就能拿到，不需要打开文件。
 * Node 的 `opendir` 走的正是这条内部路径，却把 size 字段丢掉了（`DirEntry` 只有名字与类型），
 * 所以这里用一次 PowerShell 枚举把那格捡回来。
 *
 * ## 它是兜底，不是主路
 *
 * 只在 `stat` 因为权限失败之后、按目录**惰性**调用，并且每个目录只调一次（含失败也记账）。
 * 一次进程启动实测 150–460 ms（`C:\\` 464 ms / 475 条目的 drivers 198 ms），拿它去替代
 * 全仓的 stat 是纯亏 —— 换来的是"默认扫描不用弹 UAC 也能把 9 GB 算进地图"。
 *
 * 任何失败（没有 powershell、语言模式受限、超时、编码乱掉）一律返回 `null`，
 * 调用方退回今天的行为：如实记"未计入"。**这条路径的存在不许让数字变脏**，
 * 只允许让数字从"少一大块"变成"多一大块且来源可指"。
 */
import { spawn } from 'node:child_process'

export interface FindDataEntry {
  /** 表观大小 = `WIN32_FIND_DATA.nFileSize`，与 MFT 里非驻留 `$DATA` 的 real size 同值 */
  size: number
  /** 修改时间（UTC 毫秒）—— 与 size 同一条查找记录，不是第二次 I/O。 */
  mtimeMs: number
  /** 创建时间（UTC 毫秒）。 */
  birthtimeMs: number
  /** `FILE_ATTRIBUTE_*` 位（PowerShell 的 FileAttributes 枚举值与之逐位相同）。 */
  attrs: number
}

export type FindDataLister = (dir: string) => Promise<Map<string, FindDataEntry> | null>

/**
 * 只读枚举一个目录并打印「名 \t 字节 \t 改期 \t 创建 \t 属性位」，五个字段全取自**同一条**
 * `WIN32_FIND_DATA` —— 所以兜底出来的文件条目和 stat 出来的一样齐，不需要"先顶上残缺数据"。
 *
 * 路径从 **stdin** 读，不拼进命令行 —— 扫描路径来自文件系统，任何"把它写进脚本字符串"的
 * 做法都是在给文件名留出逃逸成命令的口子。`[Console]::OutputEncoding` 显式设成 UTF-8：
 * Windows 控制台默认 OEM 码页，中文目录名会先在这里烂掉（PowerShell 5.1 与 7 行为不同，
 * 所以两个方向都设，不赌默认值）。制表符不可能是文件名的一部分，所以它是安全的分隔符。
 */
const SCRIPT = [
  "$ErrorActionPreference='Continue'",
  '[Console]::InputEncoding=[Text.Encoding]::UTF8',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '$p=[Console]::In.ReadToEnd().Trim()',
  "if ($p.Length -eq 0) { exit 1 }",
  'Get-ChildItem -Force -LiteralPath $p -ErrorAction SilentlyContinue | ForEach-Object {',
  '  if (-not $_.PSIsContainer -and $null -ne $_.Length) {',
  '    "{0}`t{1}`t{2}`t{3}`t{4}" -f $_.Name, $_.Length, $_.LastWriteTimeUtc.ToFileTimeUtc(), $_.CreationTimeUtc.ToFileTimeUtc(), [int]$_.Attributes',
  '  }',
  '}'
].join('\n')

/** Windows 文件时间（1601-01-01 起的 100ns 计数）→ Unix 毫秒。 */
function fileTimeToMs(ft: string): number | null {
  if (!/^\d+$/.test(ft)) return null
  const ms = Number(BigInt(ft) / 10_000n - 11_644_473_600_000n)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

export interface FindDataOptions {
  /** 单次枚举的硬超时。子进程卡住（电源策略、ConstrainedLanguage 弹窗）不能拖垮整轮扫描。 */
  timeoutMs?: number
  /** 测试注入点：默认走真实 powershell。 */
  run?: (script: string, dir: string, timeoutMs: number) => Promise<string | null>
}

const DEFAULT_TIMEOUT = 15_000

async function runViaPowerShell(script: string, dir: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    let settled = false
    const done = (v: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child?.pid !== undefined) {
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
      }
      resolve(v)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    child.stdout?.on('data', (b: Buffer) => chunks.push(b))
    child.on('error', () => done(null))
    child.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) return done(null)
      done(Buffer.concat(chunks).toString('utf8'))
    })
    try {
      child.stdin?.end(dir + '\n')
    } catch {
      done(null)
    }
  })
}

/**
 * 建一个带**每目录记忆**的枚举器。
 *
 * 记忆包括失败的目录：一个目录里的权限形状是稳定的，第一次拿不到就别再花 300 ms 试第二次。
 * 并发调用同一目录共享同一个在途 Promise（扫描器是同层并行的，不去重会同时起 N 个 powershell）。
 */
export function createFindDataLister(opts: FindDataOptions = {}): FindDataLister {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const run = opts.run ?? runViaPowerShell
  const memo = new Map<string, Promise<Map<string, FindDataEntry> | null>>()

  return (dir: string): Promise<Map<string, FindDataEntry> | null> => {
    const key = dir.toLowerCase()
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const job = (async (): Promise<Map<string, FindDataEntry> | null> => {
      const out = await run(SCRIPT, dir, timeoutMs)
      if (out === null) return null
      const map = new Map<string, FindDataEntry>()
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        const parts = trimmed.split('\t')
        const name = parts[0]
        const sizeText = parts[1]
        const mt = parts[2]
        const ct = parts[3]
        const attrText = parts[4]
        if (name === undefined || sizeText === undefined || !/^\d+$/.test(sizeText)) continue
        const mtimeMs = fileTimeToMs(mt ?? '')
        const birthtimeMs = fileTimeToMs(ct ?? '')
        const attrs = /^\d+$/.test(attrText ?? '') ? Number(attrText) : null
        // 四个数少一个就整条弃用。 FileEntry 的 birthtimeMs / attrs 是必需字段，
        // 可选就会诱导下游 `?? 0`，把"没采到"画成 1970-01-01 —— 那正是本项目全局口径禁的。
        // 弃用的代价只是这一个文件退回"未计入"，等于今天的行为，不会更糟。
        if (mtimeMs === null || birthtimeMs === null || attrs === null) continue
        map.set(name.toLowerCase(), { size: Number(sizeText), mtimeMs, birthtimeMs, attrs })
      }
      // 一条都没解出来 = 输出根本没按形状来（语言模式、编码、版本差异），按失败处理，
      // 别交出一个空 Map 让调用方以为"这个目录里真的没有文件"。
      return map.size > 0 ? map : null
    })()
    memo.set(key, job)
    return job
  }
}

/**
 * 查一个文件：`stat` 被拒之后由调用方拿来兜底。找不到返回 `null`（= 维持"未计入"）。
 *
 * 独立成一个函数是因为两条扫描路线（`scanner.ts` 的浅层目录与 `walk.ts` 的种子子树）
 * 都会撞 ACL，而这两处的"取不到就照旧记错误"必须**逐字同形** —— 一份口径抄两遍，
 * 迟早一份改了另一份没改，界面上就会出现"同一个文件在一次扫描里两种说法"。
 */
export async function lookupFindDataEntry(
  lister: FindDataLister | undefined,
  dir: string,
  name: string
): Promise<FindDataEntry | null> {
  if (lister === undefined) return null
  const map = await lister(dir)
  if (map === null) return null
  return map.get(name.toLowerCase()) ?? null
}
