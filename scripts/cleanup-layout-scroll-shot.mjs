// 拍「滚到中部」与「滚到底」两屏 —— 人肉复核"这一页真的能滑动"。
//
// 为什么需要（而不是主 e2e 那三张够用）：主 e2e 的截图都在探针**滚回顶部之后**拍
// （探针为了一次量完所有几何，会把 scrollTop 复原），所以那几张图上的页面永远停在顶部。
// 而人类伙伴这次的反馈正是"页面目前无法滑动" —— 要证明这件事，得让人看见**底部那一屏**。
//
// 与 `--hold-bottom` 那支诊断的区别：那一支报几何、不拍图；这一支**停在指定位置等调用方截图**。
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const WHERE = arg('where', 'bottom') // 'mid' | 'bottom'
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

const expr =
  WHERE === 'mid'
    ? `(() => { const c = document.querySelector('.dc-clean'); c.scrollTop = (c.scrollHeight - c.clientHeight) / 2; return c.scrollTop; })()`
    : `(() => { const c = document.querySelector('.dc-clean'); c.scrollTop = c.scrollHeight; return c.scrollTop; })()`
const top = await ev(expr)
await sleep(400)
console.log(`SCROLLED where=${WHERE} scrollTop=${Math.round(top)}`)
// 把连接挂住，等调用方拍完（12 秒足够截图脚本跑完一轮）
await sleep(Number(arg('hold', '12000')))
ws.close()
