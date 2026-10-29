import { describe, expect, it } from 'vitest'
import { buildDetail, typeLabelOf } from '../../core/analyze/detail'
import { WIN_ATTR } from '../../shared/classify'
import type { ChildView } from '../../shared/types'

const dir = (over: Partial<ChildView> = {}): ChildView => ({
  kind: 'directory',
  name: 'Temp',
  path: 'C:\\Users\\Kano\\AppData\\Local\\Temp',
  dirId: 7,
  size: 8_589_934_592,
  mtimeMs: new Date(2026, 8, 25, 22, 51).getTime(),
  fileCount: 12345,
  dirCount: 210,
  // 目录本轮不 stat → 属性必须是 null（"没采"），不能写成 0（"采了，啥属性都没有"）
  attrs: null,
  // 同一个理由：目录连 stat 都没走，创建时间也是「没采」，不是 1970
  birthtimeMs: null,
  ...over
})
const file = (over: Partial<ChildView> = {}): ChildView => ({
  kind: 'file',
  name: 'game.pak',
  path: 'D:\\Steam\\game.pak',
  size: 40 * 1024 ** 3,
  mtimeMs: 0,
  fileCount: 0,
  dirCount: 0,
  attrs: 0,
  birthtimeMs: new Date(2020, 4, 6, 7, 8).getTime(),
  ...over
})

/**
 * `core/analyze/treemap-data.ts` 的 `synthChild()` 产物：Task 2 造的「其它 N 项」合计格。
 * 磁盘上没有对应条目 —— path 是空串、mtimeMs/fileCount/dirCount 全是构造时的 0（不是测出来的 0）。
 */
const foldChild = (over: Partial<ChildView> = {}): ChildView => ({
  kind: 'directory',
  name: '其它 3 项',
  path: '',
  size: 3_221_225_472,
  mtimeMs: 0,
  fileCount: 0,
  dirCount: 0,
  attrs: null,
  birthtimeMs: null,
  ...over
})

describe('buildDetail 对折叠块只能说实话（Task 2 详情面板回归：0 是假的）', () => {
  it('折叠块情形下模型不得声称文件数 / 子目录数 / 类型 / 路径 / 修改时间 / 创建时间 / 属性行', () => {
    const d = buildDetail(foldChild(), 8_589_934_592, { folded: true, rootSize: 17_179_869_184 })
    // null = DetailPanel 整行不渲染（它按这些字段 1:1 出行，没有别的信息源）。
    // 红成 '0' 就是把「从未采集过的东西」当 0 报；红成 '' 就是一条空 path 行。
    expect(d.fileCountText).toBeNull()
    expect(d.dirCountText).toBeNull()
    expect(d.path).toBeNull()
    expect(d.kind).toBeNull()
    expect(d.modified).toBeNull()
    // 磁盘上没有这个条目，也就没有它的创建时间与类型可言：
    // 给 '未采集' 已经是「它有 birthtime，只是没采到」的误陈述，给 '文件夹' 等于凭空造了一格目录。
    expect(d.created).toBeNull()
    expect(d.typeLabel).toBeNull()
    expect(d.attrs).toEqual([])
  })

  it('折叠块保留它确实知道的：名称、合计容量、以及两个分母来自 payload 的百分比', () => {
    const d = buildDetail(foldChild(), 8_589_934_592, { folded: true, rootSize: 17_179_869_184 })
    expect(d.name).toBe('其它 3 项')
    expect(d.sizeText).toBe('3.0 GB')
    expect(d.percentOfParent).toBe('37.5%')
    expect(d.percentOfRoot).toBe('18.75%')
    // 与 Treemap tooltip 同一句话案（两处都引用同一个常量），中文、无 markdown 记号
    expect(d.foldedNote).toBe('合计块 · 未逐一绘制，不可进入')
    expect(d.folded).toBe(true)
    expect(d.foldedNote).not.toContain('**')
  })

  it('没给根分母时那一行是「—」而不是 0.0%（分母为 0 = 不知道）', () => {
    expect(buildDetail(foldChild(), 0, { folded: true }).percentOfRoot).toBe('—')
    expect(buildDetail(foldChild(), 0, { folded: true }).percentOfParent).toBe('—')
  })

  it('守卫只咬折叠块：真目录那一屏一个字都不许少', () => {
    const d = buildDetail(dir(), 17_179_869_184)
    expect(d.folded).toBe(false)
    expect(d.foldedNote).toBeNull()
    expect(d.fileCountText).toBe('12,345')
    expect(d.dirCountText).toBe('210')
    expect(d.path).toBe('C:\\Users\\Kano\\AppData\\Local\\Temp')
    expect(d.kind).toBe('directory')
    expect(d.modified).toBe('2026-09-25 22:51')
    expect(d.attrs).toHaveLength(4)
    // rootSize 没给 → 「占全盘」如实给「—」，不臆造
    expect(d.percentOfRoot).toBe('—')
  })
})

describe('buildDetail（§12 单击详情的六个字段一个不能少）', () => {
  it('名称 / 完整路径 / 大小 / 占当前目录比例 / 文件数量 / 修改时间', () => {
    const d = buildDetail(dir(), 17_179_869_184)
    expect(d.name).toBe('Temp')
    expect(d.path).toBe('C:\\Users\\Kano\\AppData\\Local\\Temp')
    expect(d.sizeText).toBe('8.0 GB')
    expect(d.percentOfParent).toBe('50.0%')
    expect(d.fileCountText).toBe('12,345')
    expect(d.dirCountText).toBe('210')
    expect(d.modified).toBe('2026-09-25 22:51')
    expect(d.group).toBe('temp')
    expect(d.groupLabel).toBe('临时文件')
  })

  it('父目录为 0 时不出现 NaN / Infinity', () => {
    expect(buildDetail(file(), 0).percentOfParent).toBe('—')
  })

  it('文件不显示目录数与文件数（那是目录的属性）', () => {
    const d = buildDetail(file(), 100 * 1024 ** 3)
    expect(d.fileCountText).toBe('—')
    expect(d.dirCountText).toBe('—')
    expect(d.percentOfParent).toBe('40.0%')
    expect(d.modified).toBe('—')
  })

  it('MVP 阶段 deletable 恒为 false（§28 原则一：扫描 ≠ 删除）', () => {
    expect(buildDetail(dir(), 1).deletable).toBe(false)
    expect(buildDetail(file(), 1).deletable).toBe(false)
  })

  it('§16 风险等级：系统关键区为 forbidden', () => {
    expect(buildDetail(dir({ path: 'C:\\Windows\\System32', name: 'System32' }), 1).risk).toBe('forbidden')
    expect(buildDetail(dir({ path: 'C:\\Windows\\WinSxS\\x', name: 'x' }), 1).risk).toBe('forbidden')
  })

  it('正在扫描的目录要标出来（§7 数字是中间值）', () => {
    expect(buildDetail(dir({ scanning: true }), 1).scanning).toBe(true)
    expect(buildDetail(dir(), 1).scanning).toBe(false)
  })

  it('§4.1 属性四行：隐藏/系统/只读/存档，只读判得出，其余三行如实标 unknown', () => {
    const rows = buildDetail(file({ attrs: WIN_ATTR.readonly }), 1).attrs
    expect(rows.map((r) => r.label)).toEqual(['隐藏', '系统', '只读', '存档'])
    expect(rows.map((r) => r.state)).toEqual(['unknown', 'unknown', 'set', 'unknown'])
    expect(rows.map((r) => r.text)).toEqual(['未知（stat 读不到）', '未知（stat 读不到）', '是', '未知（stat 读不到）'])
    expect(buildDetail(file({ attrs: 0 }), 1).attrs.find((r) => r.key === 'readonly')?.text).toBe('否')
  })

  it('目录那一行要写「未采集」而不是「否」——本轮目录根本不 stat', () => {
    const d = buildDetail(dir(), 1)
    expect(d.attrsCollected).toBe(false)
    expect(d.attrs.every((r) => r.text === '未采集')).toBe(true)
  })

  it('带 SYSTEM 属性位的文件即使路径人畜无害也判 protected + forbidden（§28 原则二的真判据）', () => {
    // 合成 attrs（bit system）：当前运行时永远不会置这一位，见 attrs.test.ts 的实测说明；
    // 这条测的是「规则本身对不对」，等 §16 接上真属性源就直接生效。
    const d = buildDetail(file({ name: 'photo.jpg', path: 'D:\\MyStuff\\photo.jpg', attrs: WIN_ATTR.system }), 1)
    expect(d.group).toBe('system')
    expect(d.risk).toBe('forbidden')
    expect(d.protectedByAttrs).toBe(true)
  })

  it('没带系统属性位的普通文件不被凭空保护（属性判据只能收紧，不能放松路径判据）', () => {
    expect(buildDetail(file(), 1).protectedByAttrs).toBe(false)
    expect(buildDetail(file(), 1).group).toBe('other')
    expect(buildDetail(dir({ path: 'C:\\Windows\\System32', name: 'System32' }), 1).group).toBe('system')
  })
})

describe('创建时间与类型标签（§8 文件详情）', () => {
  it('文件：创建时间就是那一次 stat 的 birthtime，类型按扩展名给中文标签', () => {
    const d = buildDetail(file(), 100 * 1024 ** 3)
    expect(d.created).toBe('2020-05-06 07:08')
    expect(d.createdCollected).toBe(true)
    expect(d.typeLabel).toBe('PAK 资源包')
    // 两个时间各走各的：mtimeMs=0 → 修改时间是「—」，创建时间不许跟着变成「—」或 1970
    expect(d.modified).toBe('—')
  })

  it('目录：birthtime 从未采集 → 写「未采集」，不是 0、不是「—」碰巧、更不是 1970-01-01', () => {
    const d = buildDetail(dir(), 1)
    expect(d.created).toBe('未采集')
    expect(d.createdCollected).toBe(false)
    expect(d.typeLabel).toBe('文件夹')
    expect(d.created).not.toMatch(/1970|NaN|undefined/)
  })

  it('birthtime 为 0（网络盘 / 非 NTFS 卷读不出创建时间）同样算未采集', () => {
    expect(buildDetail(file({ birthtimeMs: 0 }), 1).created).toBe('未采集')
    expect(buildDetail(file({ birthtimeMs: 0 }), 1).createdCollected).toBe(false)
    expect(buildDetail(file({ birthtimeMs: -1 }), 1).created).toBe('未采集')
  })

  it('typeLabelOf：认得的给中文，认不出的如实给「.xyz 文件」，点开头的名字给「无扩展名文件」', () => {
    expect(typeLabelOf('setup.exe')).toBe('可执行程序')
    expect(typeLabelOf('ntdll.dll')).toBe('系统库 (DLL)')
    expect(typeLabelOf('game.PAK')).toBe('PAK 资源包') // 大小写不敏感
    expect(typeLabelOf('data.7z')).toBe('压缩包')
    expect(typeLabelOf('photo.jpg')).toBe('图片')
    expect(typeLabelOf('notes.log')).toBe('日志')
    expect(typeLabelOf('weird.qodercn')).toBe('QODERCN 文件')
    expect(typeLabelOf('LICENSE')).toBe('无扩展名文件')
    expect(typeLabelOf('.gitignore')).toBe('无扩展名文件')
    // 用户可见字符串里不许出现 markdown 记号
    expect(typeLabelOf('game.pak')).not.toContain('**')
  })

  it('「占全盘」只在扫描根真是盘符根时才成立；根是子目录 / 不知道时必须改口', () => {
    const base = { rootSize: 100 }
    expect(buildDetail(dir({ size: 50 }), 100, { ...base, rootPath: 'C:\\' }).rootShareLabel).toBe('占全盘')
    expect(buildDetail(dir({ size: 50 }), 100, { ...base, rootPath: 'D:\\' }).rootShareLabel).toBe('占全盘')
    // 用户选的常常是 C:\Users\你 —— 分母是那棵子树，说「占全盘」就是虚报范围
    expect(buildDetail(dir({ size: 50 }), 100, { ...base, rootPath: 'C:\\Users\\Kano' }).rootShareLabel).toBe('占扫描根')
    expect(buildDetail(dir({ size: 50 }), 100, { ...base, rootPath: '\\\\nas\\share' }).rootShareLabel).toBe('占扫描根')
    expect(buildDetail(dir({ size: 50 }), 100, base).rootShareLabel).toBe('占扫描根')
  })
})

describe('§9「最大文件」的存储截断免责（地图页详情面板，审查发现：HUD 不在这一页）', () => {
  it('只有 truncated=true 才出这句话；没给 / false 一律 null（不许凭空吓用户）', () => {
    expect(buildDetail(dir(), 1).truncatedNote).toBeNull()
    expect(buildDetail(dir(), 1, { truncated: false }).truncatedNote).toBeNull()
    expect(buildDetail(file(), 1, { truncated: false }).truncatedNote).toBeNull()
    const note = buildDetail(dir(), 1, { truncated: true }).truncatedNote
    expect(note).not.toBeNull()
    expect(note).toContain('最大文件') // 点名的就是受影响的那一行
    expect(note).toContain('存储上限')
    expect(note).toContain('不受影响') // 顺带说清「最大子目录」不受影响，否则用户会连那条一起不信
    expect(note).not.toContain('**') // 用户可见文案里不许出现 markdown 记号
  })

  it('三句 caveat 各管一件事：截断这句不许借用「预算 / 节点 / 仅统计前」那套词（那是 partial 的口径）', () => {
    // 视图折叠 ≠ 截断 ≠ 预算 ≠ 没扫完（Task 1 就记过这条）。
    // 串门的后果不是难看而是误判：用户以为再等一会儿（预算/扫描）数字就全了，其实等多久都补不回来。
    const note = buildDetail(dir(), 1, { truncated: true }).truncatedNote!
    expect(note).not.toMatch(/预算|节点|仅统计前|中间值/)
    // 折叠块同理：这句只跟着扫描的全局状态走，不跟着被选中的那一格变
    expect(buildDetail(foldChild(), 1, { folded: true, truncated: true }).truncatedNote).toBe(note)
  })
})
