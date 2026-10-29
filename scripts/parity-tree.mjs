/**
 * 对账脚本共用的**夹具树 → `RuleTreeSource`** 构造。抽出来只有一条理由：
 * `parity-rules.mjs` 与 `parity-preview.mjs` 必须看**同一棵**树，
 * 两份各写一遍迟早漂 —— 而那份漂移会伪装成"引擎结论不同"。
 *
 * 与 TS 产品侧 `tree-store.ts` 的同口径处：id 深度优先分配、`childrenOf` 按
 * `LEVEL_ORDER`（容量降序、并列按名字）排。
 */
import { joinWin, normalizeKey } from '../core/fs/pathutil.ts'

export function buildSource(rootNode) {
  const byPath = new Map()
  const byId = new Map()
  const order = []
  let next = 0

  /** 先定 id（深度优先），再回填。 */
  function assign(node) {
    const id = next++
    byId.set(id, node)
    byPath.set(normalizeKey(node.path), id)
    order.push(id)
    for (const c of node.children ?? []) assign(c)
  }
  assign(rootNode)

  const subtreeBytes = new Map()
  function size(node) {
    let total = 0
    for (const f of node.files ?? []) total += f.size
    for (const c of node.children ?? []) total += size(c)
    return total
  }
  for (const id of order) subtreeBytes.set(id, size(byId.get(id)))

  return {
    rootId: 0,
    dirIdByPath: (p) => byPath.get(normalizeKey(p)),
    childrenOf(dirId) {
      const node = byId.get(dirId)
      if (node === undefined) return []
      const kids = []
      for (const c of node.children ?? []) {
        kids.push({
          kind: 'directory',
          name: c.name,
          path: c.path,
          dirId: byPath.get(normalizeKey(c.path)),
          size: subtreeBytes.get(byPath.get(normalizeKey(c.path))),
          mtimeMs: c.mtimeMs ?? 0,
          fileCount: 0,
          dirCount: 0,
          // 与 TS `tree-store.ts:110` 的 dirView 逐字同口径：目录本轮不 stat → null
          attrs: null,
          birthtimeMs: null
        })
      }
      for (const f of node.files ?? []) {
        kids.push({
          kind: 'file',
          name: f.name,
          path: joinWin(node.path, f.name),
          dirId: undefined,
          size: f.size,
          mtimeMs: f.mtimeMs ?? 0,
          fileCount: 0,
          dirCount: 0,
          attrs: f.attrs ?? 0,
          birthtimeMs: null
        })
      }
      kids.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name))
      return kids
    },
    sizeOf: (dirId) => subtreeBytes.get(dirId)
  }
}
