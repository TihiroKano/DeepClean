/**
 * 独立事实源（Task 13 Step 2）。
 *
 * 用法：
 *   node scripts/oracle.mjs "D:/deepclean-fixture/f100k"
 *   node scripts/oracle.mjs "D:/deepclean-fixture/f100k/System Volume Information"
 *
 * 输出 stdout 单行 JSON：{"files":N,"dirs":N,"bytes":N,"enumErrors":0}
 *   dirs 用 `Get-ChildItem -Directory -Recurse`，**不含根自身**。
 *
 * ⚠️ 与 Rust 扫描器比对时的两件事，别混成一句（这句以前是错的，两种错法都记着）：
 *   1. **根的口径两边一致**：Rust 侧 `crates/scanner/src/scan.rs:275` 数的是"遍历到的条目里有多少
 *      个目录"，根是**节点不是条目** ⇒ 它也不含根。旧注释写的"扫描器含根、比对时 scanner.dirs ==
 *      oracle.dirs + 1"是**已删的 TS/electron 扫描器**的口径，现在照它加那个 ±1 会把一次正确的
 *      对账判成差一。（另一份量具 `scripts/m6-file-oracle.ps1` 的约定**相反**，它的 dirs 含根，
 *      与 Rust 比才是 -1。两份 oracle 同名不同约定 —— 这正是 M6 那轮差点被"±1 容差"糊过去的原因。）
 *   2. **但两边的原始总数本来就不相等**，因为扫描器按 `SKIP_ALWAYS` 跳掉整片子树，而这份 oracle
 *      照实走进去。2026-10-17 在 `f100k` 上实测：本脚本 `files=100,006 dirs=62 bytes=1,033,725,042`，
 *      扫描器 `files=89,801 dirs=57 totalBytes=1,032,734,840` —— 差的是**被跳掉的那一片**，
 *      不是根、也不是漏扫。所以比对的正确做法是把被跳的分支单独再量一次当**子账**，
 *      验 `全量 − 子账 = 扫描器` 三轴逐项闭合（M6 第 2 道闸就是这么结的，见
 *      `docs/acceptance/2026-10-15-m6-packaging-gate.md` §二），**任何容差都不许用**。
 *
 * 这个脚本存在的唯一理由：**验证扫描器的数字不能由扫描器自己出**。
 * 因此本文件禁止 import 任何 core/ 或 electron/ 的东西 —— 一旦共享代码，它就不是第二方意见了。
 *
 * 实测过的两个口径坑（不是理论，是这台机器上量出来的）：
 *  1. 本机是 Windows PowerShell 5.1 且 `HKLM\...\FileSystem\LongPathsEnabled = 0`。
 *     不加 `\\?\` 前缀时 `Get-ChildItem -Recurse` 走到 >260 字符那一支会**静默少计**
 *     （实测 5 个文件报 0 个、13 个目录报 11 个）。加前缀后三轴全对。
 *     扫描器靠 core/fs/pathutil.ts 的 toFsPath 处理同一问题，两边各自实现、互不共享代码。
 *  2. `-ErrorAction SilentlyContinue` 会把「读不动」和「压根没读到」混成一坨。
 *     所以额外用 `-ErrorVariable` 把异常条数取出来：只要 >0，本次枚举就是残缺的，
 *     残缺的事实源没有资格当事实源 → exit 1（除非显式 --allow-partial）。
 *
 * 已登记的有意差异（对账时必须单独量一遍再闭合）：
 *   - `System Volume Information` 在扫描器的 SKIP_ALWAYS 名单里，整个子树不扫；
 *     而夹具里这个目录是我们自己建的普通目录，PowerShell 读得到 → oracle 会多计。
 *     闭合办法：把 oracle 再指到该目录本身跑一次，拿到的就是被排除掉的量。
 *   - 表观大小（`Measure-Object Length -Sum`）≠ 磁盘占用；与扫描器同口径，可比。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { win32 } from 'node:path'

const run = promisify(execFile)

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const positional = argv.filter((a) => !a.startsWith('--'))
const allowPartial = flags.includes('--allow-partial')
const dir = positional[0]

if (!dir) {
  console.error('usage: node scripts/oracle.mjs <dir> [--allow-partial]')
  process.exit(2)
}

/* 自己拼绝对路径：不用 core/ 的任何工具函数（见文件头）。 */
let abs = win32.resolve(dir)
if (abs.length > 3 && abs.endsWith('\\')) abs = abs.slice(0, -1)
/* PS 5.1 在 LongPathsEnabled=0 的机器上必须吃 \\?\ 前缀，否则 -Recurse 静默截断。 */
const ext = abs.startsWith('\\\\?\\') ? abs : `\\\\?\\${abs}`
const q = ext.replace(/'/g, "''")

const ps =
  "$ErrorActionPreference='Continue'; " +
  `$e1=$null; $e2=$null; ` +
  `$f=@(Get-ChildItem -LiteralPath '${q}' -Recurse -Force -File -ErrorAction SilentlyContinue -ErrorVariable e1); ` +
  `$d=@(Get-ChildItem -LiteralPath '${q}' -Recurse -Force -Directory -ErrorAction SilentlyContinue -ErrorVariable e2); ` +
  `$b=[long]((($f|Measure-Object -Property Length -Sum).Sum)); ` +
  `'{0}|{1}|{2}|{3}' -f [long]$f.Count, [long]$d.Count, $b, [long](@($e1).Count + @($e2).Count)`

let stdout
try {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    maxBuffer: 8 << 20
  })
  stdout = r.stdout
} catch (e) {
  console.error(`oracle: powershell failed — ${String(e.message).slice(0, 300)}`)
  process.exit(1)
}

const parts = String(stdout).trim().split(/\r?\n/).pop().split('|').map(Number)
if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
  console.error(`oracle: unparsable powershell output: ${JSON.stringify(stdout)}`)
  process.exit(1)
}

const [files, dirs, bytes, enumErrors] = parts
const result = { files, dirs, bytes, enumErrors, root: abs }
process.stdout.write(JSON.stringify(result) + '\n')

if (enumErrors > 0 && !allowPartial) {
  console.error(
    `oracle: enumeration INCOMPLETE — powershell reported ${enumErrors} error(s) while walking ${abs}. ` +
      `A partially-read tree cannot serve as the fact source (files=${files} is an undercount). ` +
      `Re-run on a readable/static target, or pass --allow-partial to accept it as a WARNING.`
  )
  process.exit(1)
}
if (enumErrors > 0) console.error(`oracle: WARNING — ${enumErrors} enumeration error(s), numbers are undercounts (--allow-partial).`)
console.error(`oracle: files=${files.toLocaleString('en-US')} dirs=${dirs.toLocaleString('en-US')} bytes=${bytes.toLocaleString('en-US')} enumErrors=${enumErrors} (dirs excludes the root itself)`)
