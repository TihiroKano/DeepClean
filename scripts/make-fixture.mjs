/**
 * 合成目录树生成器（§27 / Task 13 Step 1）。
 *
 * 用法：
 *   npm run fixture -- --files=100000 --out=D:/deepclean-fixture/f100k
 *   npx vite-node scripts/make-fixture.mjs --files=100000 --out=D:/deepclean-fixture/f100k
 *
 * 设计约束（都是工艺真相，不是保守）：
 *  1. **只用真字节，不做稀疏文件。** NTFS 上非稀疏的 ftruncate(fd, 8GB) 会真的占 8GB 簇。
 *     单文件上限 512MB，总字节数由 `--max-total-bytes` 在写之前就核算死（默认 1.3GB）。
 *  2. **禁止写 C 盘。** --out 必须落在 FIXTURE_ROOT 之下，否则 exit 3。
 *  3. 刻意布下的雷（删掉这两条 = 删掉测试）：
 *     - `System Volume Information`：扫描器的 SKIP_ALWAYS 名单（core/fs/errors.ts），整个子树不扫。
 *       注意我们自己造的普通目录 PowerShell 读得到 → 对账时它是**已登记的有意差异**，见 oracle.mjs 头部。
 *     - `longpath`：12 段 >260 字符，验 `\\?\` 前缀（Task 3）与 PowerShell 的长路径口径。
 *  4. stdout 只输出一行 JSON，进度条走 stderr —— 否则 `DC_FIXTURE_JSON="$(npm run fixture ...)"` 会
 *     把 `\r` 进度条和 JSON 粘在同一行，`$(...)` 捕获直接作废。
 *
 * 本脚本不是事实源：它自报的 files/dirs/bytes 只是「我以为我写了多少」，
 * 对账一律以 scripts/oracle.mjs（PowerShell 独立口径）为准。
 */
import { mkdir, rm, open, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, win32 } from 'node:path'

/** 唯一允许的落盘前缀（§执行须知：禁止往 C 盘写夹具）。 */
const FIXTURE_ROOT = win32.normalize('D:\\deepclean-fixture')
/** 单文件硬上限：512MB 真字节。 */
const MAX_FILE_BYTES = 512 * 1024 * 1024
/** 默认总字节上限：三档规模（10万/50万/100万）都要在 1.3GB 以内。 */
const DEFAULT_MAX_TOTAL = 1.3 * 1024 * 1024 * 1024
/** 大文件分块写：本机空闲内存常只有 1.5GB，Buffer.alloc(512MB) 会把自己逼进 swap。 */
const CHUNK = 8 * 1024 * 1024
/** 并发写盘数（建夹具是顺序 I/O 密集，8 已经吃满机械盘，再多只增排队）。 */
const WRITE_PARALLEL = 8

const BRANCH = ['Users', 'Windows', 'Program Files', 'ProgramData', 'AppData', 'Projects', 'Downloads', 'Videos', 'node_modules', '__Temp__', 'System Volume Information']
const EXT = ['.dll', '.exe', '.log', '.tmp', '.zip', '.mp4', '.png', '.pak', '.json', '.js']
const LONG_SEGMENTS = 12

/** `--k=v` 与 `--k v` 两种写法都收（计划原文只支持 `=`，接口段却用了空格形式）；kebab 与 camel 同义。 */
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) out[camel(a.slice(2, eq))] = a.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[camel(a.slice(2))] = argv[++i]
    else out[camel(a.slice(2))] = true
  }
  return out
}

const argv = parseArgv(process.argv.slice(2))
const target = Number(argv.files ?? 100_000)
const seed = Number(argv.seed ?? 12345)
const maxTotal = Number(argv.maxTotalBytes ?? DEFAULT_MAX_TOTAL)
const outRaw = String(argv.out ?? FIXTURE_ROOT)

let rnd = seed
const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

function fail(msg, code) {
  console.error(`make-fixture: ${msg}`)
  process.exit(code)
}

if (!Number.isInteger(target) || target <= 0) fail(`--files 必须是正整数，收到 ${argv.files}`, 2)

/* ---------------- 落盘位置闸门 ---------------- */
const out = win32.resolve(resolve(outRaw))
const rootKey = FIXTURE_ROOT.toLowerCase()
const outKey = out.toLowerCase()
const inside = outKey === rootKey || outKey.startsWith(rootKey + '\\')
if (!inside) {
  fail(
    `--out 必须落在 ${FIXTURE_ROOT} 之下（本工具禁止往 C 盘或任何其他位置写夹具）。收到 ${out}`,
    3
  )
}
if (outKey === rootKey) fail('--out 必须是指定子目录（如 D:/deepclean-fixture/f100k），不能直接是夹具根，否则会把整个 D:/deepclean-fixture 删掉', 3)

/* ---------------- 目录骨架 ---------------- */
/** fileDirs = 真正写文件的目录（计划原稿的 dirs 数组）；allDirs = 磁盘上会出现的全部目录（不含 out 自身）。 */
const fileDirs = []
/** 建目录用真实大小写，计数用小写 key（NTFS 大小写不敏感，两套不能混用）。 */
const realDirs = []
const allDirs = new Set()

function remember(...paths) {
  for (const p of paths) {
    realDirs.push(win32.normalize(p))
    allDirs.add(win32.normalize(p).toLowerCase())
  }
}

for (let b = 0; b < BRANCH.length; b++) {
  const depth = 3 + (b % 4)
  const chain = [join(out, BRANCH[b])]
  for (let d = 1; d < depth; d++) chain.push(join(chain[d - 1], `sub${d}`))
  fileDirs.push(...chain)
  remember(...chain)
}
remember(join(out, 'Empty'))

const longpath = [join(out, 'longpath')]
for (let i = 0; i < LONG_SEGMENTS; i++) longpath.push(join(longpath[i], 'segment-with-many-chars'))
fileDirs.push(longpath[longpath.length - 1])
remember(...longpath)

const longest = longpath[longpath.length - 1]
console.error(`longest planted path = ${longest.length} chars (>260 ⇒ 走 \\?\\ 口径)`)

/* ---------------- 先核算字节预算，再动盘 ---------------- */
const per = Math.ceil(target / fileDirs.length)
const jobs = []
let planned = 0
let plannedBytes = 0
for (const dir of fileDirs) {
  const n = Math.min(per, target - planned)
  for (let i = 0; i < n; i++) {
    const size = Math.floor(rand() ** 3 * 512)
    // size===0 时改名加 .noext（计划原稿口径）：仍然是「一个文件、0 字节」，
    // 这条分支专门用来验 files 与 bytes 两个坐标不会互相洗白。
    const name = size > 0 ? `f${i}${EXT[i % EXT.length]}` : `f${i}${EXT[i % EXT.length]}.noext`
    jobs.push({ path: join(dir, name), size })
    planned++
    plannedBytes += size
  }
  if (planned >= target) break
}
/* ---------------- 肥目录：单层规模才是地图的瓶颈 ---------------- */
/**
 * `--fat-dir=N` 往 <out>/FatDir 里塞 N 个**直属**文件（不计入 --files 的摊派）。
 * 为什么非要一个目录装这么多：C:\Windows\System32 实测有 ~10 万个直属文件，
 * 摊开成 40 个 2500 项的目录，childrenOf / levelOf / IPC 三条路径都是"轻松"的，
 * 基准会全绿而真盘一进 System32 就卡 —— 那种基准不如不跑。
 *
 * 这段必须在「先核算字节预算」的 jobs 循环之后、写盘之前：它要往 jobs / planned /
 * plannedBytes 里追加，而预算闸门（plannedBytes > maxTotal → fail）就在下面几行，
 * 这样 1M + 30万直属文件也会走同一条拒绝路径，而不是悄悄少写。
 */
const fatN = Number(argv.fatDir ?? 0)
if (!Number.isInteger(fatN) || fatN < 0) fail(`--fat-dir 必须是非负整数，收到 ${argv.fatDir}`, 2)
const fatDirPath = join(out, 'FatDir')
if (fatN > 0) {
  remember(fatDirPath)
  for (let i = 0; i < fatN; i++) {
    // size 用 1 + (i % 997) 而不是同一个值：全同 size 会让 top-K 的 tie-break 分支永远不被触发
    const size = 1 + (i % 997)
    jobs.push({ path: join(fatDirPath, `k${String(i).padStart(7, '0')}.bin`), size })
    planned++
    plannedBytes += size
  }
}

const extras = [
  // 根目录自己的直属文件：Task 6 bug① 的哨兵。buildSeeds 取深度 2 当并行单元，
  // 根和中间层头上的文件不属于任何 seed 的返回值 —— 真实盘上等价于漏掉 C:\pagefile.sys。
  // 夹具若不放这几个文件，files/bytes 两轴就永远验不到这条回归（深度 1 的直属文件已由 fileDirs 覆盖）。
  { path: join(out, 'pagefile.sys'), size: 1024 * 1024 },
  // 点开头、无扩展名：计划原稿把这条列进「刻意造的坑」却没实现。extOf() 对它必须回 ''。
  { path: join(out, '.deepclean-ignore'), size: 0 },
  { path: join(out, 'Videos', 'huge.pak'), size: MAX_FILE_BYTES },
  { path: join(out, 'Videos', 'video.mp4'), size: Math.floor(MAX_FILE_BYTES * 0.6) },
  { path: join(out, 'Videos', 'archive.zip'), size: Math.floor(MAX_FILE_BYTES * 0.3) },
  { path: join(out, 'Downloads', 'README'), size: 0 }
]
for (const e of extras) plannedBytes += e.size

// 不用 Math.max(...arr)：50 万个元素会把展开后的实参塞爆调用栈（100k 侥幸，500k 必炸）
const maxPlanted = jobs.concat(extras).reduce((m, j) => (j.size > m ? j.size : m), 0)
console.error(
  `planned: files=${planned} dirs=${allDirs.size} bytes=${plannedBytes.toLocaleString('en-US')} maxFile=${maxPlanted.toLocaleString('en-US')}`
)
if (maxPlanted > MAX_FILE_BYTES) fail(`单文件 ${maxPlanted}B 超过 ${MAX_FILE_BYTES}B 上限（不许用稀疏文件造假大小）`, 4)
if (plannedBytes > maxTotal) fail(`总字节 ${plannedBytes} 超过预算 ${maxTotal}（--max-total-bytes 可调），拒绝写盘`, 4)

/* ---------------- 写盘 ---------------- */
async function writeSized(job) {
  if (job.size === 0) {
    await writeFile(job.path, Buffer.alloc(0))
    return
  }
  if (job.size <= CHUNK) {
    await writeFile(job.path, Buffer.alloc(job.size))
    return
  }
  // 大文件：8MB 缓冲复用，分块 write。峰值 RSS 就是 8MB 而不是 512MB。
  const fh = await open(job.path, 'w')
  try {
    const buf = Buffer.alloc(CHUNK)
    let left = job.size
    while (left > 0) {
      const n = Math.min(CHUNK, left)
      await fh.write(buf, 0, n)
      left -= n
    }
  } finally {
    await fh.close()
  }
}

const t0 = Date.now()
console.error(`wiping ${out}`)
await rm(out, { recursive: true, force: true, maxRetries: 5 })
await mkdir(out, { recursive: true })
for (const d of realDirs) await mkdir(d, { recursive: true })
if (!existsSync(join(out, 'Empty')) || !existsSync(join(out, 'System Volume Information'))) {
  fail('骨架目录缺失（Empty / System Volume Information），夹具不可信', 5)
}

let done = 0
let cursor = 0
const total = jobs.length + extras.length
const tick = setInterval(() => {
  const rate = Math.round(done / Math.max(0.001, (Date.now() - t0) / 1000))
  const bar = Math.floor((done / total) * 24)
  process.stderr.write(`\r[${'#'.repeat(bar)}${'-'.repeat(24 - bar)}] ${done}/${total} ${rate}/s`)
}, 250)

async function worker() {
  for (;;) {
    const i = cursor++
    if (i >= jobs.length + extras.length) return
    await writeSized(i < jobs.length ? jobs[i] : extras[i - jobs.length])
    done++
  }
}
await Promise.all(Array.from({ length: WRITE_PARALLEL }, worker))
clearInterval(tick)
// 进度条以 \r 结尾：在交还 stdout 之前先在 stderr 上打一个换行收掉它。
process.stderr.write(`\r${' '.repeat(60)}\r\n`)

/* ---------------- 结果（stdout 只有这一行） ---------------- */
const summary = {
  root: out,
  // 含 extras（大文件 / README / 根直属那几条）—— 少了它们，自报值会比 oracle 少 6 条，
  // 变成一条需要解释的假差异。自报值仍不是事实源，只是不该主动制造噪声。
  files: planned + extras.length,
  plantedSmallFiles: planned,
  dirs: allDirs.size,
  bytes: plannedBytes,
  largestFileBytes: maxPlanted,
  elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
  note: 'self-reported by the writer; NOT the fact source — reconcile with scripts/oracle.mjs'
}
process.stdout.write(JSON.stringify(summary) + '\n')
