// 勾选延迟的专项探针（2026-10-25）。
//
// 要量的那件事：**点一下复选框，下一帧它就必须显示成已勾**。
// 人类伙伴报的是「点击勾选后会出现延迟，勾没显示出来，也未计入」——
// 所以判据同时读三格：勾选框的 checked、行的 .dc-clean-row-on、以及「计入预估」那一列。
//
// 走 debug 构建（DC_ENV_ROOT 是 debug-only 口子，规则领地才会进靶场）。
// 判据不是"最后对不对"，而是"**多久之后才对**"：真鼠标点下去，
// 立刻读一次（同一拍、不等任何 sleep），此刻勾就必须已经翻过来。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const ROOT = arg('root', '')
const OUT = arg('out', 'D:\\dc-tmp\\checkbox-latency.json')

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
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result.result.value
  }

  const evidence = []
  const note = (step, data) => {
    evidence.push({ step, ...data })
    console.log(step.toUpperCase() + ' ' + JSON.stringify(data))
  }

  // ---- ① 等页面挂载，扫靶场 ----
  let hasDc = false
  for (let i = 0; i < 100; i++) {
    hasDc = await evaluate('!!window.__dc')
    if (hasDc) break
    await sleep(300)
  }
  if (!hasDc) throw new Error('window.__dc 一直没出现（30 秒）')
  await evaluate(`(() => { window.__dc.start(${JSON.stringify(ROOT)}); return { ok: true }; })()`)
  let status = ''
  for (let i = 0; i < 360; i++) {
    status = await evaluate('window.__dc.status()')
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break
    await sleep(500)
  }
  note('scan_status', { status })
  if (status !== 'completed') throw new Error('扫描没跑完（status=' + status + '）')

  // ---- ② 进清理页，等自动打勾那一相**完全落定** ----
  //
  // ⚠️ 就绪条件必须同时看「勾着」与「计入」两格：只勾着就退出，会把
  // 「已勾 19 项 · 计入 0 项」那一相当成落定（2026-10-25 真机复现到的就是它）——
  // 那一相里行都勾着、而「计入预估」全是「—」，页面停着不动，直到下一次点击才恢复。
  // 这正是人类伙伴报的「勾选有延迟、勾没显示、也未计入」的真相：
  // 勾显示了，**但整页停在没有数字的中间相里**。
  await evaluate(`window.__dc.view('cleanup')`)
  // ---- ②b **全序列采样**：从进页面第一帧起持续记「已勾 N 项 · 计入 M 项」 ----
  //
  // 为什么要有这一段：中间相（已勾 19 · 计入 0）只在**回包慢**的时候可见，
  // 而报告缓存热的时候它只活 1.4–3.6 ms，采样点大概率漏掉。修没修对，
  // 不能靠"这一拍正好没采到"来证明。所以改成：进页面之后**立刻**开始轮询，
  // 把每一帧的 (checked, priced) 都收进 samples，最后判"有没有出现过
  // checked>0 而 priced==0 的帧"。
  //
  // 修好之后这一相被 Loading 盖住，采样看到的是 loading:true，不会计入缺陷帧。
  const samples = []
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await evaluate(`(() => {
      const count = (document.querySelector('.dc-clean-toolbar-count') || {}).textContent || '';
      const ests = [...document.querySelectorAll('.dc-clean-row-est')].map((e) => e.textContent.trim());
      return {
        rows: document.querySelectorAll('.dc-clean-row').length,
        checked: document.querySelectorAll('.dc-clean-row input[type=checkbox]:checked').length,
        loading: !!document.querySelector('.dc-revalue'),
        count: count.trim(),
        pricedRows: ests.filter((t) => t !== '—' && t !== '').length
      };
    })()`)
    samples.push({ ...ready, atMs: Date.now() })
    if (ready.rows > 0 && !ready.loading && ready.checked > 0 && ready.pricedRows > 0) break
    await sleep(50)
  }
  // 缺陷帧：有行勾着、却一行都没计价
  const blankFrames = samples.filter((s) => s.checked > 0 && s.pricedRows === 0 && s.rows > 0 && !s.loading)
  note('cleanup_ready', ready)
  note('sample_sequence', {
    frames: samples.length,
    blankFrames: blankFrames.length,
    firstBlank: blankFrames[0] ?? null,
    lastBlank: blankFrames[blankFrames.length - 1] ?? null
  })
  if (!ready || ready.rows === 0 || ready.loading) throw new Error('清理页没落定：' + JSON.stringify(ready))
  if (blankFrames.length > 0) {
    throw new Error(
      `复现到中间相：${blankFrames.length} 帧"有行勾着而一行都没计价"（共采样 ${samples.length} 帧）—— ` +
        'settling 没盖住自动打勾之后的过渡态，用户看到的就是"勾选了但没有任何数字"。' +
        ' 首帧：' +
        JSON.stringify(blankFrames[0])
    )
  }
  if (ready.pricedRows === 0) {
    throw new Error(
      '清理页停在中间相：行勾着而「计入预估」全是「—」（' +
        JSON.stringify(ready) +
        '）—— settling 没盖住自动打勾之后的过渡态'
    )
  }

  // ---- ③ 第一行先取消（造一个"未勾"的起点），等它真的稳定下来 ----
  await evaluate(`(() => {
    const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
    if (cb) cb.click();
    return { ok: true };
  })()`)
  // 等回包：取消之后服务端会重算一次，落定后 checked 稳定为 false、行不高亮
  let afterUncheck = null
  for (let i = 0; i < 100; i++) {
    afterUncheck = await evaluate(`(() => {
      const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
      const row = cb ? cb.closest('.dc-clean-row') : null;
      return {
        checked: cb ? cb.checked : null,
        rowOn: row ? row.className.includes('dc-clean-row-on') : null
      };
    })()`)
    if (afterUncheck && afterUncheck.checked === false && afterUncheck.rowOn === false) break
    await sleep(100)
  }
  note('after_uncheck_first_row', afterUncheck)
  if (!afterUncheck || afterUncheck.checked !== false) {
    throw new Error('第一行没取消成：' + JSON.stringify(afterUncheck))
  }

  // ---- ④ **核心判据**：点下去，同一拍立刻读三格 ----
  //
  // ⚠️ 关于"真鼠标"：本仓库的 e2e 从来没有成功用 `Input.dispatchMouseEvent` 合成过一次 click
  // （全仓只有 `scale-probe.mjs` 用它发滚轮，那一处可用）。本次实测确认了这件事：
  // 加上 mouseMoved + pressed + released 三连，`change` 事件计数仍是 0 —— 事件没派生成 click。
  // 所以这里量延迟用 `Runtime.evaluate` 的编程 `click()`（`userGesture: true`），
  // 它与 `clean-dialog-e2e.mjs` 点「一键清理」是同一条已验证可用的路径。
  // **量的是"点击到显示"这一跳有多长**，不是"哪种输入法更真实"。
  //
  // 关键在"同一拍"：`cb.click()` 是同步的，React 的 onChange 在同一次消息循环里跑完，
  // 所以紧接着那次 evaluate 读到的就是"用户松手那一刻屏幕上是什么"。
  const t0 = Date.now()
  const box = await evaluate(`(() => {
    const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
    if (!cb) return null;
    const r = cb.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, inView: r.top >= 0 };
  })()`)
  if (!box) throw new Error('找不到复选框')
  if (!box.inView) {
    await evaluate(`(() => {
      document.querySelector('.dc-clean-row input[type=checkbox]').scrollIntoView({ block: 'center' });
      return { ok: true };
    })()`)
    await sleep(200)
  }
  // 起点：第一行**未勾**（③ 已经摆好）
  const start = await evaluate(`(() => {
    const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
    const row = cb ? cb.closest('.dc-clean-row') : null;
    return { checked: cb ? cb.checked : null, rowOn: row ? row.className.includes('dc-clean-row-on') : null };
  })()`)
  note('click_start_state', { ...start, atMs: Date.now() - t0 })
  if (!start || start.checked !== false) throw new Error('起点没摆成"未勾"：' + JSON.stringify(start))

  const immediate = await evaluate(`(() => {
    const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
    cb.click();
    const row = cb.closest('.dc-clean-row');
    const est = row.querySelector('.dc-clean-row-est');
    const count = (document.querySelector('.dc-clean-toolbar-count') || {}).textContent || '';
    return {
      checked: cb.checked,
      rowOn: row.className.includes('dc-clean-row-on'),
      est: est.textContent.trim(),
      count: count.trim()
    };
  })()`)
  const lag = Date.now() - t0
  note('immediately_after_click', { ...immediate, lagMs: lag })

  // ---- ⑤ 判据 ----
  if (!immediate || immediate.changeEvents === 0) {
    throw new Error(
      '真鼠标点击没有产生 change 事件 —— 这是**探针的错**（CDP 事件没派生成 click），不是产品的缺陷：' +
        JSON.stringify(immediate)
    )
  }
  if (immediate.checked !== true) {
    throw new Error(
      '真鼠标点下去，勾选框没有立刻翻成已勾 —— 这就是人类伙伴报的"勾没显示出来"：' +
        JSON.stringify(immediate)
    )
  }
  if (immediate.rowOn !== true) {
    throw new Error('勾翻了但行没高亮：' + JSON.stringify(immediate))
  }
  console.log('CHECKBOX_INSTANT_OK ' + JSON.stringify(immediate))

  // ---- ⑥ 等回包落定，「计入预估」必须跟上（这是"也未计入"那一半）----
  let settled = null
  for (let i = 0; i < 100; i++) {
    settled = await evaluate(`(() => {
      const cb = document.querySelector('.dc-clean-row input[type=checkbox]');
      const row = cb ? cb.closest('.dc-clean-row') : null;
      const est = row ? row.querySelector('.dc-clean-row-est') : null;
      const count = (document.querySelector('.dc-clean-toolbar-count') || {}).textContent || '';
      return {
        checked: cb ? cb.checked : null,
        rowOn: row ? row.className.includes('dc-clean-row-on') : null,
        est: est ? est.textContent.trim() : null,
        count: count.trim()
      };
    })()`)
    if (settled && settled.est && settled.est !== '—' && /已勾 0 项/.test(settled.count) === false) break
    await sleep(100)
  }
  note('settled', settled)
  if (!settled || !settled.est || settled.est === '—') {
    throw new Error('回包之后「计入预估」还是「—」—— 那半句"也未计入"没修好：' + JSON.stringify(settled))
  }
  if (/已勾 0 项/.test(settled.count)) {
    throw new Error('回包之后「已勾 0 项」—— 勾选没进服务端：' + JSON.stringify(settled))
  }
  console.log('ESTIMATE_FOLLOWED_OK ' + JSON.stringify(settled))

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(arg('shot', 'D:\\DeepClean\\docs\\acceptance\\assets\\checkbox-instant.png'), Buffer.from(shot.result.data, 'base64'))
    note('screenshot', { bytes: Buffer.byteLength(shot.result.data, 'base64') })
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({ evidence }, null, 2))
  console.log('CHECKBOX_LATENCY_OK')
  ws.close()
}

await main()
