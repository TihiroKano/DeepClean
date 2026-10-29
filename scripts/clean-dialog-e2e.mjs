// 一键清理弹窗的真机验证驱动（2026-10-24）。
//
// 走 debug 构建（release 上拿不到 DC_ENV_ROOT，规则领地会指到真实用户路径，
// 那不是本次验证该碰的）。DC_ENV_ROOT 把 TEMP 等五键重定向进靶场，
// 所以 windows-temp 只会认领靶场里那几个种子文件。
//
// 验证链：扫描靶场 → 进清理页（自动打勾）→ 点「一键清理」→ 弹窗出现、列表滚、进度条走
// → 「清理完成」→ 读释放量 → 退出。文件是否真没了由外层 PowerShell 事后数。
//
// 为什么本驱动只做到"读完结论"：真删除的磁盘验证（文件数归零）是**独立口径**，
// 由调用方在进程退出后用 Get-ChildItem 做，不在页面内自证。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const ROOT = arg('root', '')
const OUT = arg('out', 'D:\\dc-tmp\\clean-dialog.json')

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

  const evidence = { steps: [] }
  const note = (step, data) => {
    evidence.steps.push({ step, ...data, atMs: Date.now() })
    console.log(step.toUpperCase() + ' ' + JSON.stringify(data))
  }

  // ---- ① 扫靶场（window.__dc.start 是 debug 构建里的 dev 脚手架，与用户点按钮同一条服务链）----
  // `__dc` 是 App 挂载后的一个 effect 里设的 —— CDP 连上页面那一刻 React 可能还没跑完，
  // 先等它出现再扫（等不到才报错，而不是把"启动慢"误判成"release 构建"）。
  let hasDc = false
  for (let i = 0; i < 100; i++) {
    hasDc = await evaluate('!!window.__dc')
    if (hasDc) break
    await sleep(300)
  }
  if (!hasDc) throw new Error('window.__dc 一直没出现（30 秒）—— 页面没挂载？')
  const started = await evaluate(`(() => {
    window.__dc.start(${JSON.stringify(ROOT)});
    return { ok: true };
  })()`)
  if (!started?.ok) throw new Error('扫描没起来：' + JSON.stringify(started))
  note('scan_fired', { root: ROOT })

  let status = ''
  for (let i = 0; i < 360; i++) {
    status = await evaluate('window.__dc.status()')
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break
    await sleep(500)
  }
  note('scan_status', { status })
  if (status !== 'completed') throw new Error('扫描没跑完（status=' + status + '）')

  // ---- ② 进清理页，等**自动打勾完成**（首屏 = 已勾选，见 `Cleanup.tsx` 的 settling 那段）----
  // 注意时序：第一次回包是全未勾选的中间态（被居中的 Loading 盖住），autoFilled effect
  // 触发后第二次回包才是已勾选。所以判"就绪"看的是 checked > 0，不是 rows > 0。
  await evaluate(`window.__dc.view('cleanup')`)
  let ready = null
  for (let i = 0; i < 180; i++) {
    ready = await evaluate(`(() => ({
      rows: document.querySelectorAll('.dc-clean-row').length,
      checked: document.querySelectorAll('.dc-clean-row input[type=checkbox]:checked').length,
      loading: !!document.querySelector('.dc-revalue'),
      cta: (() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('一键清理')); return b ? { disabled: b.disabled, title: b.title } : null; })()
    }))()`)
    if (ready.rows > 0 && !ready.loading && ready.checked > 0) break
    await sleep(200)
  }
  note('cleanup_ready', ready)
  if (!ready || ready.rows === 0 || ready.loading) throw new Error('清理页没落定：' + JSON.stringify(ready))
  if (ready.checked === 0) throw new Error('自动打勾没生效 —— 一键清理会因「一项都没勾」被拒')
  if (ready.cta === null) throw new Error('页头找不到「一键清理」按钮')
  if (ready.cta.disabled) throw new Error('「一键清理」是 disabled：' + ready.cta.title)

  // 清理前的统计带基线（④b 要拿它对比）
  const headBefore = await evaluate(`(() => {
    const release = document.querySelector('.dc-clean-release');
    return release ? release.textContent.trim() : null;
  })()`)
  note('head_before_clean', { release: headBefore })
  if (!headBefore || !/40\.0 KB/.test(headBefore)) {
    throw new Error('清理前「预计释放」不是 40.0 KB（种子没被认领？）：' + headBefore)
  }

  // ---- ③ 点「一键清理」→ 弹窗出现（确认阶段：先看到「确定，开始清理」）----
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('一键清理'));
    b.click();
    return { ok: true };
  })()`)
  if (!clicked?.ok) throw new Error('点击失败：' + JSON.stringify(clicked))
  note('cta_clicked', {})

  // ---- ③b 确认阶段：必须有「确定，开始清理」，且点它之前列表不滚 ----
  let confirmBtn = null
  for (let i = 0; i < 40; i++) {
    confirmBtn = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('确定，开始清理'));
      return b ? { disabled: b.disabled } : null;
    })()`)
    if (confirmBtn) break
    await sleep(100)
  }
  if (!confirmBtn) throw new Error('弹窗没出现「确定，开始清理」确认按钮')
  const confirmDesc = await evaluate(`(() => {
    const m = document.querySelector('.dc-clean-confirm-desc');
    return m ? m.textContent.trim() : '';
  })()`)
  if (!/不进回收站/.test(confirmDesc)) throw new Error('确认文案没写「不进回收站、无法恢复」：' + confirmDesc)
  const confirmSummary = await evaluate(`(() => {
    const m = document.querySelector('.dc-clean-confirm-summary');
    return m ? m.textContent.trim() : '';
  })()`)
  if (!/预计删除/.test(confirmSummary)) throw new Error('确认摘要没写「预计删除」：' + confirmSummary)
  note('confirm_stage', { confirmDesc, confirmSummary })
  // 确认阶段截图：这也是交付物（「确定后执行」的视觉证据）。
  const confirmShot = await send('Page.captureScreenshot', { format: 'png' })
  if (confirmShot.result?.data) {
    writeFileSync(arg('confirm-shot', 'D:\\DeepClean\\docs\\acceptance\\assets\\clean-dialog-confirm.png'), Buffer.from(confirmShot.result.data, 'base64'))
    note('confirm_screenshot', { bytes: Buffer.byteLength(confirmShot.result.data, 'base64') })
  }

  // ---- ③c 点「确定，开始清理」→ 真正开删 ----
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes('确定，开始清理'));
    b.click();
    return { ok: true };
  })()`)
  note('confirm_go', {})

  // ---- ④ 弹窗采样：出现、列表滚、进度条走、完成 ----
  const samples = []
  let done = null
  for (let i = 0; i < 400; i++) {
    const s = await evaluate(`(() => {
      const modal = document.querySelector('.dc-clean-progress-modal');
      if (!modal) return null;
      const rows = modal.querySelectorAll('.dc-clean-progress-list li').length;
      const title = (modal.querySelector('.dc-modal-title') || {}).textContent || '';
      const pct = (modal.querySelector('.dc-clean-progress-pct') || {}).textContent || '';
      const doneLine = (modal.querySelector('.dc-clean-progress-done') || {}).textContent || '';
      return { rows, title, pct, doneLine };
    })()`)
    if (s) samples.push(s)
    if (s && s.title === '清理完成') {
      done = s
      break
    }
    await sleep(50)
  }
  // 列表必须真的滚过：至少出现过"准备中"之外的行，且最终行数 > 0
  const maxRows = samples.reduce((m, s) => Math.max(m, s.rows), 0)
  note('dialog_samples', { count: samples.length, maxRows, first: samples[0] ?? null, last: samples[samples.length - 1] ?? null })
  if (!done) throw new Error('弹窗没到「清理完成」：' + JSON.stringify(samples[samples.length - 1] ?? null))
  if (maxRows === 0) throw new Error('弹窗里一行都没滚出来')
  note('dialog_done', done)

  // 完成那一行必须说出释放了多少
  if (!/释放/.test(done.doneLine)) throw new Error('完成行没写「释放」：' + done.doneLine)
  note('done_line', { doneLine: done.doneLine })

  // ---- ⑤ 截图证据（完成弹窗态，此刻弹窗还开着）----
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(arg('shot', 'D:\\DeepClean\\docs\\acceptance\\assets\\clean-dialog-done.png'), Buffer.from(shot.result.data, 'base64'))
    note('screenshot', { bytes: Buffer.byteLength(shot.result.data, 'base64') })
  }

  // ---- ④b 关闭弹窗，回页面采样**统计带数字**（2026-10-24 第二轮：数值必须变）----
  // 清理前在 ② 已经采过一行基线（`head_before_clean`）。这里等
  // refreshNonce 触发的新模型回来（done 事件 → 缓存键变 → 重拉预览），
  // 断言「预计释放」那一格比清理前小。
  await evaluate(`(() => {
    const x = document.querySelector('.dc-clean-progress-modal .dc-modal-x');
    if (x) x.click();
  })()`)
  await sleep(400)
  let headAfter = null
  for (let i = 0; i < 100; i++) {
    headAfter = await evaluate(`(() => {
      const release = document.querySelector('.dc-clean-release');
      const total = document.querySelector('.dc-clean-total-num');
      return {
        release: release ? release.textContent.trim() : null,
        total: total ? total.textContent.trim() : null
      };
    })()`)
    // 「预计释放」不再是清理前的 40.0 KB（可能变 0 B，也可能显示别的数，但必须变）
    if (headAfter && headAfter.release && !headAfter.release.includes('40.0 KB')) break
    await sleep(100)
  }
  note('head_after_clean', headAfter)
  if (!headAfter || !headAfter.release) throw new Error('关弹窗后读不到「预计释放」那一格')
  if (headAfter.release.includes('40.0 KB')) {
    throw new Error('清理后「预计释放」还是 40.0 KB —— 图二数字没刷新：' + JSON.stringify(headAfter))
  }
  console.log('HEAD_REFRESH_OK ' + JSON.stringify(headAfter))

  // ---- ④c **切页再切回**，数字必须还是清理后那份（2026-10-25 缺陷）----
  //
  // 人类伙伴报的是「清完之后切回清理预览，那个条目还在原样」。
  // 根因：`refreshNonce` 当时住在 `Cleanup` 的本地 state 里，切页即卸载 ⇒ nonce 归 0
  // ⇒ 缓存键与**清理前那一份逐字相同** ⇒ 模块级 `previewCache` 命中 ⇒ 旧数原样回来。
  //
  // 这一段专门跑那条路：点侧栏「清理日志」→ 等列表出来 → 点回「垃圾清理」→ 读数字。
  // 修法把 nonce 提到 `App` 之后，切回来它还在，键不再撞上清理前那份。
  await evaluate(`(() => {
    const navs = Array.from(document.querySelectorAll('.dc-nav'));
    const journal = navs.find((n) => (n.textContent || '').includes('清理日志'));
    if (journal) journal.click();
  })()`)
  await sleep(800)
  const journalSeen = await evaluate(`document.body.innerText.includes('清理日志')`)
  note('journal_page_seen', { seen: journalSeen })

  await evaluate(`(() => {
    const navs = Array.from(document.querySelectorAll('.dc-nav'));
    const cleanup = navs.find((n) => (n.textContent || '').includes('垃圾清理'));
    if (cleanup) cleanup.click();
  })()`)
  // 等这一页重新挂载并把预览拉回来
  let headBack = null
  for (let i = 0; i < 120; i++) {
    headBack = await evaluate(`(() => {
      const release = document.querySelector('.dc-clean-release');
      const total = document.querySelector('.dc-clean-total-num');
      return {
        release: release ? release.textContent.trim() : null,
        total: total ? total.textContent.trim() : null
      };
    })()`)
    if (headBack && headBack.release) break
    await sleep(100)
  }
  note('head_after_switch_back', headBack)
  if (!headBack || !headBack.release) throw new Error('切回来后读不到「预计释放」：' + JSON.stringify(headBack))
  if (headBack.release.includes('40.0 KB')) {
    throw new Error(
      '切页回来后「预计释放」又变回清理前的 40.0 KB —— nonce 没活过切页：' + JSON.stringify(headBack)
    )
  }
  console.log('HEAD_SWITCH_BACK_OK ' + JSON.stringify(headBack))

  // 关弹窗后的页面状态截图（数值刷新的视觉证据）
  await sleep(300)
  const afterShot = await send('Page.captureScreenshot', { format: 'png' })
  if (afterShot.result?.data) {
    writeFileSync(arg('after-shot', 'D:\\DeepClean\\docs\\acceptance\\assets\\clean-dialog-after.png'), Buffer.from(afterShot.result.data, 'base64'))
    note('after_screenshot', { bytes: Buffer.byteLength(afterShot.result.data, 'base64') })
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify({ evidence, samples, done }, null, 2))
  console.log('CLEAN_DIALOG_OK')
  ws.close()
}

await main()
