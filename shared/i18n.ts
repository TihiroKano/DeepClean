/**
 * 界面语言的**类型与闭集**（2026-10-29）。
 *
 * ## 为什么只有这么几行
 *
 * 词典本身不在这里 —— 这一份要同时编进 `tsconfig.node.json`（主进程/测试）
 * 与 `tsconfig.web.json`（渲染端），而词典是几百条中文原文，只有渲染端需要。
 * 把 5 条语言的词典都塞进 node 那个项目，等于让每一条 `cargo test` 的对账用例
 * 都去加载一遍它们。
 *
 * 所以分工：
 *  - **这里**：有哪些语言（`LOCALES`）、默认是哪个、怎么判定、怎么收进闭集；
 *  - `src/renderer/i18n/dicts/*.ts`：词典本体；
 *  - `src-tauri/src/settings.rs` 的 `LOCALES`：服务端清洗那一侧的白名单。
 *
 * 三处的**顺序**是同一份（`LOCALES` 的数组序就是设置页下拉的顺序，第一项是默认值）。
 * 服务端那一份不一致的表现是「设置页能选日语、存下来却被服务端打回简体」——
 * 用户会以为那一格没生效，而那是这一页最不该出现的事。
 */

/**
 * 支持的语言。**顺序即下拉顺序，第一项是默认值**。
 *
 * `zh-CN` 是产品默认，与 1.0.0 的行为逐字相同 —— 一个从没打开过设置页的用户
 * 看到的界面必须一个像素都不变。
 */
export const LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const
export type Locale = (typeof LOCALES)[number]

/** 默认语言。 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/**
 * 每种语言在那个下拉里**用自己**怎么写（`中文（简体）` 而不是 `Chinese (Simplified)`）。
 *
 * 为什么不让它跟着界面语言走：一个把这页语言设错的人，需要的正是"在列表里认出
 * 自己的那种写法"。跟着当前语言走时，界面已经是英文了，列表里却还写着
 * `Chinese (Traditional)` —— 而用户可能正是因为看不懂英文才来这一页。
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  'zh-CN': '中文（简体）',
  'zh-TW': '中文（繁體）',
  en: 'English',
  ja: '日本語',
  ko: '한국어'
}

/** `<html lang>` 那一格的值（与上面的 id 同名，但单独列出是为了让"要改哪一个"没有歧义）。 */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  en: 'en',
  ja: 'ja',
  ko: 'ko'
}

/**
 * 把任何来源的一个值收进闭集，认不出就回默认。
 *
 * 与服务端 `sanitize_locale` 逐条同一份。渲染端这一份的存在理由与服务端那一条不同：
 * 服务端挡的是"手改 settings.json"，这一份挡的是"IPC 还没回来时拿到的 `undefined`"
 * 与"词典里少了一份语言"—— 后者若不做，`t()` 会去查一个不存在的对象，
 * 于是每一个标签都显示成键名，整页看起来像坏了。
 */
export function sanitizeLocale(raw: unknown): Locale {
  if (typeof raw !== 'string') return DEFAULT_LOCALE
  const s = raw.trim()
  return (LOCALES as readonly string[]).includes(s) ? (s as Locale) : DEFAULT_LOCALE
}

/**
 * 浏览器/系统的语言偏好 → 我们支持的那一个（`navigator.language` 那一族）。
 *
 * **只作兜底**：设置文件里有值就用那个值，这一条只在"从没存过语言"时跑。
 * 判定顺序是「先精确、再前缀」：`zh-TW` 精确命中；`zh-HK` 前缀命中 `zh`，
 * 而 `zh` 有两种，按**繁体地区清单**判（`HK` / `MO` / `TW` 走 `zh-TW`，其余 `zh-CN`）。
 * 一个把 `zh-HK` 判成简体的人看到的是另一种字形，那在他看来就是"这软件没译好"。
 */
export function localeFromTag(tag: string | null | undefined): Locale {
  if (!tag) return DEFAULT_LOCALE
  const t = tag.trim().replace(/_/g, '-')
  if (t === '') return DEFAULT_LOCALE
  const exact = (LOCALES as readonly string[]).find((l) => l.toLowerCase() === t.toLowerCase())
  if (exact) return exact as Locale
  const lower = t.toLowerCase()
  if (lower.startsWith('zh')) {
    const region = lower.split('-')[1] ?? ''
    return ['tw', 'hk', 'mo', 'hant'].includes(region) ? 'zh-TW' : 'zh-CN'
  }
  if (lower.startsWith('ja')) return 'ja'
  if (lower.startsWith('ko')) return 'ko'
  if (lower.startsWith('en')) return 'en'
  return DEFAULT_LOCALE
}
