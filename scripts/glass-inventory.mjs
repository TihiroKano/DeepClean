// Liquid Glass 盘点的**静态那一半**。
//
// 为什么要拆成两半：spec 要求「Liquid Glass 全面落地」，但仓里没有任何判据能回答"落地了没"。
// 一条"这页有玻璃"的真判据是 —— 渲染这页时 DOM 里存在至少一个
// `getComputedStyle(el).backdropFilter !== 'none'` 且面积 ≥ 视口 5% 的元素。
// 这个判据**只能在真机上量**：静态 `renderToStaticMarkup` 没有布局引擎，拿不到 computed style，
// 也拿不到面积（那一段落在 scripts/m6b-pages-e2e.ps1，本文件不假装能替它）。
//
// 本文件回答的是**在它之前**的那一格：源码层面这页能不能碰到一块玻璃。分三档，一档比一档弱：
//   skeleton —— 类名写在 App.tsx 骨架层 ⇒ 八页全都有（这正是"页面级 grep 给出坏答案"的原因：
//              `Cleanup.tsx` 里 86 处 className、0 处 dc-card，不代表那页没卡片）。
//   own      —— 类名写在该页自己的 .tsx 里。
//   imported —— 类名写在该页直接 import 的组件里（只走一层，再深就不 stat本文件不追，追了也说不清）。
// 外加一条本仓 CSS 文件头自己警告过的陷阱：**定义了却没人用的玻璃 token 会骗下一个来加表面的人**，
// 所以带 backdrop-filter 而全仓无人引用的类名单独列出。

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '../..')
const rel = (p) => relative(ROOT, p).split(sep).join('/')

export const GLASS_CSS = ['src/renderer/styles/global.css', 'src/renderer/styles/glass/tokens.css']

/** 把一份 CSS 拆成顶层规则。注释里的 `{`/`}` 不参与配对 —— 那些注释很长且带中文。
 *  `@media` 这类 at-rule 钻进子里递归拆，否则包在媒体查询里的玻璃规则会整个丢掉的。 */
export function splitRules(css, inside) {
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  const out = []
  let i = 0
  while (i < noComment.length) {
    const open = noComment.indexOf('{', i)
    if (open < 0) break
    let depth = 1
    let close = open + 1
    while (close < noComment.length && depth > 0) {
      if (noComment[close] === '{') depth++
      else if (noComment[close] === '}') depth--
      close++
    }
    const body = noComment.slice(open + 1, close - 1)
    const prelude = noComment.slice(i, open).trim()
    if (prelude.startsWith('@') && prelude !== inside) {
      out.push(...splitRules(body, prelude))
    } else if (prelude) {
      out.push({ selector: prelude.replace(/\s+/g, ' '), body, media: inside || null })
    }
    i = close
  }
  return out
}

/** 所有**声明了 backdrop-filter** 的规则里出现的类名（去重、按定义顺序）。 */
export function glassClasses(rules) {
  const seen = []
  for (const r of rules) {
    if (!/backdrop-filter\s*:/.test(r.body)) continue
    if (/^\s*:root\s*$/.test(r.selector)) continue // token 定义块本身不是一块玻璃
    for (const m of r.selector.matchAll(/\.(?:[A-Za-z0-9_-]+)/g)) {
      const c = m[0].slice(1)
      if (!seen.includes(c)) seen.push(c)
    }
  }
  return seen
}

/** 从 App.tsx 里读出「view → 页组件」的映射（不硬编码八页，路由变了这条要跟着红）。
 *  两种写法都有：`view === 'home' && <Home ... />` 与 `view === 'cleanup' && (` 后面才隔行出现
 *  `<Cleanup ...>` —— 只认前一种的话，四页会静默拿到 component=null，于是 own/imported 恒空，
 *  看着像"那四页真的没玻璃"。（2026-10-17 第一版就是这么错的。） */
export function pageMap(appSrc) {
  const map = []
  for (const m of appSrc.matchAll(/view === '([a-z]+)' &&/g)) {
    const tail = appSrc.slice(m.index, m.index + 240)
    const tag = tail.match(/<([A-Z]\w*)/)
    map.push({ view: m[1], component: tag ? tag[1] : null })
  }
  return map
}

function tsxFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsxFiles(p))
    else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const usesClass = (src, cls) => new RegExp(`(?:^|[^\\w-])${cls}(?:$|[^\\w-])`).test(src)

/** 页组件 import 的第一层组件文件。基准是**该页自己所在目录**（`../components/Foo` 是相对
 *  `src/renderer/pages/` 的，拿 `src/renderer` 去 join 会归一化成 `src/components/Foo` 而全部落空）。 */
function directImports(src, fromDir) {
  const out = []
  for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
    const guess = join(fromDir, m[1] + '.tsx')
    try {
      readFileSync(guess, 'utf8')
      out.push(guess)
    } catch {
      /* 不是 .tsx（样式、纯 ts）—— 不是玻璃的载体，跳过 */
    }
  }
  return out
}

export function build() {
  const rules = []
  for (const f of GLASS_CSS) rules.push(...splitRules(readFileSync(join(ROOT, f), 'utf8')))
  const classes = glassClasses(rules)

  const rendererDir = join(ROOT, 'src', 'renderer')
  const appSrc = readFileSync(join(rendererDir, 'App.tsx'), 'utf8')
  const appClasses = classes.filter((c) => usesClass(appSrc, c))

  const pages = pageMap(appSrc)
  const rows = []
  for (const pg of pages) {
    const file = pg.component
      ? join(rendererDir, 'pages', pg.component + '.tsx')
      : null
    let own = [], imported = []
    if (file) {
      const src = readFileSync(file, 'utf8')
      own = classes.filter((c) => usesClass(src, c))
      for (const imp of directImports(src, dirname(file))) {
        const isrc = readFileSync(imp, 'utf8')
        for (const c of classes.filter((x) => usesClass(isrc, x))) {
          if (!imported.includes(c)) imported.push(c)
        }
      }
    }
    rows.push({
      view: pg.view,
      component: pg.component || '(内联)',
      file: file ? rel(file) : null,
      skeleton: appClasses,
      own,
      imported,
      total: new Set([...appClasses, ...own, ...imported]).size,
    })
  }

  // 骨架层的引用**算引用**：把 App.tsx 从这张表里排除，会得到「dc-side 定义了却没人用」这种
  // 与同一份输出里 skeleton=[dc-side] 直接矛盾的话 —— 第一版就是这么自相矛盾的。
  const allFiles = tsxFiles(rendererDir)
  const unused = classes.filter((c) => !allFiles.some((f) => usesClass(readFileSync(f, 'utf8'), c)))

  return { classes, rows, unused, definedIn: GLASS_CSS.map(rel) }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const inv = build()
  console.log(`GLASS_CLASSES=${inv.classes.length}`)
  for (const r of inv.rows) {
    console.log(
      `PAGE ${r.view.padEnd(9)} total=${String(r.total).padStart(2)} own=[${r.own.join(',')} ] ` +
        `imported=[${r.imported.join(',')}] skeleton=[${r.skeleton.join(',')}]`,
    )
  }
  console.log(`UNUSED_GLASS_CLASSES=${inv.unused.length} [${inv.unused.join(',')}]`)
}
