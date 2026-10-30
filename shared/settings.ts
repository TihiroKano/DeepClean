/**
 * 应用设置 —— 2026-10-27 扩成**两组**：重复检测门槛（历史遗留）+ 外观（新增）。
 *
 * ## 为什么住 `shared/`
 *
 * 每一个键都有两处读者，少一份定义就会分叉：
 * - 主进程：读写那个 json 文件（`src-tauri/src/settings.rs` 的 `load_settings` / `save_settings`）；
 * - 渲染端：设置页那一格控件。
 * 手抄的两份没有编译期联系，漂移的形状正是本仓反复栽过的那一类：
 * 「界面上写着这个值、服务端按另一个值走」（与 `shared/pathkey.ts` 同一个理由、同一处落点）。
 *
 * 本目录只许 import `shared/`：这个文件同时编进 `tsconfig.node.json` 与 `tsconfig.web.json`
 * 两个项目，一旦引了 `node:fs`，渲染端那一侧就是构建期炸。
 *
 * ## 外观那四格为什么是"数字 + 服务端夹紧"
 *
 * 它们全部落成 CSS 变量（`--glass-blur-page` / `--glass-saturate` / `--glass-brightness` /
 * `--glass-fill-page` 的 alpha），所以：
 *  - **必须有上下界**，而且界要住在服务端（`settings.rs` 与这里各一份、口径逐条同一份）。
 *    一个 0 值的 blur 与一个 999 的 blur 都能把界面变成不可用，而后者在 CSS 里表现为
 *    "整页糊成一团白" —— 那看起来像程序坏了，不是"我调过头了"。
 *  - **不许是任意字符串**：`backgroundImage` 那一格只接受两种形状（见 `WallpaperRef`），
 *    否则一个拼错的 CSS 片段就能让整页背景消失，而那是第二套真相开始住的地方。
 *
 * ## `autoCleanEnabled` 哪去了（2026-10-24 删）
 *
 * 那个人类伙伴当天定的是「一键清理去掉开关，点击后只清理勾选的内容」。
 * 那个开关原先的唯一读者是 Rust `service::run_auto_clean` 的总闸 —— 关着时整条回
 * `E_AUTO_CLEAN_DISABLED`。它被删掉之后就没有任何一段真逻辑读它了，
 * 而**一个没人读的设置就是这一页的一格假控件**（下面那段注释点名的缺陷形态）。
 *
 * 所以它从三处一起消失：这个 interface、Rust 那道闸、设置页那一格。
 * 老用户的 `settings.json` 里若还留着 `autoCleanEnabled`，读的时候会被忽略，
 * 写的时候会被丢掉 —— 一个已经没有任何读者的字段留在文件里，比删掉更容易让人
 * 以为它还在生效。
 *
 * 反过来这条纪律更要紧：**这里不许虚设字段**。设置页上每一格控件都必须有一个真在读它的地方，
 * 所以将来加设置的人要动的是三处（这个 interface、消费它的那段真逻辑、那一格控件），
 * 而不是只往这个 interface 里添一行 —— 后者产出的就是"看着接上了、其实没有"的那种界面。
 */
import { DEFAULT_LOCALE, sanitizeLocale, type Locale } from './i18n'

export interface AppSettings {
  /**
   * 重复文件检测的最小尺寸，单位 MB（服务端按 1024×1024 字节折算）。
   *
   * 为什么它还在而 `autoCleanEnabled` 走了：它有一个**正在被读**的消费点
   * （重复检测的候选门槛），而那个开关在删掉那道闸之后就没有读者了。
   */
  dupMinSizeMb: number
  /** 外观：卡片糊多狠（px）。真读者是 `.dc-card` 的 `backdrop-filter`。 */
  glassBlurPx: number
  /** 外观：处理后饱和度。真读者同上一格（同一条 `backdrop-filter` 链）。 */
  glassSaturate: number
  /** 外观：处理后亮度。真读者同上一格。 */
  glassBrightness: number
  /**
   * 外观：玻璃填充的不透明度（0–1）。真读者是 `--settings-card-fill` 的 alpha。
   *
   * ⚠️ **2026-10-27 改口径**：它原来调的是 `--glass-fill-page`（亮那档）。
   * 人类伙伴要求「设置页面的框色彩改成和开发环境页一样」⇒ 设置卡改用**深色档**
   * （`.dc-devenv-group` 那副配方），所以这一格跟着移到 `--settings-card-fill`。
   *
   * 为什么不直接改 `--glass-fill-page` 或 `--glass-fill-quiet` 的值：
   * 那两个是**共享** token，各有 9 处在用（地图侧栏、日志卡、开发环境组…）。
   * 为了一页的观感去动它们，等于顺手改了另外八处 —— 而"我只改了设置页"这句话
   * 就再也说不准了。所以设置页有自己的那一档，滑块只管自己这一页。
   *
   * 于是「改一格立刻生效」这句话要读准：**滑块调的是设置页自己的卡**，
   * 别的页那一档不跟着动。这与人眼在设置页上看到的一致（拖的时候只有眼前的卡在变）。
   */
  glassOpacity: number
  /** 外观：背景壁纸。真读者是 `.dc-app` 的 `background-image`。 */
  wallpaper: WallpaperRef
  /**
   * 并行扫描的 worker 数（2026-10-29）。真读者是
   * `deepclean_scanner::scan_parallel::scan_tree_parallel_with` 的 worker 池大小。
   *
   * **0 = 用推荐值**（`SCAN_WORKERS_AUTO`）—— 落进内核时变成"这台机器的逻辑核数"。
   * 这一格存在的理由是人类伙伴原话「确保用户拉满倍率导致崩溃的情况发生」，
   * 所以安全上界**不在这一格里**，而在内核的 `clamp_workers` 里（它知道本机几条核）。
   */
  scanWorkers: number
  /** 界面语言（2026-10-29）。闭集见 `shared/i18n.ts` 的 `LOCALES`。 */
  locale: Locale
}

/**
 * 壁纸引用 —— **闭集，不是任意 CSS 字符串**。
 *
 * 两种形状，各自对应一条真读它的渲染路径：
 *  - `builtin:<id>`：应用内自带的那张（今天只有 `mountain`，即 `assets/mountain-bg.jpg`）；
 *  - `file:<用户数据目录里的文件名>`：用户自己选的那张，由服务端复制进
 *    `<appData>/wallpapers/` 之后**只回文件名**。
 *
 * 为什么第二格里是**文件名**而不是绝对路径：绝对路径会被渲染端直接塞进 `url()`，
 * 于是任意路径（含 `..`）都能进来 —— 那是把"选一张图"变成"读任意文件"。服务端复制
 * + 回文件名之后，渲染端拼的永远是 `dc-wallpaper://<name>`（Tauri 的自定义协议作用域），
 * 越界由协议自己挡。
 */
export type WallpaperRef = string

/** 内置壁纸的 id 闭集。加一张要同时加文件与这条注释里点名的渲染路径。 */
export const BUILTIN_WALLPAPERS = ['mountain'] as const
export type BuiltinWallpaper = (typeof BUILTIN_WALLPAPERS)[number]

/** 默认壁纸（内置夜山）。 */
export const DEFAULT_WALLPAPER: WallpaperRef = 'builtin:mountain'

/**
 * 外观四格的上下界。**服务端 `settings.rs` 有一份逐条同口径的**
 * （`MIN_GLASS_BLUR_PX` 那一族），`tests/unit/settings-glass-bounds.test.ts` 钉着两边对同一批
 * 输入给同一个答案。
 *
 * 取值理由：
 *  - `blur 0–60px`：0 是"完全不平滑"（读起来像故障但用户可能就想看清背景），60 已经超出
 *    30 px 默认值一倍，再高在 1080p 上就是一片糊；
 *  - `saturate 0.5–2.5`：CSS 默认 1；低于 0.5 会变成灰白，高于 2.5 会发荧光
 *    （`glass/tokens.css` 那段注释写过"抬过头会发荧光"）；
 *  - `brightness 0.5–1.6`：1.05 是产品默认；高于 1.6 文字与背景的对比度会塌；
 *  - `opacity 0.06–0.9`：**下界不是 0** —— 0 会让"板"消失但盒子还在，
 *    那是一个看着像渲染坏了的状态；0.06 已经薄到能看清背景纹理。
 *    默认 **0.36** = `--glass-fill-quiet` 那一档的 alpha（2026-10-27 设置卡改用深色档
 *    之后，默认值必须跟着搬到 quiet 的值，否则第一次打开设置页会跳一下）。
 */
export const MIN_GLASS_BLUR_PX = 0
export const MAX_GLASS_BLUR_PX = 60
export const MIN_GLASS_SATURATE = 0.5
export const MAX_GLASS_SATURATE = 2.5
export const MIN_GLASS_BRIGHTNESS = 0.5
export const MAX_GLASS_BRIGHTNESS = 1.6
export const MIN_GLASS_OPACITY = 0.06
export const MAX_GLASS_OPACITY = 0.9

/**
 * 并行扫描那三格（2026-10-29），与服务端 `settings.rs` 逐条同一份。
 *
 * ⚠️ **上界分两层**：
 *  - `MAX_SCAN_WORKERS`（这里，=16）是**滑块**能拉到的最大倍率；
 *  - 服务端的 `MAX_SCAN_WORKERS_HARD`（=64）是"文件里写了什么都能收下"的硬顶；
 *  - 真正的安全上界在内核 `clamp_workers`（逻辑核数 ×2）—— 它才知道本机几条核。
 *
 * 为什么滑块不直接给到"逻辑核数"：渲染端拿不到那个数（要过一道 IPC，而这一格
 * 在设置页首次渲染时就得画出来）。给 1–16 的固定档，再由内核按本机核数夹住 ——
 * 在小机器上滑块拉到 16 等于拉到"核数×2"，在大机器上拉到 16 就是 16。
 */
export const MIN_SCAN_WORKERS = 1
export const MAX_SCAN_WORKERS = 16
/** `scanWorkers = 0` = 用推荐值（本机逻辑核数）。滑块上它显示成「推荐」。 */
export const SCAN_WORKERS_AUTO = 0

/**
 * `Object.freeze` 不是装饰：这个对象会被直接返回给 IPC 的另一侧，也会被 `sanitizeSettings`
 * 当兜底值回出去。没有冻住的话，任何一个拿到它的模块改一笔，全仓的默认值就跟着变了，
 * 而改动点离定义点有三层目录。
 *
 * ⚠️ 外观那四格的默认值**必须与 `global.css` / `glass/tokens.css` 里的现值逐字相同**：
 * `blur 30` = `--glass-blur-page`、`saturate 1.5` = `--glass-saturate`、
 * `brightness 1.05` = `--glass-brightness`、`opacity 0.36` = `--glass-fill-quiet` 的 alpha。
 * 不同的话，用户第一次打开设置页、什么都还没碰，界面就会跳到另一个样子 ——
 * 那条判据在 `settings-glass-bounds.test.ts` 里（它读 CSS 文件取值，不是再抄一份常数）。
 *
 * 2026-10-29 加了 `scanWorkers` / `locale` 两格。默认值都是"与 1.0.0 逐字相同"的那一档：
 * 不碰设置页的用户，扫描并发度与界面语言都必须一个像素/一条线程都不变。
 */
export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  dupMinSizeMb: 4,
  glassBlurPx: 30,
  glassSaturate: 1.5,
  glassBrightness: 1.05,
  glassOpacity: 0.36,
  wallpaper: DEFAULT_WALLPAPER,
  scanWorkers: SCAN_WORKERS_AUTO,
  locale: DEFAULT_LOCALE
})

/** 服务端那道清洗的上下界（`settings.rs` 的 `MIN_DUP_MIN_SIZE_MB` / `MAX_DUP_MIN_SIZE_MB`）。
 *  这里抄一份是为了让 `sanitizeSettings` 的**渲染端**那一半与主进程同一把尺子；
 *  单测 `the_two_sanitizers_agree_on_the_same_inputs` 钉着两者对同一批输入给同一个答案。 */
export const MIN_DUP_MIN_SIZE_MB = 1
export const MAX_DUP_MIN_SIZE_MB = 1024

/** 夹紧 + 取整的公共内核：非有限数回 `null`（调用方决定是回落默认值还是别的）。 */
function clampNumber(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.min(max, Math.max(min, raw))
}

/**
 * 壁纸引用收进两种合法形状之一，认不出就回默认。
 *
 * `file:` 那一路只放行**裸文件名**：不含目录分隔符、不是 `.` / `..`、不以点开头
 * （隐藏文件不是用户选出来的东西）。这条与服务端 `settings.rs` 的
 * `sanitize_wallpaper` 逐条同一份 —— 两处口径不一致时，渲染端放行的东西服务端会丢，
 * 而界面上表现成"选了图但没生效"。
 */
export function sanitizeWallpaper(raw: unknown): WallpaperRef {
  if (typeof raw !== 'string') return DEFAULT_WALLPAPER
  const s = raw.trim()
  if ((BUILTIN_WALLPAPERS as readonly string[]).includes(s.replace(/^builtin:/, '')) && s.startsWith('builtin:')) {
    return s
  }
  if (s.startsWith('file:')) {
    const name = s.slice('file:'.length)
    if (name === '' || name === '.' || name === '..') return DEFAULT_WALLPAPER
    if (name.startsWith('.') || name.includes('..')) return DEFAULT_WALLPAPER
    if (/[\\/:]/.test(name)) return DEFAULT_WALLPAPER
    // 只放行这几个图片扩展（服务端复制那一步也只认它们）
    if (!/\.(png|jpe?g|webp|bmp)$/i.test(name)) return DEFAULT_WALLPAPER
    return s
  }
  return DEFAULT_WALLPAPER
}

/**
 * 把**任何**来源的一份设置收进合法区间：磁盘上那个 json、渲染端跨 IPC 传来的半个 patch、
 * 以及将来某个还没写出来的调用方给的 `unknown`。
 *
 * 口径与服务端 `settings::sanitize_settings` 逐条同一份（另一端也有一份同样的实现，
 * 两侧对同一批输入必须给同一个答案）：
 *  - 结构不对（不是对象 / 没有这个键 / 键不是数字 / 非有限数）→ **该键**回默认值；
 *    注意是逐键回落，不是一个坏键把整份打回默认 —— 后者会让"我调了亮度"与
 *    "我的模糊半径设置丢了"变成同一件事，用户看不出是哪一格出问题。
 *  - 是有限数但出了界 → **夹住**，不回落默认值；
 *  - 那一格只有整数档的（`dupMinSizeMb`）顺手取整；外观那几格保留小数
 *    （`saturate 1.25` 与 `1` 是看得出来的两档）。
 *
 * 已删字段（`autoCleanEnabled`）**不进结果**：不认识的键不会被带出来。
 */
export function sanitizeSettings(raw: unknown): AppSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SETTINGS
  const o = raw as Partial<AppSettings>

  const dupDeclared = clampNumber(o.dupMinSizeMb, MIN_DUP_MIN_SIZE_MB, MAX_DUP_MIN_SIZE_MB)
  const blur = clampNumber(o.glassBlurPx, MIN_GLASS_BLUR_PX, MAX_GLASS_BLUR_PX)
  const saturate = clampNumber(o.glassSaturate, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE)
  const brightness = clampNumber(o.glassBrightness, MIN_GLASS_BRIGHTNESS, MAX_GLASS_BRIGHTNESS)
  const opacity = clampNumber(o.glassOpacity, MIN_GLASS_OPACITY, MAX_GLASS_OPACITY)

  return {
    dupMinSizeMb: dupDeclared === null ? DEFAULT_SETTINGS.dupMinSizeMb : Math.round(dupDeclared),
    glassBlurPx: blur === null ? DEFAULT_SETTINGS.glassBlurPx : blur,
    glassSaturate: saturate === null ? DEFAULT_SETTINGS.glassSaturate : saturate,
    glassBrightness: brightness === null ? DEFAULT_SETTINGS.glassBrightness : brightness,
    glassOpacity: opacity === null ? DEFAULT_SETTINGS.glassOpacity : opacity,
    wallpaper: sanitizeWallpaper(o.wallpaper),
    // 并行度（2026-10-29）：**夹紧而不是回落默认**，与外观那几格同一条口径。
    // 0 / 负数 / 非数字 → 用推荐值（0 本来就是"自动"的哨兵）。
    // 超过滑块上界的**夹到滑块上界**：用户写了 99 要的是"尽量多"，不是"偷偷变回推荐值"。
    scanWorkers: sanitizeScanWorkers(o.scanWorkers),
    locale: sanitizeLocale(o.locale)
  }
}

/**
 * 设置 → CSS 变量表。**渲染端唯一的"设置怎么变成样式"入口**。
 *
 * 为什么收成一个纯函数：它是"控件背后有没有真读者"这条纪律的检验点 ——
 * 一个设置键如果没出现在这里，它就没有任何读者，那一格控件就是假的。
 * `tests/unit/settings-glass-bounds.test.ts` 按 `AppSettings` 的键逐个点名，
 * 少一个键就红。
 *
 * `--glass-fill-page` 那一格的**色相与三档填充的关系**由 `global.css` 决定，这里只改 alpha：
 * 原值是 `rgba(34, 86, 186, 0.22)`，颜色不动、只换最后那个数。
 */
export function settingsToCssVars(s: AppSettings): Record<string, string> {
  return {
    '--glass-blur-page': `${s.glassBlurPx}px`,
    '--glass-saturate': String(s.glassSaturate),
    '--glass-brightness': String(s.glassBrightness),
    /**
     * 设置页那张卡自己的填充档（2026-10-27）。
     *
     * 色相取 `--glass-fill-quiet` 的 `rgb(10, 28, 70)` —— 也就是开发环境页那副材质，
     * 只换 alpha。人类伙伴要求「设置页面的框色彩改成和这个一样」，而那个"一样"
     * 指的是**观感**（深、实、蓝黑），不是"共用同一个变量"：
     * 共用会让滑块把地图侧栏、日志卡一起带走。
     */
    '--settings-card-fill': `rgba(10, 28, 70, ${s.glassOpacity})`
  }
}

/**
 * 并行度那一格：把任何输入收进 `0..=MAX_SCAN_WORKERS`（2026-10-29）。
 *
 * 口径与服务端 `sanitize_scan_workers` 逐条同一份，**但两处的上界不同**：
 * 这里夹到滑块能拉到的 `MAX_SCAN_WORKERS`（16），服务端夹到硬顶 64。
 * 这不是漂移 —— 服务端要收下"手改文件写了 40"这种值（那是用户的权利，
 * 而且机器可能真有那么多核），而滑块列不出 40 这一档。
 * 两处**下界与哨兵口径**必须一致：`0` / 负数 / 非数字 → 0（用推荐值）。
 */
export function sanitizeScanWorkers(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SCAN_WORKERS_AUTO
  if (raw <= 0) return SCAN_WORKERS_AUTO
  return Math.min(MAX_SCAN_WORKERS, Math.round(raw))
}
