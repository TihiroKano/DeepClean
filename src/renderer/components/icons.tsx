import type { ReactNode } from 'react'

/**
 * 手写图标集（V0.9 应用外壳与首页改版）。
 *
 * **为什么不装图标库**：本项目运行时依赖只有 `react` / `react-dom` 两个，这是刻意的。
 * 这台机器走的是国内镜像，历史上 `npm i` 装出过坏包（见记忆 `tooling-electron-npmmirror-install`），
 * 为几个 24px 的描线破一次"零新依赖"不值。所以 Lucide/Tabler 那一派的细描线图标在这里手写 ——
 * 代价是**每一笔都得自己保证在 20px 下认得出来**，好处是零依赖、零 tree-shaking 悬念、颜色跟着
 * `currentColor` 走（图标不需要自己的调色板，语义色只在 `tokens.css` 那一处）。
 *
 * **外壳只有一处**：`viewBox` / `fill="none"` / `stroke="currentColor"` / 圆头圆角 /
 * `width`·`height` / 无障碍属性全在 `Svg` 里，下面每个图标只写几何体。所以「某个图标
 * 忘了加 aria-hidden」这类缺陷在这里不可能发生。
 *
 * **`aria-hidden` 不是装饰**：侧栏每个导航项旁边都跟着中文标签（`App.tsx` 的 `NAV`），
 * 图标纯粹是重复信息，读屏软件念一遍「图标 首页」才是噪音。需要图标单独表意的地方由调用方
 * 自己给 `title`/`aria-label`，不在这一层替它决定。
 *
 * **一个约定要说明白**：`tests/unit/icons.test.tsx` 钉「每个图标至少 2 个几何元素」，
 * 那一条是拿来挡占位货的（一个 `<rect>` 就交差的假图标）。`CloseIcon` / `BoltIcon` /
 * `Chevron*Icon` 天生只有一笔，于是按这条约定**拆成两笔真几何**：
 * 折线在拐点/边中点处断开，两段首尾相接 —— 20px 下与单条折线逐像素相同（已用描线光栅器
 * 比对过 0 像素差）。不是把同一条路径描两遍来糊过断言。
 */

export interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
}

/** 图标组件的统一签名：`ICONS` 的值、以及下面 23 个导出的实际形状。 */
type IconComponent = (props: IconProps) => JSX.Element

/** 外壳：只有它知道 `IconProps` 的默认值，图标体因此可以只管几何。 */
function Svg({
  size,
  className,
  strokeWidth,
  children
}: {
  size: number
  /** 可以不传：不传时 DOM 上不该留一个空的 `class=""`。 */
  className?: string
  strokeWidth: number
  children: ReactNode
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={true}
      focusable={false}
    >
      {children}
    </svg>
  )
}

/** 把一个图标的几何体包成组件：`export const XxxIcon = icon(<>…</>)`。 */
const icon =
  (geometry: ReactNode): IconComponent =>
  ({ size = 20, className, strokeWidth = 1.8 }: IconProps): JSX.Element => (
    <Svg size={size} className={className} strokeWidth={strokeWidth}>
      {geometry}
    </Svg>
  )

/** 品牌：一把扫帚加一颗星。侧栏与首页头部共用这一个画法，别画两把长得不一样的扫帚。
 *  **为什么不引 `build/icon.png`**：那是给 exe / 任务栏的，而 `package.json` 的 `files`
 *  把 `build/**` 整个排除在 asar 外（S5 记着这条），引它就只有开发模式看得见、打包版是一块空图。 */
export const BroomIcon = icon(
  <>
    <path d="M14.4 3.4L20.6 9.6" />
    <path d="M17.5 6.5L9.2 14.8" />
    <path d="M12.3 11.7L5.6 18.4A2.1 2.1 0 0 0 5.6 21.4H8.6A2.1 2.1 0 0 0 11.6 21.4L18.3 14.7Z" />
    <path d="M5.9 19.5L8.4 17" />
    <path d="M4.2 3.2L4.9 5L6.7 5.7L4.9 6.4L4.2 8.2L3.5 6.4L1.7 5.7L3.5 5Z" />
  </>
)

/** 首页：屋顶起脊于 (12,3)，墙体落到底框，中间那格是门（没有门的房子在 20px 下会读成五边形）。 */
export const HomeIcon = icon(
  <>
    <path d="M3 10.4L12 3L21 10.4V20A1.6 1.6 0 0 1 19.4 21.6H4.6A1.6 1.6 0 0 1 3 20Z" />
    <path d="M9.4 21.6V14.5H14.6V21.6" />
  </>
)

/** 空间地图：外框 + 一竖两横的分割线，左右两栏的分割高度故意错开 —— 这是 treemap 的读法，不是一张表格。 */
export const MapIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2.2" />
    <path d="M14.2 4V20" />
    <path d="M3 12.4H14.2" />
    <path d="M14.2 9.6H21" />
  </>
)

/** 文档：右上角那一刀是折角，闭合段 (19,8.5)→(14.5,3) 就是被折掉的那条斜边。 */
export const FileIcon = icon(
  <>
    <path d="M14.5 3H6.8A1.8 1.8 0 0 0 5 4.8V19.2A1.8 1.8 0 0 0 6.8 21H17.2A1.8 1.8 0 0 0 19 19.2V8.5Z" />
    <path d="M14.5 3V7.2A1.4 1.4 0 0 0 15.9 8.6H19" />
  </>
)

/** 垃圾清理：盖沿 + 提手 + 桶身 + 桶身里两条竖线（少了那两条，20px 下它和「归档盒」分不开）。 */
export const TrashIcon = icon(
  <>
    <path d="M3.5 6.5H20.5" />
    <path d="M9.2 6.5V4.9A1.4 1.4 0 0 1 10.6 3.5H13.4A1.4 1.4 0 0 1 14.8 4.9V6.5" />
    <path d="M5.6 6.5L6.5 19.5A1.9 1.9 0 0 0 8.4 21.2H15.6A1.9 1.9 0 0 0 17.5 19.5L18.4 6.5" />
    <path d="M10.2 10.5V17.1" />
    <path d="M13.8 10.5V17.1" />
  </>
)

/** 重复文件：后一张只露左上三条边（露全框会被前一张的线切成十字），前一张是完整圆角矩形。 */
export const CopyIcon = icon(
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.4" />
    <path d="M15.5 8.5V4.9A2.4 2.4 0 0 0 13.1 2.5H4.9A2.4 2.4 0 0 0 2.5 4.9V13.1A2.4 2.4 0 0 0 4.9 15.5H8.5" />
  </>
)

/** 开发环境：`</>` —— 左右两个尖角加中间那道斜杠，斜杠从右上到左下（画反了就成了 `>/<`）。 */
export const CodeIcon = icon(
  <>
    <path d="M9.5 8L5 12L9.5 16" />
    <path d="M14.5 8L19 12L14.5 16" />
    <path d="M13.2 5.5L10.8 18.5" />
  </>
)

/** 清理记录：三行「对勾 + 那一行的字」。删除账本读起来就是逐条打勾，不是一本合上的书。 */
export const JournalIcon = icon(
  <>
    <path d="M3 6.2L4.7 7.9L8.3 4" />
    <path d="M11.6 6H20.6" />
    <path d="M3 12.2L4.7 13.9L8.3 10" />
    <path d="M11.6 12H20.6" />
    <path d="M3 18.2L4.7 19.9L8.3 16" />
    <path d="M11.6 18H20.6" />
  </>
)

/**
 * 设置：一圈八齿 + 中心轮毂。齿是解析出来的（8 齿 × 每齿 4 个顶点，齿顶 r=10.1 / 齿根 r=6.5），
 * 不是手描的近似 —— 齿轮一旦不对称，20px 下会歪得很明显。
 */
export const SettingsIcon = icon(
  <>
    <path d="M10.7 5.63L10.94 1.96L13.06 1.96L13.3 5.63L15.59 6.58L18.36 4.15L19.85 5.64L17.42 8.41L18.37 10.7L22.04 10.94L22.04 13.06L18.37 13.3L17.42 15.59L19.85 18.36L18.36 19.85L15.59 17.42L13.3 18.37L13.06 22.04L10.94 22.04L10.7 18.37L8.41 17.42L5.64 19.85L4.15 18.36L6.58 15.59L5.63 13.3L1.96 13.06L1.96 10.94L5.63 10.7L6.58 8.41L4.15 5.64L5.64 4.15L8.41 6.58Z" />
    <circle cx="12" cy="12" r="3" />
  </>
)

/** 磁盘：圆角盒 + 前面板那道分隔线 + 面板上的状态点。 */
export const DriveIcon = icon(
  <>
    <rect x="2.6" y="4.8" width="18.8" height="14.4" rx="2.6" />
    <path d="M2.6 14.6H21.4" />
    <circle cx="6.4" cy="16.9" r="1" />
  </>
)

/** 折叠箭头（下）：两笔在 (12,15.4) 首尾相接，见文件头那条「拆两笔」的约定。 */
export const ChevronDownIcon = icon(
  <>
    <path d="M5.8 9.2L12 15.4" />
    <path d="M12 15.4L18.2 9.2" />
  </>
)

/** 展开箭头（右）：与 `ChevronDownIcon` 同一套笔画，只是转了 90°，所以两者视觉重量一致。 */
export const ChevronRightIcon = icon(
  <>
    <path d="M9.2 5.8L15.4 12" />
    <path d="M15.4 12L9.2 18.2" />
  </>
)

/** 扫描/加速：一颗大四星加一颗小星（只有一颗就成了「星星」，两颗才是「闪光」）。 */
export const SparkleIcon = icon(
  <>
    <path d="M10 3L11.9 8.6L17.5 10.5L11.9 12.4L10 18L8.1 12.4L2.5 10.5L8.1 8.6Z" />
    <path d="M18 14L18.9 16.6L21.5 17.5L18.9 18.4L18 21L17.1 18.4L14.5 17.5L17.1 16.6Z" />
  </>
)

/** 时间：分针指到 12，时针走向 4~5 点方向（两根针都从圆心起画，缺一根就成了空盘子）。 */
export const ClockIcon = icon(
  <>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 7V12.3L15.7 14.5" />
  </>
)

/** 闪电：轮廓沿 (13.5,2.5)→(4,14)→(12,14)→(10.5,21.5)→(20,10)→(12,10) 走一圈，
 *  在两条**直边**的中点处断成两笔，接缝与边共线，所以看不出来。 */
export const BoltIcon = icon(
  <>
    <path d="M8.75 8.25L4 14L12 14L11.25 17.75" />
    <path d="M11.25 17.75L10.5 21.5L20 10L12 10L13.5 2.5L8.75 8.25" />
  </>
)

/** 大文件：左上那个台阶是标签页，横贯的那条线是前盖的上沿（没有它就成了一个圆角矩形加个凸起）。 */
export const FolderIcon = icon(
  <>
    <path d="M3.2 8.4V6.6A2 2 0 0 1 5.2 4.6H8.8A2 2 0 0 1 10.3 5.3L11.5 6.8H18.8A2 2 0 0 1 20.8 8.8V17.4A2 2 0 0 1 18.8 19.4H5.2A2 2 0 0 1 3.2 17.4Z" />
    <path d="M3.2 11.2H20.8" />
  </>
)

/** 空间概览：整圈加两条半径（12 点方向下来、3 点方向出去），那一片就是被切出来的扇区。 */
export const PieIcon = icon(
  <>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M12 2.8V12H21.2" />
  </>
)

/** 分层：最上面一颗完整的菱形，下面两层只露出被压住的那两条边 —— 三颗全菱形会读成一堆方块。 */
export const LayersIcon = icon(
  <>
    <path d="M12 2.8L20.8 7.6L12 12.4L3.2 7.6Z" />
    <path d="M3.2 12.6L12 17.4L20.8 12.6" />
    <path d="M3.2 17L12 21.8L20.8 17" />
  </>
)

/** 图片：相框 + 左上那轮太阳 + 一座山，山的两个端点正好落在框的右边与右下圆角收尾处。 */
export const ImageIcon = icon(
  <>
    <rect x="3" y="3.4" width="18" height="17.2" rx="2.6" />
    <circle cx="8.8" cy="9" r="2.1" />
    <path d="M21 15.2L15.8 10L5.6 20.6" />
  </>
)

/** 关闭：两条对角线，各一笔。 */
export const CloseIcon = icon(
  <>
    <path d="M6.2 6.2L17.8 17.8" />
    <path d="M17.8 6.2L6.2 17.8" />
  </>
)

/** 窗控·最小化：一条横线，按文件头「拆两笔」的约定在中点断开、两段首尾相接。 */
export const MinimizeIcon = icon(
  <>
    <path d="M6 12h5.6" />
    <path d="M12.4 12H18" />
  </>
)

/** 窗控·最大化：一个方框，两笔在 (6,6) 与 (18,18) 两个对角处首尾相接（同折线那条约定）。 */
export const MaximizeIcon = icon(
  <>
    <path d="M6 6h12v12" />
    <path d="M18 18H6V6" />
  </>
)

/** 窗控·还原：后框只露上边与右边，前框完整 —— 与 `CopyIcon` 同一种「后一张别露全」的读法。 */
export const RestoreIcon = icon(
  <>
    <path d="M8.5 8.5V6.2A1.8 1.8 0 0 1 10.3 4.4H18A1.8 1.8 0 0 1 19.8 6.2V13.7A1.8 1.8 0 0 1 18 15.5H15.5" />
    <rect x="4.2" y="8.5" width="11.3" height="11.3" rx="1.8" />
  </>
)

/**
 * 23 个图标的名字，字典序。
 *
 * 这份清单与下面的 `ICONS` 是**手写的两份**，不是从 `Object.keys` 推出来的 —— 因为
 * 「从 keys 推」会把两边的漂移变成静默一致（漏登记一个组件，清单跟着少一条，测试照样绿）。
 * 谁漂了由 `tests/unit/icons.test.tsx` 那条双向对账判红。
 */
export const ICON_NAMES: readonly string[] = [
  'BoltIcon',
  'BroomIcon',
  'ChevronDownIcon',
  'ChevronRightIcon',
  'ClockIcon',
  'CloseIcon',
  'CodeIcon',
  'CopyIcon',
  'DriveIcon',
  'FileIcon',
  'FolderIcon',
  'HomeIcon',
  'ImageIcon',
  'JournalIcon',
  'LayersIcon',
  'MapIcon',
  'MaximizeIcon',
  'MinimizeIcon',
  'PieIcon',
  'RestoreIcon',
  'SettingsIcon',
  'SparkleIcon',
  'TrashIcon'
]

/**
 * 名字 → 组件。侧栏按导航 id 取图标、测试按这份清单逐个渲染，都只走这一个入口。
 * 键的顺序与 `ICON_NAMES` 逐字相同（字典序），这样两边一比就知道有没有漏。
 */
export const ICONS: Record<string, IconComponent> = {
  BoltIcon,
  BroomIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  DriveIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  ImageIcon,
  JournalIcon,
  LayersIcon,
  MapIcon,
  MaximizeIcon,
  MinimizeIcon,
  PieIcon,
  RestoreIcon,
  SettingsIcon,
  SparkleIcon,
  TrashIcon
}
