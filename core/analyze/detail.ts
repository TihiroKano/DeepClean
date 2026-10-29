import {
  attrRows,
  classifyEntry,
  GROUP_LABELS,
  protectedByAttrs,
  RISK_BY_GROUP,
  type AttrRow,
  type NodeGroup,
  type Risk
} from '../../shared/classify'
import { formatBytes, formatCount, formatDate } from '../../shared/format'
import type { ChildView } from '../../shared/types'
import { FOLD_NOTE, rootShareLabel } from './treemap-data'

/** 规格书 §8 要的是「类型：PAK 文件」这种看得懂的话，不是 `.pak` 这种要用户自己去查的后缀。 */
const TYPE_LABELS: Record<string, string> = {
  '.exe': '可执行程序', '.dll': '系统库 (DLL)', '.sys': '驱动', '.msi': '安装包',
  '.zip': '压缩包', '.7z': '压缩包', '.rar': '压缩包', '.pak': 'PAK 资源包',
  '.mp4': '视频', '.mkv': '视频', '.mov': '视频', '.png': '图片', '.jpg': '图片',
  '.json': 'JSON 数据', '.db': '数据库', '.log': '日志', '.tmp': '临时文件', '.ttf': '字体'
}

/** 认得的扩展名给中文标签，认不出的如实给 `.xyz 文件` —— 不猜「未知类型」以外的东西。 */
export function typeLabelOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0) return '无扩展名文件'
  const ext = name.slice(i).toLowerCase()
  return TYPE_LABELS[ext] ?? `${ext.slice(1).toUpperCase()} 文件`
}

export interface DetailModel {
  name: string
  /**
   * null = 没有可信路径 → DetailPanel 整行不渲染。
   * 折叠块的 `path` 是合成串 `''`，照原样渲染就是一条空路径行，看着像「这个目录没路径」。
   */
  path: string | null
  /** null = 「类型」这一项无从谈起（折叠块是合成项，既不是目录也不是文件）。 */
  kind: 'file' | 'directory' | 'drive' | null
  sizeText: string
  percentOfParent: string
  /** 第二个百分比（行名见 `rootShareLabel`）：分母 rootSize 没给就是不知道 → 「—」，绝不给 0.0%。 */
  percentOfRoot: string
  /**
   * null = 整行不渲染（这个数字从未为这一项采集过）；'—' = 概念适用但判不出；
   * 两者都不是 0 —— 用 0 冒充「没算过的数字」违反本项目的全局口径。
   */
  fileCountText: string | null
  dirCountText: string | null
  /** null = 合成项没有修改时间可言（不是 formatDate(0) 兜出来的巧合）。 */
  modified: string | null
  /**
   * 「创建时间」那一行的文本：`未采集` 或日期。
   * null = 这一项压根不存在于磁盘上（折叠块），与 `modified` 同一个理由 —— 对它连"没采到"都谈不上。
   */
  created: string | null
  /** false = 该节点没有可读的 birthtime（目录本轮不 stat；网络盘/非 NTFS 卷上文件的 birthtime 也可能是 0）。 */
  createdCollected: boolean
  /**
   * §8 的可读类型（「文件夹」/「PAK 资源包」/「XYZ 文件」）。
   * null 的判据与 `kind` 完全一致：合成项既不是文件也不是文件夹。
   */
  typeLabel: string | null
  /**
   * 第二个百分比的行名：只有扫描根真是盘符根时才是「占全盘」，否则「占扫描根」。
   * 与 tooltip 同一个函数（`core/analyze/treemap-data.ts` 的 `rootShareLabel`）。
   */
  rootShareLabel: string
  group: NodeGroup
  groupLabel: string
  risk: Risk
  scanning: boolean
  /** 字面量 false：本 MVP 不给删除留任何活口（§28 原则一）。 */
  deletable: false
  /** §4.1：隐藏 / 系统 / 只读 / 存档 四行，属性判不出的如实标 unknown / 未采集。折叠块为 `[]`。 */
  attrs: AttrRow[]
  /** false = 该节点没采属性（目录本轮不 stat）。 */
  attrsCollected: boolean
  /** 真属性判出来的保护（带 SYSTEM 位即保护，与路径无关）。 */
  protectedByAttrs: boolean
  /** true = Task 2 的「其它 N 项」合计格：磁盘上不存在对应条目。 */
  folded: boolean
  /** 折叠块说明（与 tooltip 同一句常量）；真条目为 null。 */
  foldedNote: string | null
  /**
   * 「最大文件」那行的存储截断免责（`ScanSnapshot.truncated`）；没截断 = null，整句不出现。
   * 只在 §9 那两行真的渲染时才用得上 —— 判据在 DetailPanel 那边，这里只保管措辞。
   */
  truncatedNote: string | null
}

export interface DetailOpts {
  /**
   * 单击的那一格是不是折叠块（`Tile.folded`）。
   * 折叠项的文件数 / 子目录数 / 属性 / 创建时间 / 类型从未采集过（`foldedCount` 是本层被折掉的子项个数，不是文件数），
   * 所以这些行整行撤掉，而不是显示 0 或「未采集」。
   */
  folded?: boolean
  /** 本次扫描根容量 —— 第二个百分比的分母（来自 `ChildrenPayload.rootSize`）。不给就是不知道。 */
  rootSize?: number
  /** 本次扫描的根路径（`ChildrenPayload.path` 的第一层）—— 只用来决定上面那一行叫「占全盘」还是「占扫描根」。
   * 不给 = 无从判断是不是整盘，老实说「占扫描根」。
   */
  rootPath?: string
  /**
   * `ScanSnapshot.truncated`：本次扫描的文件清单撞到 `maxFiles` 存储上限（内存保护）。
   * 它只影响「最大文件」那一行的可信度，所以这句 caveat 由模型出文本、面板决定挂在哪一行下面。
   */
  truncated?: boolean
}

/** 分母为 0（调用方没给）＝ 不知道 → 「—」。这条面板与 tooltip 同口径。 */
function percent(size: number, denom: number, digits: number): string {
  return denom > 0 ? `${((size / denom) * 100).toFixed(digits)}%` : '—'
}

/**
 * §9「最大文件」那行的存储截断免责。三条 caveat 各管一件事，措辞不许互相串门
 * （判据在 `tests/unit/detail.test.ts` 里钉着）：
 * - 视图折叠：`FOLD_NOTE`（这一格是合成块）；
 * - 预算用尽：`DirStats.partial` → 面板那句「仅统计前 N 个节点」（遍历本身被截了）；
 * - 清单截断：**这一句** —— 遍历是全量的，缺的是内存里的文件名清单，
 *   所以「最大文件」可能不是真正的最大，而「最大子目录」比的是目录容量、不受影响。
 * 刻意不在这句里提"预算/节点"：那是另一个口径，混着写用户就分不清现在到底少算了什么。
 */
const STATS_TRUNCATION_NOTE =
  '本次扫描的文件清单已达存储上限（为保护内存只丢文件名、不丢容量）：上面那行「最大文件」只看到留在内存里的那批文件名，可能不是真正的最大。「最大子目录」比的是目录容量，不受影响。'

export function buildDetail(child: ChildView, parentSize: number, opts: DetailOpts = {}): DetailModel {
  const fold = opts.folded === true
  const isDir = child.kind === 'directory'
  const group = classifyEntry(child.path, child.attrs)
  return {
    name: child.name,
    // 空串 path 一律不渲染：真走到这条的只有合成项
    path: fold || child.path === '' ? null : child.path,
    kind: fold ? null : child.kind,
    sizeText: formatBytes(child.size),
    percentOfParent: percent(child.size, parentSize, 1),
    percentOfRoot: percent(child.size, opts.rootSize ?? 0, 2),
    fileCountText: fold ? null : isDir ? formatCount(child.fileCount) : '—',
    dirCountText: fold ? null : isDir ? formatCount(child.dirCount) : '—',
    // 折叠块的 mtimeMs 是 0，formatDate 恰好返回「—」—— 那是守卫碰巧，不是设计：合成项根本没有时间可言
    modified: fold ? null : formatDate(child.mtimeMs),
    // 创建时间：birthtime 与 size/mtime 出自同一次 stat（目录没走 stat → null，非 NTFS 卷上可能是 0）。
    // 「没采到」永远写成「未采集」，绝不落进 formatDate(0) 那种 1970-01-01。
    created: fold
      ? null
      : child.birthtimeMs === null || child.birthtimeMs <= 0
        ? '未采集'
        : formatDate(child.birthtimeMs),
    createdCollected: child.birthtimeMs !== null && child.birthtimeMs > 0,
    typeLabel: fold ? null : child.kind === 'file' ? typeLabelOf(child.name) : child.kind === 'drive' ? '磁盘' : '文件夹',
    // 分母是"用户选中的那一棵"，只有它真是盘符根时才有"整盘"可占（判据与 tooltip 同一个函数）
    rootShareLabel: rootShareLabel(opts.rootPath),
    group,
    groupLabel: GROUP_LABELS[group],
    risk: RISK_BY_GROUP[group],
    scanning: child.scanning === true,
    deletable: false,
    attrs: fold ? [] : attrRows(child.attrs),
    attrsCollected: child.attrs !== null,
    protectedByAttrs: protectedByAttrs(child.attrs),
    folded: fold,
    foldedNote: fold ? FOLD_NOTE : null,
    truncatedNote: opts.truncated === true ? STATS_TRUNCATION_NOTE : null
  }
}
