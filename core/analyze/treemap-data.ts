import { classifyEntry, GROUP_COLORS, type NodeGroup } from '../../shared/classify'
import { formatBytes } from '../../shared/format'
import { isDriveRootPath } from '../fs/pathutil'
import type { ChildView } from '../../shared/types'
import { squarify, type Box, type Rect } from './squarify'

export type ColorMode = 'type' | 'size' | 'dir'

/**
 * 单层最多画这么多块：真实盘上 `C:\Windows\WinSxS` 之类会有上万兄弟目录，全画会把渲染打满。
 *
 * 收窄现在由主进程 `LEVEL_CAP`（`shared/constants.ts`，值与本常量同源）做，`toTiles` **不再自己截断** ——
 * 它只把主进程报来的 `foldedBytes` 画成独立一格。这里保留常量，是给 `LEVEL_CAP` 当出处并留一句提醒。
 */
export const MAX_TILES = 1200

export interface Tile extends Rect {
  color: string
  label: string
  sub: string
  group: NodeGroup
  child: ChildView
  /** true = 这一格是「其它 N 项」的合计块，不对应任何真实存在的项。 */
  folded?: boolean
  /** 0–100。分母为 0（调用方没给 parentSize）时给 0，UI 自己判 0 时显示「—」。 */
  pctOfParent: number
  pctOfRoot: number
}

/** 主进程这一层的记账（ChildrenPayload，Task 1）搬进布局的入参。 */
export interface FoldOpts {
  /** 主进程没回传的子项个数（视图收窄的差额）。 */
  foldedCount?: number
  /** 那些子项的合计容量。 */
  foldedBytes?: number
  /** 本层总容量（百分比的分母之一）。 */
  parentSize?: number
  /** 本次扫描根节点容量 —— 「占 C 盘 %」的分母。 */
  rootSize?: number
}

/** 折叠块固定中性灰：它没有类型可涂，也不该混进「按大小」的色阶里冒充真项。 */
const FOLD_COLOR = '#3a3f46'
/**
 * 合计块那一条格子的 key。和 `keyOf` 同理只此一份 —— `top-rows.ts` 的折叠行用的就是它：
 * 两边各写一个字面量，榜单里那一行就不再指向布局里的这块合计，join 会静默错位。
 */
export const FOLD_KEY = '__fold__'

/**
 * 折叠块的实话，tooltip 与详情面板共用同一句（`core/analyze/detail.ts` 也引它）。
 * 两处必须逐字一致：同一格悬停诚实、单击却说谎，是本 Task 评审点过名的问题。
 */
export const FOLD_NOTE = '合计块 · 未逐一绘制，不可进入'

/**
 * 「占X」那一行的**名字**取决于本次扫描的根到底是什么。
 *
 * 分母 `rootSize` 是 `sizeOf(rootId)` —— 用户选中的那一棵，常常是 `C:\Users\你` 而不是整盘，
 * 这时候说「占全盘」等于把子树的容量当成盘的容量来吹，比例看着小得很、其实分母小了一个量级。
 * 只有盘符根（`C:\`）才真有一整盘可占；UNC 共享也不是"全盘"。
 * tooltip 与详情面板共用这一个判定（同 `FOLD_NOTE` 的理由：同一格悬停与单击必须说同一句话）。
 */
export function rootShareLabel(rootPath?: string): string {
  return rootPath !== undefined && isDriveRootPath(rootPath) ? '占全盘' : '占扫描根'
}

const LABEL_MIN_W = 62
const LABEL_MIN_H = 22

/**
 * 一块地图与一行榜单的**唯一**连接键（Task 6 的「点行定位到块」就靠它）。
 *
 * 导出给 `core/analyze/top-rows.ts` 的 `keyOfChild` 用 —— 同一个式子写两遍，改一处就会静默断链
 * （榜单点 A、地图高亮 B 或干脆 warn 找不到），所以这里只有一份，那边只是别名。
 * 稳定性也重要：目录用 `dirId`（改名不变），文件退回 `path`。
 */
export const keyOf = (c: ChildView): string => `${c.kind}:${c.dirId ?? c.path}`

/**
 * 造一个不落盘的 ChildView。两处用到：
 *  - 折叠块（它本来就不是磁盘上的某一项，所以没有 dirId、path 是空串）；
 *  - key 找不回原件时的兜底（宁可名字粗一点，也不能把那块面积悄悄吞掉）。
 */
function synthChild(name: string, path: string, size: number): ChildView {
  return { kind: 'directory', name, path, size, mtimeMs: 0, fileCount: 0, dirCount: 0, attrs: null, birthtimeMs: null }
}

/**
 * `children` 必须是主进程 `levelOf` 收窄**之后**的那 ≤cap 项，折叠掉的容量另走 `opts`。
 * 契约：`Σchildren + foldedBytes == ΣchildrenOf`（两端不重叠），所以这里既不再自己截断
 * （截断 = 把已经算进 foldedBytes 的那批容量吞第二遍），也不把折叠量并进任何真块头上。
 */
export function toTiles(children: ChildView[], box: Box, mode: ColorMode, opts: FoldOpts = {}): Tile[] {
  const sorted = [...children].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
  // 只丢 0 容量项：squarify 给 0 会算出零面积矩形，白占一格还点不中
  const keep = sorted.filter((c) => c.size > 0)
  const foldCount = opts.foldedCount ?? 0
  const foldBytes = opts.foldedBytes ?? 0
  const hasFold = foldCount > 0 && foldBytes > 0
  if (keep.length === 0 && !hasFold) return []

  const items = keep.map((c) => ({ key: keyOf(c), name: c.name, value: c.size }))
  if (hasFold) items.push({ key: FOLD_KEY, name: `其它 ${foldCount} 项`, value: foldBytes })

  const rects = squarify(items, box)
  // 分母只认调用方给的那两个数，不给就是不知道 → 0 → UI 显示「—」。
  // 刻意不回退成「Σ本层画出的块」：那是另一个口径，同一个百分比会因有没有 parentSize 而变数。
  const parentTotal = opts.parentSize ?? 0
  const rootTotal = opts.rootSize ?? 0
  const byKey = new Map(keep.map((c) => [keyOf(c), c]))
  // reduce 而不是 Math.max(...arr)：实参展开受调用栈限制，数组上限是「一层有几项」而不是 MAX_TILES。
  // 种子 1 同时保证它是正数 —— 「按大小」上色拿的是「相对本层最大项」的比例。
  const maxSize = rects.reduce((m, r) => (r.value > m ? r.value : m), 1)

  return rects.map((r, i) => {
    const isFold = r.key === FOLD_KEY
    // 折叠项：合成条目，没有 dirId（双击进不去）、没有 path（右键「打开」要置灰、shell 白名单进不去）
    const child: ChildView = isFold
      ? synthChild(`其它 ${foldCount} 项`, '', r.value)
      : // squarify 只会回传我们塞进去的 key，这条兜底按构造走不到；走到了也要保住这块面积
        byKey.get(r.key) ?? synthChild(r.name, r.name, r.value)
    const group: NodeGroup = isFold ? 'other' : classifyEntry(child.path, child.attrs)
    const showText = r.w >= LABEL_MIN_W && r.h >= LABEL_MIN_H
    return {
      ...r,
      group,
      // 折叠块不参与上色：固定中性灰，免得它混进「按大小」的色阶里冒充一个真项
      color: isFold ? FOLD_COLOR : colorOf(mode, group, r.value / maxSize, i),
      label: showText ? r.name : '',
      sub: showText && r.h >= LABEL_MIN_H * 2 ? formatBytes(r.value) : '',
      child,
      folded: isFold || undefined,
      pctOfParent: parentTotal > 0 ? (r.value / parentTotal) * 100 : 0,
      pctOfRoot: rootTotal > 0 ? (r.value / rootTotal) * 100 : 0
    }
  })
}

function colorOf(mode: ColorMode, group: NodeGroup, frac: number, index: number): string {
  if (mode === 'type') return GROUP_COLORS[group]
  if (mode === 'size') {
    // 磁盘占用是长尾分布，线性映射会让 99% 的块挤成同一个深色 → 开根号拉开低段
    const t = Math.pow(Math.max(0, Math.min(1, frac)), 0.35)
    return `hsl(${(210 - 190 * t).toFixed(0)} 70% ${(28 + 34 * t).toFixed(0)}%)`
  }
  // 按目录：同层用色相轮转 + 明度阶梯，相邻块可分辨但不暗示类型
  return `hsl(${(index * 47) % 360} 42% ${34 + (index % 4) * 7}%)`
}
