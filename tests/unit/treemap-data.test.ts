import { describe, expect, it } from 'vitest'
import { MAX_TILES, rootShareLabel, toTiles } from '../../core/analyze/treemap-data'
import { GROUP_COLORS, WIN_ATTR } from '../../shared/classify'
import type { ChildView } from '../../shared/types'

// dirId 必须唯一：toTiles 用 `${kind}:${dirId}` 当 tile 的 key，
// 早期版本这里写成 name.length + size，结果 'small'(5+1) 与 'big'(3+3) 撞成同一个 key，
// 两个 tile 解析回同一个 child —— 看着像布局比例错了，其实是夹具自己造了重复主键。
let nextId = 1
const dir = (name: string, size: number, path?: string): ChildView => ({
  kind: 'directory',
  name,
  path: path ?? `C:\\${name}`,
  dirId: nextId++,
  size,
  mtimeMs: 1,
  fileCount: 0,
  dirCount: 0,
  // 目录本轮不采属性，也不采创建时间
  attrs: null,
  birthtimeMs: null
})
const file = (name: string, size: number): ChildView => ({
  kind: 'file',
  name,
  path: `C:\\${name}`,
  size,
  mtimeMs: 1,
  fileCount: 0,
  dirCount: 0,
  attrs: 0,
  birthtimeMs: 1_600_000_000_000
})

const box = { x: 0, y: 0, w: 1000, h: 700 }
const area = (r: { w: number; h: number }): number => r.w * r.h
const sum = (rs: { value: number }[]): number => rs.reduce((s, r) => s + r.value, 0)

describe('toTiles（§10 面积成比例 / §13 配色）', () => {
  it('tile 数量与输入一致（未超上限时）', () => {
    expect(toTiles([dir('a', 100), dir('b', 400), dir('c', 50)], box, 'type')).toHaveLength(3)
  })

  it('面积与 size 成正比', () => {
    const t = toTiles([dir('small', 1), dir('big', 3)], box, 'type')
    const big = t.find((r) => r.child.name === 'big')!
    const small = t.find((r) => r.child.name === 'small')!
    expect(area(big) / area(small)).toBeCloseTo(3, 1)
  })

  it('渲染端拿到的是已收窄的 ≤MAX_TILES 项；toTiles 不再自己丢项（收窄在主进程做）', () => {
    const many = Array.from({ length: MAX_TILES }, (_, i) => dir(`d${i}`, MAX_TILES - i))
    const t = toTiles(many, box, 'type')
    expect(t).toHaveLength(MAX_TILES)
    expect(t[0]?.child.name).toBe('d0')
    expect(t.some((r) => r.folded)).toBe(false)
  })

  it('折叠项自成一格并点名，不再冒充某个真目录：面积仍守恒（§2 面积=大小）', () => {
    // 夹具按 ChildrenPayload 的契约构造：children 只有被留下的 MAX_TILES 项，
    // 折掉的那 3 项以 foldedCount/foldedBytes 单独记账，与数组**不重叠**（Σchildren + foldedBytes == ΣchildrenOf）。
    const many = Array.from({ length: MAX_TILES }, (_, i) => dir(`d${i}`, 10))
    const t = toTiles(many, box, 'type', { foldedCount: 3, foldedBytes: 30 })
    const fold = t.find((r) => r.folded === true)
    expect(fold?.child.name).toBe('其它 3 项')
    expect(fold?.value).toBe(30)
    expect(t.filter((r) => !r.folded).some((r) => r.child.name.includes('+'))).toBe(false)
    expect(sum(t)).toBe((MAX_TILES + 3) * 10)
  })

  it('三种配色模式各给不同颜色策略（§13 按类型 / 按大小 / 按目录）', () => {
    const kids = [dir('Windows', 100, 'C:\\Windows'), dir('Users', 50, 'C:\\Users'), file('a.mp4', 10)]
    const byType = toTiles(kids, box, 'type')
    expect(byType.find((t) => t.child.name === 'Windows')?.color).toBe('#4b6cb7')
    expect(byType.find((t) => t.child.name === 'a.mp4')?.color).toBe('#d1495b')

    const byDir = new Set(toTiles(kids, box, 'dir').map((t) => t.color))
    expect(byDir.size).toBeGreaterThan(1)

    const bySize = toTiles(kids, box, 'size')
    const colors = new Set(bySize.map((t) => t.color))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('配色与详情面板同源：真属性证明 SYSTEM 的文件即使路径干净也涂成 system 色（§13 / §16 不许各判各的）', () => {
    const protectedFile: ChildView = {
      kind: 'file',
      name: 'photo.jpg',
      path: 'D:\\MyStuff\\photo.jpg',
      size: 10,
      mtimeMs: 1,
      fileCount: 0,
      dirCount: 0,
      attrs: WIN_ATTR.system,
      birthtimeMs: 1_600_000_000_000
    }
    const t = toTiles([protectedFile], box, 'type')
    expect(t[0]?.group).toBe('system')
    expect(t[0]?.color).toBe(GROUP_COLORS.system)
  })

  it('0 字节子项不产生 tile，也不抛（空目录很常见）', () => {    const t = toTiles([dir('empty', 0), dir('x', 5)], box, 'type')
    expect(t.map((r) => r.child.name)).toEqual(['x'])
    expect(() => toTiles([dir('e', 0)], box, 'type')).not.toThrow()
  })

  it('空输入返回空数组（首页未扫描 / 空目录）', () => {
    expect(toTiles([], box, 'type')).toEqual([])
  })

  it('矩形够大才给 label 与 sub（§13 可读性）', () => {
    const t = toTiles([dir('big', 9998), dir('tiny', 1), dir('tiny2', 1)], box, 'type')
    const big = t.find((r) => r.child.name === 'big')!
    expect(big.label).toBe('big')
    expect(big.sub).not.toBe('')
    const tiny = t.find((r) => r.child.name === 'tiny')!
    expect(tiny.label).toBe('')
  })

  it('tile 携带 child 原对象，钻取要用的 dirId 不能丢（§11 可钻取）', () => {
    const d = dir('Kano', 100, 'C:\\Users\\Kano')
    const t = toTiles([d], box, 'type')
    expect(t[0]?.child.dirId).toBe(d.dirId)
    expect(t[0]?.child.kind).toBe('directory')
  })

  it('文件 tile 没有 dirId，双击不该钻进去', () => {
    const t = toTiles([file('a.bin', 10)], box, 'type')
    expect(t[0]?.child.dirId).toBeUndefined()
  })

  it('悬浮百分比：占当前目录与占全盘各一行，分母为 0 时如实给 NaN 前的 0 而不是假数', () => {
    const kids = [dir('Windows', 400, 'C:\\Windows'), dir('Users', 100, 'C:\\Users')]
    const t = toTiles(kids, box, 'type', { parentSize: 500, rootSize: 1000 })
    const w = t.find((r) => r.child.name === 'Windows')!
    expect(w.pctOfParent).toBeCloseTo(80, 6)
    expect(w.pctOfRoot).toBeCloseTo(40, 6)
    const zero = toTiles(kids, box, 'type')
    expect(zero.find((r) => r.child.name === 'Windows')?.pctOfParent).toBe(0)
  })

  it('折叠块没有 dirId：双击进不去、右键给不了打开（它不是一个真存在的项）', () => {
    const t = toTiles([dir('a', 10)], box, 'type', { foldedCount: 5, foldedBytes: 5 })
    const fold = t.find((r) => r.folded)!
    expect(fold.child.dirId).toBeUndefined()
    expect(fold.child.kind).toBe('directory')
  })

  it('面积守恒：Σtile.value == Σchildren + foldedBytes（裁剪/折叠都不许吞掉容量）', () => {
    const kids = Array.from({ length: 40 }, (_, i) => dir(`d${i}`, i + 1))
    const t = toTiles(kids, box, 'type', { foldedCount: 7, foldedBytes: 700 })
    expect(sum(t)).toBe(kids.reduce((s, c) => s + c.size, 0) + 700)
  })

  it('birthtime 随 child 原样进 tile；合成折叠格的是 null 而不是 0（详情面板据此判「未采集」/整行撤掉）', () => {
    const t = toTiles([file('x.pak', 10)], box, 'type')
    expect(t[0]?.child.birthtimeMs).toBe(1_600_000_000_000)
    const fold = toTiles([dir('a', 10)], box, 'type', { foldedCount: 5, foldedBytes: 5 }).find((r) => r.folded)!
    // 0 会被下游当成「1970-01-01」，null 才是「磁盘上没有这一项，无从采集」
    expect(fold.child.birthtimeMs).toBeNull()
  })
})

describe('rootShareLabel（「占全盘」的分母其实是扫描根，用户常常只扫了 C:\\Users\\你）', () => {
  it('扫描根是盘符根 → 才允许说「占全盘」', () => {
    expect(rootShareLabel('C:\\')).toBe('占全盘')
    expect(rootShareLabel('D:\\')).toBe('占全盘')
    expect(rootShareLabel('c:\\')).toBe('占全盘')
    expect(rootShareLabel('E:/')).toBe('占全盘')
  })

  it('扫描根是子目录 / UNC 共享 / 压根没给 → 一律说「占扫描根」，不冒充整盘口径', () => {
    expect(rootShareLabel('C:\\Users\\Kano')).toBe('占扫描根')
    expect(rootShareLabel('C:\\Users')).toBe('占扫描根')
    expect(rootShareLabel('C:\\Windows')).toBe('占扫描根')
    expect(rootShareLabel('\\\\nas\\share')).toBe('占扫描根')
    expect(rootShareLabel('')).toBe('占扫描根')
    expect(rootShareLabel(undefined)).toBe('占扫描根')
  })
})
