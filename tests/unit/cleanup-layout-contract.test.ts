/**
 * 清理页重构（2026-10-21，照图二那套版式）之后的**结构契约**闸。
 *
 * 这一轮换掉的是排版（表格 → 统计带 + 卡片列表），而这一页上有五条**别人在量**的形状，
 * 它们全都不在截图上：`--shot` 与十来个 `scripts/m*-e2e.ps1` 靠 UIA 找元素、读拼接文本。
 * 版式一改，最典型的坏法是"页面看起来更漂亮了，而某一棒 e2e 从此永远红在找不到元素上"，
 * 或者更糟——**它照样绿**，因为它找的那句话还在别处。
 *
 * 所以这里把五条逐条钉住，并且每条都写明是谁在读它：
 *  ① `.dc-clean-check` 包着 `input[type=checkbox]`，且 15×15 不许动
 *     （`global.css` 那段注释 + `m5-preview-e2e.ps1` 按 ControlType.CheckBox 取勾选框）；
 *  ② 「全选可清理项」这颗按钮还在，且仍走 `onSelectedChange(selectableIds)`
 *     （`m3-e2e-cleanup.ps1:155` 与 `m5k-cleanlog-e2e.ps1:193` 按名字等它不可点）；
 *  ③ 大号数字紧跟「预计释放」，形状是「…10.0 MB预计释放…」
 *     （`m5n-tile-dup-e2e.ps1:146` 的 `Read-Total` 正则）；
 *  ④ 「清理预览」「预计释放」两个地标仍在（`m5-preview` / `m5c-tile` / `m5f-perf` 用它们判"到了清理页"）；
 *  ⑤ 页头那颗 `.dc-cta` 的一键清理仍挂在 `.dc-clean-head` 里（`cleanup-one-click-button.test.ts` 那组的老判据，这里不重复，只守一条"没被挪进统计带"）。
 *
 * 为什么是源码闸而不是渲染闸：与 `cleanup-one-click-button.test.ts` 同一处先例 ——
 * `Cleanup` 是受控组件，挂载即发两条 IPC；而这里要钉的几条在 JSX 里就是字面量。
 * 真行为那一头由 `--shot` 与 e2e 在真实窗口上把守。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 剥注释：判据量的是实现，一句写着"旧表格已删"的注释不该把它喂饱。 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLEANUP = src('src/renderer/pages/Cleanup.tsx')
const CSS = src('src/renderer/styles/global.css')

describe('重构之后的版式契约：别人在量的五条形状都还在', () => {
  it('① 勾选框仍由 `.dc-clean-check` 包着（UIA 按 ControlType.CheckBox 取它，尺寸 15×15）', () => {
    // 段落里同时要出现这个类名与一个 checkbox —— 不要求紧邻，但要在同一段 JSX 里
    const block = /className="dc-clean-check"[\s\S]{0,600}?type="checkbox"/.exec(CLEANUP)
    expect(block, '勾选框脱离了 `.dc-clean-check` 包装 —— 那 20 几处按类名点击的步会点空').not.toBeNull()
    // 全局那条 15×15 的尺寸规则必须还在（这条是 `--shot` 的命中面积，不是审美）
    expect(CSS).toMatch(/input\[type='checkbox'\],\s*input\[type='radio'\]\s*\{[^}]*width:\s*15px/)
    expect(CSS).toMatch(/input\[type='checkbox'\],\s*input\[type='radio'\]\s*\{[^}]*height:\s*15px/)
  })

  it('② 「全选可清理项」还在，且仍然把 `selectableIds` 交回父级（两个 e2e 按名字等它）', () => {
    expect(CLEANUP, '「全选可清理项」不见了 —— m3 与 m5k 那一棒会永远等不到它').toContain('全选可清理项')
    expect(CLEANUP, '它必须仍然走 `onSelectedChange(selectableIds)`，不许改叫别的集合').toMatch(
      /onSelectedChange\(selectableIds\)/
    )
    expect(CLEANUP, '「清空勾选」也要在').toContain('清空勾选')
  })

  it('③ 大号数字紧跟「预计释放」：`Read-Total` 那条正则读的就是这个形状', () => {
    /**
     * 形状必须是**逐字同形的相邻兄弟**：
     *   `<div className="dc-clean-total-num dc-mono">{formatBytes(model.totalBytes)}</div>`
     *   紧跟 `<div className="dc-muted">` + 换行 + `预计释放 · {model.totalFiles} 个文件`
     *
     * 为什么要求这么死 —— `m5n-tile-dup-e2e.ps1:146` 的正则是
     * `([0-9.]+ ?(?:B|KB|MB|GB|TB))预计释放`，它读的是 UIA 拼起来的那串文本。
     * 要吃到这个形状，页面上必须**恰好有一处**是"数字在前、『预计释放』在后"。
     *
     * ⚠️ 两条都是实测踩出来的，写在这里免得下一个人（或下一个我）重犯：
     * 1. 第一版判据写成"两者之间 200 字符以内"，**变异不红** —— 全页另有两处「预计释放」
     *    （页头那句、以及这一格自己的第二行），宽窗口正则会滑过去命中。已收窄。
     * 2. 第一版的"变异"（在数字前面再插一句「预计释放」）**其实不是缺陷**：
     *    拼出来的文本是「预计释放306.7 MB预计释放 · N 个文件」，那条正则照样命中
     *    「306.7 MB预计释放」。真正的回归形态是**把数字改成标签之后**
     *    （「预计释放 306.7 MB」），于是全页再无"…MB预计释放"这一串 —— 见反面对照那条。
     */
    const shape =
      /<div className="dc-clean-total-num dc-mono">\{formatBytes\(model\.totalBytes\)\}<\/div>\s*<div className="dc-muted">\s*预计释放 · \{model\.totalFiles\} 个文件/.exec(
        CLEANUP
      )
    expect(
      shape,
      '「预计释放」前面不再紧挨着一个数字 —— m5n-tile-dup-e2e.ps1 的 Read-Total 会红在"读不出预估"上'
    ).not.toBeNull()
  })

  it('④ 两个页面地标仍在：「清理预览」标题与「预计释放」那句', () => {
    expect(CLEANUP).toContain('清理预览')
    expect(CLEANUP).toContain('预计释放')
    // 标题那一条类名（`m5c-tile` 等「清理预览」这四个字，`m5f-perf` 数它出现几次）
    expect(CLEANUP).toMatch(/<h2 className="dc-page-title dc-clean-title">清理预览<\/h2>/)
  })

  it('⑤ 页头把它自己的形状保住了：`.dc-clean-head` 里同时有标题与那一颗 `.dc-cta`', () => {
    const headStart = CLEANUP.indexOf('className="dc-clean-head"')
    expect(headStart, '页头那一行不见了').toBeGreaterThan(-1)
    const titleAt = CLEANUP.indexOf('dc-clean-title', headStart)
    const ctaAt = CLEANUP.indexOf('dc-cta', headStart)
    expect(titleAt, '页头里找不到标题').toBeGreaterThan(headStart)
    expect(ctaAt, '「一键清理」那颗 `.dc-cta` 不在页头里了').toBeGreaterThan(titleAt)
  })

  /**
   * ⑥ 这一页**必须能纵向滚**（2026-10-21 人类伙伴：「这个页面目前无法滑动」）。
   *
   * 这一条只能钉"那三条声明还在"，**钉不住"真的能滚"** —— 后者要布局引擎，
   * 本仓 vitest environment 是 `node`，没有 jsdom。真判据在
   * `scripts/cleanup-layout-probe.mjs` 的 `scrollY` 那一格（找可滚祖先 + 滚到底 +
   * 末行进可视区），由 `cleanup-layout-e2e.ps1` 在真窗口上跑，三档各量一次。
   *
   * 这里省掉它零红：上一轮把 `.dc-table-wrap`（自带 `flex: 1; overflow: auto`）删掉时，
   * 1004 个用例一个都没响 —— 因为**没有任何一条判据在问"这一页能不能滚"**。
   * 现在两条都在：源码这条挡"被人删掉"，几何那条挡"写了但不管用"。
   */
  it('⑥ `.dc-clean` 必须带 flex:1 + min-height:0 + overflow:auto（缺一条就滚不动）', () => {
    const rule = /^\.dc-clean \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-clean` 那条规则').not.toBeNull()
    const body = rule![1]!
    expect(body, '没有 `flex: 1` ⇒ 它不是 flex 项，只有内容那么高，overflow 无从谈起').toMatch(/flex:\s*1/)
    expect(body, '没有 `min-height: 0` ⇒ flex 项 `min-height: auto` 让它不肯缩，会把父容器顶开').toMatch(
      /min-height:\s*0/
    )
    expect(body, '没有 `overflow: auto` ⇒ 长列表在窗口下方被直接裁掉').toMatch(/overflow:\s*auto/)
  })

  it('⑦ Loading：16 点动画，挂在居中舞台上（2026-10-21 第四轮：放中间放大、白色）', () => {
    // 类名一改，probe 的 `loading` 那一格永假 ⇒ 它会一路往下量，而页面可能还在等
    expect(CLEANUP, 'Loading 的根节点丢了 `.dc-revalue`').toMatch(/className="dc-revalue[^"]*"/)
    expect(CLEANUP, '⏳ 文案必须是 `Loading`（人类伙伴 2026-10-21 点名要的）').toContain('Loading')

    // 16 颗点用 Array.from 生成：手写 16 个 <div> 会让"少画一颗"变成静默的视觉缺陷
    expect(CLEANUP, '点的数量必须是 16（人类伙伴给的动画就是 16 颗）').toMatch(/LOADING_DOTS\s*=\s*16/)
    expect(CLEANUP, '点要用 Array.from({ length: LOADING_DOTS }) 生成').toMatch(/length:\s*LOADING_DOTS/)
    expect(CLEANUP, '点心要带 `dc-jump-dot`').toContain('dc-jump-dot')
    expect(CLEANUP, '动画容器要带 `dc-jump`').toContain('className="dc-jump"')

    // 第四轮：「首次打开 Loading 加特效放中间放大些，loading 用白色字体」
    expect(CLEANUP, '要挂在居中舞台上（.dc-revalue-stage）').toContain('dc-revalue-stage')

    // 三版之外的两件必须已经撤掉：进度条、以及更早那个通用旋转环
    expect(CSS, '旧的进度条还在：.dc-revalue-bar').not.toMatch(/\.dc-revalue-bar\s*\{/)
    expect(CSS, '旧的不确定态动画还在：dc-indeterminate').not.toContain('dc-indeterminate')
    expect(CSS, '上一版的旋转环还在：.dc-spinner').not.toMatch(/\.dc-spinner\s*\{/)
  })

  it('⑦b 16 点动画的几何照抄原作，且已放大成白色、居中', () => {
    // 原作那 16 条 nth-child：任意一条掉了，那一排的波就会断
    for (const n of [1, 5, 9, 13, 16]) {
      expect(CSS, `第 ${n} 颗点的排布丢了`).toMatch(new RegExp(`\\.dc-jump-dot:nth-child\\(${n}\\)\\s*\\{`))
    }
    // 三组关键变量：位置（bottom/right）、延迟（animation-delay）、缩放（uib-scale）
    expect(CSS, '变量 --uib-bottom 丢了（点的位置）').toMatch(/--uib-bottom:\s*-?[\d.]+%/)
    expect(CSS, '变量 --uib-right 丢了（点的位置）').toMatch(/--uib-right:\s*-?[\d.]+%/)
    expect(CSS, '变量 --uib-scale 丢了（点的大小渐变）').toMatch(/--uib-scale:\s*[\d.]+/)
    expect(CSS, '动画延迟丢了（不打散就是整排同时跳，看不出波浪）').toMatch(/animation-delay:\s*calc\(var\(--uib-speed\)/)
    expect(CSS, '跳跃关键帧丢了').toMatch(/@keyframes dc-jump\s*\{/)

    // 第四轮的两条硬要求：放大 + 白色
    expect(CSS, '点阵没放大（--uib-size 应 ≥ 48px，人类伙伴要求「放大些」）').toMatch(/--uib-size:\s*(4[89]|[5-9]\d|\d{3,})px/)
    expect(CSS, '点不是白色（人类伙伴要求白色）').toMatch(/--uib-color:\s*#fff(?:fff)?\b/)
    expect(CSS, '「Loading」那几个字不是白的').toMatch(/\.dc-revalue,[\s\S]{0,400}?color:\s*#fff/)
    // 居中舞台必须在（没有它，Loading 会退回"挂在工具栏里"那一版的位置）
    expect(CSS, '居中舞台的样式丢了（.dc-revalue-stage）').toMatch(/\.dc-revalue-stage\s*\{/)
  })

  it('⑧ 勾选框的显示走 `rowChecked(i, selected)`，不许直接读服务端的 `i.selected`（2026-10-25）', () => {
    /**
     * 人类伙伴报的缺陷：「点击勾选后会出现延迟，勾没显示出来，也未计入」。
     * 读出来的时序：`checked={i.selected}` 里的 `i.selected` 是服务端按 `selection` 算的，
     * 所以点击之后要**等一次 dc_preview 回包**勾才显示。回包慢一次就复现一次。
     *
     * 判据钉的是"显示这一层以本地勾选为准"：
     *  · 渲染前必须算出 `const checked = rowChecked(i, selected)`；
     *  · `checked=` 后面只许出现那个局部量，不许再直接出现 `i.selected`（那是修之前的形状）。
     * 行为那一层由 `cleanup-row-checked.test.tsx` 喂组合跑。
     */
    expect(CLEANUP, '渲染前没算 rowChecked —— 点击又要等服务端回包才显示').toMatch(
      /const checked = rowChecked\(i, selected\)/
    )
    expect(CLEANUP, '勾选框不再用那个本地量：checked 又直接读服务端字段了').toMatch(/checked=\{checked\}/)
    expect(CLEANUP, 'checked 又直接读服务端字段了：点击与显示之间会有一帧"没反应"').not.toMatch(
      /checked=\{i\.selected\}/
    )
    // 「计入预估」那一格**仍然只认服务端 `included`**：它必须与「预计释放」总数字同源
    // （`model.totalBytes` 的逐行拆分）。本地勾上而模型还没回包时这里显示「—」是诚实的 ——
    // 那一格的字节数还没算出来，先画一个数就是编（本地 `bytes` 此刻还是 0）。
    // 用户原话里"也未计入"指的是截图里那些行连勾都没有；勾显示了，回包后这一格自然跟上。
    expect(CLEANUP, '「计入预估」不读服务端 included 了 —— 它会与「预计释放」总数字分家').toMatch(
      /\{i\.included \? formatBytes\(i\.bytes\) : '—'\}/
    )
  })

  it('⑨ `settling` 门的是"用户动过勾选"，不是"程序自动填过"（2026-10-25）', () => {
    /**
     * 真机复现到的缺陷相：19 行 `checked:true`，而工具栏是「已勾 19 项 · 计入 0 项」，
     * 页面停在那里不动，直到用户点一下触发新回包才恢复。
     *
     * 成因读得出来：`settling` 原来写 `!autoFilled.current`，而 `autoFilled.current = true`
     * 与 `onSelectedChange(selectableIds)` 在**同一个 effect 里同一拍**执行 ⇒ 自动打勾之后
     * `settling` 恒 false，中间相（勾着但没有任何数字）直接画给用户。
     *
     * 正确形状：门的是 `userTouched.current` —— 它只被 `toggle` 与工具栏那两个按钮置位，
     * 自动打勾不碰它。于是自动打勾那一次仍被 Loading 盖住，而手动勾选之后不盖。
     */
    expect(CLEANUP, 'settling 又门在 autoFilled 上了 —— 自动打勾之后的中间相会直接画出来').toMatch(
      /const settling = Boolean\(model\) && !userTouched\.current && !modelMatchesSelection\(model, selected\)/
    )
    expect(CLEANUP, '找不到 userTouched 这个 ref —— settling 没有"用户动过"这一格可门').toMatch(
      /const userTouched = useRef\(false\)/
    )
    // 三个改勾选的入口都必须置位它（单条 toggle + 全选 + 清空）
    const touches = (CLEANUP.match(/touch\(\)/g) ?? []).length
    expect(touches, `三个改勾选的入口都要 touch()，实际只有 ${touches} 处`).toBeGreaterThanOrEqual(3)
    // 自动打勾那个 effect **不许**碰它（碰了就等价于把首屏那一路也关掉）
    const autoFillBlock = /const autoFilled = useRef\(false\)[\s\S]*?\n  \}/.exec(CLEANUP)
    expect(autoFillBlock, '自动打勾那个 effect 不见了').not.toBeNull()
    expect(autoFillBlock![0], '自动打勾的 effect 里碰了 userTouched —— 首屏中间相又盖不住了').not.toContain('touch()')
  })

  it('反面对照：这组判据对"退回旧表格"是红的（否则它只是把现状抄了一遍）', () => {
    const SHAPE =
      /<div className="dc-clean-total-num dc-mono">\{formatBytes\(model\.totalBytes\)\}<\/div>\s*<div className="dc-muted">\s*预计释放 · \{model\.totalFiles\} 个文件/

    /**
     * 变异一（**真回归**）：把那格改成"标签在前"——`<div>预计释放</div><div>{数字}</div>`。
     * 拼出来的文本从此是「预计释放306.7 MB · N 个文件」，全页再没有"…MB预计释放"这一串，
     * `Read-Total` 的正则会红。这一条必须红，否则上面那条判据是空壳。
     */
    const reverted = CLEANUP.replace(
      /<div className="dc-clean-total-num dc-mono">(\{formatBytes\(model\.totalBytes\)\})<\/div>\s*<div className="dc-muted">\s*预计释放 · \{model\.totalFiles\} 个文件/,
      '<div className="dc-muted">预计释放</div><div className="dc-clean-total-num dc-mono">$1</div><div className="dc-muted">· {model.totalFiles} 个文件'
    )
    expect(reverted, '变异没落下去 —— 下面那条断言是空过').not.toBe(CLEANUP)
    expect(SHAPE.test(reverted), '数字被挪到标签之后，而这条判据照样绿 ⇒ 它是空壳').toBe(false)
    expect(SHAPE.test(CLEANUP), '同一份正则对未变异的源码必须命中（否则上面那个 false 是假红）').toBe(true)

    // 变异二：勾选框脱离 `.dc-clean-check` 包装
    const unwrapped = CLEANUP.replace(/className="dc-clean-check"/g, 'className="dc-clean-check-unused"')
    expect(/className="dc-clean-check"[\s\S]{0,600}?type="checkbox"/.test(unwrapped)).toBe(false)

    /**
     * 变异三（**真回归**，就是 2026-10-21 那次"页面无法滑动"的形状）：
     * 把 `.dc-clean` 那三条滚动的声明摘掉，⑥ 必须红。
     */
    const noScroll = CSS.replace(
      /(\.dc-clean \{[\s\S]*?)flex:\s*1;[\s\S]*?min-height:\s*0;[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*auto;/,
      '$1'
    )
    expect(noScroll, '变异没落下去 —— 下面那条断言是空过').not.toBe(CSS)
    const ruleAfter = /^\.dc-clean \{([\s\S]*?)\n\}/m.exec(noScroll)
    expect(ruleAfter, '变异之后连规则块都找不到了，这条反面对照不成立').not.toBeNull()
    const bodyAfter = ruleAfter![1]!
    expect(/flex:\s*1/.test(bodyAfter) && /min-height:\s*0/.test(bodyAfter) && /overflow:\s*auto/.test(bodyAfter)).toBe(
      false
    )

    /** 变异四：Loading 文案改回旧字样 ⇒ ⑦ 的字面量那条必须红。 */
    expect(CLEANUP.replace(/Loading/g, '正在重新计价')).not.toContain('>Loading<')
  })
})
