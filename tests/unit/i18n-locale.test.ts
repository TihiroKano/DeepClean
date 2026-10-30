/**
 * 界面语言的**口径判据**（2026-10-29）。
 *
 * 人类伙伴那条要求是「设置内增加语言切换功能，支持中文，繁体中文，英语，日语，韩语」。
 * 五个语言都"能选"是不够的 —— 这一组守四件会静默烂掉的事：
 *
 * ① **每一份语言都有一份词典，且键集覆盖中文那份**。漏一条的表现不是崩溃，
 *    是那句显示成中文（`translate` 回落源文，见 `dict.ts` 文件头）。那是欠账不是缺陷，
 *    但**欠账要有数**：这条判据让它变成一个能被看见的数字，而不是谁想起来才去数。
 * ② **`DICTS` 与 `LOCALES` 逐条对上**。少一份的表现同上，但更糟：那个语言下**整页**是中文。
 * ③ **查不到就回原文，不抛**。语言不该让界面白屏。
 * ④ **占位符原文原样保留**。`{bytes}` 译丢一半的话，界面上会显示一句缺了数字的话 ——
 *    而那比整句没译更难看，因为它看起来像计算失败。
 *
 * 为什么这些判据读的是**运行时对象**而不是源码字符串：源码里写没写不影响它能不能被查到
 * （一份语法正确但对象是空的词典，源码上看不出区别）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, LOCALES, LOCALE_HTML_LANG, LOCALE_LABELS, localeFromTag, sanitizeLocale } from '../../shared/i18n'
import { missingKeys, translate, type Dict } from '../../src/renderer/i18n/dict'
import { ZH_CN } from '../../src/renderer/i18n/dicts/zh-CN'
import { ZH_TW } from '../../src/renderer/i18n/dicts/zh-TW'
import { EN } from '../../src/renderer/i18n/dicts/en'
import { JA } from '../../src/renderer/i18n/dicts/ja'
import { KO } from '../../src/renderer/i18n/dicts/ko'

/**
 * 语言 id → 词典。
 *
 * ⚠️ **这里手写一份，而不是 `import { DICTS } from '../../src/renderer/i18n'`**：
 * 那个模块是 `.tsx`（它带着 `LocaleContext` 与 `useT`），而这个测试文件同时编进
 * `tsconfig.node.json` —— 那个项目没有 `--jsx`、也没有 React 的类型，
 * 引 `.tsx` 会让 node 那个项目当场红在 TS6142 上。
 *
 * 手写一份的代价：`DICTS` 里少登记一份语言，这里**照样绿**（本表自己就是完整的）。
 * 那条"注册表完整"的判据因此另找地方 —— 见 `i18n-index.test.tsx`（跑在
 * `tsconfig.web.json` 那个项目里，能引 `.tsx`）。这里只负责**词典内容**的口径。
 */
const DICTS: Record<string, Dict | undefined> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  en: EN,
  ja: JA,
  ko: KO
}

/** 认不出的语言回默认那份 —— 与 `dictFor` 同一条口径（那个函数在 `.tsx` 里，这里复现一份）。 */
const dictFor = (locale: string): Dict => DICTS[locale] ?? DICTS[DEFAULT_LOCALE]!

const ZH_KEYS = Object.keys(ZH_CN)

describe('① 五种语言都有词典，且键集覆盖中文那份', () => {
  it('LOCALES 恰好五条，第一项是默认值', () => {
    expect([...LOCALES]).toEqual(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])
    expect(LOCALES[0]).toBe(DEFAULT_LOCALE)
  })

  it('每一份词典都不缺中文那份的键（逐语言点名，不拿总数糊弄）', () => {
    /**
     * ⚠️ **这条一开始是"允许缺"的**：翻译分批落地，第一批只覆盖了 159/287。
     * 当时把它写成 `expect(missing.length).toBeLessThan(200)` 之类会让它永远绿 ——
     * 而"缺多少"这件事就再也没人看得见。
     *
     * 现在改成**精确 0**。为什么可以：四份词典已补齐到 287，缺一条就红。
     * 将来加一句新中文文案时，这条会立刻红 —— 那不是阻碍，那是它该做的事：
     * 新文案必须同时给五份词典。真要先合并再补译，就把这条改成
     * `expect(missing).toEqual([...已知欠账])` 那种**列得出来**的形状，别放成范围比较。
     */
    for (const locale of LOCALES) {
      const missing = missingKeys(ZH_KEYS, DICTS[locale]!)
      expect(missing, `${locale} 缺 ${missing.length} 条：\n${missing.join('\n')}`).toEqual([])
    }
  })

  it('反面对照：缺一条能被这条判据抓住（否则上面那条是空的）', () => {
    // 造一份"少一个键"的词典，确认判据真的会报出来 —— 一条永远绿的判据不是判据。
    const short = { ...DICTS.en! }
    delete short[ZH_KEYS[0]!]
    expect(missingKeys(ZH_KEYS, short)).toEqual([ZH_KEYS[0]])
  })
})

describe('② DICTS 与 LOCALES 逐条对上', () => {
  it('每个 locale 都有一份词典', () => {
    for (const locale of LOCALES) {
      expect(DICTS[locale], `${locale} 没有词典`).toBeDefined()
      expect(Object.keys(DICTS[locale]!).length, `${locale} 的词典是空的`).toBeGreaterThan(0)
    }
  })

  it('`<html lang>` 与下拉标签也覆盖每一条', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_HTML_LANG[locale], `${locale} 没有 html lang`).toBeTruthy()
      expect(LOCALE_LABELS[locale], `${locale} 没有下拉标签`).toBeTruthy()
    }
  })

  it('下拉标签**用自己那种写法**（不是跟着当前语言走）', () => {
    // 一个把语言设错的人，需要的正是"在列表里认出自己的那种写法"。
    expect(LOCALE_LABELS['zh-CN']).toContain('中文')
    expect(LOCALE_LABELS['zh-TW']).toContain('中文')
    expect(LOCALE_LABELS.ja).toBe('日本語')
    expect(LOCALE_LABELS.ko).toBe('한국어')
    expect(LOCALE_LABELS.en).toBe('English')
  })
})

describe('③ 查不到回原文，不抛', () => {
  it('没登记的键逐字回原文', () => {
    const weird = '这句话没有登记在任何词典里'
    expect(translate(DICTS.en!, weird)).toBe(weird)
    expect(translate(DICTS.ja!, weird)).toBe(weird)
  })

  it('认不出的语言回默认那份（不抛、不白屏）', () => {
    expect(() => dictFor('xx-YY' as never)).not.toThrow()
    expect(dictFor('xx-YY')).toBe(DICTS[DEFAULT_LOCALE])
  })

  it('简体中文下，登记的键逐字等于原文（与 1.0.0 的行为不变）', () => {
    // 这一条钉的是"加了 i18n 之后中文界面一个像素都不变"。
    // 键就是原文，所以这里对每一条都要成立 —— 例外是把原文写错的那些，
    // 下面这一条判据把它们挡住。
    for (const [k, v] of Object.entries(ZH_CN)) {
      expect(v, `zh-CN 的「${k}」被改成了「${v}」—— 简体下必须逐字回原文`).toBe(k)
    }
  })
})

describe('④ 占位符原样保留', () => {
  it('中文那份里的占位符在四份译文里都还在', () => {
    for (const locale of LOCALES) {
      if (locale === 'zh-CN') continue
      for (const key of ZH_KEYS) {
        const src = /\{\w+\}/g
        const want = (key.match(src) ?? []).sort()
        if (want.length === 0) continue
        const got = (String(DICTS[locale]?.[key] ?? '').match(src) ?? []).sort()
        expect(got, `${locale} 的「${key}」占位符对不上：期望 ${want.join('/')}，实际 ${got.join('/') || '(无)'}`).toEqual(want)
      }
    }
  })

  it('translate 会替换占位符，缺的变量原样留着（不渲染成 undefined）', () => {
    const dict = { '发现 {bytes} 可清理': 'Found {bytes} reclaimable' }
    expect(translate(dict, '发现 {bytes} 可清理', { bytes: '1.2 GB' })).toBe('Found 1.2 GB reclaimable')
    // 少给一个变量时**留着占位符**，不要渲染成 "undefined" —— 那看起来像数据坏了
    expect(translate(dict, '发现 {bytes} 可清理')).toBe('Found {bytes} reclaimable')
  })
})

describe('⑤ 那个把系统语言映射过来的兜底', () => {
  it('精确命中优先', () => {
    expect(localeFromTag('zh-TW')).toBe('zh-TW')
    expect(localeFromTag('en-US')).toBe('en')
    expect(localeFromTag('ja-JP')).toBe('ja')
    expect(localeFromTag('ko-KR')).toBe('ko')
    expect(localeFromTag('zh-CN')).toBe('zh-CN')
  })

  it('繁体地区走 zh-TW（一个把 zh-HK 判成简体的人看到的是另一种字形）', () => {
    for (const t of ['zh-HK', 'zh-MO', 'zh-TW', 'zh-Hant']) {
      expect(localeFromTag(t), t).toBe('zh-TW')
    }
    for (const t of ['zh-SG', 'zh-Hans', 'zh']) {
      expect(localeFromTag(t), t).toBe('zh-CN')
    }
  })

  it('认不出 / 空 / null 一律回默认', () => {
    for (const bad of ['', null, undefined, 'xx', 'de-DE']) {
      expect(localeFromTag(bad)).toBe(DEFAULT_LOCALE)
    }
  })

  it('下划线分隔也认（`zh_TW` 是 Java 那一族的写法）', () => {
    expect(localeFromTag('zh_TW')).toBe('zh-TW')
  })
})

describe('⑥ 语言那个值的消毒（两侧同一把尺子）', () => {
  it('闭集内的原样收下', () => {
    for (const l of LOCALES) expect(sanitizeLocale(l)).toBe(l)
  })

  it('闭集外一律回默认（**不是回空串** —— 空串会让每个标签显示成键名）', () => {
    for (const bad of ['', 'xx-YY', 'zh', 'ZH-CN', ' zh-CN ', 4, null, undefined, {}]) {
      expect(sanitizeLocale(bad), String(bad)).toBe(DEFAULT_LOCALE)
    }
  })

  it('前后空白会被 trim 掉再判（手改文件时很容易多一个空格）', () => {
    expect(sanitizeLocale('  ja  ')).toBe('ja')
  })
})
