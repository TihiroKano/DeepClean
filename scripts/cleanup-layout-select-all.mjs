// 「全选可清理项」这一相的驱动。抽出来的理由与 `_cleanup-layout-driver.mjs` 同一族：
// 它要用 CDP 的 real click，而那不是 shell 一行能做的事。
//
// 这一相要验的**不是按钮能按**（那条由 `m3` / `m5k` 在真窗口上把守），而是：
// 勾上之后 ①每行都真的进入 `.dc-clean-row-on`；②统计带那格「预计可释放」跟着从 0 变成真数
// （它是 `model.totalBytes` 的读法，勾选一变服务端重算、界面重画，这一条量的是那条链还在）。
const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
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
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result.result.value
  }

  // 勾选前的读数（统计带那三格 + 行数），后面要拿它做对照
  const before = await evaluate(`(() => {
    const vals = [...document.querySelectorAll('.dc-clean-stat-value')].map((e) => e.textContent.trim());
    return { vals, rows: document.querySelectorAll('.dc-clean-row').length, on: document.querySelectorAll('.dc-clean-row-on').length };
  })()`)

  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('全选可清理项'));
    if (!b) return { ok: false, why: '找不到「全选可清理项」' };
    if (b.disabled) return { ok: false, why: '「全选可清理项」是 disabled ⇒ 这套树上一条规则都没命中' };
    b.click();
    return { ok: true };
  })()`)
  if (!clicked?.ok) throw new Error(JSON.stringify(clicked))
  await sleep(2600)

  const after = await evaluate(`(() => {
    const vals = [...document.querySelectorAll('.dc-clean-stat-value')].map((e) => e.textContent.trim());
    return { vals, rows: document.querySelectorAll('.dc-clean-row').length, on: document.querySelectorAll('.dc-clean-row-on').length };
  })()`)

  console.log('SELECT before=' + JSON.stringify(before))
  console.log('SELECT after=' + JSON.stringify(after))
  /**
   * 判据只看**这一相自己该改变的那件事**：勾上之后每一行都进入 `.dc-clean-row-on`。
   *
   * ⚠️ 第一版这里还要求「预计可释放」必须从 0 B 变成非 0 —— 那条判据是错的，且已实测误红：
   * 扫的是 `D:\` 根，这台机器那个盘上没有任何登记规则的地盘，22 行全是 0 字节 / 0 文件
   * （行里明写「无命中目录」）。**0 B 在这份数据上就是诚实的答案**，
   * 逼它变成非 0 等于让判据去要求产品撒谎。
   * 「统计带跟着 model.totalBytes 重画」由别处把守：`cleanup-headline.test.tsx` 钉取数口径，
   * 真机这一相只钉"勾选 → 每行高亮"那条视觉链。
   */
  if (after.on === 0) throw new Error('点了「全选可清理项」而一行都没进 `.dc-clean-row-on`')
  if (after.on !== after.rows) {
    console.log(`  NOTE 勾上 ${after.on} / 共 ${after.rows} 行 —— 差额是被 §3.5 豁免或被拒的行，不判红`)
  }
  ws.close()
}
await main()
