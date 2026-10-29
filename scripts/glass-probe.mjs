// Task 5 Step 2：在**真机**上量"这一页到底有没有一块玻璃"。
//
// 为什么必须真机量：判据要的是 `getComputedStyle(el).backdropFilter !== 'none'` **且面积 ≥ 视口 5%**。
// 静态 `renderToStaticMarkup` 没有布局引擎 ⇒ 既拿不到 computed style 也拿不到面积；
// 而 UIA 只能读到名字，读不到样式。所以走 WebView2 的 CDP 端口。
//
// 判据口径（2026-10-17 用户裁定「骨架统一一层就够」之后定稿）：
//   一页达标 = DOM 里存在至少一个 `backdropFilter !== 'none'` 且面积 ≥ 视口 5% 的元素，
//   **骨架层那一块（`dc-side`）计入**。
//   裁定之前这里的读法是"要有一块**内容**玻璃"，那个口径下量出来是 8 页里 6 页只剩骨架 ——
//   两种读法的数都记在 `docs/acceptance/2026-10-17-tauri-m6-b-pages.md` §二，别只留一句结论。
//   这条判据仍然不许退化成"页面级 grep 类名"：那量的是源码可达，不是画面上占不占地方。
//
// 端口不是产品开的：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`
// 由**启动环境**注入（WebView2 运行时自己认它），shipped 二进制里没有为验收留的任何后门
// （与 `DC_ENV_ROOT` 那批 dev-only 口子同一纪律）。
//
// 用法（应用已经带着端口起来了）：
//   node scripts/glass-probe.mjs --port 9223 --out docs/acceptance/assets/m6b-glass.json
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i > -1 ? argv[i + 1] : dflt
}
const PORT = Number(arg('port', '9223'))
const OUT = arg('out', '')

// 八页的导航文字，从 App.tsx 的 NAV 表抄；这里用**人眼能核的中文**，比对靠 textContent 逐字相等。
const VIEWS = ['首页', '空间地图', '大文件', '垃圾清理', '重复文件', '开发环境', '清理记录', '设置']

const MEASURE = (view) => `(async () => {
  const want = ${JSON.stringify(view)};
  const navs = [...document.querySelectorAll('button, a, [role=button], div')].filter(
    (e) => e.textContent.trim() === want && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 400);
  if (navs.length === 0) return { view: want, error: 'nav-not-found' };
  navs[0].click();
  await new Promise((r) => setTimeout(r, 1200));
  const vw = innerWidth * innerHeight;
  const clip = (r) => {
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  };
  let n = 0, best = 0; const big = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (!bf || bf === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    n++;
    const ratio = clip(r) / vw;
    if (ratio > best) best = ratio;
    if (ratio >= 0.05) big.push((el.className || el.tagName) + ' @' + (ratio * 100).toFixed(1) + '%');
  }
  return { view: want, glassEls: n, maxRatio: +best.toFixed(4), big: [...new Set(big)].slice(0, 8), hasQualified: big.length > 0 };
})()`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
  if (!page) throw new Error(`CDP 列表里没有 tauri 页面（拿到 ${list.length} 个 target：${list.map((t) => t.url).join(', ')}）`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); p.resolve(msg) }
  }
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, { resolve })
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.error) throw new Error(JSON.stringify(r.error))
    if (r.result && r.result.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails))
    return r.result.result.value
  }

  const rows = []
  for (const v of VIEWS) {
    const row = await evaluate(MEASURE(v))
    rows.push(row)
    console.log(`GLASS ${v.padEnd(5)} glassEls=${String(row.glassEls ?? '-').padStart(3)} maxRatio=${row.maxRatio ?? '-'} qualified=${row.hasQualified ?? '-'}${row.error ? ' ERROR=' + row.error : ''}`)
    if (row.big && row.big.length) for (const b of row.big) console.log(`      ${b}`)
  }
  ws.close()

  const missing = rows.filter((r) => !r.hasQualified).map((r) => r.view)
  console.log(`SUMMARY pages=${rows.length} qualified=${rows.length - missing.length} missing=[${missing.join(',')}]`)
  if (missing.length === rows.length) {
    // 全空 = 量具坏了（要么端口没开对页面、要么选择器没命中），不是"八页都没玻璃"。
    throw new Error('八页全部量到 0 块合格玻璃 —— 先怀疑量具，别下结论')
  }
  if (OUT) {
    // 绝对路径就照它写，别拿去和仓库根拼（第一版把 D:\dc-tmp\... 拼成了 D:\DeepClean\D:\dc-tmp\...）。
    writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), viewport: 'css-px', rows }, null, 2))
    console.log('WROTE ' + OUT)
  }
}
await main()
