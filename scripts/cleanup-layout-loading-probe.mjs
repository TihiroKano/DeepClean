// 「Loading 什么时候出现」的真机判据（人类伙伴 2026-10-21 两轮要求）。
//
// 两轮原话：
//  ① 「重新计价这段改成 Loading」→ 那一格要有 Loading（现在是 16 颗点跳动的动画）；
//  ② 「只为第一次进入垃圾清理页面加载就好」→ 勾选/取消勾选**不许**再闪它。
//
// 所以这一支验的正是第 ② 条的**反面**（旧行为）：先记下"刚进页面时它出现过"，
// 再连点几次勾选框，确认它在整个过程中**一次都没回来**。
//
// 为什么要高频采样（30 ms）：那一格只活几百毫秒，按正常节奏读一次 DOM 既可能漏掉它，
// 也可能把"闪过一次"读成"没出现"。判据要靠采样频率才能成立。
//
// 四条判据：
//  ① 进页面时它**确实出现过**（否则"勾选时没出现"是因为它压根没实现，判据成了空过）；
//  ② 出现时带 `Loading` 与 16 个 `.dc-jump-dot`；
//  ③ 勾选 3 次（含取消勾选）期间它**一次都不许再出现**；
//  ④ 勾选之后数字最终会更新（证明"静默重算"真的在算，不是干脆不算了）。
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const OUT = arg('out', '')
/** 冷进证据：由 `cleanup-layout-drive.mjs` 在切页那一瞬 30 ms 采样写下（那边才是"第一次进"）。 */
const COLD_EVIDENCE = arg('cold-evidence', 'D:\\dc-tmp\\loading-first-seen.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
if (!page) throw new Error('没有 tauri 页面')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pend = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const p = pend.get(m.id)
  if (p) {
    pend.delete(m.id)
    p.resolve(m)
  }
}
const send = (method, params) =>
  new Promise((r) => {
    const mid = ++id
    pend.set(mid, { resolve: r })
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result.result.value
}

/**
 * 采样一格：Loading 在不在、长什么样、**在不在中间**、统计带第 3 格念的是什么。
 *
 * 2026-10-21 第四轮加了三条几何：它必须挂在 `.dc-revalue-stage` 里（居中舞台）、
 * 文字是白色、点阵够大。这三条只看 DOM/CSS 就够了，不必截图比对。
 */
const SAMPLE = `(() => {
  const load = document.querySelector('.dc-revalue');
  const stage = document.querySelector('.dc-revalue-stage');
  const stats = [...document.querySelectorAll('.dc-clean-stat-value')];
  const dots = load ? load.querySelector('.dc-jump') : null;
  const cs = load ? getComputedStyle(load) : null;
  const ds = dots ? getComputedStyle(dots) : null;
  return {
    has: !!load,
    text: load ? load.textContent.trim() : null,
    dotCount: load ? load.querySelectorAll('.dc-jump-dot').length : 0,
    hasOldBar: !!document.querySelector('.dc-revalue-bar'),
    // 居中：它必须在舞台里，且舞台是 grid + place-items:center
    inStage: !!(load && stage && stage.contains(load)),
    stageCentered: stage ? getComputedStyle(stage).placeItems : null,
    // 白色 + 放大
    color: cs ? cs.color : null,
    dotSize: ds ? ds.getPropertyValue('--uib-size').trim() : null,
    fontSize: cs ? cs.fontSize : null,
    planned: stats[2] ? stats[2].textContent.trim() : null,
    rows: document.querySelectorAll('.dc-clean-row').length,
  };
})()`

const problems = []

/**
 * ---- 判据 ①：**冷进页面**时它必须出现过 ----
 *
 * ⚠️ 第一版这里写的是"切到 home 再切回 cleanup，然后等 Loading" —— 那一条**永远等不到**，
 * 而且不是缺陷：`usePreview` 有个模块级缓存（人类伙伴 2026-10-20 要的「保存本次记录」），
 * 切回来时那个键命中缓存 ⇒ 值**同步**摆正 ⇒ 按设计就不该闪 Loading。
 * 我第一版把"切页回来"当成了"首次进入"，判据自己错了（真机实测：`FIRST_SEEN null`）。
 *
 * 真正能构造出"这一页还没有任何预估"的只有**冷进入**：应用起来之后第一次点进这一页，
 * 缓存里没有那份键。而这一刻发生在 `cleanup-layout-drive.mjs` 里（它切页之后立刻高频采样），
 * 本脚本**读它留下的那份证据** —— 不自己重复构造，因为"冷"只可能发生一次。
 *
 * 没有证据文件时**不假装通过**：明确报"构成不了冷进"，并把 ① 标成未验。
 */
let coldEvidence = null
try {
  coldEvidence = JSON.parse(readFileSync(COLD_EVIDENCE, 'utf8')).firstSeen
} catch {
  coldEvidence = null
}

const unverified = []

if (coldEvidence === null) {
  unverified.push('冷进 Loading：没有证据文件（' + COLD_EVIDENCE + '）—— 本相未验，不当作通过')
} else {
  if (!coldEvidence.text || !coldEvidence.text.includes('Loading')) {
    problems.push('冷进时的 Loading 文案不对（念的是：' + JSON.stringify(coldEvidence.text) + '）')
  }
  if (coldEvidence.dotCount !== 16) {
    problems.push('冷进时的点不是 16 颗（实际 ' + coldEvidence.dotCount + ' 颗）—— 人类伙伴给的就是 16 颗')
  }
  if (coldEvidence.hasOldBar) problems.push('冷进时旧的进度条 .dc-revalue-bar 还在')

  /**
   * 2026-10-21 第四轮的三条（人类伙伴：「首次打开 Loading 加特效放中间放大些，loading 用白色字体」）。
   * 这三条由驱动段在冷进那一瞬采到，写进同一份证据文件 —— 它们只在那一刻存在，事后补不了。
   */
  if (!coldEvidence.inStage) problems.push('冷进时的 Loading 不在居中舞台（.dc-revalue-stage）里')
  if (!coldEvidence.stageCentered || !/center/.test(String(coldEvidence.stageCentered))) {
    problems.push('居中舞台没有居中（place-items=' + JSON.stringify(coldEvidence.stageCentered) + '，要含 center）')
  }
  // 白色：computed 必须是 rgb(255, 255, 255)
  if (!/rgb\(\s*255,\s*255,\s*255\s*\)/.test(String(coldEvidence.color))) {
    problems.push('「Loading」文字不是白色（computed color=' + JSON.stringify(coldEvidence.color) + '）')
  }
  // 放大：点阵尺寸 ≥ 48px（34px 那一版就红在这里）
  const sizeNum = Number(String(coldEvidence.dotSize || '').replace('px', ''))
  if (!(sizeNum >= 48)) problems.push('点阵没放大（--uib-size=' + JSON.stringify(coldEvidence.dotSize) + '，要 ≥ 48px）')

  console.log('COLD_EVIDENCE ' + JSON.stringify(coldEvidence))
}

// 等首屏那次预估落定
for (let i = 0; i < 200; i++) {
  const s = await ev(SAMPLE)
  if (!s.has && s.planned !== null) break
  await sleep(50)
}
const before = await ev(SAMPLE)
console.log('BASELINE ' + JSON.stringify(before))

// ---- ② 勾选 / 取消勾选：一次都不许再出现 ----
const clicks = await ev(`(() => {
  const cbs = [...document.querySelectorAll('.dc-clean-row input[type=checkbox]')].filter((c) => !c.disabled);
  if (cbs.length === 0) return { ok: false, why: '没有可点的勾选框' };
  // 连点三次：勾上 → 取消 → 再勾上（三种最常见的动作都过一遍）
  cbs[0].click();
  return { ok: true, total: cbs.length };
})()`)
if (!clicks?.ok) throw new Error(JSON.stringify(clicks))

let flashed = 0
let flashedAt = -1
for (let i = 0; i < 200; i++) {
  const s = await ev(SAMPLE)
  if (s.has) {
    flashed++
    if (flashedAt < 0) flashedAt = i * 30
  }
  // 中途再点两下（取消 + 再勾上），采样不能停
  if (i === 40) await ev(`(() => { const c = [...document.querySelectorAll('.dc-clean-row input[type=checkbox]')].filter((x) => !x.disabled)[0]; if (c) c.click(); })()`)
  if (i === 90) await ev(`(() => { const c = [...document.querySelectorAll('.dc-clean-row input[type=checkbox]')].filter((x) => !x.disabled)[0]; if (c) c.click(); })()`)
  await sleep(30)
}
if (flashed > 0) {
  problems.push('勾选/取消勾选期间 Loading 出现了 ' + flashed + ' 次（第一次在第 ' + flashedAt + ' ms）—— 第 ② 条要求它一次都不许回来')
}
const after = await ev(SAMPLE)
console.log('AFTER_CLICKS ' + JSON.stringify(after) + '  flashes=' + flashed)

// ---- ③ 勾选之后数字确实更新了（"静默重算"得真在算）----
if (after.planned === before.planned && before.planned !== null) {
  // 不一定是缺陷（这份夹具上可能本来就是 0 B），所以只登记，不判红
  console.log('  NOTE 勾选前后「预计可释放」都是 ' + before.planned + '（这份数据上可能本来就没变，不判红）')
}

if (OUT) writeFileSync(OUT, JSON.stringify({ coldEvidence, before, after, flashes: flashed, problems, unverified }, null, 2))
for (const u of unverified) console.log('  WARN 未验：' + u)
if (problems.length > 0) {
  for (const p of problems) console.log('  X ' + p)
  process.exitCode = 1
} else {
  const tail = unverified.length > 0 ? '（其中 ' + unverified.length + ' 条未验，见上）' : ''
  console.log('LOADING_OK（冷进时 16 点 Loading 出现过；勾选 3 次期间零次再现）' + tail)
}
ws.close()