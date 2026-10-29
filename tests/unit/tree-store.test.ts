import { describe, expect, it } from 'vitest'
import { TreeStore, type FileEntry } from '../../core/scan/tree-store'

const mk = (maxFiles = 1_000_000): TreeStore => new TreeStore({ rootPath: 'C:\\', maxFiles })

describe('TreeStore 聚合', () => {
  it('父目录大小 = 直属文件 + 所有子孙（§2.1 获取目录总大小）', () => {
    const s = mk()
    const a = s.beginDir('C:\\a')
    const b = s.beginDir('C:\\a\\b')
    s.attachChild(a, b)
    s.addFilesToDir(b, [{ name: 'x.bin', size: 100, mtimeMs: 1, birthtimeMs: 5, attrs: 0 }, { name: 'y.bin', size: 50, mtimeMs: 2, birthtimeMs: 5, attrs: 0 }])
    s.addFilesToDir(a, [{ name: 'z.bin', size: 25, mtimeMs: 3, birthtimeMs: 5, attrs: 0 }])
    s.finalizeDir(b)
    const r = s.finalizeDir(a)
    expect(r.size).toBe(175)
    expect(r.fileCount).toBe(3)
    expect(r.dirCount).toBe(1)
  })
  it('大小写不同的同一路径合并成同一节点，不双计', () => {
    const s = mk()
    const id1 = s.beginDir('C:\\Windows')
    const id2 = s.beginDir('c:\\windows')
    expect(id1).toBe(id2)
    s.addFilesToDir(id1, [{ name: 'a', size: 10, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }])
    s.noteSeenFile(10)
    s.finalizeDir(id1)
    expect(s.stats().totalBytes).toBe(10)
    expect(s.sizeOf(id1)).toBe(10)
  })
  it('childrenOf 按 size 降序，目录带 dirId、文件不带', () => {
    const s = mk()
    const d = s.beginDir('C:\\d')
    s.beginDir('C:\\d\\sub')
    s.attachChild(d, s.dirIdByPath('C:\\d\\sub')!)
    s.addFilesToDir(s.dirIdByPath('C:\\d\\sub')!, [{ name: 'big', size: 900, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }])
    s.addFilesToDir(d, [{ name: 'small', size: 1, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }])
    s.finalizeDir(d)
    const kids = s.childrenOf(d)
    expect(kids.map((k) => k.name)).toEqual(['sub', 'small'])
    expect(kids[0]!.dirId).toBeTypeOf('number')
    expect(kids[1]!.dirId).toBeUndefined()
  })
  it('超过 maxFiles：文件列表被丢弃但容量继续累加（§28 不崩 + 统计仍对）', () => {
    const s = mk(2)
    const d = s.beginDir('C:\\d')
    // 计数字段现在由 noteSeenFile 负责（Scanner 每见一个文件调一次），
    // addFilesToDir 只管把文件挂到目录上 + 截断存储列表。
    const seen = (files: FileEntry[]): void => {
      for (const f of files) s.noteSeenFile(f.size)
    }
    const first = [
      { name: 'a', size: 10, mtimeMs: 0, birthtimeMs: 5, attrs: 0 },
      { name: 'b', size: 20, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }
    ]
    const rest = [{ name: 'c', size: 40, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }]
    seen(first)
    s.addFilesToDir(d, first)
    seen(rest)
    s.addFilesToDir(d, rest)
    s.finalizeDir(d)
    expect(s.truncated).toBe(true)
    expect(s.stats().totalBytes).toBe(70)
    expect(s.stats().files).toBe(3)
    expect(s.childrenOf(d)).toHaveLength(2)
  })

  it('计数器逐文件前进，不等子树合并（§7 实时；真实 C 盘上曾冻住 4.7 分钟）', () => {
    const s = mk()
    const d = s.beginDir('C:\\slow')
    // 模拟一个要扫很久的子树：文件一个个被发现，但 addFilesToDir 要等扫完才调用
    s.noteSeenFile(100)
    expect(s.stats().files).toBe(1)
    expect(s.stats().totalBytes).toBe(100)
    s.noteSeenFile(250)
    expect(s.stats().files).toBe(2)
    expect(s.stats().totalBytes).toBe(350)
    // 此时还没合并：HUD 已经能读到 2 个文件 / 350B
    s.addFilesToDir(d, [
      { name: 'x', size: 100, mtimeMs: 0, birthtimeMs: 5, attrs: 0 },
      { name: 'y', size: 250, mtimeMs: 0, birthtimeMs: 5, attrs: 0 }
    ])
    // 合并不得把计数再加一遍
    expect(s.stats().files).toBe(2)
    expect(s.stats().totalBytes).toBe(350)
  })
  it('setLive 让未完成目录显示中间大小（§7 增量出图）', () => {
    const s = mk()
    const d = s.beginDir('C:\\live')
    s.setLive(d, 123, 4, true)
    const kids = s.childrenOf(s.rootId)
    expect(kids.find((k) => k.name === 'live')).toMatchObject({ size: 123, fileCount: 4, scanning: true })
  })
  it('pathOf 能还原完整路径（§12 详情需要完整路径）', () => {
    const s = mk()
    const d = s.beginDir('C:\\Users\\Kano\\AppData')
    s.finalizeDir(d)
    expect(s.pathOf(d)).toBe('C:\\Users\\Kano\\AppData')
  })
})

describe('TreeStore 目录修改时间', () => {
  it('目录 mtime = 子树内最新文件的 mtime（不给每个目录多花一次 stat）', () => {
    const s = mk()
    const a = s.beginDir('C:\\a')
    const b = s.beginDir('C:\\a\\b')
    s.attachChild(a, b)
    s.addFilesToDir(b, [{ name: 'old', size: 1, mtimeMs: 100, birthtimeMs: 5, attrs: 0 }])
    s.addFilesToDir(a, [{ name: 'new', size: 1, mtimeMs: 900, birthtimeMs: 5, attrs: 0 }])
    s.finalizeDir(a)
    expect(s.getDir(b)?.mtimeMs).toBe(100)
    expect(s.getDir(a)?.mtimeMs).toBe(900)
  })

  it('空目录 mtime 为 0（UI 显示 —，不编造时间）', () => {
    const s = mk()
    const e = s.beginDir('C:\\empty')
    s.finalizeDir(e)
    expect(s.getDir(e)?.mtimeMs).toBe(0)
  })
})

describe('TreeStore 属性（§4.1）', () => {
  const withAttrs = (attrs: number): FileEntry => ({ name: 'f.bin', size: 100, mtimeMs: 7, birthtimeMs: attrs + 1, attrs })

  it('childrenOf 把文件的 attrs 原样带出去；目录给 null（本轮不采集）', () => {
    const s = mk()
    const a = s.beginDir('C:\\a')
    s.attachChild(s.rootId, a)
    s.addFilesToDir(a, [withAttrs(1 | 2 | 4 | 32)])
    s.finalizeDir(a)
    const rootKids = s.childrenOf(s.rootId)
    expect(rootKids.find((c) => c.name === 'a')?.attrs, '目录属性未采集 = null，不是 0').toBeNull()
    const kids = s.childrenOf(a)
    expect(kids.find((c) => c.name === 'f.bin')?.attrs).toBe(1 | 2 | 4 | 32)
  })

  it('attrs / birthtime 都不参与聚合：同一棵树换一套属性位（birthtime 跟着变），size / fileCount / dirCount / mtime / 计数器逐位不变（§35.2 不许动）', () => {
    const build = (attrs: number): { size: number; fc: number; dc: number; mt: number; stats: string } => {
      const s = mk()
      const a = s.beginDir('C:\\a')
      const b = s.beginDir('C:\\a\\b')
      s.attachChild(s.rootId, a)
      s.attachChild(a, b)
      s.addFilesToDir(b, [{ name: 'x', size: 100, mtimeMs: 1, birthtimeMs: attrs + 1, attrs }, { name: 'y', size: 50, mtimeMs: 2, birthtimeMs: attrs + 1, attrs }])
      s.addFilesToDir(a, [{ name: 'z', size: 25, mtimeMs: 3, birthtimeMs: attrs + 1, attrs }])
      s.noteSeenFile(175)
      const r = s.finalizeDir(a)
      return { size: r.size, fc: r.fileCount, dc: r.dirCount, mt: s.getDir(a)?.mtimeMs ?? -1, stats: JSON.stringify(s.stats()) }
    }
    expect(build(0)).toEqual(build(1 | 2 | 4 | 32))
    expect(build(0).size).toBe(175)
  })
})

describe('TreeStore 创建时间（§8 文件详情）', () => {
  it('birthtime 原样带到 ChildView；目录没有 birthtime 时是 null 而不是 0（未采集 ≠ 1970）', () => {
    const store = new TreeStore({ rootPath: 'C:\\', maxFiles: 100, topN: 10 })
    const id = store.beginDir('C:\\a')
    // 同一层放一个目录子项（beginDir 自动挂到 'C:\a' 下）：目录这一支才是 null，
    // 少掉这一行的话 `find(...'directory')` 返回 undefined，`?.` 会把「根本没这一项」当成「null」。
    store.beginDir('C:\\a\\sub')
    store.addFilesToDir(id, [{ name: 'b.bin', size: 3, mtimeMs: 10, birthtimeMs: 5, attrs: 0 }])
    const kids = store.childrenOf(id)
    expect(kids.find((c) => c.kind === 'file')?.birthtimeMs).toBe(5)
    expect(kids.find((c) => c.kind === 'file')?.mtimeMs, 'birthtime 不许串到 mtime 上').toBe(10)
    expect(kids.find((c) => c.kind === 'directory')?.birthtimeMs).toBeNull()
  })
})
