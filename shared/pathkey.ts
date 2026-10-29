/**
 * 路径归一 —— 住在 `shared/` 而不是 `core/fs/`，理由只有一个，但它是硬的：
 * 「这条路径和那条是同一个东西」这条判据必须**全仓只有一份**。
 *
 * 它原本只在 `core/fs/pathutil.ts`，而那份是主进程那一侧的文件；`core/fs/pathutil.ts` 现在只做
 * re-export，所有既有引用点不动，渲染端（需要时）也能直接从 `shared/` 拿同一份。
 */

/** 盘符 / 分隔符统一 + 小写 + 去尾斜杠，用于「同一路径不同写法」归一。 */
export function normalizeKey(p: string): string {
  let s = p.replace(/\//g, '\\').toLowerCase()
  while (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s
}

/**
 * 取盘符（`D:\x` → `'D:'`）。UNC（`\\server\share`）与相对路径返回 null —— 它们没有"盘"这个概念，
 * 宁可标注缺席，也不给一个编出来的盘符。
 *
 * §2.7 的跨磁盘标注要用它：一份内容躺在两个卷上时，"删了能省多少"这件事只对**那个卷**成立，
 * 用户在一个卷上腾出的空间不会出现在另一个卷的可用空间里。不标出来就是让人拿错尺子。
 */
export function driveOf(p: string): string | null {
  const m = /^([A-Za-z]):[\\/]/.exec(p)
  const letter = m?.[1]
  return letter === undefined ? null : letter.toUpperCase() + ':'
}
