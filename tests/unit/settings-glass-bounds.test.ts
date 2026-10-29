/**
 * 外观设置的**口径**判据（2026-10-27）。
 *
 * 人类伙伴那句话是「加入背景壁纸更换功能和 ccs 的亮度透明度（毛玻璃）等参数的调节功能」。
 * 四格滑块落成真实 CSS 变量之后，有三件事必须被钉住 —— 它们都不是"看起来对"能证明的：
 *
 * ① **默认值与样式表现值逐字相同**。不同的话，用户第一次打开设置页、什么都还没碰，
 *    界面就跳到另一个样子。这条**直接读 CSS 文件**取值，不是再抄一份常数到测试里
 *    （抄一份的话，样式表改了而测试不知道 —— 那正是"两处真相"的起点）。
 * ② **每一格都有真读者**。`settingsToCssVars` 是唯一出口；一个键没出现在它里面，
 *    那一格控件就是假的（本页立身规矩）。
 * ③ **上下界两侧口径一致**。渲染端 `sanitizeSettings` 与 Rust `sanitize_settings`
 *    对同一批输入必须给同一个答案 —— 一侧放行、另一侧丢弃的表现是"我改了但没生效"。
 *    Rust 那一侧由 `cargo test` 的 `settings::tests` 钉（同一批输入那张表在那边也有一份）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MAX_GLASS_BLUR_PX,
  MAX_GLASS_BRIGHTNESS,
  MAX_GLASS_OPACITY,
  MAX_GLASS_SATURATE,
  MIN_GLASS_BLUR_PX,
  MIN_GLASS_BRIGHTNESS,
  MIN_GLASS_OPACITY,
  MIN_GLASS_SATURATE,
  sanitizeSettings,
  sanitizeWallpaper,
  settingsToCssVars,
  type AppSettings
} from '../../shared/settings'

const CSS = readFileSync(join(process.cwd(), 'src/renderer/styles/glass/tokens.css'), 'utf8')
const GLOBAL = readFileSync(join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')

/** 从样式表里读一个 `--name: value` 的值。取不到要红（否则下面的对账会静默跳过）。 */
function cssVar(src: string, name: string): string {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(src)
  expect(m, `样式表里找不到 ${name} —— 这条对账要跟着改`).not.toBeNull()
  return m![1]!.trim()
}

describe('① 外观默认值必须与样式表现值逐字相同', () => {
  it('模糊半径 / 饱和度 / 亮度三格直接对同一个数', () => {
    // 这三个 token 住在 glass/tokens.css
    expect(cssVar(CSS, '--glass-blur-page')).toBe(`${DEFAULT_GLASS_BLUR_PX_OF('blur')}px`)
    expect(cssVar(CSS, '--glass-saturate')).toBe(String(DEFAULT_SETTINGS.glassSaturate))
    expect(cssVar(CSS, '--glass-brightness')).toBe(String(DEFAULT_SETTINGS.glassBrightness))
  })

  it('透明度那一格对的是 `--glass-fill-quiet` 的 alpha（2026-10-27 改口径）', () => {
    /**
     * 设置卡改用**深色档**（人类伙伴：「设置页面的框色彩改成和这个一样」，指开发环境页
     * 那副材质）之后，透明度滑块调的是 `--settings-card-fill`，而它的默认值必须等于
     * `--glass-fill-quiet` 那一档的 alpha —— 否则用户第一次打开设置页、什么都还没碰，
     * 卡的颜色就会跳到另一个样子。
     *
     * 色相写死成 quiet 的 `rgb(10, 28, 70)`：滑块只换 alpha，不换色相。
     * 那条"只换 alpha"由下面 ② 的第三条判据钉。
     */
    const raw = cssVar(GLOBAL, '--glass-fill-quiet')
    const m = /^rgba\(\s*10\s*,\s*28\s*,\s*70\s*,\s*([\d.]+)\s*\)$/.exec(raw)
    expect(m, `--glass-fill-quiet 的形状变了（期望 rgba(10, 28, 70, <alpha>)）：${raw}`).not.toBeNull()
    expect(Number(m![1])).toBe(DEFAULT_SETTINGS.glassOpacity)
  })

  it('设置卡读的是自己的那个变量，不是共享的 --glass-fill-quiet', () => {
    /**
     * 这条钉的是**"只改这一页"**这件事。
     *
     * `--glass-fill-quiet` 有 9 处读者（地图侧栏 / 日志卡 / 开发环境组…）。
     * 设置卡要是直接读它，拖动透明度滑块就等于顺手改了那九处 ——
     * 而用户看不到那些页、也不知道自己动了它们。
     *
     * 所以设置卡必须读 `--settings-card-fill`（由 `useSettings` 写到 documentElement），
     * 且 `var()` 的兜底值是 quiet 那一档（= 没有设置时逐字等于开发环境页）。
     */
    const rule = /\.dc-settings-card\s*\{([\s\S]*?)\n\}/.exec(GLOBAL)
    expect(rule, '找不到 `.dc-settings-card` 那条规则').not.toBeNull()
    /**
     * ⚠️ **必须剥掉块内注释再判**。那条规则里有一段很长的说明，其中**逐字写着**
     * 「为什么不直接写 `background: var(--glass-fill-quiet)`」—— 不剥注释的话，
     * 下面那条 `not.toMatch` 会被自己那句注释喂饱，判据红在一个写得没错的实现上。
     * 2026-10-27 当场踩过一次。
     */
    const body = rule![1]!.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body, '设置卡没有读自己的填充变量').toMatch(/var\(--settings-card-fill,\s*rgba\(10,\s*28,\s*70,\s*0\.36\)\)/)
    expect(body, '设置卡又直接读共享 token 了 —— 滑块会改到别的页').not.toMatch(
      /background(-color)?:\s*var\(--glass-fill-quiet\)/
    )
    /**
     * **同一属性不许写两遍**。2026-10-27 初版留了两条 `box-shadow`（一条只有
     * `var(--glass-inner)`、一条带外投影），后者生效、前者是死规则。
     * "写了但不管用"比没写更难查 —— 下一个人会以为改第一条能生效。
     */
    const shadows = (body.match(/box-shadow\s*:/g) ?? []).length
    expect(shadows, `box-shadow 写了 ${shadows} 条 —— 只许一条，多条时只有最后那条生效`).toBe(1)
    const backgrounds = (body.match(/background(-color)?\s*:/g) ?? []).length
    expect(backgrounds, `background 写了 ${backgrounds} 条 —— 填充只许一处`).toBe(1)
  })

  it('默认值的字面量也钉住（防"样式表与 TS 一起漂"）', () => {
    // 上面两条是"两边相等"，这一条是"两边都还是那个数"。
    // 少了它，有人把样式表与 TS 同时改成 12 也会绿 —— 而 12 不是产品默认。
    expect(DEFAULT_SETTINGS.glassBlurPx).toBe(30)
    expect(DEFAULT_SETTINGS.glassSaturate).toBe(1.5)
    expect(DEFAULT_SETTINGS.glassBrightness).toBe(1.05)
    expect(DEFAULT_SETTINGS.glassOpacity).toBe(0.36)
    expect(DEFAULT_SETTINGS.wallpaper).toBe('builtin:mountain')
  })
})

/** 读 TS 那个默认值的小助手（避免在测试里写第二个 30）。 */
function DEFAULT_GLASS_BLUR_PX_OF(_k: 'blur'): number {
  return DEFAULT_SETTINGS.glassBlurPx
}

describe('② 每一格都有真读者：settingsToCssVars 是唯一出口', () => {
  it('四个外观键全部出现在 CSS 变量表里', () => {
    const vars = settingsToCssVars(DEFAULT_SETTINGS)
    const keys = Object.keys(vars)
    // 逐格点名 —— 用总数对不上会漏掉"删一个加一个"
    expect(keys).toContain('--glass-blur-page')
    expect(keys).toContain('--glass-saturate')
    expect(keys).toContain('--glass-brightness')
    expect(keys).toContain('--settings-card-fill')
    expect(keys.length).toBe(4)
  })

  it('改一格只改对应的那一条', () => {
    const a = settingsToCssVars(DEFAULT_SETTINGS)
    const b = settingsToCssVars({ ...DEFAULT_SETTINGS, glassBlurPx: 12 })
    expect(b['--glass-blur-page']).toBe('12px')
    // 反面对照：其余三条**逐字不变**（写成一格改全部的话，用户拉一个滑块四个值一起动）
    expect(b['--glass-saturate']).toBe(a['--glass-saturate'])
    expect(b['--glass-brightness']).toBe(a['--glass-brightness'])
    expect(b['--settings-card-fill']).toBe(a['--settings-card-fill'])
  })

  it('透明度只换 alpha，不换色相', () => {
    const v = settingsToCssVars({ ...DEFAULT_SETTINGS, glassOpacity: 0.5 })
    expect(v['--settings-card-fill']).toBe('rgba(10, 28, 70, 0.5)')
    // 反面对照：0.5 与默认 0.36 必须是两个串（否则那条 setProperty 什么也没改）
    expect(v['--settings-card-fill']).not.toBe(settingsToCssVars(DEFAULT_SETTINGS)['--settings-card-fill'])
  })
})

describe('③ 上下界：夹住而不是回落默认', () => {
  it('出界夹到边界（用户写了 9999 要的是"别炸"，不是"偷偷变成默认"）', () => {
    const s = sanitizeSettings({
      dupMinSizeMb: 4,
      glassBlurPx: 9999,
      glassSaturate: 99,
      glassBrightness: 99,
      glassOpacity: 99,
      wallpaper: 'builtin:mountain'
    })
    expect(s.glassBlurPx).toBe(MAX_GLASS_BLUR_PX)
    expect(s.glassSaturate).toBe(MAX_GLASS_SATURATE)
    expect(s.glassBrightness).toBe(MAX_GLASS_BRIGHTNESS)
    expect(s.glassOpacity).toBe(MAX_GLASS_OPACITY)

    const low = sanitizeSettings({
      dupMinSizeMb: 4,
      glassBlurPx: -50,
      glassSaturate: -1,
      glassBrightness: -1,
      glassOpacity: -1,
      wallpaper: 'builtin:mountain'
    })
    expect(low.glassBlurPx).toBe(MIN_GLASS_BLUR_PX)
    expect(low.glassSaturate).toBe(MIN_GLASS_SATURATE)
    expect(low.glassBrightness).toBe(MIN_GLASS_BRIGHTNESS)
    expect(low.glassOpacity).toBe(MIN_GLASS_OPACITY)
  })

  it('透明度下界**不是 0**（0 会让"板"消失而盒子还在，看着像渲染坏了）', () => {
    expect(MIN_GLASS_OPACITY).toBeGreaterThan(0)
    const s = sanitizeSettings({ glassOpacity: 0 })
    expect(s.glassOpacity).toBe(MIN_GLASS_OPACITY)
  })

  it('逐键回落：一个坏键不影响别的键', () => {
    // 这条是"逐键"与"整份打回默认"的分界线。整份打回默认会让
    // "我调了亮度"与"我的模糊半径设置丢了"变成同一件事。
    const s = sanitizeSettings({
      dupMinSizeMb: 4,
      glassBlurPx: 'not a number',
      glassSaturate: 2.0,
      glassBrightness: 1.2,
      glassOpacity: 0.4,
      wallpaper: 'builtin:mountain'
    })
    expect(s.glassBlurPx, '坏的那个键回默认').toBe(DEFAULT_SETTINGS.glassBlurPx)
    expect(s.glassSaturate, '好的键不许被连坐').toBe(2.0)
    expect(s.glassBrightness).toBe(1.2)
    expect(s.glassOpacity).toBe(0.4)
  })

  it('外观几格保留小数（1.25 与 1 是看得出来的两档）；dup 那一格取整', () => {
    const s = sanitizeSettings({ dupMinSizeMb: 4.6, glassSaturate: 1.25, glassBrightness: 1.07 })
    expect(s.dupMinSizeMb, 'dup 只有整数档').toBe(5)
    expect(s.glassSaturate).toBe(1.25)
    expect(s.glassBrightness).toBe(1.07)
  })

  it('结构整个不对时回默认（不是抛）', () => {
    for (const bad of [null, 4, 'x', []]) {
      expect(sanitizeSettings(bad)).toEqual(DEFAULT_SETTINGS)
    }
  })
})

describe('壁纸引用是闭集，不是任意 CSS 字符串', () => {
  it('认两种形状', () => {
    expect(sanitizeWallpaper('builtin:mountain')).toBe('builtin:mountain')
    expect(sanitizeWallpaper('file:wallpaper-a.png')).toBe('file:wallpaper-a.png')
    expect(sanitizeWallpaper('file:我的图.jpg')).toBe('file:我的图.jpg')
  })

  it('越界的七种形状一律回默认', () => {
    for (const evil of [
      'file:../secret.png',
      'file:..\\secret.png',
      'file:sub/dir/a.png',
      'file:C:/windows/a.png',
      'file:.hidden.png',
      'file:a.gif',
      'javascript:alert(1)',
      'builtin:nope',
      ''
    ]) {
      expect(sanitizeWallpaper(evil), `${evil} 不该被接受`).toBe(DEFAULT_SETTINGS.wallpaper)
    }
  })

  it('反面对照：合法的两种必须**不等于**默认（否则上面那批断言是空的）', () => {
    expect(sanitizeWallpaper('file:a.png')).not.toBe(DEFAULT_SETTINGS.wallpaper)
  })
})

describe('④ 设置对象的键集是封闭的', () => {
  it('AppSettings 恰好六个键（多一个野字段就是"看着接上了其实没有"）', () => {
    const keys = Object.keys(DEFAULT_SETTINGS).sort()
    expect(keys).toEqual([
      'dupMinSizeMb',
      'glassBlurPx',
      'glassBrightness',
      'glassOpacity',
      'glassSaturate',
      'wallpaper'
    ])
  })

  it('野生键不会被带出来', () => {
    const s = sanitizeSettings({
      dupMinSizeMb: 4,
      glassBlurPx: 10,
      autoCleanEnabled: true,
      theme: 'midnight'
    }) as AppSettings & { autoCleanEnabled?: unknown }
    expect(s.autoCleanEnabled, '已删字段不许复活').toBeUndefined()
    expect(Object.keys(s).length).toBe(6)
  })
})
