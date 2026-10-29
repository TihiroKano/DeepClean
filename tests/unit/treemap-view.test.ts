import { describe, expect, it } from 'vitest'
import { FIT, MAX_SCALE, clampView, focusView, panBy, project, tileText, unproject, zoomAt } from '../../core/analyze/treemap-view'
import { toTiles } from '../../core/analyze/treemap-data'
import { formatBytes } from '../../shared/format'
import type { ChildView } from '../../shared/types'

const r = { x: 100, y: 50, w: 200, h: 80 }
const W = 1000
const H = 700

describe('treemap-view（§13 缩放与视图）', () => {
  it('FIT 是恒等变换', () => {
    expect(project(r, FIT)).toEqual(r)
  })

  it('project / unproject 往返：屏幕点绕一圈回到布局点', () => {
    const v = zoomAt(FIT, 320, 210, 3.7, W, H)
    const back = unproject(project({ x: 320, y: 210, w: 0, h: 0 }, v), v)
    expect(back.x).toBeCloseTo(320, 6)
    expect(back.y).toBeCloseTo(210, 6)
  })

  it('zoomAt 把光标钉在原处：缩放前后同一屏幕点对应同一布局点', () => {
    const before = unproject({ x: 320, y: 210 }, FIT)
    const v = zoomAt(FIT, 320, 210, 2, W, H)
    const after = unproject({ x: 320, y: 210 }, v)
    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('scale=1 时不许把内容拖出画布（夹回 0）', () => {
    expect(clampView({ scale: 1, ox: -500, oy: -500 }, W, H)).toEqual({ scale: 1, ox: 0, oy: 0 })
    expect(panBy(FIT, -999, -999, W, H)).toEqual({ scale: 1, ox: 0, oy: 0 })
  })

  it('放大后仍可平移到边界，且不越界露白', () => {
    const v = { scale: 2, ox: 0, oy: 0 }
    expect(clampView(panBy(v, -99999, -99999, W, H), W, H)).toEqual({ scale: 2, ox: -W, oy: -H })
    expect(clampView(panBy(v, 99999, 99999, W, H), W, H)).toEqual({ scale: 2, ox: 0, oy: 0 })
  })

  it('缩放倍率有上下限：滚轮狂滚不会把内容缩成 0 也不会放大到爆', () => {
    let v: { scale: number; ox: number; oy: number } = FIT
    for (let i = 0; i < 60; i++) v = zoomAt(v, 500, 350, 1.5, W, H)
    expect(v.scale).toBe(MAX_SCALE)
    for (let i = 0; i < 200; i++) v = zoomAt(v, 500, 350, 1 / 1.5, W, H)
    expect(v.scale).toBe(1)
  })

  it('focusView 让目标块完整落进画布；放不到 1/3 边时必须已经顶到倍率上限（两者必居其一）', () => {
    const tiny = { x: 900, y: 650, w: 5, h: 5 }
    const v = focusView(FIT, tiny, W, H)
    const p = project(tiny, v)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x + p.w).toBeLessThanOrEqual(W + 1)
    expect(p.y).toBeGreaterThanOrEqual(0)
    expect(p.y + p.h).toBeLessThanOrEqual(H + 1)
    // 5px 的块要占满 1/3 屏需要 66 倍，超过 MAX_SCALE=40 —— 那就该停在 40 而不是假装满足
    expect(p.w >= W / 3 - 1 || v.scale === MAX_SCALE).toBe(true)
  })

  it('focusView 对中等块：放大到约 60% 边长并居中', () => {
    const mid = { x: 100, y: 100, w: 100, h: 60 }
    const p = project(mid, focusView(FIT, mid, W, H))
    expect(p.w).toBeGreaterThanOrEqual(W / 3 - 1)
    expect(p.x).toBeGreaterThanOrEqual(0)
    expect(p.x + p.w).toBeLessThanOrEqual(W + 1)
    expect(p.y).toBeGreaterThanOrEqual(0)
    expect(p.y + p.h).toBeLessThanOrEqual(H + 1)
  })
})

/**
 * §13 的 label 判定：**一律用屏幕尺寸**。
 * `toTiles` 在布局期就把 62×22 以下的格子清成空 label/sub（`treemap-data.ts:112`），而缩放不重跑布局，
 * 所以「有没有字」绝不能拿 `t.label` 非空当判据 —— 那样放大只解放了本来就有字的格，
 * 小方块照样永远没名字（评审点名的半吊子）。判据在 tileText 里，故可单测。
 */
// dirId 必须唯一：toTiles 用 `${kind}:${dirId}` 当 tile 的 key，同 key 的两个子项会被 byKey 解析成同一个 child。
let nextDirId = 1
const dir = (name: string, size: number): ChildView => ({
  kind: 'directory',
  name,
  path: `C:\\${name}`,
  dirId: nextDirId++,
  size,
  mtimeMs: 1,
  fileCount: 1,
  dirCount: 0,
  attrs: null,
  birthtimeMs: null
})
const ZOOM4 = { scale: 4, ox: 0, oy: 0 }
/** 一块 30×24 的格：布局期（62×22）判不出来，所以 label/sub 就是空串 —— 正是「放大后才该有字」的那种。 */
const blankAtFit = { name: 'explorer.exe', value: 4_823_040, label: '', sub: '', x: 812, y: 402, w: 30, h: 24 }

describe('tileText（§13：文字门槛按屏幕尺寸判）', () => {
  it('100% 挤成空白的格，放大到 4× 就该出现名字和大小', () => {
    expect(tileText(blankAtFit, FIT)).toEqual({ label: '', sub: '' })
    const t = tileText(blankAtFit, ZOOM4)
    expect(t.label).toBe('explorer.exe')
    expect(t.sub).toBe(formatBytes(blankAtFit.value))
  })

  it('4× 后仍够不着门槛的格子照样不给字（判据不是恒真支）', () => {
    expect(tileText({ ...blankAtFit, w: 10, h: 5 }, ZOOM4)).toEqual({ label: '', sub: '' })
  })

  it('高度只够一行时给主名不给第二行', () => {
    const t = tileText({ ...blankAtFit, w: 20, h: 5 }, ZOOM4) // 80×20：>18 但 ≤34
    expect(t.label).toBe('explorer.exe')
    expect(t.sub).toBe('')
  })

  it('布局期就有字的格子沿用 label/sub，放大后不被 name 顶掉', () => {
    const titled = { name: 'Windows', value: 20_000_000_000, label: 'Windows', sub: '18.6 GB', x: 0, y: 0, w: 300, h: 100 }
    expect(tileText(titled, FIT)).toEqual({ label: 'Windows', sub: '18.6 GB' })
    expect(tileText(titled, ZOOM4)).toEqual({ label: 'Windows', sub: '18.6 GB' })
  })

  it('接上 toTiles 的真实产物：布局期被清空的 label 在 4× 视图里必须重新长出来', () => {
    const tiles = toTiles([dir('big', 100), dir('small', 3)], { x: 0, y: 0, w: 1000, h: 700 }, 'type')
    const small = tiles.find((t) => t.child.name === 'small')!
    expect(small.label).toBe('') // 布局期口径（treemap-data.test.ts:117 钉住的那条）
    expect(small.w * 4 > 56 && small.h * 4 > 18).toBe(true) // 4× 后落在门槛之上，前提成立
    expect(tileText(small, FIT).label).toBe('')
    expect(tileText(small, ZOOM4).label).toBe('small')
    expect(tileText(small, ZOOM4).sub).toBe(formatBytes(small.value))
  })

  /**
   * 2026-10-27 晚的 bug（人类伙伴截图：右键选中一个方块 → 返回上一级 → 蓝框还在，
   * 但框住的是**这一层别的东西**）。
   *
   * 根因不是"忘了清"，而是 `active` 里存的是一个 `Tile`，它带着 `x/y/w/h` 这一套
   * **上一层的布局坐标**；高亮层照样拿它去 `project()` 画框，于是框画进了新一层的坐标系。
   *
   * 这条判据钉的是**那条根因本身**：拿上一层的 Tile 去这一层画框，落点必然错位 ——
   * 所以"换层清掉 active"不是保守做法，是唯一能保证框与格子对得上的做法。
   * 修法在 `SpaceMap.tsx` 的 `nav.path` effect（清 active + 清统计）；
   * 那条 effect 在 node 环境里挂不起来（本仓没 jsdom），所以判据落在这里的纯函数层。
   */
  it('跨层的 Tile 在新一层里画框必然错位 —— 这就是"换层必须清选中"的理由', () => {
    /**
     * 夹具要造出**真实的错位**。踩过的两个坑，都留在这里免得下次再踩：
     *  ① 两层的选中格都从 (0,0) 起 —— 坐标恰好相同，判据成了恒真；
     *  ② 想靠"排在后面"避开原点也没用：`toTiles` 是**按大小降序**布格的，
     *     最大的那格永远在 (0,0)，所以要让选中格离开原点，它就不能是最大的。
     *
     * 这里上一层选中的是「mid」（第二大，x > 0），这一层最大的「inner」在 (0,0) 且占满前半屏。
     * 拿 mid 的坐标在这一层画框，落点必然与 inner 那格错开。
     */
    const parent = toTiles([dir('huge', 60), dir('mid', 40)], { x: 0, y: 0, w: 1000, h: 700 }, 'type')
    const selectedInParent = parent.find((t) => t.child.name === 'mid')!
    const child = toTiles([dir('inner', 60), dir('tiny', 40)], { x: 0, y: 0, w: 1000, h: 700 }, 'type')
    const inner = child.find((t) => t.child.name === 'inner')!

    // 前提：两层的布局坐标不是同一套（否则这条判据测不出任何东西）
    expect(selectedInParent.x, '夹具没造出跨层差异：上一层选中格与这一层最大格同在原点').not.toBe(inner.x)

    // 拿上一层的 Tile 在这一层画框：它落在「inner」这一格**外面**。
    // 这就是用户看到的"框还在、但框住的是别的东西"。
    const box = project(selectedInParent, FIT)
    const overlapsInner = box.x < inner.x + inner.w && box.x + box.w > inner.x
    expect(overlapsInner, '上一层的框居然对上了这一层的格子 —— 夹具没造出跨层差异').toBe(false)
  })
})
