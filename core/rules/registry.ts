/**
 * §15 规则登记表。主体是 §26 Phase 4 开头点名的首批六类：
 * Temp / Browser Cache / Thumbnail Cache / Shader Cache / Error Reporting / Recycle Bin，
 * 末尾已补上「然后逐步增加」里的开发环境批次（§16 🟡 / §21：npm、pip、Gradle、VS Code、
 * Maven、pnpm、Yarn、Hugging Face 下载缓存、Android SDK 安装残留）。
 *
 * M5-P1 T3a 起表尾又追加三条**容器入口 + leaf 判据 + 强制围栏**的规则（plan §5.1–§5.3：
 * `app-cache-data`、`app-rotated-logs`、`installer-artifacts`），T3b-i 再追加两条**显式路径模板**
 * 的 `app-transient` 规则（plan §5.4–§5.5：`dev-tool-cache`、`crash-dumps`），T3b-ii 追加
 * plan §5.6 那条 🟠（`user-downloads-installers`），共 21 条；
 * **M5-P2 P2-T4 起 22 条**：表尾再加 `orphan-app-data`（plan §2.6 / spec §3 3.5 + §4.3，表上第一条判据来自机器事实的规则，🟠 + 不进默认勾选 + `recoverable: false`）。
 * **M6（免确认清理档）起 23 条**：表尾再加 `gpu-driver-leftovers`（显卡驱动安装包残留，显式路径模板族，🟢 + `recoverable: false`），`shader-cache` 追加 AMD 两处缓存路径。
 * 后一批与前面十五条的区别不是"多了几条路径"，是判据换了一族：路径在那三条里只是**围栏**
 * （在哪些根里允许找），真正的判据是任意深度的 basename 名单 —— 所以它们**机器无关**（换台设备
 * 照样命中同一批形状），而 §0.1 说的那道风险（无围栏的 `Cache` 判据会伸进 Program Files）
 * 由声明层闸整条拒来兜。T3b-i 那两条则是另一族：模板本身跨设备稳定，靠的是**工具约定**而不是名单。
 *
 * 这一整个文件都是**数据**：没有函数、没有 fs、没有任何"执行"入口（约束 4）。
 * 想再加就是往数组里再塞条目。
 *
 * 路径一律写成 `%VAR%\…` 模板：环境相关目录**不许**在本模块读 `process.env`（约束 7），
 * 由调用方（主进程）注入 `RuleEnv`，单测注入合成机器。
 * 每条都必须落到叶子级目录（§28 原则四：`C:\Users\x\AppData\Local\Temp` 可以，`AppData` 不行），
 * 这条不是口头承诺 —— `validateRuleSet()` 会在评估前把它拒掉。
 *
 * V0.7 §3.2 起，九条「依赖某个工具才存在」的规则各带一个 `requiresDetector`（值是
 * `core/rules/detectors.ts` 里 `DEV_ENV_DETECTORS` 的 id）。这一层**仍然只是数据**：这里挂的是
 * 一个字符串引用，不是探测器对象，本文件既不问机器也不 import detectors.ts（方向是反的 ——
 * 探测器按 id 引用规则，规则按 id 引用探测器，两边都是常量，谁也不 import 谁）。
 * 失败方向要记着：**id 拼错不会报错**，只会让那条规则永远按「已装」评估（引擎对表里查不到的 id
 * 兜"已装"，理由写在 `engine.ts` 的 `absentDetector()` 上）。所以拼错这件事由
 * `tests/unit/rules-detector-registry.test.ts` 逐个 id 对照探测器表来抓，不靠肉眼。
 */
import type { Rule, RuleScopeFence } from './types'

/** 登记表允许用到的环境路径变量（拼错的变量名会被单测抓出来，而不是静默零命中）。
 * M5-P1 T1：7→8 补 `PROGRAMFILES`（plan §4.1）—— 围栏要 deny Program Files，就得能用同一套解析口径
 * **命名**它；`CONTAINER_VARS` 里本来就有它，补齐是收敛不是扩张。与 Rust `types.rs::RULE_ENV_KEYS` 同序同值。 */
export const RULE_ENV_KEYS: readonly string[] = [
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'USERPROFILE'
]

/**
 * §16 🔴 禁止路径。这里是引擎唯一的"绝对不碰"名单，故意只列系统关键组件那几条：
 * 它们**不可达**（引擎在枚举任何目录之前先比对这里），而不是"匹配上了再过滤"。
 *
 * 注意：`$Recycle.Bin` **不在**这张表里 —— 它是 `recycle-bin` 规则的地盘，
 * 要如实识别容量并给出 🔴 等级（`core/fs/errors.ts` 的口径同源：回收站要显示、要计容量，但归 🔴）。
 * 它改由下面的 `REPORT_ONLY_ROOT_PATTERNS` 兜"不可删"，所以这里的"不在"不等于"可以删"。
 * `System Volume Information` 在扫描层就被静默跳过，列在这里是为了"哪天扫描覆盖了它也不会被规则吃掉"。
 *
 * 模板必须**无通配**且以 `%VAR%` 或盘符开头；带通配会被解析成它的前缀，等于把保护范围放大。
 *
 * **CLEANUP-RULES §6 补齐（本轮）**：6 条系统组件 → 25 条，按 §6 的五个 deny 类别补
 * R-DENY-SYSCOMP（SoftwareDistribution\Download、Package Cache）/ R-DENY-AIDATA /
 * R-DENY-USERDATA / R-DENY-MSACTIVITY 的那些根。与 Rust `types.rs::FORBIDDEN_PATH_PATTERNS` 逐条同序。
 * `%LOCALAPPDATA%\Microsoft` **故意不在里面**（它整棵禁止会关掉 `thumbnail-cache` 与
 * `error-reporting` 两条已上线规则），改走 `types.ts::USER_DATA_LEAF_RELATIVE` 的 guard。
 */
export const FORBIDDEN_PATH_PATTERNS: readonly string[] = [
  '%WINDIR%\\System32',
  '%WINDIR%\\SysWOW64',
  '%WINDIR%\\WinSxS',
  '%WINDIR%\\Installer',
  '%WINDIR%\\Servicing',
  '%SYSTEMDRIVE%\\System Volume Information',
  // ── R-DENY-SYSCOMP 的其余两格 ──
  // 更新下载暂存：删了不是"下次重下"——更新状态机自己的记录还在，表现是「更新卡在某个百分比」。
  '%WINDIR%\\SoftwareDistribution\\Download',
  // ── R-DENY-AIDATA（AI 工具与会话数据）：会话记录、skills、projects、配置。名字叫 cache 也不是缓存 ──
  //
  // ⚠️ **只有住在家目录（`%USERPROFILE%` 下）的那八条留在这里**，`%APPDATA%` / `%LOCALAPPDATA%`
  // 下的一族（`\Claude` / `Tencent` / `Packages` …）已移到 `REPORT_ONLY_ROOT_PATTERNS`。
  // 理由是一处**结构性冲突**：那两条根是四条容器入口规则（browser-cache / app-cache-data /
  // installer-artifacts / app-rotated-logs）的 `allowRoots` 本身，把它们**后代叶子**登记成禁止根，
  // 评估层会按 `AncestorOfProtected` 把 allow 根判成"套住了受保护路径" ⇒ 四条规则一条 finding
  // 都不出。那是拿四条已上线、真机能收到字节的规则去换一个 guard（cleanup-rules.md §10 明令禁止
  // 「看着实现了、其实是 0」）。文档 §6 对这两类的处置本来就是 **⛔ 只上报**，
  // `REPORT_ONLY` 正是那个语义。逐字理由见 Rust `types.rs::FORBIDDEN_PATH_PATTERNS` 同名段。
  '%USERPROFILE%\\.codex',
  '%USERPROFILE%\\.claude',
  '%USERPROFILE%\\.qoder',
  '%USERPROFILE%\\.qoder-cn',
  '%USERPROFILE%\\.workbuddy',
  '%USERPROFILE%\\.dsh',
  '%USERPROFILE%\\.mem0',
  '%USERPROFILE%\\.codebuddy',
  // ── R-DENY-INSTALLDIR 的两条 Program Files（本轮从"只靠围栏"升级成禁止根）──
  // 原先它们只活在围栏地板里，于是**只保护带围栏的规则**；显式模板规则可以点名
  // `%LOCALAPPDATA%\Program Files\Foo\Bar` 就把它收走。登记进禁止根之后那是声明层整条拒。
  '%PROGRAMFILES%\\',
  '%SYSTEMDRIVE%\\Program Files (x86)\\'
]

/**
 * 「只上报、任何规则都不可删」的第二类根（§16 回收站那处冲突的落地口径，人类伙伴 2026-09-26 定）。
 *
 * 与 `FORBIDDEN_PATH_PATTERNS` 的区别只有一件事：**这里的路径照常枚举、照常如实报告占用字节**
 * （回收站要显示、要计容量），但没有任何规则能把它变成删除动作。落地是三层结构闸，不是匹配后过滤：
 * 声明层 `validateRuleSet` 拒掉非 🔴 规则把它当地盘；评估层 `takeFile` 拒绝认领；
 * 执行层 `core/clean/executor.ts` 把它并进删除前的阻断根集合。
 *
 * 为什么必须有这张表：`recycle-bin` 规则自己 `riskLevel='forbidden'` 只能挡住**它自己那条 finding**，
 * 挡不住另一条 🟢/🟡 规则把回收站里的文件认领走 —— 原先唯一的屏障是「`claimed` 表按声明顺序，
 * 而 `recycleBin` 恰好排在第 6」。顺序依赖不是防护：往 `BUILTIN_RULES` 前面插一条宽路径规则就会退回去。
 *
 * 模板同样必须**无通配**且以 `%VAR%` 或盘符开头；解析不出来时按 🔴 保护失效处理（`safetyBlocked`）。
 *
 * **CLEANUP-RULES §6 R-DENY-INSTALLDIR 补三条（本轮）**：程序安装目录是**现役软件的本体**，不是缓存；
 * 但它与 WinSxS 那一类不同 —— 用户**有权**看见它占了多少（§6 给的就是「本机 PCManager >= 879.3 MB」
 * 这种读数），所以放这一张表（照常计容量、只是不许被认领），不放 `FORBIDDEN_PATH_PATTERNS`。
 * 收尾 `\` 是刻意的：`%LOCALAPPDATA%\ProgramsX` 不是 `Programs` 的子树（段边界判据）。
 * 与 Rust `types.rs::REPORT_ONLY_ROOT_PATTERNS` 逐条同序。
 */
export const REPORT_ONLY_ROOT_PATTERNS: readonly string[] = [
  '%SYSTEMDRIVE%\\$Recycle.Bin',
  // 用户级安装根：VS Code / Slack 那类「装在家目录里的应用」的本体。
  '%LOCALAPPDATA%\\Programs\\',
  // ── R-DENY-SYSCOMP / R-DENY-AIDATA / R-DENY-USERDATA / R-DENY-MSACTIVITY 里
  //    住在 `%APPDATA%` / `%LOCALAPPDATA%` 下的那一族（CLEANUP-RULES §6）──
  // 它们**必须在只上报表**而不是禁止根：那两条根是四条容器入口规则的 `allowRoots` 本身，
  // 登记成禁止根会让 allow 根被判成"套住了受保护路径"（`AncestorOfProtected`），
  // 四条规则一条 finding 都不出。语义与文档 §6 一致：照常枚举、照实报占用、没有任何规则能认领。
  // 逐字理由见 Rust `types.rs::FORBIDDEN_PATH_PATTERNS` 与 `REPORT_ONLY_ROOT_PATTERNS` 两段。
  '%PROGRAMDATA%\\Package Cache',
  '%APPDATA%\\Claude',
  '%APPDATA%\\OpenAI',
  '%APPDATA%\\ZCode',
  '%APPDATA%\\com.qodercn.app.stable',
  '%APPDATA%\\Tencent',
  '%APPDATA%\\douyin',
  '%APPDATA%\\Spotify',
  '%APPDATA%\\NutstoreClient',
  // MSIX 每应用状态容器，basename 是通用词（§3 Step 2：容器先展开再判）
  '%LOCALAPPDATA%\\Packages'
]

/** Windows 用户临时目录（§16 🟢「用户 Temp」）。 */
const windowsTemp: Rule = {
  id: 'windows-temp',
  name: 'Windows 临时文件',
  category: 'temp',
  description: '当前用户 %TEMP% 及其子目录里的临时文件；安装器、压缩软件、应用崩溃留下的中间产物',
  paths: ['%TEMP%'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  // 临时文件删掉就是删掉了（不像缓存能再生），而且里面可能是用户没保存的东西 → 如实标 false
  recoverable: false
}

/** §16 🟢「浏览器缓存」：只碰 Cache / Code Cache，绝不碰 User Data 下的 Profile（书签、密码、历史都在那儿）。 */
const browserCache: Rule = {
  id: 'browser-cache',
  name: '浏览器缓存',
  category: 'browser-cache',
  description: 'Chrome / Edge 各 Profile 的 HTTP 缓存与代码缓存；不含书签、密码、历史、扩展等用户数据',
  paths: [
    '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache',
    '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Code Cache',
    '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Cache',
    '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\Code Cache'
  ],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/**
 * §16 🟢「缩略图缓存」。`Explorer` 目录里同放着 iconcache 与一堆随机名条目，
 * 所以 filePatterns 精确到 `thumbcache_*.db` 而不是把整个目录端走（§28 原则四在文件层的延伸）。
 */
const thumbnailCache: Rule = {
  id: 'thumbnail-cache',
  name: '缩略图缓存',
  category: 'thumbnail-cache',
  description: '资源管理器缩略图数据库 thumbcache_*.db（Explorer 目录里的 iconcache 与随机名条目不在范围内）',
  paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'],
  scanner: { filePatterns: ['thumbcache_*.db'], olderThanDays: null, recursive: false },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/** §16 🟢「Shader Cache」：图形驱动/D3D 编译产物，删掉只会导致首次启动重新编译。 */
const shaderCache: Rule = {
  id: 'shader-cache',
  name: 'Shader 缓存',
  category: 'shader-cache',
  description: 'Direct3D 与显卡驱动的着色器编译缓存，清理后由系统/驱动按需重新生成（首次启动会变慢）',
  paths: [
    '%LOCALAPPDATA%\\D3DSCache',
    '%LOCALAPPDATA%\\NVIDIA\\DXCache',
    '%LOCALAPPDATA%\\NVIDIA\\GLCache',
    // 免确认清理档（M6）：AMD 驱动这一族的同语义缓存，与上面三处同判据（可再生）
    '%LOCALAPPDATA%\\AMD\\DxCache',
    '%LOCALAPPDATA%\\AMD\\GLCache'
  ],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/** §16 🟢「部分日志」：Windows 错误报告（WER）的队列与归档，是崩溃现场快照，对用户没有留存价值。 */
const errorReporting: Rule = {
  id: 'error-reporting',
  name: '错误报告与崩溃日志',
  category: 'error-reporting',
  description: 'Windows Error Reporting 的报告队列与归档（.wer 与随附的转储）；删除后不影响系统，但崩溃现场就没了',
  paths: [
    '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportQueue',
    '%LOCALAPPDATA%\\Microsoft\\Windows\\WER\\ReportArchive',
    '%PROGRAMDATA%\\Microsoft\\Windows\\WER\\ReportQueue',
    '%PROGRAMDATA%\\Microsoft\\Windows\\WER\\ReportArchive'
  ],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: false
}

/**
 * 回收站：§26 首批要求识别，§16 判定它是 🔴 —— 清空回收站是**不可逆**的用户行为，
 * 不允许出现在普通清理项里。所以 riskLevel 'forbidden' + cleanStrategy 'manual-only'，
 * 引擎照常算出它占多少空间（这是用户要看的东西），但它永远不进「可回收」合计。
 */
const recycleBin: Rule = {
  id: 'recycle-bin',
  name: '回收站',
  category: 'recycle-bin',
  description: '本卷回收站占用空间（$Recycle.Bin 下各 SID 的内容）。只报告占用，不提供普通清理入口',
  paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'forbidden',
  cleanStrategy: 'manual-only',
  recoverable: true
}

/** §21「Java / Maven」：只认 `.m2\repository`，`.m2\settings.xml` 是配置不是缓存。 */
const mavenRepository: Rule = {
  id: 'maven-repository',
  name: 'Maven 仓库缓存',
  category: 'dev-cache',
  description: 'Maven 下载的依赖仓库 .m2\\repository。清掉后下次构建重新下载；settings.xml 与本地凭据配置不在范围内',
  paths: ['%USERPROFILE%\\.m2\\repository'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'maven'
}

/** §21「Node.js / pnpm store」：pnpm 的内容寻址存储，两个常见落点都收（v3 与新版默认布局）。 */
const pnpmStore: Rule = {
  id: 'pnpm-store',
  name: 'pnpm 存储',
  category: 'dev-cache',
  description: 'pnpm 的全局内容存储（硬链接的源头）。清掉后下次 install 重新下载，已链接进项目的文件不受影响',
  paths: ['%LOCALAPPDATA%\\pnpm-store', '%LOCALAPPDATA%\\pnpm\\store'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'pnpm'
}

/** §21「Node.js / Yarn cache」：yarn v1 的 `yarn cache dir`；berry 的 `.yarn/cache` 在项目里，属于 node_modules 那一类，见文件头说明。 */
const yarnCache: Rule = {
  id: 'yarn-cache',
  name: 'Yarn 缓存',
  category: 'dev-cache',
  description: 'Yarn v1 的全局包缓存（yarn cache dir 指的地方）。项目内的 .yarn/cache 不在范围内，那是项目自己的依赖',
  paths: ['%LOCALAPPDATA%\\Yarn\\Cache'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'yarn'
}

/** §21「AI / 本地模型」的**缓存**部分。模型本体按项目书必须归「大文件」而不是自动删除，见文件头。 */
const huggingFaceCache: Rule = {
  id: 'huggingface-cache',
  name: 'Hugging Face 下载缓存',
  category: 'dev-cache',
  description: 'datasets/transformers 的下载缓存目录 .cache\\huggingface。删了会重新下载；.ollama\\models 这类模型本体不在这里',
  paths: ['%USERPROFILE%\\.cache\\huggingface'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'huggingface',
  /**
   * §3.5：一键全选点不到它。
   *
   * 为什么单独摘出来：这个目录名义上是"缓存"，装的实际是模型权重本身 —— 判 `recoverable: true`
   * 说的是"删了还能重新下载"，而重新下载要网、要几小时、要 HF token，离线推理的机器上等于没了。
   * 「可再生」与「可以替用户一键勾掉」是两件事，这里后者单独设一道闸。
   */
  excludedFromDefaultSelection: true
}

/** §21「Android SDK Cache」：只收 SDK 安装器的下载残留。SDK 本体与 AVD 镜像是工具/用户数据，不是缓存。 */
const androidSdkTemp: Rule = {
  id: 'android-sdk-temp',
  name: 'Android SDK 安装残留',
  category: 'dev-cache',
  description: 'Android SDK 安装器留下的 .temp 下载包。SDK 组件本身与模拟器镜像（.android\\avd）都不算缓存，不在范围内',
  paths: ['%LOCALAPPDATA%\\Android\\Sdk\\.temp'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'android-sdk'
}

/* ------------------------------------------------------------------ *
 * §26 Phase 4「然后逐步增加」：npm / pip / Gradle / VS Code —— §16 🟡 谨慎
 * Docker 不在这批里：§16 说的是「Docker 未使用数据」，那是 `docker system prune` 的结果，
 * 不是一条路径 —— 用假路径表达它等于撒谎，等 §18 的任务系统再谈。
 * 通用 Electron 缓存（VS Code 之外的应用）同样不做：`%LOCALAPPDATA%\*\Cache` 这种一层通配
 * 的地盘大到无法证明它只碰渲染层缓存，`validateRuleSet` 的叶子路径判据（§28 原则四）本来就不同意。
 *
 * §21 还点名了 node_modules / __pycache__ / virtualenv —— **这三条现在的规则语言表达不出来**：
 * 路径模板里的 `*` 恰好匹配一层目录，而"任意深度下任何叫 node_modules 的目录"需要无界递归匹配。
 * 硬凑一个 `%LOCALAPPDATA%\*\node_modules` 只会漏掉所有非顶层项目，看着像实现了、实际是假数字。
 * 要支持它得给引擎加一个"遍历时按目录名匹配"的判据（walk-time dir matcher），那是引擎改动而不是往表里塞条目。
 * ------------------------------------------------------------------ */

/** §16 🟡「npm cache」：清掉只是让下次安装重新下载，不会动任何项目里的 node_modules。 */
const npmCache: Rule = {
  id: 'npm-cache',
  name: 'npm 缓存',
  category: 'dev-cache',
  description: 'npm 的内容寻址缓存（_cacache）。清掉后下次安装要重新下载包，不影响已装好的 node_modules',
  paths: ['%LOCALAPPDATA%\\npm-cache', '%USERPROFILE%\\.npm-global\\cache'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'npm'
}

/** §16 🟡「pip cache」：Windows 上 pip 的 HTTP/轮子缓存在 `%LOCALAPPDATA%\pip\Cache`。 */
const pipCache: Rule = {
  id: 'pip-cache',
  name: 'pip 缓存',
  category: 'dev-cache',
  description: 'pip 的下载与 wheel 构建缓存。清掉后下次 pip install 重新联网下载，不动任何 site-packages',
  paths: ['%LOCALAPPDATA%\\pip\\Cache'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'pip'
}

/** §16 🟡「Gradle cache」：只认 `caches` 一支，`.gradle` 里的 wrapper 分发与配置不碰。 */
const gradleCache: Rule = {
  id: 'gradle-cache',
  name: 'Gradle 缓存',
  category: 'dev-cache',
  description: 'Gradle 的依赖与构建缓存目录 .gradle\\caches（不含 wrapper 下载与 gradle.properties）',
  paths: ['%USERPROFILE%\\.gradle\\caches'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'gradle'
}

/** §21「VS Code / Electron」：只收渲染层的 Cache / CachedData，绝碰不到用户配置与扩展。 */
const vscodeCache: Rule = {
  id: 'vscode-cache',
  name: 'VS Code 缓存',
  category: 'dev-cache',
  description: 'VS Code（Electron）的 Cache 与 CachedData；settings.json、扩展与全局历史都不在范围内',
  paths: ['%APPDATA%\\Code\\Cache', '%APPDATA%\\Code\\CachedData'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  requiresDetector: 'vscode'
}

/* ------------------------------------------------------------------ *
 * M5-P1 T3a（plan §5.1–§5.3）—— 表尾三条：**容器入口 + leaf 判据 + 强制围栏**。
 *
 * 这三条的形状与前面十五条根本不同：`paths` 不再是地盘叶子，而是**遍历入口**（AppData 三根），
 * 判据打在 basename 名单上（`leafDirs` / `leafFiles`），边界由 `scopeFence` 守。
 * 三样少任一样，声明层 `validateRuleSet` 就把整条拒掉（`inadequate-fence` /
 * `container-without-predicate`），地盘从合计里静默消失 —— 所以 `engine.ts` 与 `validate.rs`
 * 那两道闸是它们能上线的前提，不是风格。
 *
 * ⚠️ **只能追加在表尾**：`claimed` 表先声明者计账（`engine.ts` 的 `takeFile`），这三条的入口
 * 覆盖了第 2 条（browser-cache）与第 7–15 条（dev-cache 一族）的地盘，插到表头就是把它们的
 * 字节抢过来再报一遍 —— 预估虚高，方向是多删。证明在
 * `tests/unit/rules-engine.test.ts` 的 `app cache data does not reclaim npm cache or browser cache`。
 * ------------------------------------------------------------------ */

/** 三条共同的采集面 = `paths` = 围栏 `allowRoots`（plan §5：AppData 三根，不是任意盘任意深度）。 */
const CONTAINER_ROOTS = ['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%'] as const

/**
 * 围栏的地板：`denyRoots` ⊇ `FORBIDDEN_PATH_PATTERNS` 全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`
 * （spec §2.3 / plan §4.1–§4.3）。`%WINDIR%\*` 一条就**覆盖**了五条 `%WINDIR%\<组件>`（覆盖判据按
 * 解析后的段边界包含算）；两处 Program Files 一条用第 8 个变量键 `%PROGRAMFILES%`、一条按 §4.2
 * 写成 `%SYSTEMDRIVE%\Program Files (x86)\*`（不新增带括号的变量键）。
 * 与 Rust `builtin.rs::container_fence` 逐条同序同串。
 */
const containerFence = (): RuleScopeFence => ({
  allowRoots: [...CONTAINER_ROOTS],
  denyRoots: [
    '%WINDIR%\\*',
    '%SYSTEMDRIVE%\\System Volume Information',
    '%PROGRAMFILES%\\*',
    '%SYSTEMDRIVE%\\Program Files (x86)\\*',
    // T6 真机对账逮到的越界：Defender 的病毒特征库被当成「更新器留下的安装包」收走过。
    // 删了的后果不是"重新下载"而是"更新回来之前这台机器不设防"。逐字见 Rust
    // `builtin.rs::container_fence` 的注释。与它同序同串。
    '%PROGRAMDATA%\\Microsoft\\Windows Defender\\*',
    // ── 下面这些逐条对应 FORBIDDEN_PATH_PATTERNS 里落在 allowRoots 之内的禁止根（§6 的四个 deny 类别）──
    // 顺序：地板 → 禁止根 → 容器族的补充（覆盖判据要求每条禁止根有**自己那一格**）。
    '%LOCALAPPDATA%\\Microsoft',
    '%LOCALAPPDATA%\\Packages',
    '%PROGRAMDATA%\\Package Cache',
    '%APPDATA%\\Claude',
    '%APPDATA%\\OpenAI',
    '%APPDATA%\\ZCode',
    '%APPDATA%\\com.qodercn.app.stable',
    '%APPDATA%\\Tencent',
    '%APPDATA%\\douyin',
    '%APPDATA%\\Spotify',
    '%APPDATA%\\NutstoreClient',
    // 家目录整棵关掉：AI 与用户数据的禁止根有一大半住在这里，而家目录不是这些规则的采集面。
    // ⚠️ 必须排在 FORBIDDEN_PATH_PATTERNS 那几条**之后**（否则覆盖判据会被一个更宽的祖先糊过去）。
    '%USERPROFILE%\\*',
    // 宽容器名（`BROAD_LEAF_NAMES` 里的 `program files`）在 Local 下也可能出现 —— 不在禁止根表里
    // （那张表按路径判），但同样不许进采集。
    '%LOCALAPPDATA%\\Program Files',
    // 地板第五条（§6 R-DENY-INSTALLDIR）：用户级 Programs 是应用本体，连枚举都不该发生。
    '%LOCALAPPDATA%\\Programs\\*'
  ]
})

/** plan §5.1 的 12 个 Chromium / Electron 约定缓存名（spec §1「形状」那一类）。与 Rust 同序。 */
const APP_CACHE_LEAF_DIRS = [
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

/** plan §5.2：**只认轮转件**。`*.?.log` 吃 `HiviewPlatform.3.log` 而不吃正在写的 `HiviewPlatform.log`。 */
const ROTATED_LOG_LEAF_FILES = ['*.?.log', '*.log.??', '*.etl']

/**
 * plan §5.3 的更新目录形状。⚠️ **故意没有 `Packages`**（plan §5 第一条排除项）：
 * `%LOCALAPPDATA%\Packages` 是 UWP 每应用状态目录（参考机 879.6 MiB / 12,744 文件），
 * 把它当"更新目录"是本轮最大的一次潜在误删。
 */
const UPDATER_LEAF_DIRS = ['*updater', '*Updater', 'pending', 'Update', 'updates']

/** plan §5.3 的安装包形状：认的是**包的样子**，不认是谁家的包（spec §1「命名惯例」那一类）。 */
const INSTALLER_FILE_PATTERNS = [
  '*.exe',
  '*.msi',
  '*.msp',
  '*.nupkg',
  '*.appx',
  '*.msix',
  '*.zip',
  '*.7z',
  '*.rar',
  '*.iso'
]

/** plan §5.1 🟡「应用缓存数据」：任意深度、名字是十二个约定名之一的缓存目录，全收。 */
const appCacheData: Rule = {
  id: 'app-cache-data',
  name: '应用缓存数据',
  category: 'app-transient',
  description:
    '应用（Chromium / Electron 一族）在 AppData 三根下任意深度、名字是 Cache / Code Cache / GPUCache 等约定名的缓存目录；删了会失去缓存本身，应用会自行重新生成，书签、密码、历史、登录态与用户配置都不在范围内',
  paths: [...CONTAINER_ROOTS],
  scanner: {
    filePatterns: [],
    olderThanDays: null,
    recursive: true,
    leafDirs: APP_CACHE_LEAF_DIRS,
    scopeFence: containerFence()
  },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/** plan §5.2 🟡「应用轮转日志」：`recoverable: false` —— 日志删了就没了，不像缓存能再生。 */
const appRotatedLogs: Rule = {
  id: 'app-rotated-logs',
  name: '应用轮转日志',
  category: 'app-transient',
  description:
    'AppData 三根下任意深度的**轮转**日志（Foo.1.log / Foo.log.01 / *.etl 这些已经封档的名字）；正在被写的同名无后缀日志（Foo.log）一条都不碰。删了会失去历史日志，无法还原',
  paths: [...CONTAINER_ROOTS],
  scanner: {
    filePatterns: [],
    olderThanDays: null,
    recursive: true,
    leafFiles: ROTATED_LOG_LEAF_FILES,
    scopeFence: containerFence()
  },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: false
}

/** plan §5.3 🟡「更新目录里的安装包」。 */
const installerArtifacts: Rule = {
  id: 'installer-artifacts',
  name: '更新目录里的安装包',
  category: 'installer-leftover',
  description:
    '更新目录（*-updater / pending / Update / updates）里留下的安装包与压缩包（exe / msi / nupkg / zip 一类）。删了会失去这些已经下完的安装包，需要时能重新下载；应用自带的运行时目录与 UWP 的 Packages 每应用状态目录不在范围内',
  paths: [...CONTAINER_ROOTS],
  scanner: {
    filePatterns: INSTALLER_FILE_PATTERNS,
    olderThanDays: null,
    recursive: true,
    leafDirs: UPDATER_LEAF_DIRS,
    scopeFence: containerFence()
  },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/** plan §5.4 🟡「开发工具与更新缓存」：**这条不走 leaf 机制** —— 六个模板是**跨设备稳定的工具约定**
 * （electron / electron-builder / NuGet 各自把缓存写死在固定位置，`USOShared` / `USOPrivate` 是
 * Windows 更新编排器的固定目录），点名它们本身就是判据，不需要 basename 名单，因此也**不需要**围栏
 * （围栏是「容器入口 + 任意深度判据」那一族规则的配件，见上面三条；这里的地盘已经逐个落到叶子）。
 *
 * ⚠️ 地盘重叠是**已登记**的，不是漏做：`%LOCALAPPDATA%\electron\Cache` 与 `%LOCALAPPDATA%\NuGet\Cache`
 * 那两个目录名同时命中第 16 条 `app-cache-data` 的 `leafDirs`，而 `claimed` 表先声明者计账 ——
 * 于是那两处字节归第 16 条，这条在其名下只留下 `claimed-by-other-rule`。方向是**归属**变化、
 * 不是双计（预估不会虚高）。留给 T6 用真机 golden 判要不要把它排到 `app-cache-data` 之前。
 */
const devToolCache: Rule = {
  id: 'dev-tool-cache',
  name: '开发工具与更新缓存',
  category: 'app-transient',
  description:
    '跨设备固定位置的开发工具与系统更新缓存：Electron 与 electron-builder 的下载缓存、NuGet 的 v3 与包缓存，以及 Windows 更新编排器（USO）的 USOShared / USOPrivate 下载目录。删了会失去这些已经下完的包，需要时能重新下载；工具本体、项目里的 node_modules 与已安装的系统更新都不在范围内',
  paths: [
    '%LOCALAPPDATA%\\electron\\Cache',
    '%LOCALAPPDATA%\\electron-builder\\Cache',
    '%LOCALAPPDATA%\\NuGet\\v3-cache',
    '%LOCALAPPDATA%\\NuGet\\Cache',
    '%PROGRAMDATA%\\USOShared',
    '%PROGRAMDATA%\\USOPrivate'
  ],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true
}

/** plan §5.5 🟡「应用崩溃转储」：`recoverable: false` —— 转储是崩溃那一次的现场，删了就没有第二份。
 * 与第 5 条 `error-reporting`（WER 的报告队列与归档，.wer）是两处地盘：这里是 Local\\CrashDumps，
 * 且按 `*.dmp` 精确收，不把目录端走。 */
const crashDumps: Rule = {
  id: 'crash-dumps',
  name: '应用崩溃转储',
  category: 'app-transient',
  description:
    '应用崩溃时由 Windows 生成的用户态内存转储（*.dmp），住在 CrashDumps / werdump / DumpFolder / Dumps 这类转储目录里（%LOCALAPPDATA%、%APPDATA%、%PROGRAMDATA% 三根下任意深度）。删了会失去崩溃现场，无法还原，但不影响系统与应用的运行；Windows Error Reporting 的报告队列与归档（.wer）归「错误报告与崩溃日志」那条，不在这里',
  paths: [...CONTAINER_ROOTS],
  // T6 真机对账发现的白漏：原先写死 %LOCALAPPDATA%\CrashDumps，于是 %PROGRAMDATA%\...\werdump
  // 里那 72 MiB 转储既没 finding 也没排除记录（根本没试过）。改成容器入口 + 目录名判据。
  // 名单与 Rust `builtin.rs::CRASH_DUMP_LEAF_DIRS` 同序同串。
  scanner: {
    filePatterns: ['*.dmp'],
    olderThanDays: null,
    recursive: true,
    leafDirs: ['CrashDumps', 'werdump', 'DumpFolder', 'Dumps'],
    leafFiles: [],
    scopeFence: containerFence()
  },
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: false
}

/** plan §5.6 🟠「下载目录里的安装包」—— **整张表上第一档 🟠**。
 *
 * 判据与第 18 条 `installer-artifacts` 共用同一份十种包形状，变的是三件事：地盘是**用户自己的
 * 下载目录**、风险 **🟠 High**、**不进默认勾选**（`excludedFromDefaultSelection: true`，
 * §3.5 那个豁免名单的第二个成员，派生只在下面 `defaultUnselectableRuleIds()` 一处）。
 * `recursive: false` = 只碰 `Downloads` 顶层：子目录是用户自己的组织方式，不是残留。
 * `recoverable: false` —— 那是他自己下载的文件，不是应用生成的缓存，删了不会自动重新生成。
 *
 * ⚠️ 🟠 不等于 🔴：§16 只把 🔴 排除在「可回收」合计之外（`engine.ts` 的
 * `if (f.riskLevel !== 'forbidden')`），所以这条的字节**照常进** `reclaimableBytes`，
 * 而它**不**进默认勾选 —— 两个方向合起来才是这条规则的完整意思（判据见
 * `tests/unit/rules-registry.test.ts` 的「a high rule 的字节进 reclaimableBytes 却进不了默认勾选」）。
 */
const userDownloadsInstallers: Rule = {
  id: 'user-downloads-installers',
  name: '下载目录里的安装包',
  category: 'installer-leftover',
  description:
    '当前用户 %USERPROFILE%\\Downloads 目录**顶层**（不递归进子目录）里名字像安装包与压缩包的文件（exe / msi / nupkg / zip 一类十种形状）。这是你自己下载的东西，不是应用生成的缓存：里面很可能还有你留着准备以后装机的安装包、驱动、绿色版工具或别人发给你的文件，删了不会自动重新生成，也找不回来，只能重新去官网下载。Downloads 里那些不像安装包的文件（照片、文档、表格）与子目录里的任何东西都不在范围内',
  paths: ['%USERPROFILE%\\Downloads'],
  scanner: { filePatterns: INSTALLER_FILE_PATTERNS, olderThanDays: null, recursive: false },
  riskLevel: 'high',
  cleanStrategy: 'delete-all',
  recoverable: false,
  excludedFromDefaultSelection: true
}

/* ------------------------------------------------------------------ *
 * M5-P2 P2-T4（plan §2.6 / spec §3 3.5 + §4.3）—— 表尾第 22 条，**表上第一条判据来自
 * 机器事实**（而不是路径、形状、命名惯例）的规则。与前面二十一条的差别不是"地盘更大"：
 * 那二十一条说"这块地方长得像可删的东西"，这一条说"**这个应用已经不在了**，所以它留下的
 * 设置与数据没人要了" —— 后者是这台机器此刻的状态，规则表里没有，只能由注入的 `appFacts`
 * 表给出（TS 侧 `core/facts/appfacts.ts` 是对账基准，产品侧是 `crates/appfacts`）。
 *
 * 三个安全方向合起来才是这条规则（plan §0.1：它的失败方向是删掉**活应用**的数据，
 * 比 M5-P1 任何一条都重）：
 *  · `requiresAbsentAppFact: true` —— 采集根 = 三根容器的**直属子目录**，逐格查表，
 *    **只有 `absent` 才收**；`present` / `unknown` / 缺键各记一条分名的排除（plan §2.4）。
 *    空表 ⇒ 一个候选都不批准，于是这条**连 finding 都不出**（`engine.ts` 那条 `continue`，
 *    与 Rust 同一条 —— 一侧出 0 字节项、一侧不出，两套实现对"这条规则上没上表"就会给出
 *    不同答案），而它看过的每个候选都以分名理由留在 `exclusions[]` 里点名。
 *  · **没有 `leafDirs` / `leafFiles`** —— 与 `requiresAbsentAppFact` 互斥是 P2-T3 的声明层闸
 *    （`engine.ts::validateRuleSet`，混给整条拒 `ambiguous-leaf-mode`）：采集根由引擎取直属
 *    子目录决定，不由 basename 名单在任意深度命中决定。
 *  · 🟠 + `excludedFromDefaultSelection: true` + `recoverable: false` —— spec §4.3 定死的三个值。
 *
 * **为什么类别是新的一格 `orphan-data` 而不是 `app-transient`**：那一族的名字承诺的是
 * "运行期产物、删了能被产品自己的动作再生"（缓存重下、包重装），而这一条的地盘是某个应用的
 * **设置与数据本体** —— 应用都没了，没有任何产品动作会把它再生成。挂进那一族与给它
 * `recoverable: true` 是同一个方向的撒谎：两个词都在替用户宣布"失去了也不要紧"。
 * 逐字同 Rust `builtin.rs` 里那一段（两份实现是同一份契约，理由不许两种说法）。
 * ------------------------------------------------------------------ */

/** plan §2.6 🟠「卸载残留的应用数据」：判据 = 三根容器的顶层一项 ∧ 机器事实 = `absent`。 */
const orphanAppData: Rule = {
  id: 'orphan-app-data',
  name: '卸载残留的应用数据',
  category: 'orphan-data',
  description: '某个应用在这台机器上已经不在了 —— 应用事实探针查得到它的安装痕迹（注册表里的厂商键、服务、计划任务、开始菜单快捷方式），卸载表条目、安装目录、进程镜像与 MSIX 包这四条本体证据却一路都没证出应用还在；而它在 %LOCALAPPDATA%、%APPDATA%、%PROGRAMDATA% 三根的**顶层**留下的那个数据目录还在。删了会失去这个应用的**全部本地设置与数据**：登录态、配置、词库、游戏存档、本地数据库那一类。应用不会再回来把它们重新生成一遍，回收站里也不会有第二份。⚠️ 这是一次**推断，不是事实**：机器上没有任何一条记录写着「这个应用已被卸载」，判据只是「有安装痕迹 ∧ 四路查无本体」。推断错的那一侧是「应用其实还在、只是探针没查到」—— 那样你失去的是一个还在用的应用的设置和数据，而它不会自己回来。探针证出本体在场、取证取到一半取不着、以及根本没被交代去看的目录，一个都不提议，只在报告里逐个点名是哪一种（这也让「这个功能没接线」与「这个功能看过但没查出东西」在报告里分得开）',
  paths: [...CONTAINER_ROOTS],
  // 第三种采集模式的 scanner：**两份 leaf 名单都是空的**（与 `requiresAbsentAppFact` 互斥），
  // 围栏仍然是容器规则那一份 `containerFence()`（带这个字段的规则必须容器入口 + 覆盖齐全的围栏，
  // 否则等于让一张机器事实表去批准整个用户目录树）。逐字见 Rust `builtin.rs::app_fact_scan`。
  scanner: {
    filePatterns: [],
    olderThanDays: null,
    recursive: true,
    leafDirs: [],
    leafFiles: [],
    scopeFence: containerFence()
  },
  riskLevel: 'high',
  cleanStrategy: 'delete-all',
  recoverable: false,
  excludedFromDefaultSelection: true,
  requiresAbsentAppFact: true
}

/* ------------------------------------------------------------------ *
 * M6（免确认清理档）—— 表尾第 23 条：显卡驱动安装包残留。
 *
 * 与 T3b-ii 那条的差别：地盘是**驱动安装器的固定现场**（盘根解压目录 + 驱动下载缓存），
 * 不是用户自己的下载目录；内容全部可重下载（官方安装器随时给得出第二份），
 * 所以它挂 🟢 而不是 🟠。显式路径模板那一族（同 dev-tool-cache：不走 leaf、无围栏），
 * 只能追加在表尾 —— 这些路径不与任何既有规则重叠，插前面插后面都不改 claimed 账。
 * 逐字同 Rust `builtin.rs` 里那一段（两份实现是同一份契约，理由不许两种说法）。
 *
 * ⚠️ DriverStore（`%WINDIR%\System32\DriverStore`）**不在这张地盘里**：那是 Windows
 * 自己管理的驱动库（在用 + 回退两份都在里面），它同时被 §16 🔴 的 `%WINDIR%\System32`
 * 挡在门外 —— 这里的三处全是安装器**外面的**临时现场。
 * ------------------------------------------------------------------ */
const gpuDriverLeftovers: Rule = {
  id: 'gpu-driver-leftovers',
  name: '显卡驱动安装包残留',
  category: 'installer-leftover',
  description:
    '显卡驱动安装器留下的解压目录与驱动下载缓存：系统盘根的 NVIDIA\\ 与 AMD\\（驱动安装包的解压现场，装完就没用了）、%PROGRAMDATA%\\NVIDIA Corporation\\Downloader（GeForce/NVIDIA App 下载完的驱动安装包）。删了会失去这些已经装完/下完的安装包，下次装驱动需要重新下载；驱动本体（DriverStore）、正在使用的驱动与着色器缓存都不在范围内（着色器缓存归「Shader 缓存」那条）',
  paths: [
    '%SYSTEMDRIVE%\\NVIDIA',
    '%SYSTEMDRIVE%\\AMD',
    '%PROGRAMDATA%\\NVIDIA Corporation\\Downloader'
  ],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: false
}

/** §26 Phase 4 首批 + 已补的开发环境批次。顺序即评估顺序（同一个文件被两条规则覆盖时，先声明者计账）。 */
export const BUILTIN_RULES: readonly Rule[] = [
  windowsTemp,
  browserCache,
  thumbnailCache,
  shaderCache,
  errorReporting,
  recycleBin,
  npmCache,
  pipCache,
  gradleCache,
  vscodeCache,
  mavenRepository,
  pnpmStore,
  yarnCache,
  huggingFaceCache,
  androidSdkTemp,
  // M5-P2 P2-T4（plan §2.6）：判据来自机器事实的第 22 条。
  // M5-P3（plan 2026-10-14-deepclean-tauri-m5-p3.md §1.3）把它从表尾**前移到这里** —— 既有 15 条仍在
  // 最前（它们与第 22 条抢同一路径时由顺序挡住，那条性质由两侧的同名免疫用例守着），六条形状规则在它
  // 之后。顺序就是 `claimed` 的计账顺序：让「这台机器上这个应用已经没了」这一条事实优先于
  // 「这堆文件名字像缓存」。本机实测换回 201.56 MiB（plan §2.5，不是 P2 验收引用的 1,413.8）。
  orphanAppData,
  // M5-P1 T3a（plan §5.1–§5.3）：容器入口那一族。顺序即 claimed 计账顺序 ——
  // M5-P3 起第 22 条在它们之前抢地盘，被抢到的字节改挂 🟠（不进默认勾选），量级见 plan §2.5。
  appCacheData,
  appRotatedLogs,
  installerArtifacts,
  // M5-P1 T3b-i（plan §5.4–§5.5）
  devToolCache,
  crashDumps,
  // M5-P1 T3b-ii（plan §5.6）：表上第一档 🟠
  userDownloadsInstallers,
  // M6 免确认清理档：表尾第 23 条，显式路径模板族，不与任何既有规则抢地盘
  gpuDriverLeftovers
]

/**
 * §3.5「一键全选点不到 AI 模型」的**唯一派生处**。
 *
 * 为什么是纯函数 + 默认参数：判据要能在单测里直接对着 `BUILTIN_RULES` 跑，也要能被预览层
 * 原样搬进模型 —— 两处共用同一份逻辑，就不会长出第二份「哪些算模型文件」的事实源。
 * 只认 `=== true`（与探测器那张表只认 `=== false` 同一个方向）：一个脏值不该顺手摘掉一条规则，
 * 也不该因为漏判而把模型文件留在默认勾选里。
 */
export function defaultUnselectableRuleIds(rules: readonly Rule[] = BUILTIN_RULES): string[] {
  return rules
    .filter((r) => r.excludedFromDefaultSelection === true)
    .map((r) => r.id)
    .sort()
}
