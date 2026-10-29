// 清理页版式（2026-10-21 重构）的**几何探针**。
//
// 为什么必须量几何而不是看截图：「表头那一行与每一行的三列数字对不对齐」在 PNG 上
// 差 3~5 px 肉眼很难判定，而它一旦错位读起来就像"这张表坏了"。判据只能是数字：
// 表头每一格的右缘必须与它所对应的那一列（行里第 5/6/7 格）的右缘在容差内一致。
//
// 三件事分开报，别被读成一件事：
//   ① 结构：`.dc-clean-stats` / `.dc-clean-list` / 每一行 `.dc-clean-row` 是否真在 DOM 且矩形非空；
//   ② 对齐：表头五格（第 3~7 列）与行里对应格子的**右缘**偏差（数字列右对齐，所以看右缘）；
//   ③ 溢出：根有没有被撑出横向滚动（与 `m6b-scale-e2e.ps1` 第一轴同一判据）。
//
// 通道与 `scale-probe.mjs` 完全一致：WebView2 CDP，端口由启动环境注入。
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const OUT = arg('out', '')
const PHYS = Number(arg('physical', '0'))
const WANT_SELECTED = arg('selected', 'false') === 'true'
/** `--wait-scan`：先等扫描跑完并切到清理页，再量（debug 版靠 DC_AUTOSCAN 起扫描时用）。 */
const WAIT_SCAN = argv.includes('--wait-scan')

/**
 * 页面里跑的那段。**只用标准 DOM API**，不引任何库。
 *
 * 容差 1.5 px 与 `scale-probe.mjs` 那条「越过右缘 1.5 px」同一个数：
 * 设备像素比 1.5 时 subpixel 会落到 1/3 px 上，容差给 0 会把正常渲染判成错位。
 */
const PROBE = `(() => {
  const innerW = innerWidth;
  const q = (s) => [...document.querySelectorAll(s)];
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +(r.right).toFixed(1) }; };
  const problems = [];

  const stats = q('.dc-clean-stats')[0] || null;
  const list = q('.dc-clean-list')[0] || null;
  const head = q('.dc-clean-list-head')[0] || null;
  const rows = q('.dc-clean-row');
  const selectedRows = q('.dc-clean-row-on');

  if (!stats) problems.push('统计带 .dc-clean-stats 不在 DOM 里');
  else { const b = box(stats); if (b.w < 100 || b.h < 40) problems.push('统计带矩形太小：' + JSON.stringify(b)); }
  if (!list) problems.push('卡片列表 .dc-clean-list 不在 DOM 里');
  if (!head) problems.push('列头 .dc-clean-list-head 不在 DOM 里');
  if (rows.length === 0) problems.push('一行 .dc-clean-row 都没有 —— 列表没渲染出来');

  /** 几何判据全部拿**第一行**当样本（每一行共用同一套 grid 模板，量一行就够）。 */
  const row0 = rows[0] || null;

  // 表头与行的**对应关系**（重构后是五格：勾选位 / 图标砖 / 描述 / 风险 / 数字组）。
  // 数字组是一格、内部再分三小列，所以三列对齐要比它内部那三小格。
  const HEAD_TO_ROW = [
    ['.dc-clean-list-head-title', 2],
    ['.dc-clean-list-head-risk', 3],
  ];
  const headNums = q('.dc-clean-list-head-nums > span');       // 三个数字标签
  const rowNums = row0 ? q('.dc-clean-row-nums > span').filter((e) => e.closest('.dc-clean-row') === row0) : [];
  let alignSkew = 0;
  if (row0) {
    const check = (label, headEl, rowEl) => {
      if (!headEl || !rowEl) { problems.push(label + '：表头或行内格子缺失'); return; }
      const a = box(headEl), b = box(rowEl);
      // 头的右缘对那一列内容的右缘（数字列是 text-align:right）；「项目」「风险」两列比左缘。
      const isNum = rowEl.classList.contains('dc-clean-row-num');
      const delta = isNum ? Math.abs(a.right - b.right) : Math.abs(a.x - b.x);
      if (delta > alignSkew) alignSkew = delta;
      if (delta > 1.5) problems.push(label + ' 与行内格子错位 ' + delta.toFixed(1) + 'px（head=' + JSON.stringify(a) + ' row=' + JSON.stringify(b) + '）');
    };
    /**
     * 表头那一行在窄窗档（≤780）是**故意** display:none 的：那一档里数字组整组换到
     * 第二行，表头没有第二行可用，留四个标签悬在第一行（而数字在第二行）会更难读。
     * 所以先判它可见不可见，隐藏时**跳过**左缘对齐这一条 —— 但对数字组本身仍在下面
     * 判"三小列齐全、不溢出"。不跳过的话探针会拿 getBoundingClientRect() 全 0 的
     * 隐藏元素去比，报「错位 316.7px」这种看不出真假的数（真机实测过，误红）。
     */
    const headVisible = head && getComputedStyle(head).display !== 'none';
    if (headVisible) {
      for (const [sel, idx] of HEAD_TO_ROW) {
        const h = head ? head.querySelector(sel) : null;
        check(sel, h, row0.children[idx] || null);
      }
      headNums.forEach((h, i) => check('.dc-clean-list-head-nums[' + i + ']', h, rowNums[i] || null));
    } else if (rowNums.length !== 3) {
      problems.push('窄窗档（表头隐藏）里行内数字组只有 ' + rowNums.length + ' 格（期望 3）');
    }
  }

  // 数字组这一格必须在视口内、且三小列都在它自己的框里（不许被裁掉一半）
  if (row0) {
    const nums = row0.querySelector('.dc-clean-row-nums');
    if (!nums) problems.push('行里找不到 .dc-clean-row-nums（三列数字装的那一格）');
    else {
      const nb = box(nums);
      if (nb.right > innerW + 1.5) problems.push('数字组越出视口右缘 ' + (nb.right - innerW).toFixed(1) + 'px');
      const est = q('.dc-clean-row-est').filter((e) => e.closest('.dc-clean-row') === row0)[0];
      if (!est) problems.push('「计入预估」那一格不在第一行里');
      else {
        const eb = box(est);
        if (eb.w < 20) problems.push('「计入预估」被挤到只剩 ' + eb.w + 'px');
        /**
         * 它必须落在数字组那一格**里面**。容差 2 px 而不是 1.5：
         * text-align: right 的可视右缘与格子右缘会差一个亚像素级的字形边距，
         * 1.5 px 在这台 150% 缩放的机器上偶发误判（实测差 4 px 那次是**真的**两处排法不同，
         * 修完共用 --dc-clean-nums 之后差值落到 0.5 px 以内；这里留 2 px 是给字形边距的余量，
         * 不是给"排法不同"的余量 —— 那种差异是 4 px 起步）。
         */
        if (eb.right > nb.right + 2) problems.push('「计入预估」溢出数字组右缘 ' + (eb.right - nb.right).toFixed(1) + 'px');
      }
    }
  }

  /**
   * 第一行那四格必须**排在同一行**（勾选 / 图标 / 描述 / 风险）。
   *
   * 窄窗里"数字组整组换到第二行"是**设计允许**的形态（grid-column: 3 / -1; grid-row: 2），
   * 所以数字组不参与这一条 —— 它参与的是上面那条"必须在视口内、三小列齐全"。
   *
   * ⚠️ 这一条是被一次真事故逼出来的：第一版窄窗模板少写了一格，第 7 格（计入预估）
   * 没有列可落、被 grid 折到第二行左边，在真机截图上孤零零挂在描述底下。
   * 而当时的探针**全绿** —— 它只比"表头与行内格子的右缘"，格数一变右缘反而更整齐。
   *
   * 判据取**前四格的 y 区间必须互相重叠**（grid 单行的定义）：任何一格换行都会让它
   * 与其余格不再重叠。
   */
  if (row0) {
    const cells = [...row0.children].filter(
      (c) => c.getBoundingClientRect().width > 0 && !c.classList.contains('dc-clean-row-nums')
    );
    if (cells.length !== 4) problems.push('第一行里 ' + cells.length + ' 个格子（期望 4：勾选/图标/描述/风险）');
    const boxes = cells.map(box);
    if (boxes.length > 1) {
      const maxTop = Math.max(...boxes.map((b) => b.y));
      const minBottom = Math.min(...boxes.map((b) => b.y + b.h));
      if (minBottom - maxTop < 4) {
        problems.push('第一行四格没有排在同一行（y 区间交集 ' + (minBottom - maxTop).toFixed(1) + 'px；某格被折到下一行了）');
      }
    }
  }

  // 勾选框尺寸（--shot 靠它点击；尺寸一改那些步会点空）
  const cb = q('.dc-clean-check input[type=checkbox]')[0] || null;
  let cbSize = null;
  if (cb) { const b = box(cb); cbSize = [b.w, b.h]; if (b.w < 14 || b.h < 14) problems.push('勾选框被缩小到 ' + JSON.stringify(cbSize)); }
  else problems.push('.dc-clean-check 里找不到 checkbox');

  // 溢出（与 scale-probe 第一轴同一判据）
  const de = document.documentElement;
  const scrollW = Math.max(de.scrollWidth, document.body.scrollWidth);
  const overflowPx = +(scrollW - innerWidth).toFixed(1);
  if (overflowPx > 1) problems.push('根被撑出横向滚动 ' + overflowPx + 'px');

  /**
   * **纵向能不能滚到列表末尾**（2026-10-21 人类伙伴：「这个页面目前无法滑动」）。
   *
   * 判据分两段，缺一不可：
   *  ① 找一个**真的可纵向滚**的祖先：overflowY 是 auto/scroll 且 scrollHeight > clientHeight；
   *  ② 把它滚到底，确认**最后一行确实进了可视区**。
   *
   * 为什么必须有 ②：只查 ① 会漏掉"容器能滚但内容被裁在别人底下"那一族；
   * 而在这一页上踩到的正是 ① 都不成立的那种 —— 根容器既没有 overflow: auto，
   * 也不是 flex 项，于是 22 行里的后 18 行**根本没有任何滚动容器装它们**，
   * 既滚不到也看不见。修法见 global.css 的 .dc-clean（flex: 1; min-height: 0; overflow: auto）。
   */
  let scrollY = { ok: false, why: '没有找到可纵向滚的容器' };
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    let scroller = null;
    for (let a = last.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && a.scrollHeight > a.clientHeight + 1) {
        scroller = a;
        break;
      }
    }
    if (!scroller) {
      // 反证一下"确实装不下"：所有行加起来比视口高，却找不到能滚的祖先 ⇒ 这就是缺陷
      const totalH = rows.reduce((s, r) => s + r.getBoundingClientRect().height, 0);
      scrollY = {
        ok: false,
        why: '找不到可纵向滚的祖先（' + rows.length + ' 行合计 ' + Math.round(totalH) + 'px，视口 ' + innerHeight + 'px）',
      };
    } else {
      /**
       * 「滚得到列表末尾」的判据：滚到底之后，**最后一行的可见高度必须大于零**，
       * 且它确实被滚上来了（scrollTop 真的变了）。
       *
       * 三条错法都实测过，写在这里免得重犯：
       *
       * ① 用 innerHeight 当可视区（第一版）：.dc-clean 上面压着 40px 标题条，
       *    容器的可视区间是 [40, 578] 而不是 [0, 578]。而且那种写法对"滚过了头"是瞎的
       *    —— 末行被滚到 top=-671 时 top < innerHeight 照样成立。
       *
       * ② 要求**整行完整落在容器可视区内**（第二版）：这一条在真机上必红，而且红得没道理。
       *    实测（1440 档、22 行、列表卡片高 2773px）：滚到底时最后一行的 top=-112、
       *    bottom=109，容器可视区 [40, 578] —— 于是"整行在区内"永远不成立。
       *    原因不是排版坏了，而是**列表下面还有东西**：总量条、风险分账、说明、确认区。
       *    滚到底本来就该看见它们，列表的末行此时只剩一截（底边 109）是正常的。
       *    「整行可见」只在"列表是这一页最后一个东西"时才该成立，而这一页不是。
       *
       * ③ 只查"能滚"（scrollTop 变了）：那会放过"滚到底了但列表末尾在裁剪区里"那一族。
       *
       * 所以现在的判据是这两条的合取：**真的滚动了** 且 **末行有可见部分**。
       * 前者挡"根本没有滚动容器"，后者挡"滚动区域没把列表包全"。
       */
      const before = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      const after = scroller.scrollTop;
      const sr = scroller.getBoundingClientRect();
      /**
       * 判据：**列表末行能被滚到看得见** —— 做法是把它滚进视野，再看它是否真的进来了。
       *
       * 四版判据都在真机上量过，前三版的红**全是判据自己的错**，逐条记下来最省事：
       *
       * ① 用 innerHeight 当可视区：容器上面压着 40px 标题条，可视区是 [40, 578] 而非 [0, 578]；
       *    而且对"滚过了头"是瞎的（末行 top=-671 时 top < innerHeight 照样成立）。
       * ② 要求末行**整行**落在容器可视区内：1440 档就红（末行 top=-112 / bottom=109，
       *    只剩 55px 露着）。那不是排版坏了 —— 它下面还有总量条、风险分账、说明、确认区。
       * ③ 要求"滚到底时列表与可视区有交集"：880 档红（列表 bottom=-224，整块滚过去了）。
       *    也不是坏的。实测这一页滚到底那一屏上依次是：总量条 77px + 分账 51px +
       *    说明 50px + **禁止根那一大段长文 347px** + 确认区 76px ≈ 601px，
       *    而 880 档的容器可视高度只有 532px —— 也就是说**这一页最底部那几块加起来比一屏还高**，
       *    滚到底时列表当然已经滚过去了。列表不可能是"滚到底还能看见"的那个东西。
       *
       * 所以判据改成：**把末行滚进视野**（scrollIntoView），再判它真的进了容器可视区。
       * 这问的才是"能不能滚到列表末尾"，而且与"列表下面还有多少东西"无关。
       * 前置那一句 after > before + 1 继续留着：它挡"根本没有滚动容器"。
       */
      last.scrollIntoView({ block: 'end' });
      const lr = last.getBoundingClientRect();
      const rowVisible = Math.max(0, Math.min(lr.bottom, sr.bottom) - Math.max(lr.top, sr.top));
      // 可见高度至少要有半行（窄窗里一行可以很高，半行是"读得到这一行是什么"的下限）
      const rowH = lr.height;
      const inView = rowVisible >= Math.min(rowH * 0.5, 40);
      scrollY = {
        ok: after > before + 1 && inView,
        scrolledPx: Math.round(after - before),
        lastRowVisiblePx: +rowVisible.toFixed(1),
        lastRowHeight: +rowH.toFixed(1),
        lastRowTop: +lr.top.toFixed(1),
        viewportTop: +sr.top.toFixed(1),
        viewportBottom: +sr.bottom.toFixed(1),
        via: scroller.tagName.toLowerCase() + '.' + String(scroller.className).slice(0, 40),
        why: after > before + 1
          ? inView
            ? ''
            : '把末行滚进视野之后仍看不见它（可见 ' + rowVisible.toFixed(1) + 'px / 行高 ' + rowH.toFixed(1) + 'px，容器 [' + sr.top.toFixed(1) + ', ' + sr.bottom.toFixed(1) + ']）'
          : '程序化滚动没有动',
      };
      scroller.scrollTop = before; // 复原，别把后面量几何的样本滚跑
    }
  }
  if (!scrollY.ok) problems.push('纵向滚不到列表末尾：' + scrollY.why);

  return {
    innerW, dpr: devicePixelRatio,
    hasStats: !!stats, statsBox: stats ? box(stats) : null,
    rows: rows.length, selectedRows: selectedRows.length,
    alignSkew: +alignSkew.toFixed(1), overflowPx, cbSize,
    scrollY,
    wantSelected: ${WANT_SELECTED},
    problems,
    ok: problems.length === 0,
  };
})()`

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

  /**
   * `--wait-scan`：等 `DC_AUTOSCAN` 那轮扫完，再切到清理页并等重新计价落地。
   *
   * 为什么放在本文件而不是另开一支脚本：那三件事与几何采样共用同一条 CDP 连接。
   * 拆成两个进程各连一次的话，两次连接之间的"重建计价"会让它们量的不是同一份画面
   * （清单一变，行数与列宽都可能变）。而且这一支在 debug 版上靠环境变量起扫描，
   * 在 release 版上由调用方先驱动首页 —— 探针只认"现在可以量了"这一个前提。
   */
  if (WAIT_SCAN) {
    /**
     * `DC_AUTOSCAN` 那条线程要睡 1500 ms 才开扫（`main.rs`：等 WebView2 挂上前端事件没人接），
     * 而验收脚本起进程之后立刻连 CDP —— 所以最初几轮读到 `idle` 是**正常的**。
     *
     * 下面这个循环本来就只在**终态**（completed / failed / cancelled）才 break，`idle` 会继续等，
     * 所以它不需要额外处理。2026-10-23 在这里红过一次，红的样子是等满 300 轮之后 `status`
     * 仍是 `idle` —— 那不是"等得不够"，是**扫描根本没起来**（`DC_AUTOSCAN` 没生效或
     * `volume_of` 失败，后者的原因只打在进程 stderr 上）。调用方必须把 stderr 收下来，
     * 否则这条红会一直长得像"扫描太慢"。
     */
    let status = ''
    for (let i = 0; i < 600; i++) {
      status = await evaluate('window.__dc ? window.__dc.status() : "no-scaffold"')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') break
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('SCAN_STATUS ' + status)
    if (status !== 'completed') {
      throw new Error(
        '扫描没跑完（status=' + status + '）。若一直是 idle ⇒ 扫描没起来，去看进程 stderr 里那行 [dc] DC_AUTOSCAN'
      )
    }
    await evaluate(`window.__dc.view('cleanup')`)
    await new Promise((r) => setTimeout(r, 1500))
    let ready = null
    for (let i = 0; i < 90; i++) {
      ready = await evaluate(`(() => ({
        rows: document.querySelectorAll('.dc-clean-row').length,
        loading: !!document.querySelector('.dc-revalue'),
        title: !!document.querySelector('.dc-clean-title'),
      }))()`)
      if (ready.rows > 0 && !ready.loading && ready.title) break
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('CLEANUP_READY ' + JSON.stringify(ready))
    if (!(ready && ready.rows > 0 && !ready.loading && ready.title)) {
      throw new Error('清理页没就绪：' + JSON.stringify(ready))
    }
  }

  const r = await send('Runtime.evaluate', { expression: PROBE, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  const row = { physicalWindowWidth: PHYS || null, ...r.result.result.value }

  /**
   * 数字列**念出来的字**。几何判据说不了这条：`text-overflow: ellipsis` 让盒子宽度
   * 完全正确，而内容读不全（「345.0 M…」的盒子与「345.0 MB」逐像素同宽）。
   *
   * 两条判据：①`scrollWidth > clientWidth` 说明真被裁了；②念出来的字必须合
   * `formatBytes` 的形状（带单位，或「—」表示未计入，或纯整数表示文件数）。
   * 真机上这一条抓过一次：夹具里全是 0 B，看不出列宽够不够 —— 有真实字节才量得出来。
   */
  const numbers = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.dc-clean-row')];
    return {
      stats: [...document.querySelectorAll('.dc-clean-stat-value')].map((e) => e.textContent.trim()),
      rows: rows.map((row) => {
        const cells = [...row.querySelectorAll('.dc-clean-row-num')];
        return {
          name: (row.querySelector('.dc-clean-name') || {}).textContent,
          text: cells.map((c) => c.textContent.trim()),
          clipped: cells.map((c) => c.scrollWidth > c.clientWidth + 1),
        };
      }),
    };
  })()`)
  console.log('STATS ' + JSON.stringify(numbers.stats))
  const numProblems = []
  for (const n of numbers.rows) {
    if (n.clipped.some(Boolean)) numProblems.push(`「${n.name}」有数字被省略号截断：${JSON.stringify(n.text)}`)
    for (const c of n.text) {
      if (c === '—') continue
      if (!/^(0 B|[\d.,]+ (B|KB|MB|GB|TB)|\d+)$/.test(c)) numProblems.push(`「${n.name}」念出来的数不是 formatBytes 的形状：${JSON.stringify(c)}`)
    }
  }
  // 只报一次全文（22 行太长），异常才逐条点名
  console.log('NUMBERS ' + numbers.rows.map((n) => n.text.join(' / ')).slice(0, 3).join('  |  ') + (numbers.rows.length > 3 ? ` …共 ${numbers.rows.length} 行` : ''))
  if (numProblems.length > 0) {
    for (const p of numProblems) console.log('  X ' + p)
    row.ok = false
    row.problems = [...(row.problems || []), ...numProblems]
  }

  console.log(
    `LAYOUT phys=${PHYS} cssViewport=${row.innerW} 统计带=${row.hasStats} 行数=${row.rows}（勾上 ${row.selectedRows}）` +
      ` 对齐偏差=${row.alignSkew}px 溢出=${row.overflowPx}px 勾选框=${JSON.stringify(row.cbSize)}`
  )
  console.log(
    `SCROLL 可纵向滚=${row.scrollY.ok} 滚了=${row.scrollY.scrolledPx ?? '—'}px 末行可见=${row.scrollY.lastRowVisiblePx ?? '—'}/${row.scrollY.lastRowHeight ?? '—'}px` +
      ` 容器可视=[${row.scrollY.viewportTop ?? '—'}, ${row.scrollY.viewportBottom ?? '—'}] via=${row.scrollY.via ?? '—'}` +
      (row.scrollY.ok ? '' : '  原因=' + row.scrollY.why)
  )
  if (!row.ok) {
    for (const p of row.problems) console.log('  X ' + p)
    ws.close()
    process.exitCode = 1
    return
  }
  ws.close()

  if (OUT) {
    let prev = []
    if (existsSync(resolve(OUT))) {
      try {
        prev = JSON.parse(readFileSync(resolve(OUT), 'utf8')).rows || []
      } catch {
        prev = []
      }
    }
    writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), rows: [...prev, row] }, null, 2))
    console.log('APPENDED ' + OUT)
  }
}
await main()
