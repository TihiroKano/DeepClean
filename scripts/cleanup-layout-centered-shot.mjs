// 冷进清理页那一刻的**居中 Loading** 截图（人类伙伴 2026-10-21 第四轮要求的效果图）。
//
// 那一格只在冷进时存在（首次进页面 → 首次回包 → 自动打勾后的第二次回包 → 消失），
// 全程几十到几百毫秒。所以做法与 `cleanup-layout-scroll-shot.mjs` 同一族：
// **由调用方在冷进那一瞬截图**，本脚本负责把那一刻"按住"。
//
// 怎么按住：切到清理页之后立刻轮询，一旦 `.dc-revalue` 出现就**不再放手**
// （每秒重设一次，让 React 的重渲染不至于把它换掉太久），并把位置报给调用方。
// 但 React 会按自己的节奏换掉它 —— 所以更可靠的做法是：**在它出现的瞬间把它的几何钉下来**，
// 然后由 PowerShell 那边用同一份 DOM 结构注入一个静止副本供截图。
//
// ⚠️ 注入的副本只用于"让人看见它长什么样"；"它何时出现、是不是居中/白色/64px"
// 已由 `cleanup-layout-loading-probe.mjs` 在**真时序**上验过（COLD_EVIDENCE 那一行）。
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const HOLD_MS = Number(arg('hold', '12000'))
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
 * 把 Loading 的**真实结构**在页面里重建一份，挂在 `.dc-clean` 的**最前面**。
 *
 * 为什么要重建而不是等真的那一个：真的那个是 React 按状态画的，它消失的时机由服务端回包决定，
 * 脚本按不住。而"长什么样"完全由 CSS 决定 —— 用同一套类名重建，视觉上逐像素相同。
 *
 * ⚠️ 两个位置细节都是实测调出来的：
 *  1. **必须插到最前面**（`prepend`）而不是末尾：`.dc-clean` 是滚动容器，末尾会被列表推下去，
 *     第一版用 `appendChild` 拍出来的图里 Loading 被列表整个盖住（截图里根本看不见它）。
 *  2. 注入时把它的高度撑到与"真实那一相"一致（那时列表还没画出来，整块内容区是空的），
 *     所以这里给它 `min-height: 420px` —— 与首次打开时 `.dc-clean` 里除了页头之外全是空的一致。
 */
const injected = await ev(`(() => {
  const host = document.querySelector('.dc-clean');
  if (!host) return { ok: false, why: '不在清理页' };
  const old = document.getElementById('dc-shot-only-stage');
  if (old) old.remove();
  const stage = document.createElement('div');
  stage.className = 'dc-revalue-stage';
  stage.id = 'dc-shot-only-stage';
  stage.style.minHeight = '420px';
  const el = document.createElement('div');
  el.className = 'dc-revalue dc-revalue-loading dc-revalue-centered';
  el.id = 'dc-shot-only-loading';
  el.setAttribute('role', 'status');
  const dots = Array.from({ length: 16 }, () => '<i class="dc-jump-dot"></i>').join('');
  el.innerHTML = '<span class="dc-jump" aria-hidden="true">' + dots + '</span>Loading';
  stage.appendChild(el);
  // prepend：放到最前面，才落在页头下方那块"首次打开时本来空着"的区域里
  host.insertBefore(stage, host.firstChild);
  const r = el.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ds = getComputedStyle(el.querySelector('.dc-jump'));
  return {
    ok: true,
    box: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), cx: +(r.left + r.width / 2).toFixed(1), top: +r.top.toFixed(1) },
    stage: { top: +sr.top.toFixed(1), h: +sr.height.toFixed(1) },
    color: cs.color, fontSize: cs.fontSize, dotSize: ds.getPropertyValue('--uib-size').trim(),
    dots: el.querySelectorAll('.dc-jump-dot').length,
  };
})()`)
console.log('INJECTED ' + JSON.stringify(injected))
if (!injected?.ok) throw new Error(JSON.stringify(injected))
await sleep(HOLD_MS)
await ev(`(() => { const e = document.getElementById('dc-shot-only-stage'); if (e) e.remove(); return true; })()`)
console.log('REMOVED')
ws.close()
