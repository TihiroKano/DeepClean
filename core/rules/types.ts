/**
 * §15 Cleaner Rule Engine —— 规则的**数据形状**。
 *
 * 项目书原话：「规则不是直接写死删除路径，而是定义规则」。
 * 所以本文件里没有任何行为：一条规则就是九个字段的可序列化数据。
 * 后果是结构性的——规则**不可能**自带删除能力（没有函数字段，`ruleShapeProblems` 会把函数字段当非法字段拒掉），
 * 而 §17 的预览/§18 的任务队列将来只能读这些字段来决定做什么。
 *
 * 纯逻辑：禁止 import electron / react / DOM / node（§29；`scripts/*.mjs` 要能直接 vite-node 跑）。
 */
import type { Risk } from '../../shared/classify'

/** §15 的 category 维度：首批就是 §26 Phase 4 开头那六类，dev-cache 给下一批预留了位子。
 *  `duplicate` 不属于任何缓存/临时类 —— 它是 §20 重复文件检测产出的建议项，口径完全不同
 *  （内容逐字节相同才有组，删的是"多余的副本"而不是"可重下的东西"）。
 *  M5-P1 T1 追加 `app-transient`、`installer-leftover`（plan §3；与 Rust `RuleCategory` 同序同串）。
 *  M5-P2 P2-T4 追加 `orphan-data`（plan §2.6 第 22 条；与 Rust `RuleCategory::OrphanData` 同序同串）。
 *  注意 `app-transient` 同时装缓存、日志、转储三种东西，是显示层的归类不是判据的统一（plan §9.4）。
 *
 *  ⚠️ 为什么 `orphan-data` 是新的一格而**不是**并进 `app-transient`：`app-transient` 那个名字承诺的
 *  是一件具体的事 —— **运行期**产物，删了能被产品自己的动作重新生成（缓存会重下、包会重装、
 *  轮转日志没人看）。`orphan-app-data` 的地盘是某个应用的**设置与数据本体**（登录态、配置、存档、
 *  本地数据库），而那个应用已经被判定不在了 —— **没有任何产品动作会把它再生成一遍**。
 *  给它挂 `app-transient` 与给它 `recoverable: true` 是同一个方向的撒谎：两个词都在替用户宣布
 *  "失去了也不要紧"。类别名是要上线的线格式、也是预览分组与 `rejectedRules` 理由串的判据，
 *  所以"宁可多一类、不可混一类"在这里不是洁癖：别让一个说谎的分组名替一条 🟠 规则背书。 */
export const RULE_CATEGORIES = [
  'temp',
  'browser-cache',
  'thumbnail-cache',
  'shader-cache',
  'error-reporting',
  'recycle-bin',
  'dev-cache',
  'duplicate',
  'app-transient',
  'installer-leftover',
  'orphan-data'
] as const
export type RuleCategory = (typeof RULE_CATEGORIES)[number]

/**
 * 清理策略也是数据：它描述「将来执行时按什么口径收」，
 * 本轮（Task 16）没有任何代码消费它去删东西 —— 那是 §17/§18 的事。
 */
export const RULE_CLEAN_STRATEGIES = [
  'delete-all',
  'delete-older-than',
  'empty-folder',
  'manual-only'
] as const
export type CleanStrategy = (typeof RULE_CLEAN_STRATEGIES)[number]

/** §16 四级；直接复用 shared/classify 的 Risk，避免两套风险口径（Treemap 配色与规则引擎必须同源）。 */
export const RULE_RISK_LEVELS: readonly Risk[] = ['safe', 'caution', 'high', 'forbidden']

/**
 * 采集围栏（M5-P1 T1，spec §2.1）：`leafDirs` / `leafFiles` 这类任意深度 basename 判据**必须**配它 ——
 * 路径在这里不是判据，只是「在哪些根里允许找 / 哪些根绝不进去」的边界。
 * 与 Rust `crates/rules/src/types.rs` 的 `RuleScopeFence` 逐字段同。
 */
export interface RuleScopeFence {
  /** `%VAR%` 模板，解析后必须绝对、非盘符根、无通配（采集入口要落到具体目录） */
  allowRoots: readonly string[]
  /** 必须 ⊇ FORBIDDEN_PATH_PATTERNS ∪ `FENCE_MINIMUM_DENY_PATTERNS`（§4.2 的两条 Program Files 走同一条解析口径） */
  denyRoots: readonly string[]
}

export interface RuleScanner {
  /**
   * 文件名 glob（大小写不敏感，`*` 任意串、`?` 单字符），对**直属文件与递归到的每个文件**做整名匹配。
   * 空数组 = 该地盘下的所有文件。
   */
  filePatterns: readonly string[]
  /** 只算 mtimeMs 早于 `nowMs - olderThanDays*86400000` 的文件；null = 不按时间过滤。时间基准由评估时注入，规则自己不读时钟。 */
  olderThanDays: number | null
  /** 是否连子目录一起收。宽目录（如 Explorer 下的缩略图库）必须 false，免得顺手扫走邻居。 */
  recursive: boolean
  /**
   * M5-P1（spec §2.1）：任意深度，目录 basename 命中即把该目录当作采集根。缺省 = 不用该能力。
   * 与 `leafFiles` **互斥**（计划 §10 裁定 1）：两者同时给 → `ambiguous-leaf-mode` 整条拒。
   * 出现本字段就必须同时出现 `scopeFence`，否则 `inadequate-fence` 整条拒（spec §2.3）。
   */
  leafDirs?: readonly string[]
  /**
   * M5-P1：任意深度，文件 basename 命中即计 —— 与 `filePatterns` 共用 `nameMatches` 那一把 glob，
   * 不新增第二把（plan Global Constraints）。互斥判据同 `leafDirs`。
   */
  leafFiles?: readonly string[]
  /** M5-P1：出现 `leaf*` 判据时**必需**的采集围栏；其根不过 `broad-container`/`pattern-not-leaf` 地盘判据（plan §4.3 的刻意不对称）。 */
  scopeFence?: RuleScopeFence
}

/**
 * 机器事实三态（spec §4.2，M5-P1 T2）。与 Rust `crates/rules/src/types.rs` 的 `AppFact` 同串。
 *
 * **本棒只有注入面，没有探针**：这张表由调用方给，引擎只读表，一次都不碰注册表 / 进程表 / Appx。
 * M5-P2 的 `crates/appfacts` 才是产这张表的地方（四路证据 + `Unknown` 带 why）。
 * 判据方向定死：`Absent` 是唯一能提议删除的状态；`Unknown` 与**表里没有这个键**同向 —— 都是不知道，
 * 都不知道就不删（这里与 `detectorStatus` 那条"缺 id 当没装"反向，因为这一侧漏判的代价是多删）。
 */
export type AppFact = 'present' | 'absent' | 'unknown'

/** §15 那棵树：id / name / category / description / paths / scanner / riskLevel / cleanStrategy / recoverable。 */
export interface Rule {
  id: string
  name: string
  category: RuleCategory
  description: string
  /**
   * 声明式路径模板。**必须以 `%VAR%` 开头**（或盘符绝对路径），`%VAR%` 由注入的 `RuleEnv` 解析
   * —— 引擎永远不从真机 `process.env` 读（约束 7：单测要能在合成树上跑）。
   * 段间 `*` 匹配**恰好一层**目录名（`User Data\*\Cache`），且**不许以通配收尾**（§28 原则四：必须落到叶子上）。
   */
  paths: readonly string[]
  scanner: RuleScanner
  /** §16：所有清理项目必须具有风险等级。🔴 的项目照常识别容量，但绝不进「可回收」合计。 */
  riskLevel: Risk
  cleanStrategy: CleanStrategy
  /**
   * 删除后用户是否会**永久失去数据**：
   * 缓存类（可再生）→ true；临时文件/错误报告（删了就没了）→ false。
   * 回收站特殊：还没清空前本来就还能还原 → true，但它同时是 🔴（只能手动处理）。
   */
  recoverable: boolean
  /**
   * V0.7 §3.2：把关本规则的探测器 id（= `core/rules/detectors.ts` 里 `IDevEnvDetector.id`）。
   *
   * 为什么是**字符串引用**而不是把探测逻辑挂进来：规则是数据（§15），带函数的字段会被形状闸拒掉；
   * 而且判据长在探测器那一层，规则只是声明"我需要它"。
   * 生效条件是 `evaluateRules({ detectorStatus })` 收到该 id 且结论为 false —— 届时本规则
   * 0 finding、0 字节，但每条地盘路径都会以 `not-installed` 逐条进 `exclusions[]`。
   * 没写这个字段的规则行为与今天逐字节一致（这也是本次改动唯一的回归轴）。
   */
  requiresDetector?: string
  /**
   * §3.5：本规则的字节**不进「一键全选」的默认勾选**（AI 模型文件本体那一类）。
   *
   * 为什么放在规则声明而不是界面的某处 if：计划书要的是「结构性」的保证 —— 声明住在数据里，
   * 派生是个纯函数（`registry.ts` 的 `defaultUnselectableRuleIds()`），预览只做搬运，
   * 于是"改界面把它改回来"这条路从源头就不存在。
   * 它**不改变账目**：这一项照样上报占用、照样能被用户逐条勾上，所以也不进确认 digest。
   */
  excludedFromDefaultSelection?: boolean
  /**
   * M5-P1（spec §4.2）：本规则的地盘只有在注入的机器事实把候选目录判成 `Absent` 时才许提议。
   *
   * 只有 `=== true` 算声明（与 `excludedFromDefaultSelection` 只认真布尔同一个方向）——
   * 脏值不许顺手给一条规则装上"要事实"的闸，也不许因为漏判让一条残留规则裸奔。
   * **本棒不实现探针**，注入表恒为空 ⇒ 带它的规则一条都不提议（fail-safe 方向是少删）。
   * 与 Rust `Rule::requires_absent_app_fact` 同字段同线格式。
   */
  requiresAbsentAppFact?: boolean
}

/**
 * 环境路径变量表（合成或来自主进程注入）。键用 Windows 环境变量名的大写形式。
 * 值必须是**绝对路径**；缺失即评估时记 `unresolved-env` 排除，不猜、不回落真机。
 */
export type RuleEnv = Readonly<Record<string, string>>

/** 只能出现在 `Rule` 上的字段名（多余字段 = 有人往数据里塞行为，直接拒）。 */
export const RULE_FIELDS = [
  'id',
  'name',
  'category',
  'description',
  'paths',
  'scanner',
  'riskLevel',
  'cleanStrategy',
  'recoverable'
] as const

/**
 * 可选字段白名单 —— 必须是**第二份名单**，不能并进 `RULE_FIELDS`。
 *
 * 守的坑：`ruleShapeProblems` 里那两个循环判据相反。「缺字段」循环遍历这份名单就会要求
 * 15 条内置规则每条都写 `requiresDetector`（没写的全被判 invalid-shape）；
 * 「非法字段」名单不含它，则带它的规则同样被判 invalid-shape → `validateRuleSet` 整条拒 →
 * 它的地盘从 `reclaimableBytes` 里**静默消失**，不报错、只是数字变小。
 * 所以：「缺字段」只查必填的九个，「非法字段」查 `RULE_FIELDS ∪ RULE_OPTIONAL_FIELDS`。
 */
export const RULE_OPTIONAL_FIELDS = [
  'requiresDetector',
  'excludedFromDefaultSelection',
  'requiresAbsentAppFact'
] as const
export type RuleOptionalField = (typeof RULE_OPTIONAL_FIELDS)[number]

/* ------------------------------------------------------------------ *
 * §28 原则四的数据侧：哪些名字**不能**当清理范围
 * ------------------------------------------------------------------ */

/**
 * 「裸环境变量 = 容器」名单：`%LOCALAPPDATA%` 这种写法本身就是一个宽容器，
 * 项目书给的对照例子正是「`C:\Users\x\AppData\Local\Temp` 可以，`AppData` 不行」。
 * `%TEMP%` 不在其列 —— 它本身就已经是一个叶子级目录。
 */
export const CONTAINER_VARS: ReadonlySet<string> = new Set([
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'HOMEDRIVE',
  'HOMEPATH'
])

/** 作为路径**最后一段**出现时视为容器的名字（`...\AppData\Local` 的 `Local`、`...\Users` 的 `Users`）。 */
export const BROAD_LEAF_NAMES: ReadonlySet<string> = new Set([
  'appdata',
  'local',
  'roaming',
  'locallow',
  'users',
  'windows',
  'winnt',
  'programdata',
  'program files',
  'program files (x86)',
  'onedrive'
])

/**
 * **第三方代码树**的名字：作为 leaf 下降时**子目录**的那一段出现 → 整棵子树不进采集。
 *
 * 与 Rust `types.rs::PACKAGE_TREE_NAMES` 逐条相同、**同序**
 * （`engine.rs::the_package_tree_list_is_identical_on_both_sides` 钉着两侧同串）。
 *
 * 为什么是「不进入」而不是「进入后过滤」：这一族的判据是 basename，而 basename 匹配按 Windows
 * 语义必须大小写不敏感 —— 于是采集名单里一个名字能命中同名的**源码目录**
 * （真机实测：`…\node_modules\undici\lib\cache`、`…\hono\dist\middleware\cache`）。
 * 删掉的不是缓存，是已装应用的代码。M5-P1 的形状判据防住「名字不像缓存」，
 * 防不住「同名但语义是代码」—— 那是这一族判据的固有失效面，所以围栏写在**枚举之前**：
 * 包树目录不被打开，其中任何东西都不可能被认领（plan §0.2「拒整条 > 过滤命中」同一个形状）。
 *
 * 匹配口径复用 `BROAD_LEAF_NAMES` 那一条（basename 小写后**整名相等**，与 `engine.ts`
 * `validateRuleSet` 里 `BROAD_LEAF_NAMES.has(last.toLowerCase())` 同一法）——
 * 不新增第二把 glob（plan Global Constraints）。整名相等也正好排掉 `dist-types` 这类近失形状。
 *
 * 这一张表**只作用于 leaf 下降**（`engine.ts::walkLeaf` / Rust `engine.rs::walk_leaf`）。
 * 模板地盘（`dev-tool-cache`、`user-downloads-installers` 与既有 15 条）走 `collectTerritory`，
 * 一个字都不受影响。
 *
 * 裁定 2 未定，见 `docs/superpowers/plans/2026-10-13-deepclean-tauri-m5-p2.md` §5 末节。
 */
export const PACKAGE_TREE_NAMES: readonly string[] = [
  'node_modules',
  'site-packages',
  'dist',
  'lib',
  'src',
  'build',
  '.git',
  'target',
  'venv',
  '.venv'
]

/**
 * **§6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的 guard**（cleanup-rules.md v2.0）：
 * 「名字叫 cache 也不是缓存」。按**路径片段 + basename** 判，不是按整棵禁止根判。
 *
 * 为什么不放进 `FORBIDDEN_PATH_PATTERNS`：`%LOCALAPPDATA%\Microsoft` 整棵禁掉会顺手关掉两条
 * **已上线**的规则（`thumbnail-cache` 住的 `…\Microsoft\Windows\Explorer`、`error-reporting`
 * 住的 `…\Microsoft\Windows\WER\*`）—— 那是拿真能回收的字节去换一个 guard。
 * 文档对这两类的判据原文就是 guard（「名字叫 cache 也不是缓存」），所以它落在判据层。
 *
 * 两条同时成立才算命中：basename 命中 `USER_DATA_LEAF_NAMES` ∧ 路径里**含**下表某一段。
 * 命中之后**不枚举、不认领**，并记一条 `user-data-leaf` 排除点名到那个具体目录。
 * 与 Rust `types.rs::USER_DATA_LEAF_RELATIVE` / `USER_DATA_LEAF_NAMES` 逐条相同。
 */
export const USER_DATA_LEAF_RELATIVE: readonly string[] = ['Microsoft\\', 'Windows Defender\\', 'Windows\\', 'SystemApps\\']

/** 命中 `USER_DATA_LEAF_RELATIVE` 之后**还要**这些 basename 之一（两者同时成立）。
 * 它们既是 Chromium / Electron / UWP 三方共用的约定缓存名，也常被用户数据借用
 * （`…<App>\LocalCache\Roaming\…` 与 `…<App>\LocalCache\Local\…\Cache` 长同一个前缀）。 */
export const USER_DATA_LEAF_NAMES: readonly string[] = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'CachedData',
  'blob_storage',
  'CacheStorage',
  'component_crx_cache'
]

/**
 * `scopeFence.denyRoots` 除 `FORBIDDEN_PATH_PATTERNS`（registry 侧）全集外**还必须**覆盖的四条根
 * （spec §2.3 + plan §4.2 裁定：32 位那条不新增带括号变量键 —— `ProgramFiles(x86)` 作 `%VAR%` 名要过
 * 分段器、括号没被测过，改走 `%SYSTEMDRIVE%\Program Files (x86)\*`；括号不在形状判据的禁用字符集里，
 * 由 `rules-engine.test.ts::a_parenthesised_literal_deny_root_passes_shape_check` 钉住）。
 * 第四条是 T6 真机对账加进来的：`installer-artifacts` 会把 Defender 的病毒特征库当安装包收走，
 * 那是安全状态不是缓存。放进**地板**而不是某条规则的私事 —— 漏了就整条拒，不用等下次真机再发现。
 * **第五条（本轮）** `%LOCALAPPDATA%\Programs\*`：cleanup-rules.md §6 R-DENY-INSTALLDIR ——
 * 用户级安装根里是装好的应用本体（真机实测 `…\Programs\Microsoft VS Code\Resources\app\Cache`
 * 被 `app-cache-data` 收走过 9000 字节）。原先它只活在测试夹具的 `leaf_fence()` 里。
 * 与 Rust `types.rs::FENCE_MINIMUM_DENY_PATTERNS` 逐条相同。
 */
export const FENCE_MINIMUM_DENY_PATTERNS: readonly string[] = [
  '%WINDIR%\\*',
  '%PROGRAMFILES%\\*',
  '%SYSTEMDRIVE%\\Program Files (x86)\\*',
  '%PROGRAMDATA%\\Microsoft\\Windows Defender\\*',
  '%LOCALAPPDATA%\\Programs\\*'
]

/* ------------------------------------------------------------------ *
 * 评估产出（报告）的形状：命中什么 + **排除了什么、为什么**
 * ------------------------------------------------------------------ */

export type ExclusionReason =
  /** 落在 §16 🔴 禁止路径里（整条分支不可达） */
  | 'forbidden-root'
  /** 落在「只上报不可删」根里（`REPORT_ONLY_ROOT_PATTERNS`，回收站那一类）：照常枚举、照常报字节，但不许被这条规则认领 */
  | 'report-only-root'
  /** 规则自己的禁止根解析不出来 → 宁可不给结论 */
  | 'forbidden-root-unresolved'
  /** 被 `protectedByAttrs()` 证明带 SYSTEM 属性（§28 原则二） */
  | 'protected-attrs'
  /** 解析出的地盘是别的规则/禁止路径的祖先（§28 原则四） */
  | 'ancestor-of-protected'
  /** 裸容器变量或宽容器收尾，不构成叶子路径 */
  | 'broad-container'
  /** 以通配收尾，落不到具体目录 */
  | 'pattern-not-leaf'
  /** 注入的 env 里没有这个变量 */
  | 'unresolved-env'
  /** 这次扫描根本没覆盖到该路径（没扫 = 不知道，不是没有） */
  | 'not-scanned'
  /** 已被先声明的规则认领，不双计 */
  | 'claimed-by-other-rule'
  /** §15 九字段形状不合格 */
  | 'invalid-shape'
  /** 所在规则被整体拒绝，本条路径连带出局 */
  | 'rule-rejected'
  /**
   * V0.7 §3.2：注入的探测表判定该规则依赖的工具未安装（`Rule.requiresDetector` 那个 id 为 false）。
   *
   * 为什么必须有它而不是让规则直接不产出 finding：那样这块地盘就从合计里**静默消失**，
   * 用户读到的是"这机器上没有 Gradle 缓存"，而真相是"探测说没装"—— 与误报同样坏。
   * 与 `not-scanned` 的分工：那条说"这次没扫到"，这条说"工具不在"。
   */
  | 'not-installed'
  /**
   * M5-P1 T1（spec §2.3）：`paths` 的条目不是既有意义上的叶子目录，而规则**没有**同时带
   * `leaf*` 判据 + `scopeFence` —— 容器入口缺形状判据，整条拒（拒整条 > 过滤命中，plan §0.2）。
   * 与 Rust `validate.rs::ProblemReason::ContainerWithoutPredicate` 同 kebab 串。
   */
  | 'container-without-predicate'
  /**
   * M5-P1 T1：`leaf*` 采集根缺 `scopeFence`，或围栏根形状不合法 / `denyRoots` 覆盖不足
   * （必须 ⊇ 禁止根全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`）。围栏是这块能力的全部风险所在（plan §0.1）。
   * 与 Rust `ProblemReason::InadequateFence` 同 kebab 串。
   */
  | 'inadequate-fence'
  /**
   * M5-P1 T1（计划 §10 裁定 1）：`leafDirs` 与 `leafFiles` 同时给出 = 两种采集根语义混用，
   * 产出无法解释的命中 → 整条拒。与 Rust `ProblemReason::AmbiguousLeafMode` 同 kebab 串。
   */
  | 'ambiguous-leaf-mode'
  /**
   * M5-P1 T2（spec §2.3）：目录落在 `scopeFence` 之外 —— 命中 `denyRoots`，或不在任何
   * `allowRoots` 之内。**与 `forbidden-root` 是同一个形状**：在 `openDir()` 那一层就被拒，
   * 连"被列举"都不发生，不是"列举完再把命中滤掉"（plan §0.2：后者让规则看着在工作、数字偏小）。
   * 记录必须点名到那个**具体目录**。与 Rust `ExclusionReason::OutsideFence` 同 kebab 串。
   */
  | 'outside-fence'
  /**
   * M5-P2 P2-T5（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 裁定 1）：leaf 下降时撞到
   * **第三方代码树**（`PACKAGE_TREE_NAMES` 的整名命中）→ 整棵子树不进采集面。
   *
   * 与 `outside-fence` **同一个形状**：目录在 `openDir()` 之前就被跳过，连"被列举"都不发生 ——
   * 不是"枚举完再把里面的命中滤掉"（plan §0.2：后者让规则看着在工作、数字偏小）。
   * 记录点名到那个**具体目录**（`…\node_modules`，不是它下面某条源码路径）。
   *
   * 为什么不能靠 `scopeFence` 覆盖：围栏点名的是**根**（`%PROGRAMFILES%` 那一类），
   * 而包树长在授权根**里面**任意深度（`%LOCALAPPDATA%\Programs\nodejs\node_modules\…`）——
   * 那不是"越栏"，是"栏内有一棵别人的代码树"。
   * 与 Rust `ExclusionReason::PackageTree` 同 kebab 串。
   */
  | 'package-tree'
  /**
   * M5-P1 T2（spec §4.2）/ **P2-T3 收窄**：注入的机器事实表把这一格**自己**判成了 `unknown` ——
   * 探针跑了、但两半里有一条取不到证据（权限拒、枚举断、覆盖面不够），带着 `why` 弃权。
   *
   * ⚠️ 它现在**只**表达这一件事。P2-T1 那半边把 present / unknown / 缺键三档合并成这一条，
   * 于是「探针看了但说不清」与「表里压根没这一格」在报告里长得一样 —— 而这两件事下一步要做的
   * 不同（前者补通道，后者把候选交给探针）。与 Rust `ExclusionReason::AppFactUnknown` 同 kebab 串。
   */
  | 'app-fact-unknown'
  /**
   * M5-P2 P2-T3（plan §2.4）：注入的机器事实表说这个候选目录**本体在场**（`present`）——
   * 卸载表 / MSIX 包目录 / 安装根 / 进程镜像任一路命中。三条弃权理由里唯一一条正面证据，
   * 必须与"没能判出来"分得开：这一档的真相是应用还在这台机器上跑着。
   * 与 Rust `ExclusionReason::AppFactPresent` 同 kebab 串。
   */
  | 'app-fact-present'
  /**
   * M5-P2 P2-T3（plan §2.4）：表里**根本没有这个键** —— 探针没被交代看过这个目录。
   * 既不是「查过、查无」也不是「查了查不动」，而是「什么都没发生过」。spec §4.2 把它与
   * `app-fact-unknown` 定成同向（都不许提议），但措辞必须分开，否则「把候选交给探针」
   * 这件事永远不会有出现在报告里的一天。
   * 与 Rust `ExclusionReason::AppFactKeyMissing` 同 kebab 串。
   */
  | 'app-fact-key-missing'
  /**
   * **§6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的 guard**（cleanup-rules.md v2.0）：
   * 这个目录的名字长得像缓存，但它长在**用户数据容器**里（`…\Microsoft\…`、`…\Packages\…`
   * 每应用状态、`SystemApps\…`）—— 删掉的是登录态 / 配置 / 会话，不是渲染层缓存。
   *
   * 与 `outside-fence` / `package-tree` 同一个形状：目录在 `openDir()` 之前就被拒，
   * 连"被列举"都不发生，记录点名到那个具体目录。判据表见 `USER_DATA_LEAF_RELATIVE`。
   * 与 Rust `ExclusionReason::UserDataLeaf` 同 kebab 串。
   */
  | 'user-data-leaf'

/** 一条「 excluded 」记录：**必须点名到具体路径**，不许只报一个总数。 */
export interface Exclusion {
  /** 与被拒绝的规则相关时填其 id；报告级（如禁止根自己解析失败）填 null */
  ruleId: string | null
  path: string
  reason: ExclusionReason
  detail: string
}

/** 静态校验（`validateRuleSet`）产出的问题：形状与结构一致，复用 Exclusion 的字段。 */
export type RuleProblem = Exclusion

export interface RejectedRule {
  ruleId: string
  name: string
  problems: RuleProblem[]
}

export interface MatchedPath {
  path: string
  size: number
}

export interface RuleFinding {
  ruleId: string
  name: string
  category: RuleCategory
  riskLevel: Risk
  cleanStrategy: CleanStrategy
  recoverable: boolean
  /** 通配展开后真正落到树上的叶子目录（升序）。空数组 = 这条规则这次什么都没找到。 */
  matchedRoots: string[]
  /** 采样路径（至多 maxListedPaths 条，按路径升序），只用于展示；口径见 fileCount/totalBytes。 */
  samplePaths: MatchedPath[]
  sampleTruncated: boolean
  /** 全量口径的文件条数与字节和 —— 与采样无关，永远是准的。 */
  fileCount: number
  totalBytes: number
  /**
   * 仅当评估时用 `EvaluateOptions.collectPathsFor` 点名本规则才出现：
   * 本 finding **实际认领的全部文件**（不是采样），`length === fileCount`、字节和 `=== totalBytes`。
   * §18 的执行器只能吃具体路径，而重走磁盘补清单会违反 §28 原则一 —— 所以由引擎把它已经算过的交出去。
   */
  allPaths?: MatchedPath[]
}

/**
 * §3.6 未完 #2 / #4b 的地盘底账。形状住在 `shared/types.ts`（线格式只有一个事实源，
 * 报告侧与 `PreviewModel` 侧必须同形），这里只沿用名字。
 */
import type { TerritoryFact } from '../../shared/types'

export type { TerritoryFact }

export interface RuleReport {
  /** 被评估的规则（= 通过静态校验的那些），顺序与传入顺序一致，包括 0 命中的。 */
  findings: RuleFinding[]
  /** 所有被排除的路径 + 原因。约束 2 要求的「显式清单」就是这里。 */
  exclusions: Exclusion[]
  /**
   * §3.6：声明了 `requiresDetector` 的那几条规则的地盘底账，按 ruleId 升序、`present` 按路径升序。
   * 见 `TerritoryFact` 的说明 —— 只报关系，不改账。没声明的规则一条都不进。
   */
  territories: TerritoryFact[]
  rejectedRules: RejectedRule[]
  /** 本次生效的禁止根（已按 env 解析成绝对路径，升序）。 */
  forbiddenRoots: string[]
  /**
   * 本次生效的「只上报不可删」根（已解析、升序）。
   * 与 forbiddenRoots 的分工：这里的目录**被枚举过**（所以回收站的字节是真的），
   * 但没有任何规则能认领它 —— 下游（预览/执行器）必须拿这张表再判一次，不许只看 riskLevel 配色。
   */
  reportOnlyRoots: string[]
  /**
   * true = 禁止根没能全部落地（env 缺变量）→ 整份报告不出结论。
   * 失去 🔴 保护还照旧说「这些可以清」是最不能接受的一类错误。
   */
  safetyBlocked: boolean
  bytesByRisk: Record<Risk, number>
  /** 🟢🟡🟠 三级之和 —— 🔴 永不计入（§16：禁止通过普通清理按钮直接删除）。 */
  reclaimableBytes: number
  /**
   * 仅在 `EvaluateOptions.reportClaims` 为真时挂上：`normalizeKey(文件路径) → 认领它的规则 id`。
   *
   * 这是引擎评估过程中**本来就已经建好**的那张防双计的表（`st.claimed`），交出去只是给个引用，
   * 零额外遍历。存在的理由：§12 的「加入清理列表」允许用户从 Treemap 上点一个具体文件，
   * 而服务端必须能回答"这个文件到底归哪条规则" —— 只许用规则引擎自己的判定，
   * 不许调用方另写一套"路径像不像在某条地盘里"的近似匹配（那会是第三套口径）。
   */
  claimedPaths?: ReadonlyMap<string, string>
}

/* ------------------------------------------------------------------ *
 * 运行时形状校验
 * ------------------------------------------------------------------ */

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `%VAR%` 开头，或 `C:\...` 这类盘符绝对路径；别的写法（相对、`\\server`、含 `..`）一律拒。 */
const PATH_HEAD = /^%[A-Za-z0-9_]+%(\\|$)/
const ABS_DRIVE = /^[A-Za-z]:\\/

/**
 * §15 九字段的运行时把关。返回问题清单（空 = 合规）。
 * 为什么要运行时再查一遍：规则是数据，数据将来从 JSON 读，`as Rule` 一 cast TS 就什么都保证了不了。
 */
export function ruleShapeProblems(rule: unknown): string[] {
  const out: string[] = []
  if (!isPlainObj(rule)) return ['规则必须是对象']
  const r = rule as Record<string, unknown>

  for (const f of RULE_FIELDS) if (!(f in r)) out.push(`缺 ${f} 字段`)
  // 名单取必填 ∪ 可选：只放宽这一侧，上面那个「缺字段」循环仍然只遍历必填九个
  const knownFields: readonly string[] = [...RULE_FIELDS, ...RULE_OPTIONAL_FIELDS]
  for (const f of Object.keys(r)) if (!knownFields.includes(f)) out.push(`非法字段 ${f}`)

  // 可选字段的值也要把关：写错类型的 requiresDetector 会在探测表里永远查不到，
  // 于是悄悄退回「按已装处理」—— 那不是崩溃，是一条永远不出结论的引用，所以在这里就拒。
  if (r.requiresDetector !== undefined && !isStr(r.requiresDetector))
    out.push('requiresDetector 必须是非空字符串')

  // 与 recoverable 同一轴：只有真布尔才算结论。`"1"`/`"yes"` 一旦被接受，
  // "这条不进默认全选"就会随 JSON 的写法漂移，而漂移的方向是**多勾**（用户没打算删的模型文件进了工作单）。
  if (r.excludedFromDefaultSelection !== undefined && typeof r.excludedFromDefaultSelection !== 'boolean')
    out.push('excludedFromDefaultSelection 必须是 boolean')

  // M5-P1 T2（spec §4.2）：同一个轴。这条漏判的后果不是数字变小，是**方向**变了 ——
  // 一个脏值把"要先问机器事实"摘掉，那条卸载残留规则就会在没有证据的情况下提议删除。
  if (r.requiresAbsentAppFact !== undefined && typeof r.requiresAbsentAppFact !== 'boolean')
    out.push('requiresAbsentAppFact 必须是 boolean')

  if (!isStr(r.id)) out.push('id 必须是非空字符串')
  if (!isStr(r.name)) out.push('name 必须是非空字符串')
  if (!isStr(r.description)) out.push('description 必须是非空字符串')
  if (!(RULE_CATEGORIES as readonly string[]).includes(String(r.category)))
    out.push(`category 非法: ${String(r.category)}`)
  if (!(RULE_RISK_LEVELS as readonly string[]).includes(String(r.riskLevel)))
    out.push(`riskLevel 非法: ${String(r.riskLevel)}`)
  if (!(RULE_CLEAN_STRATEGIES as readonly string[]).includes(String(r.cleanStrategy)))
    out.push(`cleanStrategy 非法: ${String(r.cleanStrategy)}`)
  if (typeof r.recoverable !== 'boolean') out.push('recoverable 必须是 boolean')

  if (!Array.isArray(r.paths) || r.paths.length === 0) {
    out.push('paths 不能为空')
  } else {
    for (const [i, p] of r.paths.entries()) {
      if (typeof p !== 'string' || p.length === 0) out.push(`paths[${i}] 不能为空`)
      else if (!PATH_HEAD.test(p) && !ABS_DRIVE.test(p)) out.push(`paths[${i}] 必须以 %VAR% 或盘符绝对路径开头`)
    }
  }

  const sc = r.scanner
  if (!isPlainObj(sc)) {
    out.push('scanner 必须是对象')
    return out
  }
  if (!Array.isArray(sc.filePatterns) || !sc.filePatterns.every(isStr))
    out.push('scanner.filePatterns 必须是字符串数组')
  if (sc.olderThanDays !== null && !(typeof sc.olderThanDays === 'number' && sc.olderThanDays >= 0))
    out.push('scanner.olderThanDays 必须是非负数或 null')
  if (typeof sc.recursive !== 'boolean') out.push('scanner.recursive 必须是 boolean')

  // M5-P1 T1 的三个新字段：缺省合规（既有 15 条都不写）；写了就必须是对形状 ——
  // 脏值一旦放行，T2 的 basename 匹配会静默不中（少删方向），围栏会静默失效（多删方向）。
  // 与 Rust serde 同一判据：`deny_unknown_fields` + `Vec<String>` / `Option<RuleScopeFence>`。
  if (sc.leafDirs !== undefined && !(Array.isArray(sc.leafDirs) && sc.leafDirs.every(isStr)))
    out.push('scanner.leafDirs 必须是字符串数组')
  if (sc.leafFiles !== undefined && !(Array.isArray(sc.leafFiles) && sc.leafFiles.every(isStr)))
    out.push('scanner.leafFiles 必须是字符串数组')
  if (sc.scopeFence !== undefined) {
    if (!isPlainObj(sc.scopeFence)) out.push('scanner.scopeFence 必须是对象')
    else {
      const f = sc.scopeFence as Record<string, unknown>
      for (const k of Object.keys(f))
        if (k !== 'allowRoots' && k !== 'denyRoots') out.push(`非法字段 scanner.scopeFence.${k}`)
      if (!Array.isArray(f.allowRoots) || !f.allowRoots.every(isStr))
        out.push('scanner.scopeFence.allowRoots 必须是字符串数组')
      if (!Array.isArray(f.denyRoots) || !f.denyRoots.every(isStr))
        out.push('scanner.scopeFence.denyRoots 必须是字符串数组')
    }
  }

  return out
}
