import { createContext, useContext } from 'react'

/**
 * 字节数的**口径**。同一个数字，两种含义，标签必须跟着数据走。
 *
 *  · `'apparent'`  = 表观（逻辑）大小之和：硬链接按名重复计、不含 NTFS 压缩收益。
 *                    Electron 侧现行实现给的就是这个，所以它是**默认值**（缺省 = 老行为）。
 *  · `'allocated'` = 占用（分配）大小且硬链接已按 (卷序列号, 文件 ID) 去重。
 *                    Tauri 侧 Rust 扫描内核给的是这个 —— 也是「80G 的盘扫出 90G」那个
 *                    毛病的正解：只有这个数才允许与卷容量比。
 *
 * **为什么要有这个东西**：界面全篇写着「表观大小」，而 Tauri 侧送来的数**不是**表观。
 * 不改标签就是让界面撒谎，改了标签又会让 Electron 侧说错 —— 所以标签从数据里读，
 * 不写死。这一条与 `glass/tokens.css` 里"定义了却没人用的 token 会骗人"是同一类纪律：
 * **一个字面量要么是对的，要么是活的，不能是"现在对、换条链就错"的。**
 */
export type SizeBasis = 'apparent' | 'allocated'

const SizeBasisContext = createContext<SizeBasis>('apparent')

export const SizeBasisProvider = SizeBasisContext.Provider

export function useSizeBasis(): SizeBasis {
  return useContext(SizeBasisContext)
}

/** 「表观」/「占用」。用在 `<dt>`、表头、tooltip 这些地方。 */
export function basisWord(b: SizeBasis): string {
  return b === 'allocated' ? '占用' : '表观'
}

/** 「表观大小」/「占用大小」。 */
export function basisNoun(b: SizeBasis): string {
  return b === 'allocated' ? '占用大小' : '表观大小'
}

/** tooltip：把口径的含义说清楚，别只给两个字。 */
export function basisHint(b: SizeBasis): string {
  return b === 'allocated'
    ? '本层文件在磁盘上的分配大小之和：硬链接按 (卷序列号, 文件 ID) 去重、按簇计入，因此不会超过卷容量'
    : '本层文件表观大小之和：硬链接按名重复计、不含 NTFS 压缩收益，故可高于资源管理器显示的占用'
}
