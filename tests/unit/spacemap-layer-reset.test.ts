/**
 * 换层必须清掉选中 —— 2026-10-27 晚人类伙伴截图报的 bug。
 *
 * ## 缺陷长什么样
 *
 * 右键某个方块 → 它被选中（蓝框）→ 返回上一级 → **蓝框还在，但框住的是这一层别的东西**。
 * 截图里：站在 `C:\Users` 这一层，框却落在 AppData 那一格的位置上。
 *
 * 根因不是"忘了清"这么简单：`active` 里存的是一个 `Tile`，它带着 `x/y/w/h` 这一套
 * **上一层的布局坐标**。`TreemapCanvas` 的高亮层照样拿它去 `project(t, view)` 画框 ——
 * 于是框画进了新一层的坐标系。
 *
 * ## 为什么是两半，且这半比较弱
 *
 * 本仓**没有 React 挂载设施**（渲染端一律测抽出来的纯判定，见 `scan-scope-ownership.test.tsx`
 * 文件头那段同一条理由），所以：
 *  ① **根因**用纯函数钉：`treemap-view.test.ts` 那条「跨层的 Tile 在新一层里画框必然错位」——
 *    它证明"不清就必然错位"，是这半的**理由**，但它**抓不住**"有人把 `setActive(null)` 删了"
 *    这个回归（实测：删掉之后 27 条全绿）。
 *  ② **行为**用读源码的结构闸钉（本文件）。它挡得住"那行被删/被挪走"，挡不住"在别处又塞一份
 *    `active`"。
 *
 * 要升级成真行为用例，得先给仓里装一套 mount 设施，那是另一批的事 —— 在那之前不许把这条
 * 说成"已被行为覆盖"。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SPACE_MAP = readFileSync('src/renderer/pages/SpaceMap.tsx', 'utf8')

/** 取出 `useEffect(() => {...}, [nav.path])` 那个块的函数体。 */
function navPathEffectBody(): string {
  /**
   * ⚠️ 这里踩过一个坑，留在这免得下次再踩：**不许**写成
   * `/useEffect\(\(\) => \{([\s\S]*?)\}, \[nav\.path\]\)/`。
   *
   * 那个正则会从文件里**第一个** `useEffect(() => {` 起匹配，一路非贪婪地吃到
   * `[nav.path]` —— 而 `SpaceMap.tsx` 前面还有别的 effect（拉 skipped、拉视图…），
   * 于是捕获体是**别人的整个函数体**。它里面恰好有 `setActive(null)`，
   * 所以「删掉换层那行的 setActive」这个变异**测不出来**（实测：变异后 4 条全绿）。
   *
   * 正确做法：先定位 `[nav.path]` 这个依赖数组（全文只有一处），再从它**往前**找
   * 最近的 `useEffect(() => {`，两者之间就是那个 effect 的体。
   */
  const dep = SPACE_MAP.indexOf('}, [nav.path])')
  expect(dep, '找不到依赖 [nav.path] 的收尾 —— 换层的唯一落点没了？').toBeGreaterThan(-1)
  const open = SPACE_MAP.lastIndexOf('useEffect(() => {', dep)
  expect(open, '找不到 [nav.path] 那个 effect 的开头').toBeGreaterThan(-1)
  const bodyStart = SPACE_MAP.indexOf('{', open) + 1
  const body = SPACE_MAP.slice(bodyStart, dep)
  // 自检：这个体不许大到把别的 effect 也包进来（真出这种事时下面几条会假绿）。
  expect(body.length, '取到的 effect 体异常长，多半把前面的 effect 一起吞了').toBeLessThan(400)
  return body
}

describe('换层（nav.path 变化）必须同时做三件事', () => {
  it('清掉选中 `setActive(null)`（就是这次的 bug）', () => {
    expect(
      navPathEffectBody(),
      '换层时没清选中 ⇒ 上一层的 Tile 会被拿去这一层画框，蓝框落在错误的位置上'
    ).toContain('setActive(null)')
  })

  it('清掉统计 `nav.clearStats()`（它与选中是同一个动作拉的，只清一半会变成"没名字 + 有统计"）', () => {
    expect(navPathEffectBody(), '换层时没清统计').toContain('nav.clearStats()')
  })

  it('松开钉住 `setPinned(false)`（原有那条，不许在改动里被顺手删掉）', () => {
    expect(navPathEffectBody(), '换层时没松开钉住').toContain('setPinned(false)')
  })

  it('这三件事**都在同一个 effect 里**，不是散在两个地方（散开就会有一条走不到）', () => {
    const body = navPathEffectBody()
    const missing = ['setActive(null)', 'nav.clearStats()', 'setPinned(false)'].filter((s) => !body.includes(s))
    expect(missing, `这些不在 [nav.path] 那个 effect 里：${missing.join(' / ')}`).toEqual([])
  })
})
