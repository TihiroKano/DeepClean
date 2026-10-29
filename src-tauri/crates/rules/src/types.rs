//! §15 Cleaner Rule Engine —— 规则的**数据形状**（Rust 侧）。
//!
//! 与 TS 侧的 `core/rules/types.ts` 是同一份契约，**行为基准在那边**。
//! 铁律同一条：**本模块里没有任何行为** —— 一条规则就是九个必填 + 两个可选字段的可序列化数据。
//! 后果是结构性的：规则**不可能**自带删除能力（没有函数字段，未知字段会被 `deny_unknown_fields` 拒掉）。

use serde::{Deserialize, Serialize};

/// §15 的 category 维度（`core/rules/types.ts` 逐字相同）。
/// M5-P1 T1：8→10，尾部追加 `AppTransient`、`InstallerLeftover`（plan §3 —— 与 TS `RULE_CATEGORIES` 同序同串）。
/// M5-P2 P2-T4：10→11，尾部追加 `OrphanData`（plan §2.6 第 22 条 `orphan-app-data`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuleCategory {
    Temp,
    BrowserCache,
    ThumbnailCache,
    ShaderCache,
    ErrorReporting,
    RecycleBin,
    DevCache,
    Duplicate,
    /// M5-P1 §5.1/5.2/5.5：应用运行期可再生产物（缓存、轮转日志、转储）—— 显示层归类，不是判据统一（plan §9.4）
    AppTransient,
    /// M5-P1 §5.3/5.6：安装器/更新器留下的安装包形状的东西
    InstallerLeftover,
    /// M5-P2 P2-T4（plan §2.6 / spec §4.3）：应用已经不在了、但它的设置与数据还在 —— 卸载残留。
    ///
    /// **为什么不并进 `AppTransient`**：那一族的名字说的是一件具体的事 —— 应用**运行期**产物、
    /// 删了能被产品自己的动作重新生成（缓存会重下、轮转日志没人看、`electron\Cache` 下次 install 就回来）。
    /// 这一条的地盘是某个应用的**设置与数据本体**（登录态、配置、存档、数据库），
    /// **没有任何产品动作会把它再生出来** —— 应用都没了，谁来再生？
    /// 把它叫 "transient" 与给它 `recoverable: true` 是同一个方向的撒谎：两个词都在对读的人宣布
    /// "失去了也不要紧"，而这里失去的东西要用户自己去别处找回（往往找不回）。
    /// 类别是显示层的分组判据（预览分组、`rejectedRules` 的理由串都念它），所以"宁可多一类、
    /// 不可混一类"在这里不是洁癖，是别让一个说谎的分组名替一条 🟠 规则背书。
    OrphanData,
}

/// 清理策略也是数据：描述「将来执行时按什么口径收」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanStrategy {
    DeleteAll,
    DeleteOlderThan,
    EmptyFolder,
    ManualOnly,
}

/// §16 四级；与 `shared/classify` 的 `Risk` 同源（Treemap 配色与规则引擎必须同一套风险口径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Risk {
    Safe,
    Caution,
    High,
    Forbidden,
}

/// 采集围栏（M5-P1 T1，spec §2.1）：`leafDirs` / `leafFiles` 这类任意深度 basename 判据**必须**
/// 配它 —— 路径在这里不是判据，只是「在哪些根里允许找 / 哪些根绝不进去」的边界。
///
/// - `allow_roots`：`%VAR%` 模板，解析后必须绝对、非盘符根、**无通配字符**（采集入口要落到具体目录）。
/// - `deny_roots`：必须 ⊇ `FORBIDDEN_PATH_PATTERNS` 全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`（§4.2 的裁定
///   把 32 位那条写成 `%SYSTEMDRIVE%\Program Files (x86)\*` —— 不新增带括号变量键）。
///   围栏根**不过** `BroadContainer`/`PatternNotLeaf` 那两条地盘判据 —— 这个不对称是刻意的，
///   逐字见 `validate.rs::validate_fence` 的注释（plan §4.3）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleScopeFence {
    pub allow_roots: Vec<String>,
    pub deny_roots: Vec<String>,
}

/// M5-P1 T1 起 `RuleScanner` 的三个新字段全部缺省 ⇒ 既有 15 条内置规则不写它们，
/// 行为与逐字节改前一致（回归轴：`the_builtin_table_has_no_shape_problems`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RuleScanner {
    /// 文件名 glob（大小写不敏感、`*` 任意串、`?` 单字符），对**直属文件与递归到的每个文件**做整名匹配。
    /// 空数组 = 该地盘下的所有文件。
    pub file_patterns: Vec<String>,
    /// 只算 mtime 早于 `now - olderThanDays*86400000` 的文件；`None` = 不按时间过滤。
    /// **时间基准由评估时注入，规则自己不读时钟。**
    pub older_than_days: Option<u32>,
    /// 是否连子目录一起收。宽目录（如 Explorer 下的缩略图库）必须 `false`，免得顺手扫走邻居。
    pub recursive: bool,
    /// M5-P1（spec §2.1）：任意深度，目录 basename 命中即把该目录当作采集根。空 = 不用该能力。
    /// 与 `leaf_files` **互斥**（§10 裁定 1）：两者同时给 → `AmbiguousLeafMode` 整条拒。
    pub leaf_dirs: Vec<String>,
    /// M5-P1：任意深度，文件 basename 命中即计 —— 与 `file_patterns` 同一把 glob，不新增第二把。
    pub leaf_files: Vec<String>,
    /// M5-P1：出现 `leaf*` 判据时**必需**的采集围栏；缺 = `InadequateFence` 整条拒。
    pub scope_fence: Option<RuleScopeFence>,
}

/// 机器事实的三态（spec §4.2）。**本棒只有注入面，没有探针** —— 表由调用方给，
/// 引擎只读表，一次都不碰注册表 / 进程表 / Appx（`lib.rs:4` 那句"零文件系统"因此不变）。
///
/// M5-P1 T2 起把它定义在规则侧而不是等 `crates/appfacts`：`EvaluateOptions::app_facts` 的
/// 值类型必须有个名字，而"表里没有这个键"与"表说 Unknown"这两件事在判据上**同向**（都不许提议），
/// 所以引擎侧只需要这三个状态。`Unknown` 的 `why` 字符串留在探针那一侧（M5-P2）：
/// 弃权理由由引擎在排除记录里就地生成（要点名的是**那个具体目录**，不是探针的内部措辞）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppFact {
    /// 本体在（卸载表 / Appx / 进程 / 安装目录任一路证出来了）
    Present,
    /// `有安装痕迹 ∧ 无本体` 两半都成立 —— 唯一能提议删除的状态
    Absent,
    /// 证据取不到 / 表里根本没这个键（缺键 ≠ 可删）
    Unknown,
}

/// §15 那棵树：九个必填字段 + 三个可选字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub category: RuleCategory,
    pub description: String,
    /// 声明式路径模板。**必须以 `%VAR%` 开头（或盘符绝对路径）**，`%VAR%` 由注入的 `RuleEnv` 解析
    /// —— 引擎永远不读真机环境变量（单测要能在合成树上跑）。
    /// 段间 `*` 匹配**恰好一层**目录名，且**不许以通配收尾**（§28 原则四：必须落到叶子上）。
    pub paths: Vec<String>,
    pub scanner: RuleScanner,
    /// §16：所有清理项目必须具有风险等级。🔴 的项目照常识别容量，但绝不进「可回收」合计。
    pub risk_level: Risk,
    pub clean_strategy: CleanStrategy,
    /// 删除后用户是否会**永久失去数据**：缓存类（可再生）true；临时文件/错误报告 false。
    pub recoverable: bool,

    /// V0.7 §3.2：把关本规则的探测器 id。没写这个字段的规则行为与从前逐字节一致。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_detector: Option<String>,
    /// §3.5：本规则的字节**不进「一键全选」的默认勾选**（AI 模型本体那一类）。
    /// **不改变账目**：照常上报占用、照样能被逐条勾上。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excluded_from_default_selection: Option<bool>,
    /// M5-P1（spec §4.2）：本规则的地盘只有在机器事实判成 `Absent` 时才许提议。
    ///
    /// 只有 `Some(true)` 算声明（与 `excludedFromDefaultSelection` 只认真布尔同一轴向）——
    /// 脏值不许顺手给一条规则装上"要事实"的闸，也不许因为漏判让一条残留规则裸奔。
    /// **必须进 `RULE_OPTIONAL_FIELDS`**：漏登记 ⇒ 带它的规则判 `invalid-shape` ⇒
    /// 地盘从合计里静默消失（`types.rs` 顶部那段警告，spec §4.2 点名它是本轮最容易踩的雷）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_absent_app_fact: Option<bool>,
}

/// 只能出现在 `Rule` 上的**必填**字段名。
///
/// ⚠️ **必须是两份名单，不许并成一份**（这条在 TS 侧有专门注释，`core/rules/types.ts:266`）：
/// 把 `requiresDetector` 塞进这份必填名单，就等于要求 15 条内置规则**每条都写它**；
/// 而若「非法字段」那份名单不含它，带它的 6 条规则会被判 `invalid-shape` → **整条规则被拒** →
/// 它的地盘从可回收合计里**静默消失**（不报错、只是数字变小）。
pub const RULE_FIELDS: [&str; 9] = [
    "id",
    "name",
    "category",
    "description",
    "paths",
    "scanner",
    "riskLevel",
    "cleanStrategy",
    "recoverable",
];

/// 可选字段白名单 —— **第二份名单**（理由见上）。
///
/// M5-P1 T2：2→3 补 `requiresAbsentAppFact`（spec §4.2）。这条新增本身就是要防的那个雷：
/// 少登记一个名字，带它的规则整条被判 `invalid-shape`，地盘静默从合计里消失，
/// 而报告看起来完全正常。
pub const RULE_OPTIONAL_FIELDS: [&str; 3] =
    ["requiresDetector", "excludedFromDefaultSelection", "requiresAbsentAppFact"];

/// §16 🔴 禁止路径 —— 引擎唯一的「任何规则都不许当采集根」名单。
///
/// 注意：`$Recycle.Bin` **不在这张表里** —— 它是 `recycle-bin` 规则的地盘，要如实识别容量
/// 并给出 🔴 等级。它改由 `REPORT_ONLY_ROOT_PATTERNS` 兜"不可删"，所以"不在"≠"可以删"。
///
/// **CLEANUP-RULES §6 补齐（本轮）**：原先是六条系统组件，现在按 `D:\DSH-Work\del-audit\cleanup-rules.md`
/// §6 的五个 deny 类别补到二十**五**条。判据是「这一类里的东西**本质**不是缓存」，而不是
/// 「这条路径今天有没有被某条规则提到」—— 一个没被点名的禁止根，等于一条只差一个巧合就能误删的地盘
/// （`orphan-app-data` 会把任何被判 `Absent` 的顶层目录端走，`.codex` / `Roaming\Claude` 正是它的候选）。
///
/// | 文档类别 | 覆盖的模板 |
/// |---|---|
/// | R-DENY-SYSCOMP | `%WINDIR%\WinSxS`、`%WINDIR%\Installer`、`%WINDIR%\System32`（⇒ DriverStore）、`%WINDIR%\SoftwareDistribution\Download`、`%PROGRAMDATA%\Package Cache` |
/// | R-DENY-INSTALLDIR | Program Files 两条与 `%LOCALAPPDATA%\Programs` 在 `REPORT_ONLY_ROOT_PATTERNS`（照常计容量） |
/// | R-DENY-AIDATA | `%USERPROFILE%\.codex` 等七个点目录 + `%APPDATA%` 下四个 AI 客户端目录 |
/// | R-DENY-USERDATA | `%APPDATA%\Tencent` 等五个用户数据容器 |
/// | R-DENY-MSACTIVITY | `%LOCALAPPDATA%\Packages`；`%LOCALAPPDATA%\Microsoft\**` 走 [`USER_DATA_LEAF_RELATIVE`] 的 guard |
///
/// ⚠️ 这张表**同时是** `scopeFence.denyRoots` 的地板（见 `FENCE_MINIMUM_DENY_PATTERNS` 与
/// `validate.rs::validate_fence`）：加一条这里，所有带围栏的规则都要在 denyRoots 里覆盖它，
/// 少一条整条规则被声明层拒 —— 方向是少删，不是多删。
pub const FORBIDDEN_PATH_PATTERNS: [&str; 17] = [
    r"%WINDIR%\System32",
    r"%WINDIR%\SysWOW64",
    r"%WINDIR%\WinSxS",
    r"%WINDIR%\Installer",
    r"%WINDIR%\Servicing",
    r"%SYSTEMDRIVE%\System Volume Information",
    // ── R-DENY-SYSCOMP 的其余两格（cleanup-rules.md §6）──
    // `SoftwareDistribution\Download`：Windows 更新的下载暂存。删了不是"下次重下"——更新状态机
    // 自己的记录还在，重下的动作不一定被触发，表现是「更新一直卡在某个百分比」。
    // 唯一合法清理途径是 `Dism` / 停止 wuauserv 后由系统自己重建，不是删目录。
    r"%WINDIR%\SoftwareDistribution\Download",
    // `Package Cache`：注册表的 Uninstall 串**直接指向这里**，删了之后多个软件的卸载器作废
    // （卸载时报「找不到原始安装包」，只能强行删目录）。文档 §6 原文：「不许动」。
    //
    // ⚠️ 它在 `REPORT_ONLY_ROOT_PATTERNS` 里而**不在** FORBIDDEN，理由是同一个
    // `AncestorOfProtected` 冲突：`%PROGRAMDATA%` 是四条容器入口规则的 allowRoots 之一，
    // 把它的后代叶子登记成禁止根会让那四条规则一条 finding 都不出（详见下面
    // R-DENY-AIDATA 那段与 `types.rs::REPORT_ONLY_ROOT_PATTERNS`）。只上报 = 照常枚举、
    // 照实报那 115.2 MB、没有任何规则能认领它。
    // ── R-DENY-AIDATA / R-DENY-USERDATA（AI 数据 + 用户数据容器）──
    // 这些目录里是会话记录、skills、projects、配置，或聊天记录 / 登录态 / 离线歌单。
    // **名字叫 cache 也不是缓存**（文档 §6 原话）。最危险的一条是 `%APPDATA%\Claude`：
    // 它有厂商键当痕迹、而本体可能一路都查不到，于是 `orphan-app-data` 会把它当残留推上前台。
    //
    // ⚠️ **为什么住在 `%USERPROFILE%` 下的那八条在 FORBIDDEN、而 `%APPDATA%` / `%LOCALAPPDATA%`
    // 下的这一族在 `REPORT_ONLY_ROOT_PATTERNS`**：`%APPDATA%` / `%LOCALAPPDATA%` 是四条容器入口
    // 规则（browser-cache / app-cache-data / installer-artifacts / app-rotated-logs）的
    // **allowRoots 本身**。把它们的后代叶子登记成禁止根，评估层会按 `AncestorOfProtected`
    // 把 allow 根判成"受保护路径的祖先" → 整条规则一条 finding 都不出。那是拿四条已上线、
    // 有正反用例、真机能收到字节的规则去换一个 guard —— cleanup-rules.md §10 明令禁止
    // 「看着实现了、其实是 0」。而文档 §6 对这两类的处置本来就是 **⛔ 只上报**
    // （照常枚举、照实报占用、没有任何规则能认领），`REPORT_ONLY` + `report_only_block`
    // 正是那个语义：差别只在枚举阶段看不看得见，而看得见才能如实报出那 1298.9 MB。
    // `%USERPROFILE%` 不在任何 allowRoots 里，所以它下面那八条留在 FORBIDDEN。
    r"%USERPROFILE%\.codex",
    r"%USERPROFILE%\.claude",
    r"%USERPROFILE%\.qoder",
    r"%USERPROFILE%\.qoder-cn",
    r"%USERPROFILE%\.workbuddy",
    r"%USERPROFILE%\.dsh",
    r"%USERPROFILE%\.mem0",
    r"%USERPROFILE%\.codebuddy",
    // ── R-DENY-MSACTIVITY（微软软件活动数据）──
    // `%LOCALAPPDATA%\Packages` 是 MSIX 每应用状态容器，**basename 是通用词**
    // （cleanup-rules.md §3 Step 2：容器先展开再判，不许按自身名字判存活）。
    //
    // ⚠️ `%LOCALAPPDATA%\Microsoft` **故意不在这张表里**，这是本轮对文档 §6 的一次**收窄**，
    // 理由不是"它安全"而是"这张表放不下它"：禁止根会**在评估层整棵拒掉**任何落在里面的路径，
    // 而 `thumbnail-cache`（`…\Microsoft\Windows\Explorer`）与 `error-reporting`
    // （`…\Microsoft\Windows\WER\ReportQueue`）两条**已上线、有正反用例、真机能收到字节**的规则
    // 恰好住在里面 —— 放进来等于一次性关掉这两条规则，那正是 §10 警告的「看着实现了、其实是 0」。
    // 文档 §6 对它的判据原文是 **guard**:「名字叫 cache 也不是缓存」，guard 是**判据级**的东西，
    // 所以它落成 `types.rs::USER_DATA_LEAF_RELATIVE`（按路径后缀判，不是按整棵根判）。
    // ── R-DENY-INSTALLDIR 的两条 Program Files（本轮从"只靠围栏"升级成禁止根）──
    // 原先它们只活在 `FENCE_MINIMUM_DENY_PATTERNS`（围栏地板）里，于是**只保护带围栏的规则**：
    // 而一条显式模板规则完全可以点名 `%LOCALAPPDATA%\Program Files\Foo\Bar` 把它收走，
    // 声明层那时只查"落在禁止根里吗"，答案是"不"（集合里根本没有它）。
    // 登记进禁止根之后，这类路径在**声明层**就整条拒，围栏地板那一份照旧留着（两处都要）。
    //
    // ⚠️ 写成 `%PROGRAMFILES%\`（带收尾分隔符）而不是 `%PROGRAMFILES%`：**两侧的 env 值口径本来就不一样**
    // —— Rust 测试夹具给的是 `C:\Program Files`（不带尾分隔符），TS 夹具给的是 `C:\Program Files\`，
    // 而 `resolve_pattern` 在 `%VAR%` 为唯一一段时不补尾分隔符。不带那一下，同一个模板在两侧解析成
    // `C:\Program Files` 与 `C:\Program Files\` 两种写法，而这串会**进报告**（`forbiddenRoots`），
    // 零容差对账当场红。带收尾分隔符时两侧都裁成 `C:\Program Files`，与 TS 生产值逐字相同。
    r"%PROGRAMFILES%\",
    r"%SYSTEMDRIVE%\Program Files (x86)\",
];

/// 「只上报、任何规则都不可删」的第二类根。
///
/// 与 `FORBIDDEN_PATH_PATTERNS` 的区别只有一件事：**这里的路径照常枚举、照常如实报告占用字节**，
/// 但没有任何规则能把它变成删除动作。落地是**结构闸**，不是匹配后过滤。
///
/// 为什么必须有这张表：`recycle-bin` 规则自己 `riskLevel='forbidden'` 只能挡住**它自己那条 finding**，
/// 挡不住另一条 🟢/🟡 规则把回收站里的文件认领走 —— 原先唯一的屏障是「`claimed` 表按声明顺序，
/// 而 `recycleBin` 恰好排在第 6」。**顺序依赖不是防护**。
///
/// **CLEANUP-RULES §6 R-DENY-INSTALLDIR 补三条（本轮）**：程序安装目录是**现役软件的本体**，
/// 不是缓存 —— 但它们与 WinSxS 那一类不同：用户**有权**看见它们占了多少（文档 §6 给的就是
/// 「本机 PCManager >= 879.3 MB」这种读数），所以放这一张表（照常计容量、只是不许被认领），
/// 不放 `FORBIDDEN_PATH_PATTERNS`（那边连容量都不进任何 finding）。
///
/// 为什么 `%LOCALAPPDATA%\Programs` 是这一格而不是围栏：围栏只保护**带围栏的规则**，
/// 而这条地盘会被任意一条显式模板规则踩到（`%LOCALAPPDATA%\Programs\*` 底下也有 `Cache`）。
/// 只上报根是**结构闸**（`engine.rs` 的 `report_only_block` 在认领前逐文件判），与规则的
/// 声明方式无关。
pub const REPORT_ONLY_ROOT_PATTERNS: [&str; 12] = [
    r"%SYSTEMDRIVE%\$Recycle.Bin",
    // 用户级安装根：VS Code / Slack 那类「装在家目录里的应用」的本体。
    // 收尾 `\` 是刻意的：`%LOCALAPPDATA%\ProgramsX` 不是它的子树（段边界判据），
    // 而带收尾分隔符时 `resolve_roots` 解析出的根就是 `…\Programs` 本身。
    r"%LOCALAPPDATA%\Programs\",
    // R-DENY-SYSCOMP：`Package Cache`（Visual Studio 等的安装缓存）。注册表的 Uninstall 串
    // 直接指着它，删了多个软件的卸载器作废。同族的 `%WINDIR%\SoftwareDistribution\Download`
    // 留在 FORBIDDEN —— `%WINDIR%` 不是任何 allowRoot 的后代，放进禁止根不会引发
    // `AncestorOfProtected`。
    r"%PROGRAMDATA%\Package Cache",
    // 这一族放在**只上报**而不是禁止根，理由逐字写在 `FORBIDDEN_PATH_PATTERNS` 那一段
    // （`AncestorOfProtected` 会因它们把四条已上线规则整条判死）。语义与文档 §6 一致：
    // 照常枚举、照实报占用、**没有任何规则能认领**。
    r"%APPDATA%\Claude",
    r"%APPDATA%\OpenAI",
    r"%APPDATA%\ZCode",
    r"%APPDATA%\com.qodercn.app.stable",
    r"%APPDATA%\Tencent",
    r"%APPDATA%\douyin",
    r"%APPDATA%\Spotify",
    r"%APPDATA%\NutstoreClient",
    // R-DENY-MSACTIVITY：MSIX 每应用状态容器（同上，`%LOCALAPPDATA%` 是 allowRoots）
    r"%LOCALAPPDATA%\Packages",
];

/// `scopeFence.denyRoots` 除 `FORBIDDEN_PATH_PATTERNS` 全集外**还必须**覆盖的四条根
/// （spec §2.3 + plan §4.2 的裁定：32 位那条不新增带括号变量键，走 `%SYSTEMDRIVE%` + 字面括号段；
/// 括号不在形状判据的禁用字符集里，由 validate.rs 的
/// `a_parenthesised_literal_deny_root_passes_shape_check` 钉住）。
/// 与 TS `core/rules/types.ts` 的 `FENCE_MINIMUM_DENY_PATTERNS` 逐条相同。
///
/// **CLEANUP-RULES §6 R-DENY-INSTALLDIR**：第四条 `%LOCALAPPDATA%\Programs\*` 是这一轮补的。
/// 原先它只活在 TS 测试夹具的 `leaf_fence()` 里 —— 也就是说产品侧从未真正拦过用户级安装根，
/// 只有测试在替它兜。现在它是地板：任何容器入口规则漏了它，`validate_fence` 当场整条拒。
pub const FENCE_MINIMUM_DENY_PATTERNS: [&str; 5] = [
    r"%WINDIR%\*",
    r"%PROGRAMFILES%\*",
    r"%SYSTEMDRIVE%\Program Files (x86)\*",
    // 地板而不是某条规则的私事：T6 真机跑出来 `installer-artifacts` 会吃 Defender 的特征库，
    // 放进最小必含集 ⇒ 以后任何一条容器入口规则漏了它，`validate_fence` 当场整条拒，
    // 而不是等下一次真机对账再发现。
    r"%PROGRAMDATA%\Microsoft\Windows Defender\*",
    // R-DENY-INSTALLDIR（cleanup-rules.md §6）：用户级安装根里是**装好的应用本体**
    // （真机实测 `…\Programs\Microsoft VS Code\Resources\app\Cache` 被 `app-cache-data`
    // 收走过 9000 字节 —— 那是 `Cache` 名字判据的固有失效面，不是偶然）。
    r"%LOCALAPPDATA%\Programs\*",
];

/// **「名字叫 cache 也不是缓存」** —— cleanup-rules.md §6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的
/// guard，按**路径后缀 + basename** 判，而不是按整棵禁止根判。
///
/// 为什么它不是禁止根：`%LOCALAPPDATA%\Microsoft` 整棵禁掉会顺手关掉两条**已上线**的规则
/// （`thumbnail-cache` 住的 `…\Windows\Explorer`、`error-reporting` 住的 `…\Windows\WER\*`），
/// 那是拿真能回收的字节去换一个 guard（cleanup-rules.md §10：0 命中只许写「本机 0 命中」）。
/// 而文档对这两类的判据本来就是 **guard**（「名字叫 cache 也不是缓存」），所以它该落在判据层。
///
/// 命中判据（两条同时成立）：
///  · basename 命中 [`USER_DATA_LEAF_NAMES`]（约定成俗的缓存/临时名 —— 认的是包的样子，不认谁家的包）；
///  · 路径里**含**表中某一段（`Microsoft\` / `Windows Defender\` / `Windows\` / `SystemApps\`）。
///
/// 命中之后**不枚举、不认领**，并在 `exclusions[]` 里点名到那个具体目录
/// （`ExclusionReason::UserDataLeaf`）。方向是少删：宁可漏掉一块 Microsoft 下的真缓存，
/// 也不许把 Edge 的登录态当渲染层缓存端走。
///
/// 与 TS `core/rules/types.ts` 的 `USER_DATA_LEAF_RELATIVE` / `USER_DATA_LEAF_NAMES` 逐条相同。
pub const USER_DATA_LEAF_RELATIVE: [&str; 4] = [
    r"Microsoft\",
    // Defender 的特征库本体不在缓存名单里，但它的临时更新目录会叫 `Temp`/`Cache`
    r"Windows Defender\",
    r"Windows\",
    // MSIX 包的每应用状态：`…\Packages\Family_x64__abc\LocalCache\…`
    r"SystemApps\",
];

/// 命中上表路径之后，**还要**这些 basename 之一才算「用户数据容器」（两者同时成立）。
/// 这批名字是 Chromium / Electron / UWP 三方共用的约定名 —— 正因如此它们才既像缓存、
/// 又常常被用户数据借用（`LocalCache\Roaming\…` 与 `LocalCache\Local\…\Cache` 长同一个前缀）。
pub const USER_DATA_LEAF_NAMES: [&str; 12] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "ShaderCache",
    "GrShaderCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "CachedData",
    "blob_storage",
    "CacheStorage",
    "component_crx_cache",
];

/// Windows 环境变量名（大写形式）。值必须是**绝对路径**。
///
/// M5-P1 T1：7→8 补 `PROGRAMFILES`（plan §4.1）。`CONTAINER_VARS` 里本来就有它，
/// 围栏要 deny Program Files 就得能用同一套解析口径**命名**它 —— 用字面盘符会让
/// 「围栏」和「被围栏保护的东西」不是同一套解析，那是防护自己的口径分裂。补齐是收敛不是扩张。
pub const RULE_ENV_KEYS: [&str; 8] = [
    "SYSTEMDRIVE",
    "WINDIR",
    "TEMP",
    "LOCALAPPDATA",
    "APPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "USERPROFILE",
];

/// 「裸环境变量 = 容器」名单：`%LOCALAPPDATA%` 这种写法本身就是一个宽容器，不许当清理范围。
/// 项目书给的对照例子正是「`C:\Users\x\AppData\Local\Temp` 可以，`AppData` 不行」。
/// **`%TEMP%` 不在其列** —— 它本身就已经是一个叶子级目录。
///
/// ⚠️ 这一份必须与 TS `types.ts:138` 的 `CONTAINER_VARS` **逐条相同**。它原先只有 6 条
/// （漏了 `PROGRAMDATA` / `PROGRAMFILES` / `HOMEDRIVE` / `HOMEPATH`），
/// 后果是这四条裸容器在 Rust 侧**不被拦**、直接拿去当清理地盘 —— 那是"多删"的方向。
pub const CONTAINER_VARS: [&str; 10] = [
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// 作为路径**最后一段**出现时视为容器的名字（`...\AppData\Local` 的 `Local`、`...\Users` 的 `Users`）。
/// 与 TS `types.ts:152` 的 `BROAD_LEAF_NAMES` 逐条相同。
pub const BROAD_LEAF_NAMES: [&str; 11] = [
    "appdata",
    "local",
    "roaming",
    "locallow",
    "users",
    "windows",
    "winnt",
    "programdata",
    "program files",
    "program files (x86)",
    "onedrive",
];

/// **第三方代码树**的名字：作为 leaf 下降时**子目录**的那一段出现 → 整棵子树不进采集。
///
/// 与 TS `types.ts` 的 `PACKAGE_TREE_NAMES` 逐条相同、**同序**
/// （`engine.rs::the_package_tree_list_is_identical_on_both_sides` 钉着两侧同串）。
///
/// 为什么是"不进入"而不是"进入后过滤"：这一族的判据是 basename，而 basename 匹配按 Windows
/// 语义必须大小写不敏感 —— 于是采集名单里一个名字能命中同名的**源码目录**
/// （真机实测：`…\node_modules\undici\lib\cache`、`…\hono\dist\middleware\cache`）。
/// 删掉的不是缓存，是已装应用的代码。M5-P1 的形状判据防住"名字不像缓存"，
/// 防不住"同名但语义是代码" —— 那是这一族判据的固有失效面，所以围栏写在**枚举之前**：
/// 包树目录不被打开，其中任何东西都不可能被认领（plan §0.2「拒整条 > 过滤命中」同一个形状）。
///
/// 匹配口径复用 `BROAD_LEAF_NAMES` 那一条（basename 小写后**整名相等**，见
/// `validate.rs` 的 `BROAD_LEAF_NAMES.contains(&last_lower.as_str())` 与 TS 侧同一法）——
/// 不新增第二把 glob（plan Global Constraints）。
///
/// 这一张表**只作用于 leaf 下降**（`engine.rs::walk_leaf` / `engine.ts::walkLeaf`）。
/// 模板地盘（`dev-tool-cache`、`user-downloads-installers` 与既有 15 条）走
/// `collect_territory`，一个字都不受影响。
///
/// 裁定 2 未定，见 `docs/superpowers/plans/2026-10-13-deepclean-tauri-m5-p2.md` §5 末节。
pub const PACKAGE_TREE_NAMES: [&str; 10] = [
    "node_modules",
    "site-packages",
    "dist",
    "lib",
    "src",
    "build",
    ".git",
    "target",
    "venv",
    ".venv",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::builtin_rules;

    /// **两份字段名单与真实形状的两向对账。**
    /// 序列化一条真实规则，键集合必须**恰好**等于两份名单的并集 —— 少了说明名单漏登记，
    /// 多了说明有字段没进任何名单（那样它就会被"未知字段"判据误拒）。
    #[test]
    fn the_two_field_lists_cover_the_real_shape_exactly() {
        // 用**两个可选字段都写了**的那条规则 —— 只挑第一条会因 `skip_serializing_if`
        // 少两个键，那是序列化策略不是名单漏登记（我第一次就写错了这条）
        let rules = builtin_rules();
        let mut r = rules
            .iter()
            .find(|r| r.requires_detector.is_some() && r.excluded_from_default_selection.is_some())
            .expect("内置表里必须有一条两个可选字段都写了的规则")
            .clone();
        // M5-P1 T2：名单变成三份，对账的输入就得把三个都写上 ——
        // 新字段没进 serde 线格式时这条相等判据会红在**名单**上（漏登记长什么样就是这个），
        // 而不是让测试改成"取交集比"那种自我放宽。
        r.requires_absent_app_fact = Some(true);
        let v = serde_json::to_value(&r).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<String> = obj.keys().cloned().collect();
        keys.sort();
        let mut expected: Vec<String> = RULE_FIELDS
            .iter()
            .chain(RULE_OPTIONAL_FIELDS.iter())
            .map(|s| s.to_string())
            .collect();
        expected.sort();
        assert_eq!(keys, expected, "序列化出来的键集合必须与两份名单的并集逐字相同");
    }

    #[test]
    fn optional_fields_are_absent_when_not_set() {
        // 没写的可选字段不该在 JSON 里留 `null`：TS 侧的"缺字段"判据按"键存在与否"看
        let r = &builtin_rules()[0];
        assert!(r.requires_detector.is_none());
        let v = serde_json::to_value(r).unwrap();
        assert!(!v.as_object().unwrap().contains_key("requiresDetector"));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        // 有人往数据里塞行为（`action` / 函数字段）—— 必须当场拒，不许静默忽略
        let bad = r#"{
            "id":"x","name":"X","category":"temp","description":"d",
            "paths":["%TEMP%"],"scanner":{"filePatterns":[],"olderThanDays":null,"recursive":true},
            "riskLevel":"safe","cleanStrategy":"delete-all","recoverable":false,
            "action":"rm -rf"
        }"#;
        let e = serde_json::from_str::<Rule>(bad).unwrap_err().to_string();
        assert!(e.contains("action"), "错误信息要点名是哪个字段：{e}");
    }

    #[test]
    fn missing_required_fields_are_rejected() {
        let bad = r#"{"id":"x","name":"X"}"#;
        assert!(serde_json::from_str::<Rule>(bad).is_err());
    }

    #[test]
    fn a_rule_with_optional_fields_parses() {
        // **这条是承重墙**：带 `requiresDetector` 的规则必须能过解析，
        // 否则它整条被拒 → 地盘从可回收合计里静默消失
        let ok = r#"{
            "id":"maven-repository","name":"Maven","category":"dev-cache","description":"d",
            "paths":["%USERPROFILE%\\.m2\\repository"],
            "scanner":{"filePatterns":[],"olderThanDays":null,"recursive":true},
            "riskLevel":"caution","cleanStrategy":"delete-all","recoverable":true,
            "requiresDetector":"maven","excludedFromDefaultSelection":true
        }"#;
        let r: Rule = serde_json::from_str(ok).expect("带可选字段的规则必须能过");
        assert_eq!(r.requires_detector.as_deref(), Some("maven"));
        assert_eq!(r.excluded_from_default_selection, Some(true));
    }

    /// M5-P1 T1（plan §6-T1）：`RuleCategory` 8→10，新增 `app-transient`、`installer-leftover`。
    /// M5-P2 P2-T4（plan §2.6）：10→11，新增 `orphan-data`。
    /// 与 TS `RULE_CATEGORIES`（`core/rules/types.ts`）逐条同、同序、同 kebab 串 ——
    /// 类别名是要上线格式与 `rejectedRules`/预览分组的判据，漂一个字符就是两套事实源。
    #[test]
    fn rule_categories_list_has_eleven_members() {
        let all = [
            RuleCategory::Temp,
            RuleCategory::BrowserCache,
            RuleCategory::ThumbnailCache,
            RuleCategory::ShaderCache,
            RuleCategory::ErrorReporting,
            RuleCategory::RecycleBin,
            RuleCategory::DevCache,
            RuleCategory::Duplicate,
            RuleCategory::AppTransient,
            RuleCategory::InstallerLeftover,
            RuleCategory::OrphanData,
        ];
        assert_eq!(all.len(), 11, "闭集必须恰好十一个成员");
        let kebab: Vec<String> = all
            .iter()
            .map(|c| serde_json::to_value(c).unwrap().as_str().unwrap().to_string())
            .collect();
        let uniq: std::collections::BTreeSet<&String> = kebab.iter().collect();
        assert_eq!(uniq.len(), 11, "kebab 串两两不同：{kebab:?}");
        // 三个新成员的线格式逐字钉住（与 TS 侧 `rules-types.test.ts` 的闭集用例同判据）
        assert!(kebab.contains(&"app-transient".to_string()), "{kebab:?}");
        assert!(kebab.contains(&"installer-leftover".to_string()), "{kebab:?}");
        assert!(kebab.contains(&"orphan-data".to_string()), "{kebab:?}");
        let back: RuleCategory = serde_json::from_str("\"installer-leftover\"").unwrap();
        assert_eq!(back, RuleCategory::InstallerLeftover);
        // P2-T4 那一格的 kebab 串就是 TS `RULE_CATEGORIES` 里的那一个词，反序列化也必须认
        let back: RuleCategory = serde_json::from_str("\"orphan-data\"").unwrap();
        assert_eq!(back, RuleCategory::OrphanData);
    }

    #[test]
    fn a_scanner_with_leaf_fields_and_a_fence_parses_and_defaults_when_absent() {
        // T1 新字段的 serde 面：缺省 = 空表/无围栏（既有 15 条不写它们，行为逐字节不变）；
        // 写了则必须能进 `RuleScopeFence` 的 camelCase 线格式。
        let bare: RuleScanner =
            serde_json::from_str(r#"{"filePatterns":[],"olderThanDays":null,"recursive":true}"#).unwrap();
        assert!(bare.leaf_dirs.is_empty() && bare.leaf_files.is_empty() && bare.scope_fence.is_none());
        let full: RuleScanner = serde_json::from_str(
            r#"{"filePatterns":[],"olderThanDays":null,"recursive":true,
               "leafDirs":["Cache"],"leafFiles":["*.?.log"],
               "scopeFence":{"allowRoots":["%LOCALAPPDATA%"],"denyRoots":["%WINDIR%\\*"]}}"#,
        )
        .unwrap();
        assert_eq!(full.leaf_dirs, vec!["Cache"]);
        assert_eq!(full.leaf_files, vec!["*.?.log"]);
        let f = full.scope_fence.unwrap();
        assert_eq!(f.allow_roots, vec!["%LOCALAPPDATA%"]);
        assert_eq!(f.deny_roots, vec![r"%WINDIR%\*"]);
    }

    /// M5-P1 T2（spec §4.2 点名的那颗雷）：`requiresAbsentAppFact` 必须**同时**是
    /// ①能解析的线格式字段、②登记在 `RULE_OPTIONAL_FIELDS` 里、③缺省时不出现。
    /// 漏 ② 的代价不是报错，是带它的规则整条被判 `invalid-shape` → 地盘从合计里静默消失。
    #[test]
    fn an_app_fact_declaration_parses_and_is_registered_in_the_optional_list() {
        assert!(
            RULE_OPTIONAL_FIELDS.contains(&"requiresAbsentAppFact"),
            "可选字段漏登记 = 规则静默消失（types.rs 顶部那段警告）"
        );
        assert!(!RULE_FIELDS.contains(&"requiresAbsentAppFact"), "并进必填就等于要求 15 条内置规则都写它");
        let r: Rule = serde_json::from_str(
            r#"{"id":"ghost","name":"G","category":"app-transient","description":"d",
                "paths":["%LOCALAPPDATA%\\GhostApp"],
                "scanner":{"filePatterns":[],"olderThanDays":null,"recursive":true},
                "riskLevel":"high","cleanStrategy":"delete-all","recoverable":false,
                "requiresAbsentAppFact":true}"#,
        )
        .expect("带 requiresAbsentAppFact 的规则必须能过解析");
        assert_eq!(r.requires_absent_app_fact, Some(true));
        let bare: Rule = serde_json::from_str(
            r#"{"id":"ghost","name":"G","category":"app-transient","description":"d",
                "paths":["%LOCALAPPDATA%\\GhostApp"],
                "scanner":{"filePatterns":[],"olderThanDays":null,"recursive":true},
                "riskLevel":"high","cleanStrategy":"delete-all","recoverable":false}"#,
        )
        .expect("没写这个字段的规则照旧合规（回归轴）");
        assert_eq!(bare.requires_absent_app_fact, None);
        let v = serde_json::to_value(&bare).unwrap();
        assert!(!v.as_object().unwrap().contains_key("requiresAbsentAppFact"), "没写就不该上线");

        // 机器事实三态的线格式（注入表的价值方向：缺键与 Unknown 同向，都不许提议）
        for (json, want) in [
            (r#""present""#, AppFact::Present),
            (r#""absent""#, AppFact::Absent),
            (r#""unknown""#, AppFact::Unknown),
        ] {
            let got: AppFact = serde_json::from_str(json).unwrap();
            assert_eq!(got, want);
            assert_eq!(serde_json::to_value(got).unwrap(), json.parse::<serde_json::Value>().unwrap());
        }
    }
}
