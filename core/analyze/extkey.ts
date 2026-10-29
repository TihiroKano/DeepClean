import { extOf } from '../fs/pathutil'

/**
 * 无扩展名的归类标签。规格书 §6 要「[无扩展名]」，不许留空串（空串在表里长得像 bug）。
 * 住在这里而不是 `shared/` 是因为它只在扩展名这一列上有意义，见 `extLabel`。
 */
export const NO_EXT_LABEL = '[无扩展名]'

/**
 * 扩展名归一的判据 —— **分析层引这一处**（Tasks 2–7 不许直接引 `pathutil.extOf` 取扩展名键）。
 *
 * 口径（规格书 §6「多重扩展名 / 大小写不同 / 无扩展名 / 点开头文件」四条都在这里）：
 * 大小写统一为小写并带点；无扩展名与点开头文件（`.gitignore`）归 `''`；
 * 多重扩展名取**最后一个**点：`archive.tar.gz → .gz`、`f.tmp.noext → .noext`。
 * 这是一条口径而不是"正确答案" —— 取最后一段与 Windows 资源管理器一致，代价是
 * `.tar.gz` 会被并进 `.gz`。口径用 `tests/unit/analysis-accumulators.test.ts` 的
 * `extKeyOf` 那组用例钉住（`.gitignore` 那条钉的是判据里的 `<= 0`），改判据必须同时改用例。
 *
 * ### 为什么它是 `extOf` 而不是第三份实现
 *
 * `core/fs/pathutil.ts` 的 `extOf` 早就在做同一件事，`core/analyze/top-files.ts` 里还躺着一份
 * 私有的 `extOfHit`（V0.1 遗留，因为 `FileHit.ext` 对无扩展名文件会退化成名字尾巴）。
 * 全仓再造一份逐字相同的判据，代价不是"多六行"，是**同一棵树在两张表里对"什么是 .gz"各说一套**：
 * `TreeStore.addFilesToDir` 就是拿 `extOf` 填 `topHeap` 的 `ext` 的，那是规格书 §2 全局 Top-N 榜的
 * 数据来源，而本文件是 §3 文件类型统计的键 —— 两张表必须能对上。
 * 所以这里**只做别名 + 标签**，判据留在 `pathutil`：`extKeyOf` 的入参是名字（`ChildView.name`），
 * 而 `extOf` 先过一道 `baseName`，对不含 `\\` 的名字是恒等的 —— 也就是说对 `extKeyOf` 唯一合法的
 * 入参域，两者逐字同解。这条"同解"不靠注释维持，由用例里那条八个样本的交叉断言钉着；
 * 顺手的好处是万一调用方误传整条路径，`extOf` 那一道 `baseName` 会把它救回来。
 *
 * 反过来它**不**并到 `extKeyOf` 名下也是有意为之：`extOf` 在扫描层的计价路径上
 * （`tree-store.ts` 第 367 行），V0.3 全局约束冻结 `core/scan/**`，把判据搬到分析层会让
 * `pathutil` 反向依赖 `core/analyze`。Task 2 若要"判据只有一个物理位置"，那是把 `extOf` 搬进
 * `extkey.ts` 再让 `pathutil` 引它 —— 一次单独落地的改动，不该藏在引擎骨架里。
 */
export function extKeyOf(name: string): string {
  return extOf(name)
}

/** 展示用标签：`''` 显示成 `NO_EXT_LABEL`，其余原样（带点小写）。 */
export function extLabel(ext: string): string {
  return ext === '' ? NO_EXT_LABEL : ext
}
