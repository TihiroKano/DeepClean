/**
 * 图标集的诚实性检查（V0.9 应用外壳与首页改版）。
 *
 * 这一组测试守的不是"好不好看"——好不好看归 `--shot` 的肉眼验收管，20px 下一个歪掉的齿轮
 * 任何断言都测不出来。这里守的是**四件会静默烂掉的事**：
 *
 * 1. **清单与注册表对得上，且指向同一个组件**。`ICON_NAMES` 与 `ICONS` 是手写的两份
 *    （故意的：从 `Object.keys(ICONS)` 推清单，会把"漏登记一个组件"变成静默一致）。
 *    手写就有漂移，所以两边都要查，还要查 `ICONS.HomeIcon` 真的就是那个导出的 `HomeIcon`
 *    —— 复制粘贴时把值写成隔壁那个组件，是这种表最典型的坏法，而它照样渲染得出东西。
 * 2. **外壳那套属性是真由 `Svg` 统一给的**，不是每个图标自己抄一遍。所以逐个钉
 *    `viewBox` / `fill="none"` / `stroke="currentColor"`：漏了 `fill="none"` 的话
 *    闭合路径会被填成实心黑块，那是视觉验收里最难看的一种坏法，但它在源码里看不出来。
 * 3. **几何体真的存在**：每个图标至少 2 个 path/circle/rect/line/polyline/polygon。
 *    这一条是拿来挡占位货的 —— 一个 `<rect>` 交差、名字起得好好的、看着像接了，其实什么都没画。
 *    （`CloseIcon` / `BoltIcon` / `Chevron*Icon` 天生一笔，按 `icons.tsx` 文件头的约定
 *    拆成两笔真几何，接缝落在拐点或直边中点上，20px 下与单条折线逐像素相同。）
 * 4. **23 个图形互不相同**：两个图标渲染出同一串几何体，就说明其中一个是复制粘贴来的假货。
 *
 * 渲染走 `renderToStaticMarkup`（与 `dup-render.test.tsx` / `skip-panel.test.tsx` 同先例）：
 * 本项目 vitest 是 `environment: 'node'`，没有 jsdom，也没有 testing-library，
 * 断言打在**真渲染出来的 HTML 串**上，不打在源码字符串上 —— 后者测的是字面量在文件哪儿，
 * 不是元素有没有进 DOM。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ICON_NAMES, ICONS } from '../../src/renderer/components/icons'
import * as IconsNamespace from '../../src/renderer/components/icons'

/** 非默认的一组 props：既验参数真的生效，也顺便验默认值没被写死。 */
const PROPS = { size: 18, strokeWidth: 2, className: 'dc-nav-ico' } as const

/** 按组件的方式走 JSX（而不是 `ICONS[name](props)` 直接调函数）：测的是"它真的能被当组件用"。 */
const markupOf = (name: string): string => {
  const Cmp = ICONS[name]
  if (!Cmp) throw new Error(`ICONS 里查不到 ${name}`)
  return renderToStaticMarkup(<Cmp {...PROPS} />)
}

const geometryCount = (markup: string): number => (markup.match(/<(path|circle|rect|line|polyline|polygon)\b/g) ?? []).length

describe('图标集：清单、注册表与导出三者对账', () => {
  it('ICON_NAMES 恰好 23 条', () => {
    expect(ICON_NAMES).toHaveLength(23)
  })

  it('没有重名（重名会让 23 这个数字骗过上一条）', () => {
    expect(new Set(ICON_NAMES).size).toBe(23)
  })

  it('按字典序排列', () => {
    expect([...ICON_NAMES]).toEqual([...ICON_NAMES].sort())
  })

  it('ICONS 的键与 ICON_NAMES 逐字相同：漏登记与多登记都要红', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...ICON_NAMES].sort())
  })

  it('每个 ICONS 值就是同名那个导出组件，不是指错了人', () => {
    for (const name of ICON_NAMES) {
      const exported = (IconsNamespace as Record<string, unknown>)[name]
      expect(exported, `${name} 没有作为同名导出存在`).toBeTypeOf('function')
      expect(ICONS[name], `ICONS.${name} 指向的不是那个导出的 ${name}`).toBe(exported)
    }
  })

  it('反向半边：文件里每个 XxxIcon 导出都进了清单（不许有没人认领的图标）', () => {
    const exportedIcons = Object.keys(IconsNamespace).filter((k) => /Icon$/.test(k))
    expect(exportedIcons.sort()).toEqual([...ICON_NAMES].sort())
  })
})

describe('图标集：逐个真渲染', () => {
  for (const name of ICON_NAMES) {
    it(`${name} 渲染不抛错，且外壳属性由 Svg 统一给齐`, () => {
      let markup = ''
      expect(() => {
        markup = markupOf(name)
      }).not.toThrow()
      expect(markup.startsWith('<svg '), `${name} 的根元素不是 <svg>`).toBe(true)
      expect(markup).toContain('viewBox="0 0 24 24"')
      expect(markup).toContain('fill="none"')
      expect(markup).toContain('stroke="currentColor"')
      // props 真的透传，不是外壳里写死一组数：写死的话尺寸与描边永远调不动
      expect(markup).toContain('width="18"')
      expect(markup).toContain('height="18"')
      expect(markup).toContain('stroke-width="2"')
      expect(markup).toContain('class="dc-nav-ico"')
      // 侧栏每个导航项旁边都跟着中文标签，图标是重复信息：读屏不许念第二遍
      expect(markup).toContain('aria-hidden="true"')
      expect(markup).toContain('focusable="false"')
      expect(markup).toContain('stroke-linecap="round"')
      expect(markup).toContain('stroke-linejoin="round"')
    })

    it(`${name} 至少 2 个几何元素（挡一个 <rect> 交差的占位货）`, () => {
      expect(geometryCount(markupOf(name)), `${name} 画得太少，认不出是个什么东西`).toBeGreaterThanOrEqual(2)
    })
  }

  it('23 个图形两两不同（复制粘贴出来的假货在这里现形）', () => {
    const shapes = ICON_NAMES.map((n) => {
      const m = markupOf(n)
      return m.slice(m.indexOf('>') + 1, m.lastIndexOf('</svg>'))
    })
    expect(new Set(shapes).size, '有两个图标渲染出同一串几何体').toBe(23)
  })

  it('不传 props 时的默认值：size 20 / strokeWidth 1.8', () => {
    const Cmp = ICONS['HomeIcon']
    expect(Cmp).toBeDefined()
    const markup = renderToStaticMarkup(Cmp ? <Cmp /> : null)
    expect(markup).toContain('width="20"')
    expect(markup).toContain('height="20"')
    expect(markup).toContain('stroke-width="1.8"')
    // 没传 className 就不该留一个空 class 属性在 DOM 上
    expect(markup).not.toContain('class=')
  })
})
