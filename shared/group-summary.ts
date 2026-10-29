/**
 * group-summary —— 把扫描根那一层的子项按类型档位（§13 的 NodeGroup）聚合成一份「空间概览」账。
 *
 * 纯函数，依赖红线与 `shared/` 其余模块一致：只准碰 `./types` 与 `./classify`，不许 import `core/**`。
 *
 * 为什么 `unaccountedBytes` 要单独立成一个字段（本文件的存在理由）：
 * 送进来的 `children` 是**收窄之后**的视图，而 `shared/types.ts` 里 `foldedBytes` 那段契约注释已经写明
 * 它不等于整棵树 —— 有三条彼此独立的机制会各自漏掉容量：
 *  ① 视图折叠（`foldedBytes`）：超出 `LEVEL_CAP` 的那批直属子项被并成合成块「其它 N 项」，
 *     那一块**没有路径**（见 `ChildView.path` 为空串的合成条目），所以按路径判档的规则压根分不到它；
 *  ② 视图排除（`excludedBytes`）：用户在地图上把某个目录藏了，账还在、面积没了；
 *  ③ `maxFiles` 截断：`core/scan/tree-store.ts` 的 `addFilesToDir` 丢的是**存储里的文件记录**而容量照计，
 *     那部分字节既不进 `children` 也不进 `foldedBytes`，`totalChildren` / `foldedCount` 同样偏小，
 *     只由 `ScanSnapshot.truncated` 点名 —— ①② 各有字段，③ 谁都不认。
 * 于是 `rootBytes − Σbuckets − foldedBytes − excludedBytes` 这一段差额必须原样端给用户。
 * 并进任何一档、或者干脆不报，百分比都会「刚好凑成 100」，那张卡片就是在谎报覆盖率
 * （项目铁律：摆到用户面前的数字不许静默少报）。
 */

import type { ChildView } from './types'
import { classifyEntry, type NodeGroup } from './classify'

export interface GroupBucket {
  group: NodeGroup
  /** 这一档的合计字节。脏输入（NaN / Infinity / 负数）按 0 计，见 `readableBytes`。 */
  bytes: number
  /**
   * 归进这一档的子项个数（文件与目录都算，0 字节的那几项也计入），给「N 项」这种点名用。
   * 注意它与 `bytes` 不对称：整档都是 0 字节时这一档根本不上榜，它的项数也就看不见 ——
   * 不上榜的是「这一档占了多少空间」，不是「盘上有几项」。
   */
  items: number
}

export interface GroupSummary {
  /** 按 bytes 降序；bytes 为 0 的档不出现。同 bytes 时按档位名升序，顺序不由 `children` 的来序决定。 */
  buckets: GroupBucket[]
  /** 视图折叠掉的、没有路径可归类的字节（机制 ①，原样透传调用方给的那个数）。 */
  foldedBytes: number
  /** 用户在本轮排除掉的字节（机制 ②，`ChildrenPayload.excludedBytes` 的**本层直属**口径）。 */
  excludedBytes: number
  /**
   * `rootBytes - Σbuckets - foldedBytes - excludedBytes`，**必须原样点名**，不许并进任何 bucket。
   * 这一段主要就是机制 ③：`maxFiles` 截断掉的那部分容量。
   * 夹到 ≥ 0：为负只可能是调用方给的 folded/excluded/root 三个数自己没对上账，
   * 而一个「负的未计入字节」在界面上既没法印、还会被读成「还有一块正向的账没算」，比印 0 更误导。
   */
  unaccountedBytes: number
  /** 本次扫描根（那一整棵）的总容量：`coveredRatio` 的分母，原样透传。 */
  rootBytes: number
  /**
   * `Σbuckets / rootBytes`，0..1；rootBytes 为 0 时给 0。
   * 上限夹到 1：children 的合计按理超不过根，真超了是上游两个口径不同源（比如传错了层），
   * 那一刻该印的是「100% + 数据有出入」，而不是 130%。
   * **小于 1 是常态而不是 bug** —— 差额由 `unaccountedBytes` 解释，别拿 `1 - coveredRatio` 去补一个档位。
   */
  coveredRatio: number
}

/**
 * 只认「有限且为正」的容量。一个脏 size 不该把整栏加成 NaN —— 那等于用户问「这盘怎么分的」，
 * 答案变成「不知道」，而其实其它档都是好数。
 */
function readableBytes(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 按档位聚合那一层的子项。
 *
 * 输入就是 `ChildrenPayload` 的那四个数（`children` / `foldedBytes` / `excludedBytes` + `rootSize`），
 * 这里不加权、不补估、也不把 `unaccountedBytes` 摊进档里。扫描进行中的中间值（`ChildView.scanning`、
 * `status` 非 completed）不在这里区分：那是调用方要不要印「仍在扫描」那句话的事，字节口径只有一个。
 */
export function summarizeGroups(
  children: readonly ChildView[],
  foldedBytes: number,
  excludedBytes: number,
  rootBytes: number
): GroupSummary {
  const byGroup = new Map<NodeGroup, GroupBucket>()
  let coveredBytes = 0

  for (const c of children) {
    // 目录在这份线格式里 attrs 恒为 null（本轮不 stat 目录，见 `ChildView.attrs` 的注释），
    // 所以目录实际只由路径决定档位，这是设计边界而不是待修的缺陷；
    // 文件的 attrs 仍要递进去：证明出 SYSTEM 的那几条会被收紧成 system（§28 原则二）。
    const group = classifyEntry(c.path, c.attrs)
    const bytes = readableBytes(c.size)
    coveredBytes += bytes
    const bucket = byGroup.get(group)
    if (bucket === undefined) {
      // `noUncheckedIndexedAccess` 之下 `get` 的返回带 undefined，分支必须写实
      byGroup.set(group, { group, bytes, items: 1 })
    } else {
      bucket.bytes += bytes
      bucket.items += 1
    }
  }

  const buckets = [...byGroup.values()]
    .filter((b) => b.bytes > 0)
    // 同容量按档位键的**字典序**收尾（不是 localeCompare：档位键是内部标识，比较结果不该随机器 locale 漂）。
    // 为什么要有这一条 tiebreak：V8 的 sort 稳定，光按 bytes 排就等于让「`children` 里谁先来」决定档次顺序，
    // 同一张盘重扫一次、或折叠后剩的项换个顺序，卡片上那一列配色就会重新洗一遍牌。
    // 与 `core/analyze/top-rows.ts` 的同容量 tiebreak 同源理由（那边比的是 name，这里比的是 group）。
    .sort((a, b) => b.bytes - a.bytes || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0))

  // 三个「账外面的数」透传原值给 UI，参与运算的那一份才走 readableBytes：
  // 上游给了 NaN 就照原样让它露出来，但别让它把 buckets 那几档的好数字一起拖成 NaN。
  const folded = readableBytes(foldedBytes)
  const excluded = readableBytes(excludedBytes)
  const root = readableBytes(rootBytes)

  return {
    buckets,
    foldedBytes,
    excludedBytes,
    unaccountedBytes: Math.max(0, root - coveredBytes - folded - excluded),
    rootBytes,
    coveredRatio: root > 0 ? Math.min(1, coveredBytes / root) : 0
  }
}

/* ------------------------------------------------------------------ *
 * 首页「空间概览」那一列的四档（V0.9 第二轮）
 *
 * **这是一份新造的语义，`NodeGroup` 那 13 档里没有任何一处写着它。** 之所以还是做了，
 * 是人类伙伴这一轮的设计说明点名要 系统 / 应用 / 用户 / 其他 四行条形图。
 * 上一轮（计划 §5 的 U9）我判"13 压成 4 是造语义"而拒绝了同一件事 —— 这次接受，但把代价
 * 用两条硬要求买回来：
 * ① 映射只住在这里这一处，且每一档都点名它吞了哪些 `NodeGroup`（见 `OVERVIEW_BUCKET_OF_GROUP`），
 *    不许在组件里再手写一份 switch；
 * ② 四档**加起来不等于已扫描容量**（缓存与临时文件被算进「其他」而不是单独一档，
 *    而折叠/排除/截断那三笔压根没有路径可归），所以条形图旁边必须照旧点名残差，
 *    不许把四根条画成"把盘分完了"。
 * ------------------------------------------------------------------ */

export type OverviewBucket = 'system' | 'app' | 'user' | 'other'

export const OVERVIEW_BUCKET_LABELS: Record<OverviewBucket, string> = {
  system: '系统',
  app: '应用',
  user: '用户',
  other: '其他'
}

/**
 * 13 → 4 的那份映射。`dev` 归「应用」而不是「其他」—— 它是装出来的东西；
 * `cache` / `temp` 归「其他」，**这一条最容易被读成"其他=可清理"**，所以它们不该并排出现，
 * 可清理那个数有自己的位置（首页那条 `reportReclaimableBytes`）。
 */
export const OVERVIEW_BUCKET_OF_GROUP: Record<NodeGroup, OverviewBucket> = {
  system: 'system',
  app: 'app',
  dev: 'app',
  user: 'user',
  document: 'user',
  archive: 'user',
  video: 'user',
  image: 'user',
  audio: 'user',
  model: 'user',
  cache: 'other',
  temp: 'other',
  other: 'other'
}

/** 条形图固定的显示顺序（不按字节排：四行来回换位比颜色少更扰人） */
export const OVERVIEW_BUCKET_ORDER: readonly OverviewBucket[] = ['system', 'app', 'user', 'other']

export interface OverviewRow {
  bucket: OverviewBucket
  bytes: number
  items: number
}

/** 把 13 档收成 4 行，顺序固定为 `OVERVIEW_BUCKET_ORDER`，全 0 的档也保留（四行不跳来跳去）。 */
export function toOverviewRows(buckets: readonly GroupBucket[]): OverviewRow[] {
  const acc = new Map<OverviewBucket, OverviewRow>()
  for (const b of buckets) {
    const bucket = OVERVIEW_BUCKET_OF_GROUP[b.group]
    const row = acc.get(bucket)
    if (row === undefined) acc.set(bucket, { bucket, bytes: b.bytes, items: b.items })
    else {
      row.bytes += b.bytes
      row.items += b.items
    }
  }
  return OVERVIEW_BUCKET_ORDER.map((bucket) => acc.get(bucket) ?? { bucket, bytes: 0, items: 0 })
}
