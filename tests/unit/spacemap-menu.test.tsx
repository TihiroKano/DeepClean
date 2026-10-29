/**
 * Task 7 的 UI 半边：右键菜单那两项的行为，与详情面板「已固定」那一句的渲染。
 *
 * 为什么这些值得单独钉（截图之前的一层）：
 * 1. 「查看详情」从 no-op 变成"钉住 + 拉统计"，「排除该目录」从占位禁用变成真动作 ——
 *    **禁用条件**就是这一版的安全边界：合计块（磁盘上没有这一项）不许被"查看详情"当成有详情可拉，
 *    也不许被"排除"（藏一个不存在的条目没意义，它的容量已经在 foldedBytes 里点过名），
 *    文件不是地图的一层所以不可排除。写错一条，用户点到的就是一个看起来坏了的菜单。
 * 2. 「排除该目录」那一句 hint 是这版唯一对用户承诺"不会删除任何东西"的地方。
 *    它必须逐字在，且不许带 markdown 的 `**`（用户可见串）。
 * 3. 「已固定」必须看得见、并给得出取消入口 —— 钉住而关不掉，等于界面变哑。
 *
 * 与 `skip-panel.test.tsx` 同一条路子：node 环境 + `renderToStaticMarkup` 渲染真组件，
 * 断言真实 HTML 文本（没装 jsdom，也不引新依赖）。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { toTiles } from '../../core/analyze/treemap-data'
import type { Tile } from '../../core/analyze/treemap-data'
import { EXCLUDE_HINT, excludedLine, menuFor } from '../../src/renderer/pages/SpaceMap'
import { DetailPanel } from '../../src/renderer/components/DetailPanel'
import type { ChildView } from '../../shared/types'

const BOX = { x: 0, y: 0, w: 1000, h: 700 }

const child = (over: Partial<ChildView> & { name: string; size: number }): ChildView => ({
  kind: 'directory',
  path: `C:\\${over.name}`,
  dirId: 7,
  mtimeMs: 1,
  fileCount: 3,
  dirCount: 1,
  attrs: null,
  birthtimeMs: null,
  ...over
})

/** 用真的 `toTiles` 造格子：合计块的形状（folded / 空 path / 无 dirId）只有它能给得准。 */
function tilesFor(c: ChildView, fold: { foldedCount: number; foldedBytes: number } | null): Tile[] {
  const kids: ChildView[] = [c, child({ name: 'sibling.bin', size: 100, kind: 'file', dirId: undefined })]
  return toTiles(kids, BOX, 'type', fold ? { ...fold } : {})
}

const realDir = child({ name: 'AppData', size: 9000, dirId: 42 })
const dirTile = (): Tile => tilesFor(realDir, null)[0]!
const fileTile = (): Tile => tilesFor(realDir, null)[1]!
const foldTile = (): Tile => tilesFor(realDir, { foldedCount: 7, foldedBytes: 700 }).find((t) => t.folded === true)!

const handlers = (calls: string[]) => ({
  onAddToCleanup: (p: string) => calls.push(`cleanup:${p}`),
  onDetail: (t: Tile) => calls.push(`detail:${t.child.name}:${t.child.dirId ?? '-'}`),
  onExclude: (id: number) => calls.push(`exclude:${id}`)
})

const item = (items: ReturnType<typeof menuFor>, label: string) => items.find((i) => i.label === label)

describe('§12 右键菜单：查看详情 / 排除该目录两项落地（Task 7）', () => {
  it('六项俱在，且这两项都活着（旧的「排除扫描」占位禁用项已经不见了）', () => {
    const items = menuFor(dirTile(), handlers([]))
    expect(items.map((i) => i.label)).toEqual([
      '打开',
      '打开所在位置',
      '复制路径',
      '查看详情',
      '加入清理列表',
      '排除该目录'
    ])
    expect(item(items, '排除扫描')).toBeUndefined()
    expect(item(items, '查看详情')?.disabled).toBeFalsy()
    expect(item(items, '排除该目录')?.disabled).toBeFalsy()
  })

  it('单击目录格：查看详情走 onDetail，排除该目录走 onExclude，各带各自的对象', () => {
    const calls: string[] = []
    const items = menuFor(dirTile(), handlers(calls))
    item(items, '查看详情')!.run()
    item(items, '排除该目录')!.run()
    expect(calls).toEqual(['detail:AppData:42', 'exclude:42'])
  })

  it('文件格：可查看详情（文件本就有详情），不可排除且点名原因「只按目录」', () => {
    const calls: string[] = []
    const items = menuFor(fileTile(), handlers(calls))
    const ex = item(items, '排除该目录')!
    expect(ex.disabled).toBe(true)
    expect(ex.note).toBe('只按目录')
    ex.run() // 即使被绕过也拿不到 dirId：不许把 undefined 递给排除
    expect(calls).toEqual([])
    item(items, '查看详情')!.run()
    expect(calls).toEqual(['detail:sibling.bin:-'])
  })

  /**
   * 合计块（`Tile.folded`）是「其它 N 项」的合成格：没有 dirId、path 是空串。
   * 「查看详情」以前对它开着 —— 现在必须关：那一项的承诺是"钉住这份详情并拉目录统计"，
   * 而磁盘上没有被统计可拉的条目；「排除该目录」同理（藏一个不存在的项，容量也已经在
   * foldedBytes 里点过名）。这一条与既有的三项 shell 置灰共用同一个理由文案。
   */
  it('合计块：查看详情与排除该目录都置灰，原因点名到「合计块」', () => {
    const calls: string[] = []
    const items = menuFor(foldTile(), handlers(calls))
    for (const label of ['查看详情', '排除该目录']) {
      const it = item(items, label)!
      expect(it.disabled, label).toBe(true)
      expect(it.note, label).toBe('合计块')
    }
    // 置灰本身由 `ContextMenu` 兜（`if (it.disabled) return`，与既有那三项 shell 同一套门槛）；
    // 这里单独要钉的是 run() 自己也不许把合计块那个**不存在的 dirId** 递给排除。
    item(items, '排除该目录')!.run()
    expect(calls).toEqual([])
    expect(item(items, '查看详情')?.hint).toContain('没有目录统计可看')
  })

  it('排除那一句 hint 逐字在：只影响地图、不停止扫描、不删任何东西、清理预估按完整树计价', () => {
    const items = menuFor(dirTile(), handlers([]))
    expect(item(items, '排除该目录')?.hint).toBe(EXCLUDE_HINT)
    expect(EXCLUDE_HINT).toBe(
      '只影响这张地图：该目录本轮从这一层消失，容量按「已排除」单独点名。' +
        '不会停止扫描、不会删除任何东西，清理预估仍按完整的树计价（有哨兵用例守着）'
    )
  })

  it('用户可见串里没有 markdown 的 **（UI 一律中文、不渲染 markdown）', () => {
    for (const t of [dirTile(), fileTile(), foldTile()]) {
      for (const i of menuFor(t, handlers([]))) {
        for (const s of [i.label, i.note ?? '', i.hint ?? '']) {
          expect(s, `${i.label}: ${s}`).not.toContain('**')
        }
      }
    }
  })
})

describe('侧栏那句「已排除 N 个目录」（Task 7 修订 Fix 1 / Fix 2）', () => {
  /**
   * 造一份 `excludedLine` 要的那四个数。两份口径**故意给不同的值**：
   * 横幅到底读哪一份就是这个 bug 本身，两个值相同的话接错线也测不出来。
   */
  const counts = (over: Partial<Parameters<typeof excludedLine>[0]> = {}): Parameters<typeof excludedLine>[0] => ({
    excludedCount: 1,
    excludedBytes: 5 * 1024,
    sessionExcludedCount: 2,
    sessionExcludedBytes: 700 * 1024 * 1024,
    ...over
  })

  it('有排除时要素齐：个数、被藏掉的容量、以及"清理预估仍按完整的树计价"这句免责', () => {
    const s = excludedLine(counts())!
    expect(s).toContain('已排除 2 个目录')
    expect(s).toContain('700.0 MB') // 被藏掉的容量必须点名，不许只说"藏了 2 个"
    expect(s).toContain('不计入地图')
    expect(s).toContain('清理预估也仍按完整的树计价')
    expect(s).not.toContain('**')
  })

  /**
   * Fix 2 的调用点半边（`excludedLine` 收整个对象而不是两个裸数字，就是为了让这一条测得到）：
   * 本层那份（`excludedCount` = 1 / 5.0 KB）与本轮那份（2 / 700.0 MB）**同时在场**，
   * 那句必须报后者 —— 报前者就是"钻回根之后横幅说这一层没排除任何东西"的那条老 bug。
   */
  it('横幅读的是本轮累计那一份，不是本层那一份：两份同时在场时报本轮', () => {
    const s = excludedLine(counts())!
    expect(s).toContain('已排除 2 个目录')
    expect(s).toContain('700.0 MB')
    expect(s).not.toContain('已排除 1 个目录') // 本层那份一个字都不许漏进这句
    expect(s).not.toContain('5.0 KB')
    expect(s).toContain('本轮累计')
  })

  /**
   * 全局口径「不显示没算过的数字」：门是**本轮累计**那份。
   * 本层那份非 0 而本轮那份为 0 的形状在真机上到不了（本层那份是本轮那一份的子集），
   * 但这一条钉的是"门到底挂在哪一份上"—— 挂错那一份时这句会凭空消失，撤销入口跟着没。
   */
  it('本轮没有任何排除时回 null：那句连同「清除全部排除」整段不出现', () => {
    expect(excludedLine(counts({ sessionExcludedCount: 0, sessionExcludedBytes: 0 }))).toBeNull()
    expect(excludedLine(counts({ sessionExcludedCount: 0, sessionExcludedBytes: 12345 }))).toBeNull() // 个数才是门
    expect(excludedLine(counts({ excludedCount: 0, excludedBytes: 0 }))).not.toBeNull() // 本层是 0、本轮有 → 仍要说
  })

  /**
   * Fix 1：「清除全部排除」没生效时这句必须改口，而且**不许消失**。
   * 撤销一个正在隐藏容量的过滤器，失效形状就是"横幅不见了、地图还少一块" —— 那等于界面宣称
   * 已经全部还给你了。所以这一支的判据是三条：个数仍在、容量仍点名、并明说"没生效/仍然被藏着"。
   */
  it('上一次清除没生效：横幅不消失也不假装清空，改说"没有生效"并给得出重试', () => {
    const s = excludedLine(counts(), true)!
    expect(s).toContain('已排除 2 个目录') // 不能消失，也不能报 0
    expect(s).toContain('700.0 MB')
    expect(s).toContain('没有生效')
    expect(s).toContain('仍然被藏着')
    expect(s).toContain('重试')
    // 成功那半句（"这一栏一切正常"式的措辞）不许留在失败的话里
    expect(s).not.toContain('清理预估也仍按完整的树计价')
    expect(s).not.toContain('**')
    // 第三参默认 false：没点过清除时不许凭空冒出一句"没生效"
    expect(excludedLine(counts())).not.toContain('没有生效')
  })
})

describe('详情面板的「已固定」（Task 7 查看详情）', () => {
  const panel = (pinned: boolean): string =>
    renderToStaticMarkup(
      <DetailPanel child={realDir} parentSize={20000} rootSize={90000} rootPath="C:\\" pinned={pinned} onUnpin={() => undefined} />
    )

  it('pinned 时标题右侧给「已固定」标记与取消入口；名称仍单独在 .dc-panel-title 里', () => {
    const html = panel(true)
    expect(html).toContain('已固定')
    expect(html).toContain('取消固定')
    // 截图步骤靠 `.dc-panel-title` 的 textContent 读"现在看的是哪一格"，标记混进那个节点就成了假判据
    expect(html).toMatch(/<h3 class="dc-panel-title">AppData<\/h3>/)
  })

  it('没 pinned 时那两个字一个字都不出现（悬浮式选中不声称自己被钉住）', () => {
    const html = panel(false)
    expect(html).not.toContain('已固定')
    expect(html).not.toContain('取消固定')
    expect(html).toContain('AppData')
  })
})
