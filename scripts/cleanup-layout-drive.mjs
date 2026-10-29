// 清理页版式真机验收的**驱动段**（只做两件事：起一轮真扫描，然后进清理页）。
// 几何采样与截图交给 `cleanup-layout-probe.mjs` 与 `cleanup-layout-e2e.ps1` 各自一档跑一次。
//
// 为什么单独一支走 CDP 而不是 `lib-dc-release.ps1`：那条 UIA 驱动通道当前是坏的，
// 坏因与本任务无关 —— 首页把「指定位置」改成了「选择位置」+ 盘符下拉（工作区里
// `src/renderer/pages/Home.tsx` 的一份未提交改动），而 helper 还在找旧的名字与 `<input>`。
// 登记在验收文档里，本轮不改别人的半成品。
//
// 扫描走的是首页**真实那颗按钮**（与用户同一路径），不是 `DC_AUTOSCAN`（release 上没有它）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const DRIVE = arg('drive', 'D:\\')
const ROOT = arg('root', '')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
      if (page) return page
    } catch {
      /* WebView2 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('80 轮都没等到 CDP 页面')
}

async function main() {
  const page = await connect()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      p.resolve(m)
    }
  }
  const send = (method, params) =>
    new Promise((resolve2) => {
      const mid = ++id
      pending.set(mid, { resolve: resolve2 })
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result.result.value
  }

  // ---- ① 切「选择位置」→ 选盘根 → 点「开始深度扫描」 ----
  const switched = await evaluate(`(() => {
    const custom = [...document.querySelectorAll('input[type=radio]')]
      .find((r) => { const l = r.closest('label'); return l && (l.textContent || '').includes('选择位置'); });
    if (!custom) return { ok: false, why: '找不到「选择位置」单选钮' };
    custom.click();
    return { ok: true };
  })()`)
  if (!switched?.ok) throw new Error('首页驱动失败：' + JSON.stringify(switched))
  await sleep(700)

  const fired = await evaluate(`(async () => {
    const sel = document.querySelector('select.dc-scope-drive');
    if (!sel) return { ok: false, why: '切到选择位置之后没有盘符下拉' };
    const want = ${JSON.stringify(DRIVE)};
    const opt = [...sel.options].find((o) => o.value === want);
    if (!opt) return { ok: false, why: '下拉里没有 ' + want + ' 这一项，实际有：' + [...sel.options].map((o) => o.value).join(',') };
    // React 只认派发出来的 change 事件：直接改 value 而不派发，state 不会变
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const cta = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('开始深度扫描'));
    if (!cta) return { ok: false, why: '找不到「开始深度扫描」' };
    if (cta.disabled) return { ok: false, why: '「开始深度扫描」仍是 disabled（目标没进 state）' };
    // 走真实的按钮点击（不是 window.__dc.start）—— 那才是用户那条路
    cta.click();
    return { ok: true };
  })()`)
  if (!fired?.ok) throw new Error('扫描没起来：' + JSON.stringify(fired))
  console.log('SCAN_FIRED drive=' + DRIVE)

  let status = ''
  for (let i = 0; i < 720; i++) {
    status = await evaluate('window.__dc.status()')
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break
    await sleep(500)
  }
  console.log('SCAN_STATUS ' + status)
  if (status !== 'completed') throw new Error('扫描没跑完（status=' + status + '）')

  // ---- ② 进清理页（**这是应用起来之后第一次进这一页 = 冷进入**）----
  //
  // ⚠️ 不能在这里 `await sleep(1500)` 再采样：Loading 那格只活几百毫秒（一次内存 IPC），
  // 一睡就把它睡过去了 —— 而"冷进页面时它出现过"恰恰是本轮要验的第 ① 条。
  // 所以切页之后**立刻**开始 30 ms 高频采样，把首次出现的样子抓下来写盘，
  // 由 `cleanup-layout-loading-probe.mjs` 读这份证据来判（它自己不做冷进构造）。
  await evaluate(`window.__dc.view('cleanup')`)
  const firstSeen = await (async () => {
    for (let i = 0; i < 300; i++) {
      // 2026-10-21 第四轮：除了"有没有"，还要采"在不在中间 / 白不白 / 多大" ——
      // 这三条只在冷进那一瞬成立（之后它就不在 DOM 里了），事后补不出来。
      const s = await evaluate(`(() => {
        const load = document.querySelector('.dc-revalue');
        if (!load) return null;
        const stage = document.querySelector('.dc-revalue-stage');
        const dots = load.querySelector('.dc-jump');
        const cs = getComputedStyle(load);
        const ds = dots ? getComputedStyle(dots) : null;
        return {
          text: load.textContent.trim(),
          dotCount: load.querySelectorAll('.dc-jump-dot').length,
          hasOldBar: !!document.querySelector('.dc-revalue-bar'),
          inStage: !!(stage && stage.contains(load)),
          stageCentered: stage ? getComputedStyle(stage).placeItems : null,
          color: cs.color,
          dotSize: ds ? ds.getPropertyValue('--uib-size').trim() : null,
          fontSize: cs.fontSize,
        };
      })()`)
      if (s) return { ...s, atMs: i * 30 }
      await sleep(30)
    }
    return null
  })()
  console.log('FIRST_LOADING ' + JSON.stringify(firstSeen))
  writeFileSync(arg('first-seen', 'D:\\dc-tmp\\loading-first-seen.json'), JSON.stringify({ firstSeen }, null, 2))

  // 再等它落定（行出来、Loading 消失）
  let last = null
  for (let i = 0; i < 90; i++) {
    last = await evaluate(`(() => ({
      rows: document.querySelectorAll('.dc-clean-row').length,
      loading: !!document.querySelector('.dc-revalue'),
      previewTitle: !!document.querySelector('.dc-clean-title'),
    }))()`)
    if (last.rows > 0 && !last.loading && last.previewTitle) break
    await sleep(200)
  }
  console.log('CLEANUP_READY ' + JSON.stringify(last))
  if (!(last && last.rows > 0 && !last.loading && last.previewTitle)) {
    throw new Error('90 轮之后清理页仍没有行 / 仍在等 / 没有标题：' + JSON.stringify(last))
  }

  mkdirSync(dirname(arg('out', 'D:\\dc-tmp\\x.json')), { recursive: true })
  ws.close()
}

await main()
