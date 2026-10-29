// 验收图守卫：docs/acceptance 下的证据图只许是「应用窗口」，不许是整块桌面。
// 桌面里邻居家的窗口、别的会话开的文件管理器、聊天窗口都会随截图进仓 —— 图一旦提交，
// 撤回要重写 git 历史，而本仓的证据链到处互指哈希，抹历史等于换坐标系。所以拦在写入口之后、
// 提交之前这一格。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 阈值来源：本机 150% 缩放下应用窗口的 DWM 帧是 1774x1144，整屏抓取是 2160x1440。
// 1900 给别的 DPI 留余量，又足以拦住任何整屏。换机器/换 DPI 时改这一个常量。
// 这个数**故意偏严**：现网确实存在 1987px 宽的合法窗口（2026-10-17 用 GetForegroundWindow +
// DWM 帧实测），所以它会在"窗口比 1774 宽"时误报。误报在这里是安全方向 —— 闸只拦提交，
// 处置是把图重拍窄一点，或明写理由把它加进 ALLOW_LIST；同一数字若放进 Save-DcShot 的写入口
// 就会直接打断 e2e，那条已经试过并且撤了。
export const MAX_SHOT_WIDTH = 1900

export function readPngSize(path) {
  const b = readFileSync(path)
  if (b.slice(1, 4).toString() !== 'PNG') throw new Error(`不是 PNG：${path}`)
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.toLowerCase().endsWith('.png')) out.push(p)
  }
  return out
}

// 返回宽超过 limit 的图（按宽度降序）。name 一律相对 repo 根 —— ALLOW_LIST 的键和 git 里的
// 路径要能对上，而 join() 在 Windows 上吐的是绝对路径兼反斜杠，直接拿去查表永远不命中。
export function scanShots(dir, limit, root = dir) {
  const rel = (p) => relative(root, p).split(sep).join('/')
  const out = []
  for (const p of walk(dir)) {
    const { w, h } = readPngSize(p)
    if (w > limit) out.push({ name: rel(p), w, h })
  }
  return out.sort((a, b) => b.w - a.w)
}

// 白名单为空，而且应当保持为空。这里原有三条"已知历史泄露"（两张 M3-B 预览、一张 M4 无授权卡），
// 它们在 2026-10-17 的历史抹除里随 66 张 DWM 修图前的整屏截图一并从版本库去掉（见
// docs/acceptance/2026-10-17-tauri-history-scrub.md）—— 留在表里就变成一个指向日光下已不存在之物的
// 豁免口：谁再用同名文件提交一张整屏，这道闸会静默放过。
export const ALLOW_LIST = {}

export function repoRoot() {
  return join(fileURLToPath(import.meta.url), '../..')
}

/**
 * 这道闸守的目录在不在。
 *
 * ## 2026-10-29：目录可能**不存在**，那不是"通过"，是"没东西可查"
 *
 * 公开仓库只放程序相关的文件，`docs/acceptance/assets/`（93 张验收截图，97.83 MB）
 * 整个不在版本库里。于是这个目录在 CI 上不存在 —— 而原来 `walk()` 直接 `readdirSync`
 * 一个不存在的路径，抛 ENOENT，把整条 `npm test` 判红。
 *
 * **红得没道理**：这条闸要防的是"把整屏桌面截图提交进版本库"，而公开仓库里一张图都没有，
 * 它根本没有可防的对象。
 *
 * ⚠️ 这与"把断言改松"不是一回事：在**有**图的环境里（本地全量工作区）行为逐字不变，
 * `把阈值压到 100 时必须红` 那条判据仍然钉着闸真的会红。
 */
export function shotsDirExists() {
  return existsSync(join(repoRoot(), 'docs', 'acceptance'))
}

export function offenders(limit = MAX_SHOT_WIDTH) {
  const root = repoRoot()
  const dir = join(root, 'docs', 'acceptance')
  // 目录不在 ⇒ 没有可查的东西（见上面那段注释）
  if (!existsSync(dir)) return []
  return scanShots(dir, limit, root).filter((x) => !(x.name in ALLOW_LIST))
}

// 被直接调用时才走 CLI（被测试 import 时不许碰 process.exit）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const i = process.argv.indexOf('--limit')
  const limit = i > -1 ? Number(process.argv[i + 1]) : MAX_SHOT_WIDTH
  if (!shotsDirExists()) {
    // 明写「跳过」而不是冒充 OK —— 一个把"没东西可查"印成"查过且干净"的闸是假闸
    console.log(`SHOT_LEAK_SKIPPED docs/acceptance 不在本仓（公开仓只放程序相关文件）`)
    process.exit(0)
  }
  const bad = offenders(limit)
  for (const o of bad) console.log(`LEAK ${o.name} ${o.w}x${o.h}`)
  if (bad.length > 0) {
    console.log(`SHOT_LEAK_FAILED count=${bad.length} limit=${limit}`)
    process.exit(1)
  }
  console.log(`SHOT_LEAK_OK limit=${limit}`)
}
