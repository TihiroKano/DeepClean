/**
 * 真实磁盘只读冒烟（Task 13 Step 4）。
 *
 * 用法：
 *   npm run smoke:real -- --root=C:\ --yes
 *   npx vite-node scripts/smoke-real.mjs --root=D:\some\static\dir --yes --min-files=1
 *
 * 安全阀（顺序即实现顺序，都在加载扫描器之前）：
 *   1. 没有显式 --yes → exit 2，且**不做任何 I/O**（core/ 的 import 是 dynamic 的，
 *      放在闸后面，否则 ESM 顶层 import 会在参数检查之前就执行）。
 *   2. 必须显式给 --root，不默认 C:\ —— 少打一个参数就去数十万个真实目录不是好设计。
 *   3. 本脚本**只读**：只 import Scanner 与 nodeFs（nodeFs 只有 readdir / stat），
 *      脚本自身不调用任何 mkdir / writeFile / rm / unlink。
 *      项目的硬验收是 `git grep -n "rm(\|unlink\|rimraf" core/ electron/` 为空。
 *   4. 只读扫描也会持续数分钟、产生大量读 I/O（冷盘可能拖慢 Explorer），这就是 --yes 存在的意义。
 *
 * §8 红线：真实盘上绝不允许出现 status==='failed'（权限错误必须只是「记录+跳过+继续」）。
 */
const argvRaw = process.argv.slice(2)
const argv = {}
/** kebab → camel：`--min-files=1` 与 `--minFiles=1` 都必须命中 argv.minFiles（只认一种会静默吃参数）。 */
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
for (let i = 0; i < argvRaw.length; i++) {
  const a = argvRaw[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq >= 0) argv[camel(a.slice(2, eq))] = a.slice(eq + 1)
  else argv[camel(a.slice(2))] = true
}

if (!argvRaw.includes('--yes')) {
  console.error(
    '需要显式加 --yes：本命令会只读扫描真实磁盘，持续数分钟并产生大量磁盘读取。\n' +
      '  npm run smoke:real -- --root=C:\\ --yes\n' +
      '（确认只读：脚本只 import Scanner + nodeFs(readdir/stat)，不含任何写入或删除调用。）'
  )
  process.exit(2)
}
if (!argv.root || argv.root === true) {
  console.error('usage: npx vite-node scripts/smoke-real.mjs --root=C:\\ --yes [--concurrency=16] [--min-files=100000]')
  process.exit(2)
}

/* 闸门之后才加载被测代码。 */
const { win32 } = await import('node:path')
const { Scanner } = await import('../core/scan/scanner.ts')
const { nodeFs } = await import('../core/fs/fslike.ts')

const concurrency = Number(argv.concurrency ?? 16)
const minFiles = Number(argv.minFiles ?? 100_000)
if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(minFiles) || minFiles < 0) {
  console.error(`smoke-real: --concurrency / --min-files 参数不合法 (${argv.concurrency} / ${argv.minFiles})`)
  process.exit(2)
}

let root = win32.resolve(String(argv.root)).replace(/\//g, '\\')
if (root.length > 3 && root.endsWith('\\')) root = root.slice(0, -1)

const pool = Number(process.env.UV_THREADPOOL_SIZE ?? 4)
if (pool < concurrency) {
  console.error(`smoke-real: UV_THREADPOOL_SIZE=${pool}(default 4) < concurrency=${concurrency}；libuv 池启动后不可扩，真实并行度按池大小封顶。`)
}
console.error(`smoke-real: READ-ONLY scan of ${root} (concurrency=${concurrency}, minFiles=${minFiles})`)

const t0 = Date.now()
let last = 0
let events = 0
let peakRss = 0
const sc = new Scanner({ fs: nodeFs, concurrency, progressIntervalMs: 1000, maxFiles: 3_000_000, maxDepth: 64 })
const snap = await sc.start(root, (e) => {
  events++
  const now = Date.now()
  if (e.kind !== 'progress' || now - last < 2000) return
  last = now
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  process.stderr.write(
    `\r${snap0(e.snapshot)}   `
  )
})
process.stderr.write('\n')

function snap0(s) {
  return `${s.files} files  ${s.dirs} dirs  ${Math.round(s.totalBytes / 1073741824)} GB  ${String(s.currentPath).slice(0, 60)}`
}

/**
 * v0.1：真实盘这一跑必须产出**和 app 同一份 schema** 的报告 —— 否则脚本一套格式、
 * app 另一套格式，"标准化"就只剩名字。harness 专属的数（事件条数、线程池大小）
 * 不进 schema，只打到 stderr。
 */
const { buildScanReport, SCAN_REPORT_SCHEMA } = await import('../core/report/scan-report.ts')
const { writeFileSync } = await import('node:fs')

const report = buildScanReport({
  snapshot: snap,
  source: sc.store,
  topFiles: sc.topRaw().slice(0, 50),
  appVersion: '0.1.0-smoke',
  nowMs: Date.now(),
  peakRssBytes: Math.max(peakRss, process.memoryUsage().rss)
})
const result = { ...report, harness: { progressEvents: events, uvThreadPoolSize: pool, concurrency, wallSec: Math.round((Date.now() - t0) / 1000) } }
if (argv.out && argv.out !== true) {
  writeFileSync(String(argv.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stderr.write(`\n报告已写出：${argv.out}\n`)
}
process.stdout.write(JSON.stringify(result) + '\n')

let failed = false
if (result.schema !== SCAN_REPORT_SCHEMA) {
  console.error(`FAIL: schema 版本不对 (${result.schema})`)
  failed = true
}
if (result.scan.counters.files !== snap.files || result.scan.counters.totalBytes !== snap.totalBytes) {
  console.error('FAIL: 报告计数与快照不一致 —— 导出的不是同一次扫描')
  failed = true
}
if (snap.status !== 'completed') {
  console.error(`FAIL: status=${snap.status}（§8 要求权限错误只能记录+跳过，不得让整次扫描失败）`)
  failed = true
}
if (snap.files < minFiles) {
  console.error(`FAIL: 文件数 ${snap.files} < 门槛 ${minFiles}，可能权限或路径处理有问题（小目录冒烟请用 --min-files=1）`)
  failed = true
}
if (snap.denied === 0) {
  console.error('WARN: 真实系统盘通常不可能零权限错误（夹具/自有目录才会）。检查错误分类是否被吞掉。')
}
if (failed) process.exit(1)
console.error(
  `真实盘扫描通过：净 ${Math.round(result.scan.elapsedMs / 1000)}s / 墙钟 ${result.harness.wallSec}s · ` +
    `${result.scan.speed.filesPerSec} files/s · 峰值 RSS ${Math.round((result.scan.peakRssBytes ?? 0) / 1048576)} MB`
)
