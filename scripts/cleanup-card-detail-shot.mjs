// 详情框的开/关驱动（给截图用）。
//
// 为什么单独一支：`cleanup-card-detail-probe.mjs` 已经"点开 → 量 → 按 Esc 关掉"走完了整条链，
// 但它关完框才退出 —— 截图要的是**框开着的那一相**。把驱动拆出来，探针管判据、它管画面,
// 两件事各自可以被单独重跑（判据红了不必重开窗口重拍，照片糊了也不必重跑一整轮扫描）。
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const MODE = arg('mode', 'open')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && t.url.includes('tauri.localhost'))
  if (!page) throw new Error('CDP 列表里没有 tauri 页面')
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
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result.result.value
  }

  if (MODE === 'open') {
    /**
     * 点**第二条**（浏览器缓存那一条）：它的规则文案最长、命中目录最多，
     * 详情框里"目录列表"那一块才有内容可看 —— 拿第一条（临时文件）拍出来的框太单薄，
     * 看不出这一格到底装得下多少东西。
     */
    const r = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('.dc-clean-more')];
      if (btns.length === 0) return { ok: false, why: '一行的「查看详情」都没有' };
      const i = Math.min(1, btns.length - 1);
      btns[i].click();
      return { ok: true, picked: i, total: btns.length };
    })()`)
    if (!r?.ok) throw new Error('打开详情框失败：' + JSON.stringify(r))
    await sleep(450)
    const st = await evaluate(`(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return { open: false };
      const t = d.querySelector('.dc-modal-title');
      return {
        open: true,
        title: t ? t.textContent : '',
        roots: d.querySelectorAll('.dc-clean-detail-list li').length,
        h: +d.getBoundingClientRect().height.toFixed(1),
      };
    })()`)
    if (!st.open) throw new Error('点了「查看详情」但框没出现')
    console.log('DETAIL_OPEN ' + JSON.stringify({ ...r, ...st }))
    writeFileSync('D:\\dc-tmp\\cleanup-card-detail-open.json', JSON.stringify(st, null, 2))
  } else {
    // 关：Esc 那条路（与用户按的一样）。关不掉就是缺陷，不当"拍照用的清理动作"。
    await evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`)
    await sleep(300)
    const left = await evaluate(`document.querySelectorAll('[role="dialog"]').length`)
    if (left !== 0) throw new Error('按 Esc 之后还剩 ' + left + ' 个详情框')
    console.log('DETAIL_CLOSED')
  }
  ws.close()
}

await main()
