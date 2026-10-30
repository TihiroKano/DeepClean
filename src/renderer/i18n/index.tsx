/**
 * 界面语言的运行期入口（2026-10-29）。
 *
 * ## 为什么要一个 Context，而不是每处 `import { t } from '../i18n'`
 *
 * 一个模块级的 `t` 只能在**启动时**决定语言；而这一格是**当场生效**的
 * （设置页选了日语，回来那一屏就该是日语）。模块级实现要么重启，
 * 要么让每个组件自己订阅 —— 后者是"同一份 state 有一百个读者各自记得刷新"，
 * 而那正是本仓反复栽过的那种形状缺陷。
 *
 * 所以：`LocaleProvider` 在 `App` 外面挂一次，`useT()` 往下取。
 * 换语言 = 换一次 context 值 = React 自己重渲染，不需要任何组件知道这件事。
 *
 * ## 为什么不放 `useLocale` 那个 hook 里去读设置
 *
 * `useSettings()` 已经有一份"读盘 + 回执赢"的实现。再写第二个读盘入口，
 * 就成了"设置页改了语言、别处还拿着旧的那份"的开始。
 * 这个 Provider 的输入是 `useSettings().value.locale`，它自己不读盘。
 */
import { createContext, useContext, useMemo } from 'react'
import { DEFAULT_LOCALE, type Locale } from '../../../shared/i18n'
import { translate, type Dict } from './dict'
import { ZH_CN } from './dicts/zh-CN'
import { ZH_TW } from './dicts/zh-TW'
import { EN } from './dicts/en'
import { JA } from './dicts/ja'
import { KO } from './dicts/ko'

/**
 * 语言 id → 词典。
 *
 * ⚠️ 这张表**必须与 `shared/i18n.ts` 的 `LOCALES` 逐条对上**：
 * 少一份的表现不是崩溃，是那个语言下每一个标签都显示成中文原文
 * （因为 `translate` 回落到源文）—— 看起来像"选了没生效"。
 * `tests/unit/i18n-locale.test.ts` 按 `LOCALES` 逐个点名这张表，少一份就红。
 */
export const DICTS: Record<Locale, Dict> = {
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW,
  en: EN,
  ja: JA,
  ko: KO
}

/** 取一份词典。认不出的语言回默认那份（不抛 —— 语言不该让界面白屏）。 */
export function dictFor(locale: Locale): Dict {
  return DICTS[locale] ?? DICTS[DEFAULT_LOCALE]
}

export type TranslateFn = (source: string, vars?: Record<string, string | number>) => string

export const LocaleContext = createContext<Locale>(DEFAULT_LOCALE)

/**
 * 当前语言的 `t`。
 *
 * `useMemo` 的依赖只有 `locale`：换语言时 `t` 换新引用，所有用到它的组件都重渲染；
 * 没换语言时引用稳定，避免每帧重渲染。
 */
export function useT(): TranslateFn {
  const locale = useContext(LocaleContext)
  return useMemo(() => {
    const dict = dictFor(locale)
    const t: TranslateFn = (source, vars) => translate(dict, source, vars)
    return t
  }, [locale])
}

/** 当前语言本身（`<html lang>`、语言下拉那一格要它）。 */
export function useLocale(): Locale {
  return useContext(LocaleContext)
}
