/**
 * 地图层规模基准（§16 / 验收第 11 条）。
 *
 * 用法：
 *   npx vite-node scripts/bench-map.mjs --root=D:/deepclean-fixture/fat-1m --yes
 *
 * 测的是**数据与布局**这条链，不含 Electron 渲染（那部分由 --shot 里的 performance.now 补）：
 *   1. 扫描：files/dirs/bytes、净耗时、peak RSS + **整条 RSS 曲线**（每 500ms 采一次）
 *   2. 根层 levelOf：一次取根节点的子页
 *   3. 肥层 levelOf：FatDir（N 个直属文件）—— 这是最坏单层
 *   4. payloadBytes：JSON.stringify(ChildrenPayload).length，即这条 IPC 消息的真实体积
 *   5. toTilesMs：1200 项在 1000×700 盒子里 squarify + 上色
 *   6. switchMs：根 ↔ FatDir 来回 10 次的均值（"大目录进入速度可接受"的量化）
 *   7. childrenOfMs：同一层的**完整口径**（全量 ChildView + 排序）单列出来，
 *      用来判定 Task 10b 那条「levelOf 超标是排序造成的」假设到底成不成立。
 *
 * 安全阀：--yes 必须有；--root 必须落在 D:/deepclean-fixture 之下（只读，但参数打错很便宜）。
 * 内存阀：--max-rss-mb（默认 2600）到线即 cancel 扫描并如实记 `scanStatus=cancelled-at-rss-guard`。
 *   为什么要有：本机实测空闲内存 1.5 GB，而扫描层按 2,062 B/文件外推 1M 要 ~2.7 GB，
 *   不放阀就会把整机拖进 swap 死循环，拿不到任何可用读数（那是把「未达成」写成「跑挂了」）。
 *   越线**是结论不是失败**：曲线 + 越线时的 files 都落盘。
 */
import { win32 } from 'node:path'

const argvRaw = process.argv.slice(2)
const argv = {}
for (const a of argvRaw) {
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  const k = a.slice(2, eq < 0 ? undefined : eq).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  argv[k] = eq < 0 ? true : a.slice(eq + 1)
}
if (!argv.yes) {
  console.error('bench-map: 需要 --yes（会读真实磁盘上的夹具目录）')
  process.exit(2)
}
const root = String(argv.root ?? '')
if (!/^D:\\deepclean-fixture\\/i.test(root.replace(/\//g, '\\'))) {
  console.error(`bench-map: --root 必须是 D:\\deepclean-fixture\\ 下的夹具，收到 ${root}`)
  process.exit(3)
}
const maxRssMb = Number(argv.maxRssMb ?? 2600)
const maxScanSec = Number(argv.maxScanSec ?? 900)
const curvePath = String(argv.curve ?? '')

const { Scanner } = await import('../core/scan/scanner.ts')
const { nodeFs } = await import('../core/fs/fslike.ts')
const { toTiles } = await import('../core/analyze/treemap-data.ts')
const { LEVEL_CAP } = await import('../shared/constants.ts')

const box = { x: 0, y: 0, w: 1000, h: 700 }
let peakRss = 0
const rss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
}

/** RSS 曲线：{ tSec, files, rssMB } —— 「越线在哪一格」只能靠这条曲线回答，peak 单个数不够。 */
const curve = []
const scanStart = Date.now()
let guardTripped = false
let deadlineTripped = false
const sample = () => {
  const r = process.memoryUsage().rss
  peakRss = Math.max(peakRss, r)
  curve.push({
    tSec: Number(((Date.now() - scanStart) / 1000).toFixed(1)),
    files: sc.store.stats().files,
    rssMB: Math.round(r / 1048576)
  })
  if (!guardTripped && r / 1048576 > maxRssMb) {
    guardTripped = true
    sc.cancel()
    console.error(`bench-map: RSS 越线 ${Math.round(r / 1048576)}MB > ${maxRssMb}MB（${curve.at(-1).files} 文件 / ${((Date.now() - scanStart) / 1000).toFixed(0)}s）→ 取消扫描`)
  }
  // 墙钟阀：内存没越线但已经慢到不像能跑完（swap 抖动）时，把「挂死」换成一条有读数的结论
  const elapsedSec = (Date.now() - scanStart) / 1000
  if (!deadlineTripped && elapsedSec > maxScanSec) {
    deadlineTripped = true
    sc.cancel()
    console.error(`bench-map: 扫描墙钟 ${elapsedSec.toFixed(0)}s > ${maxScanSec}s（${curve.at(-1).files} 文件 / RSS ${Math.round(r / 1048576)}MB）→ 取消扫描`)
  }
}

const sc = new Scanner({ fs: nodeFs, concurrency: 16, progressIntervalMs: 1000, maxFiles: 3_000_000, maxDepth: 64 })
const sampler = setInterval(sample, 500)
const t0 = Date.now()
const snap = await sc.start(root, (e) => {
  if (e.kind === 'progress') rss()
})
clearInterval(sampler)
const scanSec = (Date.now() - t0) / 1000
sample()
const scanStatus = guardTripped
  ? 'cancelled-at-rss-guard'
  : deadlineTripped
    ? 'cancelled-at-wallclock-guard'
    : snap.status
if (scanStatus !== 'completed') {
  console.error(`bench-map: 扫描未正常结束（status=${scanStatus}），地图层的数只在**已入树的那部分**上成立，逐字标注`)
}

const timed = (f) => {
  const a = process.hrtime.bigint()
  const out = f()
  return [Number(process.hrtime.bigint() - a) / 1e6, out]
}
/** 中位数：本机「同一份数据两轮差 26%」是记录在案的事实，单次读数不可信，取 5 次的中位数当稳态值。 */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const [rootPageMs, rootPage] = timed(() => sc.children(-1))
/** FatDir 的 id 从**根层页本身**取（不拼路径）：路径口径被 win32/POSIX 混写坑过一次，用 API 给的 id 最硬。 */
const fatEntry = rootPage.children.find((c) => c.kind === 'directory' && c.name === 'FatDir')
const fatId = fatEntry?.dirId
let fatPageMs = null
let fatPageColdMs = null
let fatChildren = 0
let payloadBytes = 0
let toTilesMs = null
let toTilesColdMs = null
let switchMs = null
let childrenOfMs = null
let childrenOfColdMs = null
let serializeMs = null
// Task 10b 的同解判据（fatId 缺席时保持 null，判读时一眼看得出没测到）
let pageSameAsSlowPath = null
let pageSha256 = null
let slowPageSha256 = null
let foldedBytesFast = null
let foldedBytesSlow = null
if (fatId !== undefined) {
  const [ms, page] = timed(() => sc.children(fatId))
  fatPageColdMs = ms
  fatChildren = page.children.length
  const [sm, json] = timed(() => JSON.stringify(page))
  serializeMs = sm
  payloadBytes = json.length

  const layout = () =>
    toTiles(page.children, box, 'type', {
      foldedCount: page.foldedCount,
      foldedBytes: page.foldedBytes,
      parentSize: page.size,
      rootSize: page.rootSize
    })
  const [coldTiles] = timed(layout)
  toTilesColdMs = coldTiles
  const tileRuns = [coldTiles]
  for (let i = 0; i < 4; i++) tileRuns.push(timed(layout)[0])
  toTilesMs = median(tileRuns)

  const pageRuns = [ms]
  for (let i = 0; i < 4; i++) pageRuns.push(timed(() => sc.children(fatId))[0])
  fatPageMs = median(pageRuns)

  // 完整口径（视图 cap 之前那一步）单独计时 —— 10b 的候选瓶颈就在这。
  // 冷跑一次就超过 500ms 时只再跑 1 次：1M 档一层 30 万项，5 次全量 ChildView 分配会把
  // 本机仅剩的 1.5GB 内存换成 swap 抖动，那样连"该不该做 10b"都测不准。
  const coRuns = [timed(() => sc.store.childrenOf(fatId).length)[0]]
  const extra = coRuns[0] < 500 ? 4 : 1
  for (let i = 0; i < extra; i++) coRuns.push(timed(() => sc.store.childrenOf(fatId).length)[0])
  childrenOfColdMs = coRuns[0]
  childrenOfMs = median(coRuns)

  // --- Task 10b：有界选择的**同解**判据（真实规模，不是夹具之外的合成形状） ---
  // 参照实现 = 10b 之前的 `levelOf` 本体：完整 `childrenOf` + filter + 稳定排序 + slice。
  // 与快路径回的那一页比 JSON 文本（不是比长度）：文本相同 ⟹ IPC 载荷、tile 划分、
  // foldedCount/foldedBytes 那四份账、以及 1,200 项的**先后顺序**全部相同。
  // 这一条与 unit 的等价用例分工不同：单测管形状，这里管"30 万项、997 档同分"那一层真实边界。
  const { createHash } = await import('node:crypto')
  const slowAll = sc.store.childrenOf(fatId) // 本轮 bench 没有视图排除 → kept === all
  const slowCut = LEVEL_CAP >= 0 && slowAll.length > LEVEL_CAP ? LEVEL_CAP : slowAll.length
  const slowRest = slowAll.slice(slowCut)
  const slowPage = {
    children: slowAll.slice(0, slowCut),
    totalChildren: slowAll.length,
    foldedCount: slowRest.length,
    foldedBytes: slowRest.reduce((s, c) => s + c.size, 0),
    excludedCount: 0,
    excludedBytes: 0
  }
  const fastPage = sc.store.levelOf(fatId, LEVEL_CAP)
  const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16)
  pageSameAsSlowPath = sha(fastPage) === sha(slowPage)
  pageSha256 = sha(fastPage)
  slowPageSha256 = sha(slowPage)
  foldedBytesSlow = slowPage.foldedBytes
  foldedBytesFast = fastPage.foldedBytes
  if (!pageSameAsSlowPath)
    console.error(
      `bench-map: ⚠ 有界选择与全量排序**不同解** fast=${JSON.stringify({ ...fastPage, children: fastPage.children.length })} slow=${JSON.stringify({ ...slowPage, children: slowPage.children.length })}`
    )

  const sw = []
  for (let i = 0; i < 10; i++) {
    const [a] = timed(() => sc.children(fatId))
    const [b] = timed(() => sc.children(-1))
    sw.push(a + b)
  }
  switchMs = sw.reduce((s, x) => s + x, 0) / sw.length
}

const result = {
  root,
  scale: snap.files,
  files: snap.files,
  dirs: snap.dirs,
  bytes: snap.totalBytes,
  scanSec: Number(scanSec.toFixed(1)),
  scanStatus,
  rssMB: Math.round(peakRss / 1048576),
  rssGuardMb: maxRssMb,
  rssGuardTripped: guardTripped,
  scanDeadlineSec: maxScanSec,
  deadlineTripped,
  levelCap: LEVEL_CAP,
  rootPageMs: Number(rootPageMs.toFixed(1)),
  fatPageColdMs: fatPageColdMs === null ? null : Number(fatPageColdMs.toFixed(1)),
  fatPageMs: fatPageMs === null ? null : Number(fatPageMs.toFixed(1)),
  fatChildren,
  payloadBytes,
  payloadKB: Math.round(payloadBytes / 1024),
  serializeMs: serializeMs === null ? null : Number(serializeMs.toFixed(1)),
  childrenOfColdMs: childrenOfColdMs === null ? null : Number(childrenOfColdMs.toFixed(1)),
  childrenOfMs: childrenOfMs === null ? null : Number(childrenOfMs.toFixed(1)),
  toTilesColdMs: toTilesColdMs === null ? null : Number(toTilesColdMs.toFixed(1)),
  toTilesMs: toTilesMs === null ? null : Number(toTilesMs.toFixed(1)),
  switchMs: switchMs === null ? null : Number(switchMs.toFixed(1)),
  pageSameAsSlowPath,
  pageSha256,
  slowPageSha256,
  foldedBytesFast,
  foldedBytesSlow,
  skipped: snap.skipped,
  truncated: snap.truncated,
  heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  curvePoints: curve.length
}
if (curvePath) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(win32.resolve(curvePath), curve.map((c) => JSON.stringify(c)).join('\n') + '\n')
}
process.stdout.write(`${JSON.stringify(result)}\n`)
console.error(
  `bench-map: ${result.scale} 文件 · 肥层 ${result.fatChildren} 项 / payload ${result.payloadKB} KB · ` +
    `levelOf ${result.fatPageMs}ms (childrenOf ${result.childrenOfMs}ms) · toTiles ${result.toTilesMs}ms · ` +
    `switch ${result.switchMs}ms · 同解=${result.pageSameAsSlowPath ? '逐字节相同' : result.pageSameAsSlowPath === false ? '❌不同解' : '未测'} · ` +
    `RSS ${result.rssMB}MB${result.rssGuardTripped ? ' (越线取消)' : ''} · status=${result.scanStatus}`
)
