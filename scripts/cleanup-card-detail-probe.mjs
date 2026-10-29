// 清理页 2026-10-23 那一改（卡片等高 / 风险与占用居中 / 最简详情 + 查看详情框 / 删副标题）的几何探针。
//
// 为什么必须量几何：这一改的四条全是**像素里的事** —— 等高差 0 px、数字与药丸的中心线对齐、
// 摘要真的只有一行（省略号生效）、详情框真的浮在最上层且能关。截图看得见"像不像"，
// 但"两个中心差 3.7 px"这种事只有 getBoundingClientRect 说得清。所以判据是数字，截图只是旁证。
//
// 通道与 `cleanup-layout-probe.mjs` 完全一致：WebView2 CDP，端口由启动环境注入。
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const PORT = Number(arg('port', '9231'))
const OUT = arg('out', '')

/**
 * 页面里跑的那段。**只用标准 DOM API**。
 *
 * 三组判据，各自量各自的事：
 *  ① 等高：所有行高度两两之差 ≤ 1 px（`grid-auto-rows: 1fr` 的产物）；
 *  ② 居中：每行里风险药丸、三个数字的中心线，与该行内容块（`.dc-clean-row-main`）的中心线
 *     之差 ≤ 1.5 px（容差与 `scale-probe` 同一个理由：DPR 1.5 下 subpixel 会落到 1/3 px）；
 *     同时**反向**量一次"偏上"：若它们仍贴在第一行顶部，中心线会差出十几像素，这条必须红；
 *  ③ 详情：点「查看详情」之后框在 DOM 里、是 role=dialog、宽度合理、Esc/遮罩能关。
 */
const PROBE = `(() => {
  const problems = [];
  const warns = [];
  const q = (s) => [...document.querySelectorAll(s)];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), top: +(r.top).toFixed(1), bottom: +(r.bottom).toFixed(1), cy: +((r.top + r.bottom) / 2).toFixed(1) };
  };

  // ---- 副标题必须已经删掉（图二上方那句话）----
  const sub = document.querySelector('.dc-clean-sub');
  if (sub) problems.push('副标题 .dc-clean-sub 还在：' + (sub.textContent || '').trim());

  // ---- 列表与行 ----
  const rowsEl = q('.dc-clean-row');
  if (rowsEl.length === 0) {
    return { ok: false, problems: problems.concat(['一行 .dc-clean-row 都没有']), rows: 0 };
  }

  // ---- ① 等高 ----
  const heights = rowsEl.map((r) => +r.getBoundingClientRect().height.toFixed(1));
  const maxH = Math.max(...heights), minH = Math.min(...heights);
  const heightSpread = +(maxH - minH).toFixed(1);
  /**
   * 容差 1 px：1fr 在自动高度的 grid 里做的是等分，浏览器会留亚像素余数，
   * 相邻行能差 0.–1 px。差出 2 px 以上才是"没等高"。
   */
  if (heightSpread > 1) problems.push('行高不一致：最高 ' + maxH + ' / 最矮 ' + minH + '（差 ' + heightSpread + 'px）');

  // ---- ② 居中 ----
  // 每行量三样：内容块中心、风险药丸中心、数字组中心。取最差的一行报出来。
  let worstRisk = 0, worstNums = 0, worstRow = null;
  const centers = [];
  for (const [i, el] of rowsEl.entries()) {
    const main = el.querySelector('.dc-clean-row-main');
    const risk = el.querySelector('.dc-clean-row-risk');
    const nums = el.querySelector('.dc-clean-row-nums');
    if (!main || !risk || !nums) { problems.push('第 ' + i + ' 行缺格：' + JSON.stringify({ main: !!main, risk: !!risk, nums: !!nums })); continue; }
    const mb = box(main), rb = box(risk), nb = box(nums);
    const dr = Math.abs(rb.cy - mb.cy), dn = Math.abs(nb.cy - mb.cy);
    centers.push({ i, mainCy: mb.cy, riskCy: rb.cy, numsCy: nb.cy, dr: +dr.toFixed(1), dn: +dn.toFixed(1) });
    if (dr > worstRisk) { worstRisk = dr; worstRow = i; }
    if (dn > worstNums) { worstNums = dn; worstRow = i; }
  }
  if (worstRisk > 1.5) problems.push('风险药丸没纵向居中：第 ' + worstRow + ' 行中心线差 ' + worstRisk.toFixed(1) + 'px');
  if (worstNums > 1.5) problems.push('数字列没纵向居中：第 ' + worstRow + ' 行中心线差 ' + worstNums.toFixed(1) + 'px');

  // ---- 摘要必须只有一行（省略号生效）----
  const descs = q('.dc-clean-row-desc');
  const multiLine = [];
  for (const d of descs) {
    const lh = parseFloat(getComputedStyle(d).lineHeight) || 16;
    const h = d.getBoundingClientRect().height;
    if (h > lh * 1.6) multiLine.push({ text: (d.textContent || '').slice(0, 24), h: +h.toFixed(1), lh });
  }
  if (multiLine.length > 0) problems.push('有 ' + multiLine.length + ' 条摘要换成了多行（最简模式失效）：' + JSON.stringify(multiLine.slice(0, 3)));

  // 每条摘要必须念出字（空串会让这一行看起来"没内容"，而它是"最简模式"而不是"空"）
  const emptyDesc = descs.filter((d) => (d.textContent || '').trim() === '').length;
  if (emptyDesc > 0) problems.push('有 ' + emptyDesc + ' 条摘要一个字都没有');

  // ---- 「查看详情」每行都在，且尺寸不是 0 ----
  const more = q('.dc-clean-more');
  if (more.length !== rowsEl.length) problems.push('「查看详情」有 ' + more.length + ' 个，行有 ' + rowsEl.length + ' 行（不是一一对应）');
  const tiny = more.filter((b) => { const r = b.getBoundingClientRect(); return r.width < 20 || r.height < 8; });
  if (tiny.length > 0) problems.push('有 ' + tiny.length + ' 个「查看详情」被挤到几乎不可点');

  return {
    ok: problems.length === 0,
    rows: rowsEl.length,
    heights: { max: maxH, min: minH, spread: heightSpread },
    worstRiskDelta: +worstRisk.toFixed(1),
    worstNumsDelta: +worstNums.toFixed(1),
    worstRow,
    centers: centers.slice(0, 4),
    descLines: multiLine.length,
    moreCount: more.length,
    problems,
    warns,
  };
})()`

/** 点开第一个「查看详情」，量那个框；再按 Esc 关掉并确认它真的没了。 */
const OPEN = `(() => {
  const b = document.querySelector('.dc-clean-more');
  if (!b) return { ok: false, why: '找不到「查看详情」' };
  b.click();
  return { ok: true, name: (b.getAttribute('aria-label') || '') };
})()`

const INSPECT = `(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return { ok: false, why: '点开之后 DOM 里没有 role=dialog 的框' };
  const r = d.getBoundingClientRect();
  const mask = d.closest('.dc-modal-mask');
  const inView = r.top >= -1 && r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  // 框里必须念出那条规则的完整文案，且不许是空壳
  const txt = (d.textContent || '');
  const hasOccupancy = /占用/.test(txt) && /计入预估/.test(txt);
  const hasRoots = /目录（\\d+ 个）/.test(txt);
  const closeBtn = d.querySelector('.dc-modal-x');
  return {
    ok: true,
    w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    top: +r.top.toFixed(1), left: +r.left.toFixed(1),
    inView, hasMask: !!mask,
    ariaModal: d.getAttribute('aria-modal'),
    hasOccupancy, hasRoots,
    hasClose: !!closeBtn,
    title: (d.querySelector('.dc-modal-title') || {}).textContent || '',
    len: txt.length,
  };
})()`

/**
 * 头部三件套的**几何关系**（2026-10-23 第二轮：「这里标签出现了重合现象」）。
 *
 * 判据是**两两不相交**，而不是"看着有点空隙"：风险药丸、标题文字、× 按钮三个矩形，
 * 任意两个的交集面积必须为 0。这一条只能量，说不清 —— 真机上它们叠在一起时，
 * DOM 结构与类名都完全正常（药丸确实在头部那一行里），差异只在 rect 上。
 */
const HEAD = `(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return { ok: false, why: '详情框不在 DOM 里' };
  const name = (s) => d.querySelector(s);
  const badge = name('.dc-clean-detail-title .dc-badge');
  const title = name('.dc-modal-title');
  const close = name('.dc-modal-x');
  if (!badge || !title || !close) {
    return { ok: false, why: '头部缺元素：' + JSON.stringify({ badge: !!badge, title: !!title, close: !!close }) };
  }
  const R = (el) => { const b = el.getBoundingClientRect(); return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1) }; };
  const inter = (a, b) => {
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (w > 0 && h > 0) ? +(w * h).toFixed(1) : 0;
  };
  const bd = R(badge), ti = R(title), cl = R(close);
  /**
   * **药丸内部**：圆点与文字两个矩形不许相交（2026-10-23 人类伙伴第三次指同一件事）。
   *
   * 这一条是本轮真正缺的那块判据。前两轮量的都是"药丸 / 标题 / × 三者之间"的位置，
   * 而缺陷长在**药丸里面**：圆点是 inline-block，父级没有 flex 接管时
   * 它与文字同在一条行内流里，被基线与行高挤到一起 —— 圆点压在「安」字左半边。
   *
   * 判据取两件事：
   *  ① 两个矩形的交集面积为 0（不许压字）；
   *  ② 圆点中心线与文字中心线之差 ≤ 1px（不许一高一低 —— 那是"没压上但歪着"）。
   */
  const dot = badge.querySelector('.dc-risk-dot');
  let dotInfo = null;
  if (dot) {
    const dd = R(dot);
    // 文字部分：把药丸里除圆点以外的内容节点逐个量，取并集
    const textRects = [...badge.childNodes]
      .filter((n) => n !== dot && (n.nodeType === 1 || (n.textContent || '').trim() !== ''))
      .map((n) => {
        if (n.nodeType === 1) return R(n);
        const range = document.createRange();
        range.selectNodeContents(n);
        const b = range.getBoundingClientRect();
        return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1), w: +b.width.toFixed(1) };
      })
      .filter((b) => b.w > 0);
    const union = textRects.length
      ? {
          l: Math.min(...textRects.map((b) => b.l)),
          r: Math.max(...textRects.map((b) => b.r)),
          t: Math.min(...textRects.map((b) => b.t)),
          b: Math.max(...textRects.map((b) => b.b)),
          w: 0,
        }
      : null;
    dotInfo = union
      ? {
          dot: dd,
          text: union,
          overlap: inter(dd, union),
          gap: +(union.l - dd.r).toFixed(1),
          centerDelta: +Math.abs((dd.t + dd.b) / 2 - (union.t + union.b) / 2).toFixed(1),
          dotSize: [dd.w, dd.b - dd.t],
        }
      : { dot: dd, text: null, why: '药丸里只有一个圆点、没有文字' };
  }
  /**
   * × 必须在**框的右上角**，不是浮在中间。
   *
   * 这一条是"过度修正"的探针：修重合时第一版把整块的 flex: 1 也一起撤了，
   * 于是药丸不压 × 了，但 × 紧紧贴在药丸后面、孤零零悬在框中间（真机截图看到的）。
   * 判据取 × 右缘到框内边（right 减去 paddingRight）的距离。
   */
  const dcs = getComputedStyle(d);
  const padR = parseFloat(dcs.paddingRight) || 0;
  const dbox = d.getBoundingClientRect();
  const closeToRight = +(dbox.right - padR - cl.r).toFixed(1);
  return {
    ok: true,
    badge: bd, title: ti, close: cl,
    dotInfo,
    badgeDisplay: getComputedStyle(badge).display,
    badgeAlign: getComputedStyle(badge).alignItems,
    overlapBadgeClose: inter(bd, cl),
    overlapBadgeTitle: inter(bd, ti),
    overlapTitleClose: inter(ti, cl),
    // 药丸右缘到 × 左缘之间那条缝（正数=分开了）
    gapBadgeClose: +(cl.l - bd.r).toFixed(1),
    badgeInsideRow: bd.r <= cl.l + 0.5,
    closeToRight,
    closeTopGap: +(cl.t - (dbox.top + (parseFloat(dcs.paddingTop) || 0))).toFixed(1),
  };
})()`

/**
 * 导航选中态的高光有没有露到圆角外（2026-10-23 第二轮：「选择框上有高光露出来了」）。
 *
 * 判据取**计算样式**而不是像素：露出来的根因是 `inset 0 1px 0` 描的是盒子顶边。
 * 所以这里查两件事 ——
 *  ① 选中态那条规则里还有没有 `inset 0 1px 0` 这种盒子级顶沿高光（`boxShadow` 里能读到字符串）；
 *  ② `overflow` 是不是 `hidden`（圆角裁剪的保险）。
 * 再加一条几何：胶囊的实际渲染盒必须在自己祖先的可视区内（`overflow:hidden` 生效时它不会被裁变形）。
 */
const NAV = `(() => {
  const el = document.querySelector('.dc-nav-on');
  if (!el) return { ok: false, why: '没有选中态的导航项' };
  const cs = getComputedStyle(el);
  return {
    ok: true,
    boxShadow: cs.boxShadow,
    overflow: cs.overflow,
    radius: cs.borderRadius,
    hasBoxTopHighlight: /inset 0px? 1px 0px?/.test(cs.boxShadow) || /inset 0 1px 0/.test(cs.boxShadow),
    label: (el.textContent || '').trim(),
  };
})()`

/**
 * 字体与 logo 实际生效的证据（2026-10-23 第二轮）。
 *
 * 字体这一条**必须量渲染后的 built 字体族**：`document.fonts.check()` 会告诉你
 * "能不能用"，而 `getComputedStyle().fontFamily` 只告诉你"声明了什么"。
 * 两者都不够 —— 真正要证的是"那段拉丁文字确实用 DM Sans 排出来了"，
 * 所以取 `document.fonts` 里每个 face 的 `status`（loaded 才说明文件真的加载成功）。
 * 路径写错时它会是 `error`（本仓刚撞过一次：构建成功但产物里没有 woff2）。
 */
const THEME = `(() => {
  const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/"/g, ''), weight: f.weight, status: f.status }));
  const loaded = faces.filter((f) => f.status === 'loaded');
  const errored = faces.filter((f) => f.status === 'error');
  const body = getComputedStyle(document.body).fontFamily;
  const brandIcon = document.querySelector('.dc-brand-icon');
  const brandWord = document.querySelector('.dc-brand-logo');
  const titleEl = document.querySelector('.dc-clean-title');
  const shot = (el) => el ? {
    src: el.getAttribute('src'),
    natural: [el.naturalWidth, el.naturalHeight],
    rendered: (() => { const b = el.getBoundingClientRect(); return [+b.width.toFixed(1), +b.height.toFixed(1)]; })(),
    complete: el.complete,
    alt: el.getAttribute('alt'),
    draggable: el.draggable,
  } : null;
  return {
    ok: true,
    faceCount: faces.length,
    loadedFamilies: [...new Set(loaded.map((f) => f.family))],
    erroredFamilies: [...new Set(errored.map((f) => f.family))],
    bodyFont: body,
    monoFont: getComputedStyle(document.querySelector('.dc-mono') || document.body).fontFamily,
    titleFont: titleEl ? getComputedStyle(titleEl).fontFamily : null,
    brandIcon: shot(brandIcon),
    brandWord: shot(brandWord),
  };
})()`

/** Esc 关：`document.dispatchEvent` 不够 —— 监听挂在 document 上，必须发真的 keydown。 */
const CLOSE_ESC = `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { left: document.querySelectorAll('[role="dialog"]').length };
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
    if (r.result?.exceptionDetails) throw new Error('页面里抛了：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
    return r.result.result.value
  }

  const layout = await evaluate(PROBE)
  // 字体/logo/导航高光：不需要开框，先量（开框之后遮罩会挡住导航）
  const theme = await evaluate(THEME)
  const nav = await evaluate(NAV)
  const opened = await evaluate(OPEN)
  await new Promise((r) => setTimeout(r, 350))
  const dialog = await evaluate(INSPECT)
  const head = await evaluate(HEAD)
  // 截图要的是"框开着的这一相"，所以这里不关，交给调用方拍完再关
  console.log('DIALOG_OPEN ' + JSON.stringify(opened))
  console.log('DIALOG ' + JSON.stringify(dialog))
  console.log('HEAD ' + JSON.stringify(head))
  console.log('NAV ' + JSON.stringify(nav))
  console.log('THEME ' + JSON.stringify(theme))

  const themeProblems = []
  // ---- 字体：文件必须真的加载成功（路径写错时是 error，而构建不会报错）----
  const wantFamilies = ['DM Sans', 'DM Serif Display', 'Poppins', 'JetBrains Mono']
  for (const fam of wantFamilies) {
    if (!theme.loadedFamilies.includes(fam)) {
      themeProblems.push('字体族「' + fam + '」没有加载成功（已加载的是 ' + JSON.stringify(theme.loadedFamilies) + '）')
    }
  }
  if (theme.erroredFamilies.length > 0) {
    themeProblems.push('有字体加载失败：' + JSON.stringify(theme.erroredFamilies))
  }
  if (!/DM Sans/.test(theme.bodyFont)) themeProblems.push('body 的字体族里没有 DM Sans：' + theme.bodyFont)
  if (!/JetBrains Mono/.test(theme.monoFont)) themeProblems.push('.dc-mono 的字体族里没有 JetBrains Mono：' + theme.monoFont)
  if (theme.titleFont && !/DM Serif Display/.test(theme.titleFont)) {
    themeProblems.push('页面大标题的字体族里没有 DM Serif Display：' + theme.titleFont)
  }

  // ---- 左上角品牌位：图标 + 字标两张图都必须真的画出来 ----
  const checkBrandImg = (label, b, { needAlt }) => {
    if (!b) { themeProblems.push('左上角没有 ' + label + '（.dc-brand-* 找不到）'); return }
    if (!b.complete) themeProblems.push(label + ' 没加载完：' + b.src)
    if (b.natural[0] < 40) themeProblems.push(label + ' 原始尺寸异常：' + JSON.stringify(b.natural))
    if (b.rendered[0] < 8 || b.rendered[1] < 8) {
      themeProblems.push(label + ' 渲染尺寸异常（几乎看不见）：' + JSON.stringify(b.rendered))
    }
    if (needAlt && b.alt !== 'DeepClean') themeProblems.push(label + ' 的 alt 丢了：' + JSON.stringify(b.alt))
    if (b.draggable !== false) themeProblems.push(label + ' 还是可拖拽的（会拖出残影）')
  }
  checkBrandImg('品牌图标', theme.brandIcon, { needAlt: false })
  checkBrandImg('品牌字标', theme.brandWord, { needAlt: true })
  // 图标必须在字标左边、两者同一水平线（精修版是"图标 + 字标"横向组合）
  if (theme.brandIcon && theme.brandWord) {
    const i = theme.brandIcon.rendered, w = theme.brandWord.rendered
    if (i[1] > 0 && w[1] > 0 && Math.abs(i[1] - w[1]) > 12) {
      themeProblems.push('图标与字标高度差太多（' + i[1] + ' vs ' + w[1] + '）—— 看起来不像一组')
    }
  }

  // ---- 导航选中态高光 ----
  if (!nav.ok) themeProblems.push('导航：' + nav.why)
  else {
    if (nav.hasBoxTopHighlight) themeProblems.push('导航选中态还在用盒子级顶沿高光（inset 0 1px 0）—— 圆角处会露出来')
    if (nav.overflow !== 'hidden') themeProblems.push('导航选中态没有 overflow: hidden（高光没有第二道保险）：' + nav.overflow)
  }

  // ---- 详情框头部：药丸 / 标题 / × 两两不相交 ----
  const headProblems = []
  if (!head.ok) headProblems.push('详情框头部：' + head.why)
  else {
    if (head.overlapBadgeClose > 0) {
      headProblems.push('风险药丸压在 × 上：重叠 ' + head.overlapBadgeClose + 'px²（药丸右缘 ' + head.badge.r + '，× 左缘 ' + head.close.l + '）')
    }
    if (head.overlapBadgeTitle > 0) headProblems.push('风险药丸压在标题上：重叠 ' + head.overlapBadgeTitle + 'px²')
    if (head.overlapTitleClose > 0) headProblems.push('标题压在 × 上：重叠 ' + head.overlapTitleClose + 'px²')
    if (head.gapBadgeClose < 4) headProblems.push('药丸与 × 之间只剩 ' + head.gapBadgeClose + 'px（挤在一起了）')
    // 过度修正的探针：× 必须贴到框的右上角，不许浮在中间
    if (head.closeToRight > 2) {
      headProblems.push('× 没有贴到右上角：距框右内边还有 ' + head.closeToRight + 'px（它悬在中间）')
    }
    // 药丸**内部**：圆点不许压字（本轮的主缺陷）
    if (!head.dotInfo) headProblems.push('药丸里找不到圆点 `.dc-risk-dot`')
    else if (head.dotInfo.text) {
      if (head.dotInfo.overlap > 0) {
        headProblems.push(
          '圆点压在文字上：重叠 ' + head.dotInfo.overlap + 'px²（圆点右缘 ' + head.dotInfo.dot.r + '，文字左缘 ' + head.dotInfo.text.l + '）'
        )
      }
      if (head.dotInfo.gap < 2) {
        headProblems.push('圆点与文字之间只剩 ' + head.dotInfo.gap + 'px（挤在一起）')
      }
      if (head.dotInfo.centerDelta > 1) {
        headProblems.push('圆点与文字没对齐中线：差 ' + head.dotInfo.centerDelta + 'px')
      }
    }
    // 药丸本体必须是 flex：不是的话它随时会退回行内排版（上一版就是这么复发的）
    if (head.badgeDisplay !== 'inline-flex' && head.badgeDisplay !== 'flex') {
      headProblems.push('风险药丸不是 flex 容器（display=' + head.badgeDisplay + '）⇒ 圆点会退回行内流')
    }
  }

  const dialogProblems = []
  if (!dialog.ok) dialogProblems.push('详情框：' + dialog.why)
  else {
    if (!dialog.inView) dialogProblems.push('详情框不在视口内：' + JSON.stringify({ top: dialog.top, left: dialog.left, w: dialog.w, h: dialog.h }))
    if (!dialog.hasMask) dialogProblems.push('详情框没有遮罩（点空白处关不掉）')
    if (dialog.ariaModal !== 'true') dialogProblems.push('详情框缺 aria-modal="true"')
    if (!dialog.hasClose) dialogProblems.push('详情框没有 × 按钮')
    if (!dialog.hasOccupancy) dialogProblems.push('详情框里没有「占用 / 计入预估」两格')
    if (!dialog.hasRoots) dialogProblems.push('详情框里没有「目录（N 个）」那一块')
    if (dialog.w < 300) dialogProblems.push('详情框只有 ' + dialog.w + 'px 宽（内容读不开）')
  }

  /**
   * 关一下确认出口真的通（不然这是一个只能刷新页面才消失的框）。
   *
   * ⚠️ 判据只能看**落定后**的读数。第一版把 `CLOSE_ESC` 同步返回值也当判据，
   * 于是它必然报红：那次求值里 React 还没重渲染（state 更新是批处理的），
   * 同步读到的 `left` 还是 1，而 250 ms 之后真正的答案是 0。
   * 这正是本仓说过的那类错 —— 拿**过渡态**的读数当终态结论。
   * 所以这里只认延时之后的那一次。
   */
  await evaluate(CLOSE_ESC)
  await new Promise((r) => setTimeout(r, 350))
  const stillThere = await evaluate(`document.querySelectorAll('[role="dialog"]').length`)
  if (stillThere !== 0) dialogProblems.push('按 Esc 关不掉详情框（350ms 后还剩 ' + stillThere + ' 个）')

  console.log(
    `LAYOUT2026 行数=${layout.rows} 行高=${layout.heights ? layout.heights.min + '~' + layout.heights.max + '（差 ' + layout.heights.spread + 'px）' : '—'}` +
      ` 药丸中心差=${layout.worstRiskDelta ?? '—'}px 数字中心差=${layout.worstNumsDelta ?? '—'}px` +
      ` 摘要多行=${layout.descLines ?? '—'} 查看详情=${layout.moreCount ?? '—'}`
  )
  if (layout.centers) for (const c of layout.centers) console.log('  ROW ' + JSON.stringify(c))

  const problems = [...(layout.problems || []), ...dialogProblems, ...themeProblems, ...headProblems]
  if (problems.length > 0) {
    for (const p of problems) console.log('  X ' + p)
    ws.close()
    process.exitCode = 1
    return
  }
  ws.close()
  console.log('OK 等高 / 居中 / 最简摘要 / 详情框（开-看-关）全绿')
  console.log(
    `THEME_OK 字体=${JSON.stringify(theme.loadedFamilies)} 图标=${theme.brandIcon ? theme.brandIcon.rendered.join('x') : '—'}` +
      ` 字标=${theme.brandWord ? theme.brandWord.rendered.join('x') : '—'}` +
      ` 药丸-×缝=${head.gapBadgeClose ?? '—'}px 导航高光=${nav.hasBoxTopHighlight ? '越界' : '贴内沿'}`
  )

  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), layout, dialog, head, nav, theme }, null, 2))
    console.log('WROTE ' + OUT)
  }
}

await main()
