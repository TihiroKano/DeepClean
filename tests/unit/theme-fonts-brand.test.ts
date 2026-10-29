/**
 * 2026-10-23 第二轮四条改动的契约（字体 / logo / 导航高光 / 详情框标签重合 / 卡片高度）。
 *
 * 这一组和 `cleanup-item-detail.test.tsx` 是同一族：本仓 vitest 是 `node` 环境、没有布局引擎，
 * 所以"像素里的事"只能钉两半 ——
 *  · **源码半**：结构、类名、声明在不在（这一组做的）；
 *  · **几何半**：真的量出 0 重叠、0 越界（`scripts/cleanup-card-detail-probe.mjs`，真窗口上跑）。
 * 只做源码半会漏掉"写了但不管用"，只做几何半则要起窗口才有反馈。两半都在才闭环。
 *
 * 每条都写清"它防的是哪个具体坏法"，因为这一轮里有一条（导航高光）恰恰是
 * **看起来完全合理的写法**造成的：`inset 0 1px 0` 描的是盒子顶边而不是边框形状，
 * 圆角只负责裁剪、不负责收边，于是角上会露出一小段亮线。
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 剥注释：一句写着"高光已改成贴内沿"的注释不该把判据喂饱。 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CSS = src('src/renderer/styles/global.css')
const FONTS = src('src/renderer/styles/fonts.css')
const APP = src('src/renderer/App.tsx')
const TAURI_MAIN = src('src/renderer/tauri-main.tsx')

describe('① 字体：Anthropic 风格 = 开源等效字体本地打包', () => {
  it('fonts.css 声明了那三个族，且每一支都指向本仓库内的 woff2', () => {
    for (const family of ['DM Sans', 'DM Serif Display', 'Poppins', 'JetBrains Mono']) {
      expect(FONTS, `字体族「${family}」没有声明`).toContain(`font-family: '${family}'`)
    }
    /**
     * 每一个 `url()` 都必须是**相对 `styles/fonts.css` 能走到的那个目录**。
     *
     * ⚠️ 这条判据是被一次真事故逼出来的：第一版写成 `url('./fonts/…')`，而这张表在
     * `styles/` 下 ⇒ 解析成 `styles/fonts/`，那个目录不存在。`vite build` **不报错**，
     * 只在 stderr 里留一句 "didn't resolve at build time, it will remain unchanged"，
     * 然后产物里一个 woff2 都没有 —— 界面照常渲染，只是全部回退到系统字体。
     * 也就是说：**字体没打包进去，而构建是成功的**。所以这里两个方向都钉：
     * 路径前缀正确 + 磁盘上真有那些文件。
     */
    const urls = [...FONTS.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]!)
    expect(urls.length, '一条 @font-face 都没有').toBeGreaterThan(5)
    expect(urls.filter((u) => !u.startsWith('../assets/fonts/')), '有字体指到了本仓库之外').toEqual([])
    expect(FONTS, '字体不许走 http(s) 远程地址').not.toMatch(/url\('https?:/)

    // 磁盘上真的有：路径写对但文件没下载，构建同样会静默回退
    for (const u of urls) {
      const abs = join(process.cwd(), 'src/renderer/styles', u)
      expect(existsSync(abs), `字体文件不存在：${u}（构建会静默回退到系统字体）`).toBe(true)
    }
  })

  it('`--font-ui` 里拉丁在前、中文在后（反了 DM Sans 就永远轮不到）', () => {
    const v = /--font-ui:\s*([^;]+);/.exec(CSS)
    expect(v, '找不到 `--font-ui` 变量').not.toBeNull()
    const stack = v![1]!
    const latin = stack.indexOf("'DM Sans'")
    const han = stack.indexOf("'Microsoft YaHei UI'")
    expect(latin, '`--font-ui` 里没有 DM Sans').toBeGreaterThan(-1)
    expect(han, '`--font-ui` 里没有中文字体').toBeGreaterThan(-1)
    expect(latin, '中文字体排在拉丁前面 —— 字母会被雅黑接走，打包的 DM Sans 白费').toBeLessThan(han)
  })

  it('入口里 fonts.css 在 global.css 之前加载（@font-face 要早于用到它的声明）', () => {
    const iFonts = TAURI_MAIN.indexOf("styles/fonts.css")
    const iGlobal = TAURI_MAIN.indexOf("styles/global.css")
    expect(iFonts, 'fonts.css 没被引入').toBeGreaterThan(-1)
    expect(iFonts, 'fonts.css 排在 global.css 之后 ⇒ 首帧会先按回退字形排版再重排').toBeLessThan(iGlobal)
  })

  it('body 真的用上了 `--font-ui`（只定义变量不引用等于没改）', () => {
    expect(CSS).toMatch(/font-family:\s*var\(--font-ui\)/)
    // 旧那串回退链必须撤掉：留着它等于"本机装了什么"重新成为运行时变量
    expect(CSS, '旧的 Segoe UI Variable 回退链还在').not.toContain("'Segoe UI Variable Text'")
  })

  it('**每一个** `--font-*` 变量都被引用（定义了没人用 = 字体文件白打包）', () => {
    /**
     * 真事故：`--font-brand: 'Poppins', …` 定义之后没有任何规则引用它。
     * 后果不是报错，而是**浏览器从不加载 Poppins 那五个 woff2** ——
     * 文件躺在产物里、构建全绿、界面照常，只是"字体优化"这件事根本没发生。
     * 真机探针靠 `document.fonts` 里 Poppins 一个 face 都不是 `loaded` 抓到的。
     *
     * 这条判据就是那件事的静态版：变量必须至少出现在一条 `font-family:` 里。
     * （定义那一行本身不算引用 —— 它写成 `--font-x: …`，不匹配 `font-family`。）
     */
    const declared = [...CSS.matchAll(/--font-([a-z]+):/g)].map((m) => m[1]!)
    expect(declared.length, '一个 `--font-*` 变量都没声明').toBeGreaterThanOrEqual(3)
    const used = [...CSS.matchAll(/font-family:\s*var\(--font-([a-z]+)\)/g)].map((m) => m[1]!)
    const unused = declared.filter((d) => !used.includes(d))
    expect(unused, '这些字体变量定义了但没人用 ⇒ 对应的字体文件不会被浏览器加载：' + JSON.stringify(unused)).toEqual([])
  })
})

describe('② 左上角品牌位：图标 + 字标（精修版）', () => {
  it('brand 位是**两张图**：图标 + 字标，指向打包素材', () => {
    expect(APP, '字标还是文字节点').not.toContain('dc-brand-name')
    expect(APP).toContain('dc-brand-icon')
    expect(APP).toContain('dc-brand-logo')
    expect(APP, '没有 import 图标').toMatch(/import appIcon from '\.\/assets\/app-icon\.png'/)
    expect(APP, '没有 import 字标').toMatch(/import brandLogo from '\.\/assets\/deepclean-wordmark\.png'/)
  })

  it('读屏语义：字标 alt="DeepClean"，图标 alt="" + aria-hidden（组合图只念一次）', () => {
    expect(APP, '字标丢了 alt').toMatch(/className="dc-brand-logo"[^>]*alt="DeepClean"/)
    expect(APP, '图标应当 alt="" 且 aria-hidden —— 否则读屏会把品牌名念两遍').toMatch(
      /className="dc-brand-icon"[^>]*alt=""[^>]*aria-hidden="true"/
    )
  })

  it('两张图都关掉默认拖拽（侧栏是拖窗区，否则拖出残影）', () => {
    expect(APP, '没关 draggable').toMatch(/dc-brand-icon[^>]*draggable=\{false\}/)
    expect(CSS, 'CSS 侧没关 -webkit-user-drag（图标）').toMatch(/\.dc-brand-icon \{[^}]*-webkit-user-drag:\s*none/)
    expect(CSS, 'CSS 侧没关 -webkit-user-drag（字标）').toMatch(/\.dc-brand-logo \{[^}]*-webkit-user-drag:\s*none/)
  })

  it('品牌行是横向 flex，图标不被压缩、字标可收缩', () => {
    const brand = /^\.dc-brand \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(brand, '找不到 `.dc-brand` 那条规则').not.toBeNull()
    expect(brand![1]!, '不是 flex ⇒ 图标与字标会各占一行').toMatch(/display:\s*flex/)
    const icon = /^\.dc-brand-icon \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(icon![1]!, '图标没有 flex: none ⇒ 窄栏里会被压扁').toMatch(/flex:\s*none/)
    const logo = /^\.dc-brand-logo \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(logo![1]!, '字标没有 min-width: 0 ⇒ 撑破侧栏').toMatch(/min-width:\s*0/)
  })

  it('原来那套渐变字规则整条撤掉（节点没了，规则留着会被下一个人照抄回去）', () => {
    expect(CSS, '`.dc-brand-name` 规则还在').not.toMatch(/\.dc-brand-name\s*\{/)
    expect(CSS, '`background-clip: text` 那套还在').not.toMatch(/-webkit-text-fill-color:\s*transparent/)
  })

  it('`.dc-brand-logo` 的样式只有一条（上一轮留过一条重复的老规则，两处会分叉）', () => {
    const n = [...CSS.matchAll(/^\.dc-brand-logo \{/gm)].length
    expect(n, '出现 ' + n + ' 条 `.dc-brand-logo` 规则').toBe(1)
  })
})

describe('③ 导航选中态的高光不许露到圆角外', () => {
  it('顶沿高光改成贴内沿的一圈，不再用 `inset 0 1px 0`', () => {
    const rule = /^\.dc-nav-on \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-nav-on` 那条规则').not.toBeNull()
    const body = rule![1]!
    expect(body, '还在用 `inset 0 1px 0` —— 它描的是盒子顶边，圆角处会露出来').not.toMatch(/inset 0 1px 0/)
    expect(body, '没有贴内沿的那条（描边要跟着 border-radius 一起收圆）').toMatch(/inset 0 0 0 1px/)
    expect(body, '没有 overflow: hidden 这道保险').toMatch(/overflow:\s*hidden/)
  })
})

describe('④ 详情框头部：风险药丸不许压在 × 上，× 也不许被挤到行中间', () => {
  it('**整块**吃满中间（× 才留在右上角）', () => {
    const rule = /^\.dc-clean-detail-title \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-clean-detail-title` 那条规则').not.toBeNull()
    expect(
      rule![1]!,
      '整块不伸缩 ⇒ × 会紧贴在药丸后面，浮在框中间而不是右上角'
    ).toMatch(/flex:\s*1 1 auto/)
  })

  it('**标题文字**不伸缩（药丸才紧跟在标题后面，而不是被推到行尾）', () => {
    /**
     * ⚠️ 这两条是同一个缺陷的两半，必须一起看：
     *  · 只让"整块"伸缩、"标题"也伸缩 ⇒ 标题吃满整块、药丸被推到自己那块的最右端，
     *    正好落在 × 上 —— 这就是 2026-10-23 人类伙伴看到的「标签重合」；
     *  · 只让"标题"伸缩、整块不伸缩 ⇒ 药丸与 × 挨在一起浮在框中间（真机截图见过）。
     * 所以正确形状只有一个：外层伸缩、内层不伸缩。
     */
    const rule = /^\.dc-modal-title \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-modal-title` 那条规则').not.toBeNull()
    expect(rule![1]!, '标题在伸缩 ⇒ 药丸会被推到行尾压住 ×').not.toMatch(/flex:\s*1\s*;/)
    expect(rule![1]!, '没有 min-width: 0 ⇒ 长名字把药丸挤出框外').toMatch(/min-width:\s*0/)
  })

  it('药丸在头部那一行里是 `flex: none`（不压扁、不被推）', () => {
    expect(CSS).toMatch(/\.dc-clean-detail-title \.dc-badge \{[^}]*flex:\s*none/)
  })
})

describe('⑤ 卡片等高再高一点：用 min-height，不许用 padding 硬撑', () => {
  it('`.dc-clean-row` 有 min-height 下限', () => {
    /**
     * ⚠️ 不能只抓"第一个 `.dc-clean-row {`"：这个选择器出现不止一次
     * （`.dc-clean-list-head, .dc-clean-row {` 那条合并规则在前），
     * 第一版的正则抓到的正是那条合并块，于是对**已经写对的**实现报红。
     * 这里把所有以 `.dc-clean-row` 开头的规则块全取出来，任意一条带 min-height 即可。
     */
    const blocks = [...CSS.matchAll(/^\.dc-clean-row \{([\s\S]*?)\n\}/gm)].map((m) => m[1]!)
    expect(blocks.length, '一条 `.dc-clean-row {` 都没有').toBeGreaterThan(0)
    const withMin = blocks.filter((b) => /min-height:\s*\d+px/.test(b))
    expect(withMin.length, '没有 min-height ⇒ 矮的那几张不会"再高一点"').toBeGreaterThan(0)
  })

  it('下限不是靠 padding 硬撑（padding 会挤描述行，min-height 只补白）', () => {
    const blocks = [...CSS.matchAll(/^\.dc-clean-row \{([\s\S]*?)\n\}/gm)].map((m) => m[1]!)
    const joined = blocks.join('\n')
    expect(joined, '纵向内边距被加大了 —— 摘要行会被挤变形').toMatch(/padding:\s*6px var\(--sp-3\)/)
  })

  it('它仍然与 `.dc-clean-rows` 的等高并存（下限不是第二种等高口径）', () => {
    const rows = /^\.dc-clean-rows \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rows![1]!).toMatch(/grid-auto-rows:\s*1fr/)
  })
})

describe('⑥ 风险药丸：圆点与文字不许重合（这一条被指了三次）', () => {
  it('flex 对齐长在 `.dc-badge-risk` **本体**上，不是某个容器下面', () => {
    /**
     * 前两版把 `display: inline-flex` 写在 `.dc-clean-row-risk .dc-badge` 里 ——
     * 只覆盖"列表行里的药丸"。详情框头部那颗不在那个容器下，于是退回行内流：
     * 圆点与文字同处一条行内流，被基线和行高挤到一起，圆点压住「安」字。
     * 同一个视觉缺陷被指了三次，都是因为规则挂错了位置。
     */
    const rule = /^\.dc-badge-risk \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-badge-risk` 本体那条规则').not.toBeNull()
    const body = rule![1]!
    expect(body, '本体不是 flex ⇒ 任何没被特例覆盖的地方都会退回行内排版').toMatch(/display:\s*inline-flex/)
    expect(body, '没有 align-items: center ⇒ 圆点会去对文字基线（压低半格贴字）').toMatch(/align-items:\s*center/)
    expect(body, '没有 gap ⇒ 圆点贴着文字').toMatch(/gap:\s*\d+px/)
  })

  it('圆点是 `display: block` + `align-self: center`（不是 inline-block）', () => {
    const rule = /^\.dc-risk-dot \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-risk-dot` 那条规则').not.toBeNull()
    const body = rule![1]!
    expect(body, '还是 inline-block ⇒ 没被 flex 接管时会跟着基线走').not.toMatch(/display:\s*inline-block/)
    expect(body).toMatch(/display:\s*block/)
    expect(body, '没有 align-self: center').toMatch(/align-self:\s*center/)
  })

  it('列表行那条只留"不换行"，不再重复写 display/align-items（两处各写一份迟早分叉）', () => {
    const rule = /^\.dc-clean-row-risk \.dc-badge \{([\s\S]*?)\n\}/m.exec(CSS)
    if (rule) {
      expect(rule[1]!, '行内又重写了一份 flex 对齐 —— 与本体的那份会分叉').not.toMatch(/display:\s*inline-flex/)
      expect(rule[1]!).not.toMatch(/align-items:/)
    }
  })
})

describe('⑦ 应用图标与左上角 logo 用官方成套素材', () => {
  it('src-tauri/icons/icon.ico 存在且是多档尺寸（打包与安装器都引用它）', () => {
    const p = join(process.cwd(), 'src-tauri/icons/icon.ico')
    expect(existsSync(p), 'app 图标不见了 —— tauri.conf.json 的 icon 与 installerIcon 都指着它').toBe(true)
    expect(readFileSync(p).length, 'ico 太小，不像多档尺寸').toBeGreaterThan(10000)
    // ICO 头里 `count` 在偏移 4（u16 LE）：多档图标必须 >1，否则高分屏只能拿一档去缩放
    const head = readFileSync(p).subarray(0, 6)
    expect(head[0]! | (head[1]! << 8), '不是 ICO 文件').toBe(0)
    const frames = head[4]! | (head[5]! << 8)
    expect(frames, 'ico 只有 ' + frames + ' 档尺寸（高 DPI 下会糊）').toBeGreaterThan(1)
  })

  it('tauri.conf.json 仍然只引用那一个 ico（没被改成某个中间产物）', () => {
    const conf = readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    expect(conf).toContain('"icons/icon.ico"')
  })

  it('三处图标素材都在，且都是 PNG（渲染端 / 打包参考 / ico 源）', () => {
    /**
     * 2026-10-23：人类伙伴给了 `DeepClean_Logo_Assets.zip`（成套官方素材）。
     * 这里钉的是"三个落点都接上了官方素材"，而不是"某个文件有几字节"——
     * 字节数会随后续精修变，但**落点**不该变。
     */
    for (const rel of [
      'src/renderer/assets/app-icon.png',
      'build/icon.png',
      'src/renderer/assets/deepclean-wordmark.png'
    ]) {
      const p = join(process.cwd(), rel)
      expect(existsSync(p), `素材不在：${rel}`).toBe(true)
      const head = readFileSync(p).subarray(0, 8)
      // PNG 魔数：89 50 4E 47 0D 0A 1A 0A
      expect([...head], `${rel} 不是 PNG`).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    }
  })
})

describe('反面对照：这组判据对"退回旧版"是红的', () => {
  it('把高光改回 `inset 0 1px 0` ⇒ ③ 必须红', () => {
    const mutated = CSS.replace(/inset 0 0 0 1px rgba\(255, 255, 255, 0\.16\)/, 'inset 0 1px 0 rgba(255, 255, 255, 0.28)')
    expect(mutated, '变异没落下去').not.toBe(CSS)
    const body = /^\.dc-nav-on \{([\s\S]*?)\n\}/m.exec(mutated)![1]!
    expect(/inset 0 1px 0/.test(body)).toBe(true)
  })

  it('把 `flex: 1` 塞回标题文字 ⇒ ④ 必须红', () => {
    const mutated = CSS.replace(
      /(\.dc-modal-title \{[^}]*?)flex: 0 1 auto;/,
      '$1flex: 1 1 auto;'
    )
    expect(mutated, '变异没落下去').not.toBe(CSS)
    const body = /^\.dc-modal-title \{([\s\S]*?)\n\}/m.exec(mutated)![1]!
    expect(/flex:\s*1 1 auto/.test(body)).toBe(true)
  })

  it('把整块也设成不伸缩 ⇒ ④ 的"× 留在右上角"那条必须红', () => {
    const mutated = CSS.replace(
      /(\.dc-clean-detail-title \{[^}]*?)flex: 1 1 auto;/,
      '$1flex: 0 1 auto;'
    )
    expect(mutated, '变异没落下去').not.toBe(CSS)
    const body = /^\.dc-clean-detail-title \{([\s\S]*?)\n\}/m.exec(mutated)![1]!
    expect(/flex:\s*1 1 auto/.test(body)).toBe(false)
  })

  it('把字体栈换成"只写名字不打包" ⇒ ① 必须红', () => {
    const mutated = FONTS.replace(/url\('\.\.\/assets\/fonts\//g, "url('https://example.com/")
    expect(mutated).not.toBe(FONTS)
    const urls = [...mutated.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]!)
    expect(urls.filter((u) => !u.startsWith('../assets/fonts/'))).not.toEqual([])
  })

  it('把路径改回 `./fonts/`（那个目录不存在）⇒ ① 必须红', () => {
    const mutated = FONTS.replace(/url\('\.\.\/assets\/fonts\//g, "url('./fonts/")
    expect(mutated).not.toBe(FONTS)
    const urls = [...mutated.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]!)
    expect(urls.filter((u) => !u.startsWith('../assets/fonts/')).length).toBe(urls.length)
  })
})
