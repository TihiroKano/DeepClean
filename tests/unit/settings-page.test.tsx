/**
 * 设置页的三个形状（2026-10-27）。
 *
 * 人类伙伴那一串要求里，有三条是**能被判据钉住的**，另外几条只能靠截图（见验收文档）：
 *
 *  ① 「授权下方所有文字删掉，只保留展示激活和未激活，加一句需联网激活验证」
 *    → 渲染 `LicensePanel`，逐句点名哪些字**必须不在**、哪些**必须在**。
 *  ② 「点击激活出现校验中加一个莫比乌斯环的加载动画」
 *    → `busy` 时 `LicenseBusy` 必须出现，且它里面有 `<svg>` 与那句 label。
 *  ③ 「分为三栏」→ 实际落成**三块竖排卡片**（人类伙伴随后自己修正为「上下结构」）
 *    → 三块卡的类名与顺序。
 *
 * 为什么是渲染闸而不是源码闸：这三条全是"用户读到的字/看到的元素"，
 * 源码里有那几个字不证明它被渲染出来（`LicensePanel` 有四个分支）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LicensePanel, rollDurations, type LicenseState } from '../../src/renderer/components/LicenseCard'
import { LicenseBusy } from '../../src/renderer/components/LicenseBusy'
import { GLASS_SLIDERS, wallpaperLabel } from '../../src/renderer/pages/Settings'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { LicenseStatusWire } from '../../shared/types'

const status = (over: Partial<LicenseStatusWire> = {}): LicenseStatusWire =>
  ({
    state: 'unlicensed',
    activatedAtMs: null,
    deviceId: null,
    problemReason: null,
    problem: null,
    ...over
  }) as LicenseStatusWire

const ready = (over: Partial<LicenseStatusWire> = {}, extra: Record<string, unknown> = {}): LicenseState => ({
  kind: 'ready',
  status: status(over),
  error: null,
  busy: false,
  busyPhase: null,
  lastActivation: null,
  ...extra
})

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const CSS = readFileSync(join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')

describe('① 授权卡只留状态 + 需联网激活验证', () => {
  it('未激活：只念「未激活」，不念「授权不可信」', () => {
    const t = text(renderToStaticMarkup(<LicensePanel state={ready()} code="" onCode={() => {}} onActivate={() => {}} />))
    expect(t).toContain('未激活')
    expect(t).toContain('需联网激活验证')
    // 「授权不可信」是旧三态里 `invalid` 的措辞，人类伙伴要的是只有两态
    expect(t).not.toContain('授权不可信')
  })

  it('已激活：只念「已激活」（不再带「（本机）」）', () => {
    const t = text(
      renderToStaticMarkup(
        <LicensePanel
          state={ready({ state: 'licensed', activatedAtMs: 1, deviceId: 'abcdef0123456789' })}
          code=""
          onCode={() => {}}
          onActivate={() => {}}
        />
      )
    )
    expect(t).toContain('已激活')
    expect(t).not.toContain('已激活（本机）')
    // 旧那一行「激活于 … 设备指纹 …」整句删掉了（人类伙伴：授权下方所有文字删掉）
    expect(t).not.toContain('激活于')
    expect(t).not.toContain('设备指纹')
  })

  it('旧那一大段说明文字一个字都不许剩', () => {
    const t = text(renderToStaticMarkup(<LicensePanel state={ready()} code="" onCode={() => {}} onActivate={() => {}} />))
    // 逐句点名 —— 这些正是人类伙伴要删的那几段
    expect(t, '激活码格式那段还在').not.toContain('32 位十六进制')
    expect(t, 'TCP 探测那段还在').not.toContain('TCP')
    expect(t, 'DPAPI 那段还在').not.toContain('DPAPI')
    expect(t, '「探测点」那句还在').not.toContain('探测点')
    expect(t, '「激活码不上传」那句还在').not.toContain('激活码不上传')
  })

  it('输入框与激活按钮保留（人类伙伴选的是「留输入框和按钮，只删说明文字」）', () => {
    const html = renderToStaticMarkup(<LicensePanel state={ready()} code="" onCode={() => {}} onActivate={() => {}} />)
    expect(html).toContain('type="text"')
    expect(html).toContain('aria-label="激活码"')
    expect(html).toContain('>激活<')
  })

  /**
   * 2026-10-27 晚，人类伙伴附了那张只有「已激活」三个字的图：
   * 「激活后不再显示激活码和输入框，只保留已激活字样」。
   */
  it('已激活之后：输入框、按钮、「需联网激活验证」全都**不再渲染**', () => {
    const html = renderToStaticMarkup(
      <LicensePanel
        state={ready({ state: 'licensed', activatedAtMs: 1, deviceId: 'abcdef0123456789' })}
        code="DC-3133CB2CF2565B0F403641E945C2D716"
        onCode={() => {}}
        onActivate={() => {}}
      />
    )
    // 三样都不许在：输入框、激活按钮、那句"需联网激活验证"
    expect(html, '已激活还画着输入框').not.toContain('aria-label="激活码"')
    expect(html, '已激活还画着 type=text').not.toContain('type="text"')
    expect(html, '已激活还画着激活按钮').not.toContain('>激活<')
    expect(html, '已激活还画着 .dc-actions').not.toContain('dc-actions')
    expect(html, '已激活还挂着"需联网激活验证"').not.toContain('需联网激活验证')
    // 激活码本体也不许以任何形式出现（它是敏感串，已激活之后没有理由留在 DOM 里）
    expect(html, '已激活后激活码仍在 DOM 里').not.toContain('DC-3133CB2C')
    // 但结论那三个字必须在
    expect(text(html)).toContain('已激活')
  })

  it('授权失效（invalid）时输入框自己回来 —— 不必重开设置页', () => {
    const html = renderToStaticMarkup(
      <LicensePanel
        state={ready({ state: 'invalid', problem: 'device-mismatch', problemReason: '绑的是别的设备' })}
        code=""
        onCode={() => {}}
        onActivate={() => {}}
      />
    )
    expect(html, 'invalid 时输入框没回来，用户就没法重新激活').toContain('aria-label="激活码"')
    expect(html).toContain('需联网激活验证')
    expect(text(html)).toContain('未激活')
  })

  it('`invalid` 归到「未激活」但**原因不删**（六种具名原因是运维唯一的线索）', () => {
    const t = text(
      renderToStaticMarkup(
        <LicensePanel
          state={ready({ state: 'invalid', problemReason: 'device-mismatch' })}
          code=""
          onCode={() => {}}
          onActivate={() => {}}
        />
      )
    )
    expect(t, 'invalid 不许被念成已激活').toContain('未激活')
    expect(t).toContain('device-mismatch')
  })
})

describe('② 校验中：莫比乌斯环', () => {
  /**
   * 2026-10-27 晚，人类伙伴：「激活的加载最好时间不定，3-7 秒随机」。
   *
   * `rollDurations` 收一个 `rand` 是为了让这条判据**能确定地**量到上下界 ——
   * 拿 `Math.random` 跑一百次也能看出界，但那是一条统计判据，会偶发红。
   */
  it('总时长落在 3–7 秒，且两相加起来正好等于它', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const d = rollDurations(() => r)
      const total = d.network + d.verify
      expect(total, `rand=${r} 时总时长越界`).toBeGreaterThanOrEqual(3000)
      expect(total, `rand=${r} 时总时长越界`).toBeLessThanOrEqual(7000)
      // 两相都必须真的占一段时间：任一相为 0 会让那半句文案一闪而过
      expect(d.network, `rand=${r} 时网络相为 0`).toBeGreaterThan(0)
      expect(d.verify, `rand=${r} 时判定相为 0`).toBeGreaterThan(0)
    }
    // 两端都要真到得了（不是"落在 [3000, 7000)" 那种半开区间的假边界）
    expect(rollDurations(() => 0).network + rollDurations(() => 0).verify).toBe(3000)
    expect(rollDurations(() => 1).network + rollDurations(() => 1).verify).toBe(7000)
  })

  it('时长是**随机**的：两次抽到的不是同一个数', () => {
    // 用真 Math.random 抽 20 次，至少要有 2 个不同的总值 —— 固定时长会让这条红。
    const totals = new Set<number>()
    for (let i = 0; i < 20; i++) {
      const d = rollDurations()
      totals.add(d.network + d.verify)
    }
    expect(totals.size, '抽 20 次只得一个总值 ⇒ 时长其实是固定的').toBeGreaterThan(1)
  })

  it('busy 时环出现（有 svg、有那句 label）', () => {
    const html = renderToStaticMarkup(
      <LicensePanel
        state={ready({}, { busy: true, busyPhase: 'verify' })}
        code="DC-XX"
        onCode={() => {}}
        onActivate={() => {}}
      />
    )
    expect(html, 'busy 时没有出现莫比乌斯环').toContain('dc-mobius')
    expect(html).toContain('<svg')
    const t = text(html)
    expect(t).toContain('正在校验激活码')
  })

  /**
   * 2026-10-27 晚：人类伙伴「加载动画加个服务器通讯中......」。
   *
   * 两相各自点名 —— 只说「有 label」不够，那会让两相写成同一句话而判据全绿，
   * 而用户看到的差别恰恰是这两句。
   */
  it('两相文案分得开：网络那相说「服务器通讯中」，本地判定那相说「校验激活码」', () => {
    const net = text(
      renderToStaticMarkup(
        <LicensePanel
          state={ready({}, { busy: true, busyPhase: 'network' })}
          code="DC-XX"
          onCode={() => {}}
          onActivate={() => {}}
        />
      )
    )
    expect(net).toContain('服务器通讯中')
    // 网络那一相**不许**同时说"校验激活码"：那是下一步的事，先说出来就是提前报进度
    expect(net).not.toContain('正在校验激活码')

    const verify = text(
      renderToStaticMarkup(
        <LicensePanel
          state={ready({}, { busy: true, busyPhase: 'verify' })}
          code="DC-XX"
          onCode={() => {}}
          onActivate={() => {}}
        />
      )
    )
    expect(verify).toContain('正在校验激活码')
    expect(verify).not.toContain('服务器通讯中')
  })

  it('三个点自己在动（CSS 动画 + 错开的 delay），不是靠换文本', () => {
    // 结构：三个 <span> 落在 .dc-dots 里
    const html = renderToStaticMarkup(<LicenseBusy />)
    expect(html, '没有 .dc-dots').toContain('dc-dots')
    expect((html.match(/dc-dots/g) ?? []).length, '.dc-dots 只该出现一次（外层容器）').toBe(1)
    expect((html.match(/<span>\.<\/span>/g) ?? []).length, '应该是三个点').toBe(3)
    // 装饰节点不许进读屏的正文
    expect(html).toContain('aria-hidden="true"')

    // 行为：CSS 里真有一条无限动画，且三个点各自错开
    const dotsBlock = /\.dc-dots > span\s*\{([\s\S]*?)\n\}/.exec(CSS)
    expect(dotsBlock, '找不到 `.dc-dots > span` 规则').not.toBeNull()
    expect(dotsBlock![1], '三个点没有 animation').toMatch(/animation:\s*dc-dots-pulse[\s\S]*infinite/)
    for (const n of [1, 2, 3]) {
      expect(CSS, `第 ${n} 个点没有自己的 animation-delay`).toMatch(
        new RegExp(`\\.dc-dots > span:nth-child\\(${n}\\)\\s*\\{[\\s\\S]{0,60}?animation-delay`)
      )
    }
    expect(CSS, '缺少 dc-dots-pulse 关键帧').toContain('@keyframes dc-dots-pulse')
  })

  it('reduced-motion 下三个点停住但**仍然可见**（停成透明的点等于删了半句文案）', () => {
    /**
     * 取**所有** reduced-motion 块再拼起来，不取第一个：这个文件里有多处
     * `@media (prefers-reduced-motion: reduce)`（`.dc-jump-dot` 那组也在），
     * 用第一个匹配会读到别人那一段，于是这条判据在**真出错时也是绿的**。
     */
    const blocks = [...CSS.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g)]
    expect(blocks.length, '一个 reduced-motion 块都没有').toBeGreaterThan(0)
    const all = blocks.map((b) => b[1]).join('\n')
    expect(all, '三个点在 reduced-motion 下没有停').toMatch(/\.dc-dots > span\s*\{[\s\S]{0,80}?animation:\s*none/)
    expect(all, '停掉之后必须把 opacity 放回 1').toMatch(/\.dc-dots > span\s*\{[\s\S]{0,120}?opacity:\s*1/)
  })

  it('不 busy 时环不出现（否则它会在每一次打开设置页时转个不停）', () => {
    const html = renderToStaticMarkup(
      <LicensePanel state={ready()} code="DC-XX" onCode={() => {}} onActivate={() => {}} />
    )
    expect(html).not.toContain('dc-mobius')
  })

  it('`LicenseBusy` 自带 `role="status"`（纯图形对读屏是空的）', () => {
    const html = renderToStaticMarkup(<LicenseBusy label="正在校验激活码…" />)
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(text(html)).toContain('正在校验激活码')
  })

  it('环是一条**闭合轮廓**（一条路径 + 一个渐变），不是一堆分片', () => {
    /**
     * 2026-10-27 第五版的结构判据。
     *
     * 前四版都被真机截图否掉了（对照表在 `mobius-geometry.ts` 文件头），
     * 根因都是同一件事：**把连续的明暗场切成有限片**，每片一个 opacity，
     * 片边界必然可见 —— 表现为一圈放射状条纹或深浅扇贝。
     *
     * 所以这条判据钉的是"结构上没有片"：
     *  · 只有**一条**带子路径（`.dc-mobius-body`）；
     *  · 它的 `fill` 是一个 `url(#…)` 渐变（渐天生连续，不可能有缝）；
     *  · 那条 `<defs><linearGradient>` 真的在；
     *  · 翻面脊（`.dc-mobius-seam`）恰好一条 —— 没有它读不出"扭"，多了就是分片回潮。
     */
    const html = renderToStaticMarkup(<LicenseBusy />)
    expect((html.match(/dc-mobius-body/g) ?? []).length, '带子只许一条路径').toBe(1)
    expect((html.match(/dc-mobius-seam/g) ?? []).length, '翻面脊只许一条').toBe(1)
    expect(html, '带子的 fill 不是渐变 —— 那就会退回分片版').toMatch(/fill="url\(#dc-mobius-g[^)]*\)"/)
    expect(html, '没有 linearGradient 定义').toContain('<linearGradient')
    // 反向半边：不许再出现"每片一个 opacity"那种结构
    expect(html, '又出现分片版的 opacity 属性了').not.toMatch(/dc-mobius-face/)
  })

  it('`prefers-reduced-motion` 时动画必须停（前庭敏感者的真实不适来源）', () => {
    expect(CSS, '缺少 reduced-motion 那一档').toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]{0,200}?\.dc-mobius-ring\s*\{[\s\S]{0,80}?animation:\s*none/
    )
    // 反面对照：正常那一档必须有动画（否则上面那条"能停"是在停一个本来就不动的东西）
    expect(CSS).toMatch(/\.dc-mobius-ring\s*\{[\s\S]{0,200}?animation:\s*dc-mobius-spin/)
  })
})

describe('③ 三块竖排卡片', () => {
  it('四格滑块的规格覆盖四个键，且上下界与契约同一份', () => {
    const keys = GLASS_SLIDERS.map((s) => s.key)
    expect(keys).toEqual(['glassBlurPx', 'glassSaturate', 'glassBrightness', 'glassOpacity'])
    const blur = GLASS_SLIDERS.find((s) => s.key === 'glassBlurPx')!
    expect(blur.min).toBe(0)
    expect(blur.max).toBe(60)
    // 每一格都要有 label 与 hint —— 没有 hint 的话，四个英文变量名对用户是空的
    for (const s of GLASS_SLIDERS) {
      expect(s.label.length, `${s.key} 缺 label`).toBeGreaterThan(0)
      expect(s.hint.length, `${s.key} 缺 hint`).toBeGreaterThan(8)
      expect(s.format(DEFAULT_SETTINGS[s.key]), `${s.key} 的读数念不出来`).not.toBe('')
    }
  })

  it('壁纸显示名：内置那张有名字，用户选的用源文件名', () => {
    expect(wallpaperLabel('builtin:mountain')).toBe('夜山（内置）')
    expect(wallpaperLabel('file:wallpaper-cat.png')).toBe('wallpaper-cat.png')
  })

  it('三块卡片的标题字号比常规卡标题大一档（人类伙伴：字放大一些）', () => {
    const m = /\.dc-settings-card-title\s*\{([\s\S]*?)\n\}/.exec(CSS)
    expect(m, '找不到 `.dc-settings-card-title` 那条规则').not.toBeNull()
    const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(m![1]!)
    expect(size, '它没有写死字号').not.toBeNull()
    // 常规卡标题是 15px（`.dc-panel-title`）；这里必须更大
    expect(Number(size![1])).toBeGreaterThan(15)
  })

  it('授权状态的字号明显更大（22px 那档）', () => {
    const m = /\.dc-license-state\s*\{([\s\S]*?)\n\}/.exec(CSS)
    expect(m, '找不到 `.dc-license-state` 规则').not.toBeNull()
    const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(m![1]!)
    expect(Number(size![1])).toBeGreaterThanOrEqual(20)
  })
})
