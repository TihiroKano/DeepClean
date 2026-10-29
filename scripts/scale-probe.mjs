// Task 4：量「这一页在这个宽度下有没有被撑出横向滚动」。
// 与 glass-probe 同一套通道（WebView2 CDP，端口由启动环境注入，产品里没有为验收留后门）。
//
// 为什么必须量而不是看：判据 ① 是 `document.scrollWidth > innerWidth`，这是一个数；
// 肉眼看截图只能发现"溢出的那一格里有东西被切掉"，而 flex 子项 `min-width:auto` 那个老坑
// 撑出来的常常是**空白**（表格把根推宽，右边多出一段没内容的可滚动区），截图上看着一切正常。
//
// 两件事要分开报，否则会被误读成一件事：
//   窗口物理宽（MoveWindow 给的那个）与 CSS 视口宽（innerWidth）在 150% 缩放下差 1.5 倍 ——
//   CSS 里若出现 `@media (max-width: 900px)`，比的是**后者**。本轮实测两份样式表里 `@media` 计数为 0，
//   所以窄窗行为完全由 flex / table-layout 撑着，没有断点可依赖（这本身是条要登记的缺口）。
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d }
const PORT = Number(arg('port', '9223'))
const OUT = arg('out', '')
const PHYS = Number(arg('physical', '0'))

const VIEWS = ['首页', '空间地图', '大文件', '垃圾清理', '重复文件', '开发环境', '清理记录', '设置']
const END_VIEW = arg('endview', '')   // 量完之后停在某一页，好让调用方在那一页上拍图（表格页最容易溢出）

const PROBE = (view) => `(async () => {
  const want = ${JSON.stringify(view)};
  const navs = [...document.querySelectorAll('button, a, [role=button], div')].filter(
    (e) => e.textContent.trim() === want && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 400);
  if (navs.length === 0) return { view: want, error: 'nav-not-found' };
  navs[0].click();
  await new Promise((r) => setTimeout(r, 1100));
  const de = document.documentElement;
  const innerW = innerWidth, scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
  let worst = null;
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right > innerW + 1.5 && r.width > 24) {
      if (!worst || r.right - innerW > worst.overPx) {
        // 越过右缘有两种，**只有一种是缺陷**：
        //   (a) 祖先里有横向滚动容器（overflow-x: auto/scroll 且真的可滚）⇒ 内容只是要滚才看得到；
        //   (b) 没有 ⇒ 被裁掉了，用户无论怎么滚都看不到那一截。
        // 本文件第一版只量 document.scrollWidth，于是 (b) 会伪装成"没溢出"（根不滚，因为被 overflow:hidden 吃了）。
        let reachable = false, via = null;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) {
            reachable = true; via = a.tagName.toLowerCase() + '.' + String(a.className).slice(0, 40);
            break;
          }
        }
        worst = {
          tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 60),
          overPx: +(r.right - innerW).toFixed(1), w: +r.width.toFixed(1), reachable, via,
        };
      }
    }
  }
  const primaryEl = document.querySelector('.dc-map-canvas');
  // 第四轴（2026-10-17 全站隐藏滚动条之后加的）：**没有为滚动条预留布局空间，且滚动仍然可用**。
  // ⚠️ 这一轴**不能**被读成"证明滚动条看不见"。本机实测：WebView2(Edg/155) 用**覆盖式滚动条**，
  //    一个 220×150、内容 900×900、overflow:scroll 的盒子，在**删掉我们那条隐藏规则之后**
  //    offsetWidth-clientWidth 仍然是 0 —— 布局口径下它本来就不占地方。
  //    又用真滚轮事件（Input.dispatchMouseEvent 的 mouseWheel，scrollTop 确实走到 360）在滚动瞬间
  //    截同一块区域，加规则/删规则两张图**逐字节相同** ⇒ 这台机器上根本拍不出"一条可见的滚动条"，
  //    所以这条轴只声明它能声明的：**布局没被条吃掉 + 程序化滚动有效**。
  //    （写在这里的说明不许用反引号：整段判据是一个模板字符串，反引号会当场把它截断 —— 第一版就这么挂的。）
  // 为什么两半都要：只查布局会得到"条藏了但整页滚不动"那种绿；只查滚动则看不见布局回归。
  const de2 = document.documentElement;
  let scrollables = 0, barTaken = 0, victim = null;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const canX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    const canY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    if (!canX && !canY) continue;
    scrollables++;
    const takenX = el.offsetWidth - el.clientWidth;
    const takenY = el.offsetHeight - el.clientHeight;
    if (takenX > 1 || takenY > 1) barTaken++;
    if (!victim) victim = { el, canX, canY };
  }
  let scrolled = null;
  if (victim) {
    const { el, canX, canY } = victim;
    if (canX) { el.scrollLeft = 0; el.scrollLeft = 80; }
    if (canY) { el.scrollTop = 0; el.scrollTop = 80; }
    await new Promise((r) => setTimeout(r, 120));
    scrolled = { x: el.scrollLeft, y: el.scrollTop };
    el.scrollLeft = 0; el.scrollTop = 0;
  }
  return { view: want, innerW, scrollW, overflowPx: +(scrollW - innerW).toFixed(1), worst, dpr: devicePixelRatio,
    docBarWidth: innerW - de2.clientWidth, scrollables, barTaken,
    scrolled: scrolled ? (scrolled.x > 1 || scrolled.y > 1) : 'no-scrollable-here',
    // 第三轴：**主内容不能被挤成 0**。这一格是定点判据，不是通用规则 —— 它只认地图页那块画布，
    // 因为只有它有"页面存在的理由就是这块画"的属性。把它推广成"任意页最宽元素 ≥ X%"会绿得毫无意义
    // （窄窗下最宽的永远是那根撑满的容器）。前两条轴都绿过而画布宽 0，就是这条存在的理由。
    mapCanvasW: primaryEl ? +primaryEl.getBoundingClientRect().width.toFixed(1) : null };
})()`

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
  if (!page) throw new Error('CDP 列表里没有 tauri 页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p.resolve(m) } }
  const send = (method, params) => new Promise((resolve2) => { const mid = ++id; pending.set(mid, { resolve: resolve2 }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })) })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 200))
    return r.result.result.value
  }

  const rows = []
  for (const v of VIEWS) {
    const r = await evaluate(PROBE(v))
    rows.push({ physicalWindowWidth: PHYS || null, ...r })
    if (r.error) { console.log(`SCALE ${PHYS} ${v} ERROR=${r.error}`); continue }
    console.log(`SCALE phys=${PHYS} cssViewport=${r.innerW} dpr=${r.dpr} ${v.padEnd(5)} scrollW=${r.scrollW} overflowPx=${r.overflowPx} 可滚元素=${r.scrollables} 被条占布局=${r.barTaken} 程序化滚=${r.scrolled}` +
      (r.worst ? ` 越右缘=<${r.worst.tag} class="${r.worst.cls}"> 宽${r.worst.w} 超出${r.worst.overPx}px ` +
        (r.worst.reachable ? `可滚到(经 ${r.worst.via})` : '裁掉且滚不到') : ''))
  }
  if (END_VIEW) { await evaluate(PROBE(END_VIEW)) }
  ws.close()
  const bad = rows.filter((r) => r.overflowPx > 1)
  console.log(`SCALE_SUMMARY phys=${PHYS} pages=${rows.length} overflowing=${bad.length} [${bad.map((b) => b.view + '+' + b.overflowPx).join(', ')}]`)
  if (OUT) {
    let prev = []
    if (existsSync(resolve(OUT))) {
      try { prev = JSON.parse(readFileSync(resolve(OUT), 'utf8')).rows || [] } catch { prev = [] }
    }
    writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), rows: [...prev, ...rows] }, null, 2))
    console.log('APPENDED ' + OUT)
  }
}
await main()
