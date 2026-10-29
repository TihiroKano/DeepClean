import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitRules, glassClasses, pageMap, build, GLASS_CSS } from '../../scripts/glass-inventory.mjs'

// 这一组断言钉的是**量具本身**，不是"哪页有没有玻璃"那个结论 —— 结论是 Task 5 要交给用户定的，
// 把它写成断言就等于预先替设计拍板（而且第一次跑就把它跑红了）。

describe('glass-inventory 量具', () => {
  it('仓里两份 CSS 拆得出规则，且玻璃类非空（先证明判据不是恒空）', () => {
    const rules = GLASS_CSS.flatMap((f) => splitRules(readFileSync(join(process.cwd(), f), 'utf8')))
    expect(rules.length).toBeGreaterThan(100)
    const cls = glassClasses(rules)
    expect(cls.length).toBeGreaterThanOrEqual(10)
    expect(cls).toContain('dc-card')
  })

  it('包在 @media 里的玻璃规则不许整个丢掉（递归分支要有东西喂）', () => {
    const css = `@media (max-width: 900px) {\n  .dc-narrow-glass { backdrop-filter: blur(8px); }\n}\n.dc-outside { color: red; }`
    const rules = splitRules(css)
    expect(rules.map((r) => r.selector)).toContain('.dc-narrow-glass')
    expect(glassClasses(rules)).toEqual(['dc-narrow-glass'])
    expect(rules.find((r) => r.selector === '.dc-narrow-glass')!.media).toContain('max-width')
  })

  it('`:root` 的 token 定义块不算一块玻璃；没声明 backdrop-filter 的规则也不算', () => {
    const rules = splitRules(
      ':root { --glass-blur-page: 18px; backdrop-filter: none; }\n.plain { padding: 4px; }\n.glassy { backdrop-filter: blur(2px); }',
    )
    expect(glassClasses(rules)).toEqual(['glassy'])
  })

  it('六页全部解析出组件名 —— 这条钉的是 `view === x && (` 那种隔行写法', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8')
    const pages = pageMap(src)
    // `large`（大文件）与 `dups`（重复文件）两页已下线并删除，清单跟着收成六页。
    expect(pages.map((p) => p.view)).toEqual(['home', 'map', 'cleanup', 'devenv', 'journal', 'settings'])
    const missing = pages.filter((p) => !p.component)
    expect(missing, `这些页没解析出组件，own/imported 会静默恒空：${JSON.stringify(missing)}`).toEqual([])
  })

  it('盘点结果自相矛盾检查：被判"没人用"的玻璃类，不许同时出现在骨架层引用里', () => {
    const inv = build()
    const skeleton = new Set(inv.rows[0]?.skeleton ?? [])
    const lied = inv.unused.filter((c) => skeleton.has(c))
    expect(lied, `第一版就是这个形状：skeleton=[dc-side] 与 UNUSED 含 dc-side 同屏出现`).toEqual([])
    expect(inv.rows.every((r) => r.total >= r.skeleton.length)).toBe(true)
  })

  it('页文件里的引用真能被 own 抓到（不是所有页都只剩骨架那一格）', () => {
    const inv = build()
    const cleanup = inv.rows.find((r) => r.view === 'cleanup')
    expect(cleanup, '盘点里必须有 cleanup 这一行').toBeTruthy()
    expect(cleanup!.own.length, 'Cleanup.tsx 里那些 dc-clean-* 类必须归到它自己名下').toBeGreaterThan(0)
    expect(cleanup!.own).toContain('dc-clean-total')
  })
})
