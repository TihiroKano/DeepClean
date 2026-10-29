import { FOLD_KEY, keyOf } from './treemap-data'
import type { ChildView } from '../../shared/types'

export interface TopRow {
  key: string
  name: string
  path: string
  size: number
  kind: 'file' | 'directory' | 'folded'
  dirId?: number
}

/**
 * 榜单行找回地图块的连接键 —— 就是 `treemap-data.ts` 的 `keyOf` **本身**（不是"另抄一份同式子"）。
 * 名字 `keyOfChild` 保留：brief 的 Interfaces 里它是本 Task 对外产出的契约，这里只换掉实现来源。
 */
export const keyOfChild = keyOf

/**
 * 本层的空间榜（§10）。**预算：最多 `n` 个真项，外加至多一行合计块 —— 返回长度上限是 `n + 1`。**
 * 合计行承载的是「被省略的那批容量」的点名，把它挤掉等于丢掉这条披露，
 * 所以它不受 `n` 的配额约束（Task 6 评审 Fix 3 的裁定：预算写死在这里，别再拿 `rows.length < n + 1`
 * 那种 slice 之后恒真的条件冒充"列表还有位置"）。
 */
export function topRows(
  children: ChildView[],
  n: number,
  opts: { foldedCount?: number; foldedBytes?: number } = {}
): TopRow[] {
  // 标注 TopRow[]：不标的话推断出 kind 只剩 'file'|'directory'，下面 push 折叠行会被 TS 拒（行为不变）。
  const rows: TopRow[] = children
    .filter((c) => c.size > 0)
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((c) => ({
      key: keyOfChild(c),
      name: c.name,
      path: c.path,
      size: c.size,
      kind: c.kind === 'file' ? ('file' as const) : ('directory' as const),
      dirId: c.dirId
    }))
  const fc = opts.foldedCount ?? 0
  const fb = opts.foldedBytes ?? 0
  if (fc > 0 && fb > 0) {
    rows.push({ key: FOLD_KEY, name: `其它 ${fc} 项`, path: '', size: fb, kind: 'folded' })
  }
  return rows
}
