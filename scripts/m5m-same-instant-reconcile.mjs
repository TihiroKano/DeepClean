/**
 * M5-M 的「同刻背靠背对账」—— 补 M1/M2 就登记的那笔欠账。
 *
 * 欠账的原形：Rust 内核与旧实现（`core/scan`，Electron 那套一直在跑的 TS 扫描器）
 * 从没在**同一时刻**比过。M1/M2 各自都跟独立口径对过账，但那是"两次相邻运行"，
 * 而活盘在动 —— M5-J 现场又撞见一次：同一棵树相邻两遍差出 125,125 vs 120,640。
 * 那种差异既不能算口径差也不能算缺陷，只能算**没量成**。
 *
 * 所以这里的形状是 **Rust → TS → Rust**，三趟背靠背：
 *   ① 两次 Rust 必须逐字相等 —— 不等就是这棵树在自己动，这一轮**没有对账资格**，
 *      直接判 VOID 而不是去解释差异（这是"漂移"与"差异"唯一的分界动作）；
 *   ② Rust 与 TS 比三轴：files / dirs / bytes_logical。
 *
 * 比的字节是 `bytes_logical`（表观大小之和），**不是** `bytes_counted`（占用、硬链接去重）——
 * 后者与 TS 侧不同一件事，M5-F 就差点拿它去比出 295,788 的假差异。
 *
 * 挑的树要满足三条（不然第三方的对照会静默少算，见下）：没有 >260 字符的路径
 * （本机 `LongPathsEnabled=0`，PowerShell 那类裸 API 走法会**悄悄漏**长路径文件）、
 * 没有 reparse point（两边对 junction 的处理不同，那是另一条已登记的口径）、
 * 以及这段时间没人写它。默认 `C:\Windows\System32\en-US`：1734 文件 / 7 目录 /
 * 最长路径 91 / 0 个 reparse。
 *
 * 用法：
 *   node scripts/m5m-same-instant-reconcile.mjs
 *   node scripts/m5m-same-instant-reconcile.mjs --dir='C:\Program Files\WindowsPowerShell\Modules'
 * 退出码：0 = 三轴全等；1 = 有差异（真差异，值得查）；2 = 这一轮作废（盘在动 / 某一趟没跑成）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const DIR = arg('dir', 'C:\\Windows\\System32\\en-US')
const REPO = win32.resolve(import.meta.dirname, '..')

if (!existsSync(DIR)) {
  console.error(`要量的树不在：${DIR} —— 这一格没跑，不许写成通过`)
  process.exit(2)
}

/** Rust 那一侧：跑 perf.rs 里那条只扫描的 `#[ignore]` 判据，从 stdout 里挑出 `M5M {...}`。
 *
 * ⚠️ **cwd 必须是 `src-tauri/`，不是仓库根** —— `src-tauri/.cargo/config.toml` 里配的是
 * crates-io 的国内镜像（rsproxy），cargo 只从**当前工作目录往上**找配置。第一版从仓库根跑，
 * 配置没吃到 ⇒ 它去默认 index 重新拉了一份依赖 ⇒ 整个 tauri 依赖树重编，
 * 还撞出一句 `only metadata stub found for rlib dependency core`。
 * 那句看着像代码错了，其实是"换了份源、半路写坏"的样子（本仓已经记过两次"磁盘/构建状态
 * 坏了会伪装成代码错误"）。
 */
function rustScan() {
  const r = spawnSync('cargo', ['test', '--bin', 'deepclean-app', 'perf::', '--', '--ignored', '--nocapture', 'scan_only'], {
    cwd: win32.join(REPO, 'src-tauri'),
    encoding: 'utf8',
    env: { ...process.env, DC_PERF_ROOT: DIR },
        maxBuffer: 64 << 20,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('M5M '))
  if (!line) {
    console.error('Rust 那一趟没吐出 M5M 行 —— 判 VOID，不许拿"可能是输出格式不同"顶过去：')
    console.error(out.split('\n').slice(-25).join('\n'))
    return null
  }
  try {
    return JSON.parse(line.slice(4))
  } catch (e) {
    console.error(`M5M 行解不开 JSON：${line} —— ${e}`)
    return null
  }
}

/** TS 那一侧：旧实现的扫描器本体（`core/scan/scanner.ts`）。
 *
 * **不用 `npx vite-node`**：这个仓的 `node_modules` 里**没有** vite-node，`npx` 会去
 * 注册表拉包 —— 本机拉不到，于是整个驱动挂在那一句上（第一版就是这么挂到超时的）。
 * 改用仓库里对账一直在用的那招：esbuild 就地打包，再拿裸 node 跑。
 * 打包失败会大声崩（`core/scan` 一旦 import electron 就会在这儿现形），不是静默跳过。
 */
function tsScan() {
  const esb = win32.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild')
  const out = win32.join(process.env.TEMP ?? win32.join(REPO, 'node_modules', '.cache'), 'm5m-bench.mjs')
  const b = spawnSync('node', [esb, win32.join(REPO, 'scripts', 'bench.mjs'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`], {
    cwd: REPO,
    encoding: 'utf8',
        maxBuffer: 32 << 20,
  })
  if (b.status !== 0) {
    console.error(`esbuild 打包 bench 失败：\n${b.stderr ?? ''}${b.stdout ?? ''}`)
    return null
  }
  const r = spawnSync('node', [out, `--dir=${DIR}`, '--repeat=1'], {
    cwd: REPO,
    encoding: 'utf8',
        maxBuffer: 64 << 20,
  })
  const line = (r.stdout ?? '').split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) {
    console.error('TS 那一趟没吐 JSON —— 判 VOID。stderr 尾巴：')
    console.error((r.stderr ?? '').split('\n').slice(-25).join('\n'))
    return null
  }
  try {
    return JSON.parse(line)
  } catch (e) {
    console.error(`bench 的 JSON 解不开：${line} —— ${e}`)
    return null
  }
}

const AXES = [
  // files / bytes：两套实现同口径，直接比。
  ['files', (a) => a.files, (b) => b.files],
  ['bytes_logical', (a) => a.bytes_logical, (b) => b.bytes],
  // dirs：**差一个根目录，且两侧各自都自洽**（不是谁数错了）：
  //   · Rust `counters.dirs` 只在"发现一个子目录"时 +1（`crates/scanner/src/scan.rs:275`），
  //     并且有 `debug_assert_eq!(counters.dirs, root.dir_count)`（同文件 216 行）兜着 —— 根不算自己。
  //   · TS `TreeStore` 在 `this.rootId = this.beginDir(rootPath)`（`core/scan/tree-store.ts:306`）
  //     那一刻就把根自己计进了 `c.dirs`（同文件 337 行）⇒ 同一棵树恒多 1。
  // 为什么不去"对齐"：M1-T5 那一格是拿 PowerShell `Get-ChildItem -Recurse -Directory`
  // （同样不含根）当独立口径验过的，Rust 与它相等；把 Rust 改成 +1 会同时弄坏那条对账
  // 和上面那个 arena 不变量，而换来的只是"两个 UI 的目录数一样"。
  // 所以这里**显式 +1 并留出处**，而不是把它算成一致替谁背书。
  ['dirs(+根)', (a) => a.dirs + 1, (b) => b.dirs],
]

const one = (tag, v) =>
  `${tag.padEnd(7)} files=${v.files} dirs=${v.dirs}${tag === 'ts' ? '' : '(+1=' + (v.dirs + 1) + ')'} bytes=${v.bytes_logical ?? v.bytes}`

const r1 = rustScan()
const t = tsScan()
const r2 = rustScan()

console.log('')
if (r1) console.log('  ' + one('rust#1', r1))
if (t) console.log('  ' + one('ts', { files: t.files, dirs: t.dirs, bytes_logical: t.bytes }))
if (r2) console.log('  ' + one('rust#2', r2))
console.log('')

const missing = [['rust#1', r1], ['ts', t], ['rust#2', r2]].filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error(`===== 判 VOID：${missing.join(' / ')} 这一趟没跑成，这一轮没有任何结论 =====`)
  console.error('   （上面每一趟失败时都单独打过原因。没跑成 ≠ 有差异，也 ≠ 通过。）')
  process.exit(2)
}

// ① 漂移闸：两次 Rust 自己先要相等
const drift = [['files', r1.files, r2.files], ['dirs', r1.dirs, r2.dirs], ['bytes_logical', r1.bytes_logical, r2.bytes_logical]]
  .filter(([, a, b]) => a !== b)
if (drift.length > 0) {
  console.error('===== 判 VOID：这棵树在自己动，不是口径问题 =====')
  for (const [k, a, b] of drift) console.error(`   ${k}: rust#1=${a} rust#2=${b}`)
  console.error('   换一棵更静的树、或换个时段再跑。**别把漂移解释成结论。**')
  process.exit(2)
}

// ② 与旧实现在同一时刻比三轴
const rows = []
let bad = 0
for (const [name, getR, getT] of AXES) {
  const rv = getR(r1)
  const tv = getT(t)
  const eq = rv === tv
  if (!eq) bad++
  rows.push(`   ${name.padEnd(13)} rust=${String(rv).padStart(12)}  ts=${String(tv).padStart(12)}  ${eq ? '相等' : `**差 ${rv - tv}**`}`)
}
console.log('三轴（rust#1 == rust#2 已成立 ⇒ 这三行是同一时刻的两套实现）：')
console.log(rows.join('\n'))
console.log('')
console.log(`   附带读数：denied=${r1.denied} skipped=${r1.skipped} depth_capped=${r1.depth_capped} deduped_hardlinks=${r1.deduped_hardlinks}  |  ts: status=${t.status} truncated=${t.truncated} denied=${t.cold?.denied} skipped=${t.cold?.skipped}`)

if (bad === 0) {
  console.log(`===== M5-M 同刻背靠背：三轴全等（${DIR}）=====`)
  process.exit(0)
}
console.log(`===== M5-M 同刻背靠背：${bad} 轴不等，要逐轴点名解释（${DIR}）=====`)
process.exit(1)
