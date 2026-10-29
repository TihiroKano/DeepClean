/**
 * `shouldShowLoading` —— 「Loading 什么时候该出现」的唯一判据。
 *
 * ## 为什么值得单开一个文件
 *
 * 这一格的语义**变过三次**，每次都因为同一种毛病：把"请求在飞"当成"该给用户看 spinner"。
 * 于是每勾选一条、每取消一条，页面上就闪一次 Loading —— 而一次重新计价是**单条内存 IPC**
 * （毫秒级），那条 Loading 的寿命常常比一次渲染还短，用户看到的只是"画面抖了一下"。
 * 那一抖恰好发生在刚点完复选框之后，读起来像卡了。
 *
 * 人类伙伴 2026-10-21 两轮的原话：
 *  · 「每次点击或取消勾选会出现重新计价」← 描述的就是上面那一抖；
 *  · 「只在第一次进入垃圾清理页面加载就好」← 这才是它该有的语义。
 *
 * 所以现在的定义只有一句话：**这一页还没有任何预估可显示时，才显示 Loading。**
 * 四格里最容易退回去的是第 3 格（已经有数还在算）—— 谁把它改回 true，
 * 那一下抖动就回来了，而**截图很难证明这件事**（抖动只有几百毫秒）。
 * 所以它在这里被钉成纯函数判据，而不是靠人眼复查。
 */
import { describe, expect, it } from 'vitest'
import { shouldShowLoading } from '../../src/renderer/hooks/usePreview'

describe('Loading 只在「这一页还没有预估」时出现', () => {
  it('① 首次进页面：没有过预估 + 请求在飞 ⇒ 显示', () => {
    expect(shouldShowLoading(false, true, false)).toBe(true)
  })

  it('② 首次进页面、但这次请求已经落定 ⇒ 不显示（不能让 Loading 自己留在屏幕上）', () => {
    expect(shouldShowLoading(false, false, false)).toBe(false)
  })

  it('③ **已经有预估、勾选后重算 ⇒ 不显示**（这一条就是人类伙伴说的那次抖动）', () => {
    expect(shouldShowLoading(true, true, false)).toBe(false)
  })

  it('④ 命中缓存 ⇒ 永远不显示（切页回来、勾选来回点都不闪）', () => {
    expect(shouldShowLoading(true, true, true)).toBe(false)
    expect(shouldShowLoading(false, true, true)).toBe(false)
    expect(shouldShowLoading(false, false, true)).toBe(false)
  })

  /**
   * 反面对照：这条判据必须**真的看** `hadAnyPreview` —— 如果它其实只返回 `isPending`，
   * 上面 ②③④ 里会有几条照样通过（③ 是唯一会红的那条，而它是整件的要害）。
   * 这里把 ③ 单独再压一次，并确认 ①/③ 在同一组 `isPending`、不同 `hadAnyPreview` 下答案相反。
   */
  it('对照：同一个 isPending=true，只翻 hadAnyPreview 就必须换答案', () => {
    expect(shouldShowLoading(false, true, false)).toBe(true)
    expect(shouldShowLoading(true, true, false)).toBe(false)
  })

  it('对照：同一个 hadAnyPreview=false，只翻 isPending 也必须换答案（否则它不看 isPending）', () => {
    expect(shouldShowLoading(false, true, false)).toBe(true)
    expect(shouldShowLoading(false, false, false)).toBe(false)
  })

  it('对照：cacheHit 必须压过其余两格（否则缓存命中时还会闪一下）', () => {
    expect(shouldShowLoading(false, true, false)).toBe(true)
    expect(shouldShowLoading(false, true, true)).toBe(false)
  })
})
