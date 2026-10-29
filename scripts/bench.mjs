/**
 * §27 性能基准（Task 13 Step 3）。
 *
 * 用法（**必须走 vite-node**，见计划文末「给 Task 13 的修正」：Node 24 的 strip-only 模式
 *  既不认 TS 参数属性也不解析无扩展名相对 import，直接 `node scripts/bench.mjs` 跑不了 core/*.ts）：
 *    npm run bench -- --dir=D:/deepclean-fixture/f100k --repeat=3 --concurrency=16
 *    UV_THREADPOOL_SIZE=32 npx vite-node scripts/bench.mjs --dir=... --concurrency=32
 *
 * stdout 只有一行 JSON（供 $(...) 捕获 / 写进 results.md），人类可读的表格走 stderr。
 *
 * 本脚本顺带在验两件事：
 *  1. `core/scan/scanner.ts` 在纯 node（无 electron 运行时）下能加载 —— 它一旦 import electron 就当场崩。
 *  2. 扫描器报的 files/dirs/bytes 要和 scripts/oracle.mjs 的独立口径逐轴相等（结果写进 JSON 里对账）。
 *
 * UV_THREADPOOL_SIZE 的真相：libuv 只在线程池**首次创建**时读一次这个变量，而脚本跑起来时
 * vite-node 早就做过文件 I/O → 池已经按默认 4 建好了，进程内再赋值不生效。所以要用 shell 前缀
 * 在启动前设好；没设时下面会打一条 WARNING，而不是假装拿到了 16 个线程。
 */
import { performance } from 'node:perf_hooks'
import { win32 } from 'node:path'
import { Scanner } from '../core/scan/scanner.ts'
import { nodeFs } from '../core/fs/fslike.ts'

/** kebab → camel：`--max-depth=64` 与 `--maxDepth=64` 都要命中，否则参数被静默吃掉。 */
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
const dirArg = argv.dir ?? argv.d
if (!dirArg || dirArg === true) {
  console.error('usage: npx vite-node scripts/bench.mjs --dir=<path> [--repeat=3] [--concurrency=16] [--max-depth=64]')
  process.exit(2)
}
const repeat = Number(argv.repeat ?? 3)
const concurrency = Number(argv.concurrency ?? 16)
const maxDepth = Number(argv.maxDepth ?? 64)
const progressIntervalMs = Number(argv.progressMs ?? 250)
const maxFiles = Number(argv.maxFiles ?? 3_000_000)

if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error(`bench: --concurrency 必须是正整数，收到 ${argv.concurrency}`)
  process.exit(2)
}
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error(`bench: --repeat 必须是正整数，收到 ${argv.repeat}`)
  process.exit(2)
}

/* 反斜杠 + 去尾斜杠：与扫描器内部 joinWin 产出的 key 保持同一形态（盘符根 'D:\' 除外）。 */
const dir = (() => {
  let p = win32.resolve(String(dirArg)).replace(/\//g, '\\')
  if (p.length > 3 && p.endsWith('\\')) p = p.slice(0, -1)
  return p
})()

const pool = Number(process.env.UV_THREADPOOL_SIZE ?? 0)
if (pool < concurrency) {
  console.error(
    `bench: WARNING UV_THREADPOOL_SIZE=${pool || 'unset(default 4)'} < --concurrency=${concurrency}. ` +
      `libuv 的线程池在脚本启动前就按当时的值定下来了，进程内赋值不生效 —— ` +
      `并发度会被真实线程数压住。要量并发上限请用 shell 前缀重跑：UV_THREADPOOL_SIZE=${concurrency} npx vite-node scripts/bench.mjs ...`
  )
}

console.error(`bench: dir=${dir} concurrency=${concurrency} repeat=${repeat} maxDepth=${maxDepth} UV_THREADPOOL_SIZE=${process.env.UV_THREADPOOL_SIZE ?? 'default(4)'}`)

const rows = []
for (let r = 0; r < repeat; r++) {
  const t0 = performance.now()
  let events = 0
  let peakRss = 0
  let peakHeap = 0
  const sample = () => {
    const m = process.memoryUsage()
    if (m.rss > peakRss) peakRss = m.rss
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed
  }
  const sampler = setInterval(sample, 100)
  const sc = new Scanner({ fs: nodeFs, concurrency, progressIntervalMs, maxFiles, maxDepth })
  const snap = await sc.start(dir, (e) => {
    events++
    if (events % 20 === 0) sample()
  })
  clearInterval(sampler)
  sample()
  const elapsedMs = Math.round(performance.now() - t0)
  rows.push({
    run: r + 1,
    status: snap.status,
    files: snap.files,
    dirs: snap.dirs,
    bytes: snap.totalBytes,
    elapsedMs,
    filesPerSec: Math.round(snap.files / Math.max(0.001, elapsedMs / 1000)),
    peakRSS_MB: Math.round(peakRss / 1048576),
    peakHeap_MB: Math.round(peakHeap / 1048576),
    currentRSS_MB: Math.round(process.memoryUsage().rss / 1048576),
    denied: snap.denied,
    missing: snap.missing,
    busy: snap.busy,
    otherErrors: snap.otherErrors,
    skipped: snap.skipped,
    progressEvents: events,
    truncated: snap.truncated,
    rootFilesViaShallow: sc.store.getDir(sc.store.rootId)?.directFileCount ?? 0,
    treeBytes: sc.store.sizeOf(sc.store.rootId)
  })
  console.error(JSON.stringify(rows[rows.length - 1]))
}

const first = rows[0]
const best = rows.reduce((a, b) => (b.elapsedMs < a.elapsedMs ? b : a))
const summary = {
  dir,
  concurrency,
  repeat,
  maxDepth,
  progressIntervalMs,
  maxFiles,
  uvThreadPoolSize: process.env.UV_THREADPOOL_SIZE ?? 'default(4)',
  cold: first,
  best,
  peakRSS_MB: Math.max(...rows.map((x) => x.peakRSS_MB)),
  files: best.files,
  dirs: best.dirs,
  bytes: best.bytes,
  status: best.status,
  truncated: best.truncated,
  otherErrors: best.otherErrors,
  runs: rows
}
console.error(
  `run  elapsedMs  files/sec  peakRSS_MB\n` +
    rows.map((x) => `    ${x.run}    ${String(x.elapsedMs).padStart(8)}  ${String(x.filesPerSec).padStart(8)}  ${String(x.peakRSS_MB).padStart(9)}`).join('\n')
)
console.error(`peakRSS_MB=${summary.peakRSS_MB} files=${best.files} dirs=${best.dirs} bytes=${best.bytes} status=${best.status}`)
process.stdout.write(JSON.stringify(summary) + '\n')
