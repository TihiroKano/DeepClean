/**
 * Windows 路径纯工具（core/ 层，禁止 import electron / node 之外的宿主 API）。
 * 所有产出的路径都是「纯拼接」（见 joinWin），不含 `..`，
 * 因为一旦加 \\?\ 前缀，`.` / `..` 不再被规范化。
 */

/** 260 是 Windows MAX_PATH；这里用 250 留 10 字符余量给 readdir 内部拼接。 */
const LONG_LIMIT = 250

/**
 * 盘符 / 分隔符统一 + 小写 + 去尾斜杠，用于「同一路径不同写法」归一。
 * 定义已挪到 `shared/pathkey.ts`（渲染端也要同一条判据），这里 re-export 让既有引用点不动。
 */
export { normalizeKey } from '../../shared/pathkey'

/** 拼接父目录与条目名，正确处理 `C:\` 这类已带尾斜杠的父级。 */
export function joinWin(parent: string, name: string): string {
  return parent.endsWith('\\') ? parent + name : parent + '\\' + name
}

export function baseName(p: string): string {
  const s = p.replace(/\\+$/, '')
  const i = s.lastIndexOf('\\')
  return i < 0 ? s : s.slice(i + 1)
}

/** 根目录（`C:\`）没有父级，返回 null。盘符根的父级是 `C:\` 本身而不是裸 `C:`（与 path.win32.dirname 一致）。 */
export function parentOf(p: string): string | null {
  const s = p.replace(/\\+$/, '')
  const i = s.lastIndexOf('\\')
  if (i <= 0) return null
  const head = s.slice(0, i)
  // 去掉分隔符会把「盘符根」变成裸 'C:'，与 root 的 key 'c:\' 对不上 → 树会挂不上去
  return /^[A-Za-z]:$/.test(head) ? head + '\\' : head
}

/** 小写扩展名（含点）；无扩展名 / 点开头的名字（`.gitignore`）返回 ''。 */
export function extOf(p: string): string {
  const b = baseName(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i).toLowerCase()
}

/**
 * 「这一个路径就是盘符根」——`C:\` / `c:` / `D:\\` 都算，`C:\Users` 与 UNC（`\\srv\share`）都不算。
 *
 * 住在这里是因为全仓只有这一处判据：`core/analyze/treemap-data.ts` 的 `rootShareLabel`
 * 用它决定第二行百分比叫「占全盘」还是「占扫描根」，V0.3 分析层的 `AnalysisResult.rootIsDrive`
 * 也用同一个函数。这两处若各写一份正则，就会出现「地图上写占扫描根、分析页写占全盘」的同一格两说。
 * （`parentOf` 里那条 `/^[A-Za-z]:$/` 是**另一件事**：它认的是去掉尾斜杠之后的盘符头，不是完整根路径。）
 */
export function isDriveRootPath(p: string): boolean {
  return /^[A-Za-z]:[/\\]*$/.test(p)
}

/**
 * 转成可以直接喂给 node:fs 的路径：
 * 超过 LONG_LIMIT 时加 `\\?\` 扩展前缀（绕过 MAX_PATH 限制），UNC 走 `\\?\unc\`。
 * 幂等：已有前缀的原样返回。
 */
export function toFsPath(p: string): string {
  if (p.startsWith('\\\\?\\')) return p
  const isUnc = p.startsWith('\\\\')
  if (!isUnc && p.length <= LONG_LIMIT) return p
  if (isUnc) return '\\\\?\\unc\\' + p.slice(2).replace('\\', '/')
  return '\\\\?\\' + p
}
