/**
 * 词典的**形状**（2026-10-29）。
 *
 * ## 为什么是"中文原文当键"
 *
 * 三个方案都试过在心里走一遍：
 *  ① `t('home.startScan')` + 五份扁平 JSON —— 键名与文案分离，改一句话要同时改五处；
 *  ② 中文原文当键（本方案）—— 改中文原文时，另外四份找不到键会自动回落到中文；
 *  ③ 给每个字符串编号 —— 编号会漂，而漂了的编号在界面上的表现是一句风马牛不相及的话。
 *
 * 选 ② 的理由不是省事，是**失败模式**：键名方案漏一条的表现是界面上冒出
 * `home.startScan` 这种字样，而那是一个用户不该看到的东西；中文原文方案漏一条的
 * 表现是那句话显示成中文 —— 在一个日语界面上，它是一处没译到，但不是一处坏掉。
 * 前者是缺陷，后者是欠账，而欠账可以一条条补。
 *
 * ## 为什么不做编译期穷尽
 *
 * 词典是 `Record<string, string>` 而不是 `{ [K in keyof ZH]: string }`。
 * 后者看着更严，但它会让"加一条新的中文文案"变成"同时改五个文件"——
 * 而那五份之间没有任何自动化能保证译得对，只保证**填了**。
 * 这里宁可让漏译在运行时可见（下面 `missingKeys` 一条判据钉着数量），
 * 也不拿类型系统假装翻译完成了。
 */

/** 一份词典。键是**中文原文**，值是目标语言。 */
export type Dict = Record<string, string>

/**
 * 查一条。**查不到就回原文**（见文件头那段"失败模式"）。
 *
 * `vars` 做的是 `{name}` 占位替换，而不是 `t('a') + x + t('b')` ——
 * 后者会把一句话拆成几段，而语序在日语/韩语里与中文不同，
 * 拆开之后译者就没法把句子重新排序了。占位符留在一句完整的话里，他才有那个自由。
 */
export function translate(dict: Dict, source: string, vars?: Record<string, string | number>): string {
  const hit = dict[source]
  const text = hit === undefined ? source : hit
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : String(v)
  })
}

/**
 * 一份词典相对中文原文**漏了多少条**。给测试用，也给"这份翻译完成了几成"一句话。
 *
 * `keys` 是那份语言的键集（必须逐字等于中文词典的键集才有意义 ——
 * 多出来的键不会被任何地方读到，漏掉的键会回落成中文）。
 * 只报漏，不报多：多出来的键通常是中文原文改过之后的残留，
 * 它不影响显示，只影响文件大小，不值得让一条判据红。
 */
export function missingKeys(source: readonly string[], dict: Dict): string[] {
  return source.filter((k) => dict[k] === undefined)
}
