// 勾选链的**状态对账**探针：把 DOM 上的勾、本地 selected、服务端模型的 selected
// 三样同时打出来，看它们在哪一帧分叉。是 checkbox-latency-probe 的调试用伴生脚本。
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const ROOT = arg('root', '')
const OUT = arg('out', 'D:\\dc-tmp\\checkbox-reconcile.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let page = null
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
      if (page) break
    } catch {
      /* WebView2 还没起来 */
    }
    await sleep(500)
  }
  if (!page) throw new Error('80 轮都没等到 CDP 页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    const p = pending.get(m.id)
    if (p) { pending.delete(m.id); p.resolve(m) }
  }
  const send = (method, params) => new Promise((resolve2) => {
    const mid = ++id
    pending.set(mid, { resolve: resolve2 })
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 500))
    return r.result.result.value
  }

  const rows = () => evaluate(`(() => {
    const out = [];
    document.querySelectorAll('.dc-clean-row').forEach((row) => {
      const cb = row.querySelector('input[type=checkbox]');
      const est = row.querySelector('.dc-clean-row-est');
      out.push({
        name: (row.querySelector('.dc-clean-name') || {}).textContent || '',
        checked: cb ? cb.checked : null,
        rowOn: row.className.includes('dc-clean-row-on'),
        est: est ? est.textContent.trim() : ''
      });
    });
    const count = (document.querySelector('.dc-clean-toolbar-count') || {}).textContent || '';
    return { rows: out, count: count.trim() };
  })()`)

  for (let i = 0; i < 100; i++) {
    const has = await evaluate('!!window.__dc')
    if (has) break
    await sleep(300)
  }
  await evaluate(`(() => { window.__dc.start(${JSON.stringify(ROOT)}); return { ok: true }; })()`)
  let status = ''
  for (let i = 0; i < 360; i++) {
    status = await evaluate('window.__dc.status()')
    if (status === 'completed' || status === 'failed') break
    await sleep(500)
  }
  await evaluate(`window.__dc.view('cleanup')`)
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await evaluate(`(() => ({
      rows: document.querySelectorAll('.dc-clean-row').length,
      checked: document.querySelectorAll('.dc-clean-row input[type=checkbox]:checked').length,
      loading: !!document.querySelector('.dc-revalue')
    }))()`)
    if (ready.rows > 0 && !ready.loading && ready.checked > 0) break
    await sleep(200)
  }
  console.log('READY ' + JSON.stringify(ready))
  const before = await rows()
  console.log('BEFORE ' + JSON.stringify(before))

  // 真鼠标点第一行
  const box = await evaluate(`(() => {
    const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
    const r = cb.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  const t0 = Date.now()
  const immediate = await rows()
  console.log('IMMEDIATE (+' + (Date.now() - t0) + 'ms) ' + JSON.stringify(immediate))
  await sleep(300)
  const after300 = await rows()
  console.log('AFTER_300MS ' + JSON.stringify(after300))
  await sleep(1200)
  const after1500 = await rows()
  console.log('AFTER_1500MS ' + JSON.stringify(after1500))

  writeFileSync(OUT, JSON.stringify({ ready, before, immediate, after300, after1500 }, null, 2))
  ws.close()
}
await main()
