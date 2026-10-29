//! 内置规则表（M5-P1 T3b-ii 起 21 条；**M5-P2 P2-T4 起 22 条** —— 第 22 条 `orphan-app-data`。
//! M5-P3 起它排在既有 15 条**之后**、六条形状规则**之前**，理由与量级见
//! plan `2026-10-14-deepclean-tauri-m5-p3.md` §1.3 / §2.5）。
//! **逐字段照抄** `core/rules/registry.ts`，字段名/取值/顺序
//! 不许自行发挥 ——
//! 两套实现对「什么可删」的判断只要差一条，就是两套事实源。
//!
//! 三条刻意的"不做"，照抄过来免得下一个人以为是漏项：
//!  · **Docker 不做**：§16 说的是「Docker 未使用数据」，那是 `docker system prune` 的结果，
//!    不是一条路径 —— 用假路径表达它等于撒谎。
//!  · **通用 Electron 缓存**：原先（V0.4 §16）写着「`%LOCALAPPDATA%\*\Cache` 这种一层通配的地盘
//!    大到无法证明它只碰渲染层缓存，不做」。**M5-P1 T3a 起这句被推翻**（spec §9 点名的一条改动）：
//!    `app-cache-data` 用 `leafDirs`（12 个 Chromium/Electron 约定名，只打 basename）+ **强制**
//!    `scopeFence` 把地盘从「任意深度任意目录」收窄成「已知角色名，且只在 AppData 三根之内」。
//!    代价照 spec §7.1 记着：名单人工维护，换台设备**少删**而不是多删。
//!  · **`node_modules` / `__pycache__` / virtualenv 不做**：路径模板里的 `*` 恰好匹配一层，
//!    "任意深度下任何叫 node_modules 的目录"需要无界递归匹配。硬凑一个
//!    `%LOCALAPPDATA%\*\node_modules` 只会漏掉所有非顶层项目 —— **看着像实现了、实际是假数字**。
//!    要做必须给引擎加 walk-time 目录名判据。（M5-P1 T2 起这个能力**已经有了**，但 plan §1 明写
//!    「能力解锁而不开闸」：`node_modules` 删了要重装且常含未提交的原生构建产物，性质不是缓存。）

use crate::types::{CleanStrategy, Risk, Rule, RuleCategory, RuleScanner, RuleScopeFence};

fn scan(file_patterns: &[&str], older_than_days: Option<u32>, recursive: bool) -> RuleScanner {
    RuleScanner {
        file_patterns: file_patterns.iter().map(|s| s.to_string()).collect(),
        older_than_days,
        recursive,
        // M5-P1 T1 的三个新字段一律缺省（空表 / 无围栏）—— 原有 15 条的行为逐字节不变
        leaf_dirs: Vec::new(),
        leaf_files: Vec::new(),
        scope_fence: None,
    }
}

fn paths(p: &[&str]) -> Vec<String> {
    p.iter().map(|s| s.to_string()).collect()
}

/* ------------------------------------------------------------------ *
 * M5-P1 T3a —— 容器入口那一族规则的共用形状（plan §5.1 / §5.2 / §5.3）
 *
 * 三条都是 **leaf 判据 + 强制围栏** 的形状：`paths` 降级成遍历入口（三根容器），
 * 真正的判据打在 basename 名单上，边界由 `scopeFence` 守。声明层
 * （`validate.rs::validate_rule_set`）要求这两件事同时出现，缺围栏整条拒。
 * ------------------------------------------------------------------ */

/// 三条规则共同的采集面 = `paths` = `allowRoots`（plan §5：AppData 三根，**不是**任意深度任意盘）。
const CONTAINER_ROOTS: [&str; 3] = ["%LOCALAPPDATA%", "%APPDATA%", "%PROGRAMDATA%"];

/// 围栏的地板：`denyRoots` 必须 ⊇ `FORBIDDEN_PATH_PATTERNS` 全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`
/// （spec §2.3 / plan §4.1–§4.3）。`%WINDIR%\*` 一条就**覆盖**了五条 `%WINDIR%\<组件>`（覆盖判据按
/// 解析后的段边界包含算，见 `validate_fence`），`System Volume Information` 只能自己点名；
/// 两处 Program Files 一条用第 8 个变量键 `%PROGRAMFILES%`、一条按 §4.2 的裁定写成
/// `%SYSTEMDRIVE%\Program Files (x86)\*`（**不**新增带括号的变量键）。
///
/// **CLEANUP-RULES §6 落地（本轮）**：`denyRoots` 与 `FORBIDDEN_PATH_PATTERNS` 逐条同序，
/// 另加两条**只在容器规则这一族里成立**的补充：
///  · `%USERPROFILE%\*`：AI 与用户数据的禁止根有一大半住在家目录（`.codex` / `.claude` / …），
///    而**家目录不是这些规则的采集面**（allowRoots 只有 AppData 三根）—— 围栏先于判据把它整棵关掉，
///    省得哪天有人给 allowRoots 加了 `%USERPROFILE%`，第一件事就是吃到那八个点目录。
///    ⚠️ 它必须**排在** `FORBIDDEN_PATH_PATTERNS` 那几条之后：覆盖判据要求每一条禁止根
///    都能在 denyRoots 里找到**自己**那一条，而不是"被一个更宽的祖先顺手罩住"。
///  · `%LOCALAPPDATA%\Program Files`：宽容器名（`BROAD_LEAF_NAMES` 里的 `program files`）
///    在 Local 下也可能出现，它不在禁止根表里（那张表按路径而不是按名字判），但同样不许进采集。
///
/// ⚠️ 围栏根**不过** `BroadContainer`/`PatternNotLeaf` 那两条地盘判据（§4.3 的不对称，
/// 理由逐字写在 `validate_fence` 的注释里）—— 这里 `%PROGRAMDATA%` 当 deny 根用不会被自己拒掉。
fn container_fence() -> RuleScopeFence {
    RuleScopeFence {
        allow_roots: paths(&CONTAINER_ROOTS),
        deny_roots: paths(&[
            r"%WINDIR%\*",
            r"%SYSTEMDRIVE%\System Volume Information",
            r"%PROGRAMFILES%\*",
            r"%SYSTEMDRIVE%\Program Files (x86)\*",
            // T6 真机对账逮到的越界：`installer-artifacts` 把
            // `%PROGRAMDATA%\Microsoft\Windows Defender\Definition Updates\Updates` 当成
            // 「更新器留下的安装包」收走了。那是**病毒特征库**，不是缓存 —— 删了的后果不是
            // "重新下载"而是"这台机器在更新回来之前不设防"，而每台 Windows 都有这个目录，
            // 换设备只会更严重。第三方杀软装在 Program Files 下、已经被上面两条挡住了。
            r"%PROGRAMDATA%\Microsoft\Windows Defender\*",
            // 上面四条是 `FENCE_MINIMUM_DENY_PATTERNS` 的地板；下面这些逐条对应
            // `FORBIDDEN_PATH_PATTERNS` 里**落在 allowRoots 之内**的禁止根（§6 的四个 deny 类别）。
            // 顺序：地板 → 禁止根 → 容器族的补充，见函数文档最后那段关于覆盖判据的说明。
            r"%LOCALAPPDATA%\Microsoft",
            r"%LOCALAPPDATA%\Packages",
            r"%PROGRAMDATA%\Package Cache",
            r"%APPDATA%\Claude",
            r"%APPDATA%\OpenAI",
            r"%APPDATA%\ZCode",
            r"%APPDATA%\com.qodercn.app.stable",
            r"%APPDATA%\Tencent",
            r"%APPDATA%\douyin",
            r"%APPDATA%\Spotify",
            r"%APPDATA%\NutstoreClient",
            r"%USERPROFILE%\*",
            r"%LOCALAPPDATA%\Program Files",
            // 地板第五条（CLEANUP-RULES §6 R-DENY-INSTALLDIR）。它同时也在
            // `REPORT_ONLY_ROOT_PATTERNS` 里 —— 那张表管"任何规则都不许认领"，这一条管
            // "连枚举都不发生"：用户级 Programs 是应用本体，没有什么可挑的。
            r"%LOCALAPPDATA%\Programs\*",
        ]),
    }
}

/// 崩溃转储目录的**形状**名单（plan §5.5 / spec §1「形状」那一类）。
/// 第一版这条规则写的是 `paths = %LOCALAPPDATA%\CrashDumps` 直取 —— T6 真机对账发现那样
/// `%PROGRAMDATA%\...\werdump` 里那 72 MiB 转储**根本没被试过**（既无 finding 也无排除记录，
/// 是白漏，不是被别的规则认领走）。改成容器入口 + 目录名判据之后，换台设备上有
/// `Razer\Synapse3\CrashDumps`、`...\DumpFolder` 之类的也照样收得到。
/// 只收 `*.dmp`，所以名单里出现同名非转储目录也不会误吃。
const CRASH_DUMP_LEAF_DIRS: [&str; 4] = ["CrashDumps", "werdump", "DumpFolder", "Dumps"];

/// leaf 形状规则的 scanner：三条都递归、都不按时间过滤、都带同一份围栏。
fn leaf_scan(dirs: &[&str], files: &[&str], patterns: &[&str]) -> RuleScanner {
    RuleScanner {
        file_patterns: patterns.iter().map(|s| s.to_string()).collect(),
        older_than_days: None,
        recursive: true,
        leaf_dirs: dirs.iter().map(|s| s.to_string()).collect(),
        leaf_files: files.iter().map(|s| s.to_string()).collect(),
        scope_fence: Some(container_fence()),
    }
}

/// 机器事实闸那一族（M5-P2 P2-T4 的 `orphan-app-data`）的 scanner：**两份 leaf 名单都是空的**。
///
/// 为什么必须空着：P2-T3 的声明层闸（`validate.rs::requires_absent_app_fact_with_leaf_dirs_is_refused`）
/// 把 `requiresAbsentAppFact` 与 `leafDirs`/`leafFiles` 定成**互斥**，混给整条拒
/// （`ambiguous-leaf-mode`）。第三种采集模式的采集根**不是** basename 名单在任意深度命中决定的，
/// 而是引擎取「入口目录的直属子目录」逐格查注入的机器事实表（plan §2.4 / spec §3 3.5
/// 那句「`LOCALAPPDATA`/`APPDATA`/`PROGRAMDATA` 顶层一项」）—— 名单在这里没有对应的语义，
/// 给它填东西要么被闸拒掉，要么让同一条路径同时被表批准、被名单命中，字节算在哪一档说不清。
/// 围栏倒是**必须**有，而且就是容器规则那一份 `container_fence()`：`validate.rs` 要求带这个字段的
/// 规则必须容器入口 + 覆盖齐全的围栏，否则等于让一张机器事实表去批准整个用户目录树。
fn app_fact_scan() -> RuleScanner {
    RuleScanner {
        file_patterns: Vec::new(),
        older_than_days: None,
        recursive: true,
        leaf_dirs: Vec::new(),
        leaf_files: Vec::new(),
        scope_fence: Some(container_fence()),
    }
}

/// plan §5.1 的 12 个 Chromium / Electron 约定缓存名（spec §1「形状」那一类：几千个应用共用同一批名字）。
/// 顺序即名单顺序，两侧逐字同（`core/rules/registry.ts` 的 `APP_CACHE_LEAF_DIRS`）。
const APP_CACHE_LEAF_DIRS: [&str; 12] = [
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

/// plan §5.2：**只认轮转件**。`*.?.log` 吃 `HiviewPlatform.3.log` 而不吃正在写的 `HiviewPlatform.log`
/// —— 这条 glob 语义是本轮唯一挡住"删掉正在被写的日志"的判据，有单测钉住（`engine.rs`）。
const ROTATED_LOG_LEAF_FILES: [&str; 3] = ["*.?.log", "*.log.??", "*.etl"];

/// plan §5.3 的更新目录形状。⚠️ **故意没有 `Packages`**（plan §5 第一条排除项）：
/// `%LOCALAPPDATA%\Packages` 是 UWP 每应用状态目录（参考机 879.6 MiB / 12,744 文件），
/// 把它当"更新目录"是本轮最大的一次潜在误删。这条由 `builtin.rs` 的
/// `packages_is_in_any_leaf_dir_list_is_red_blocked` 与 `engine.rs` 的行为用例双向钉住。
const UPDATER_LEAF_DIRS: [&str; 5] = ["*updater", "*Updater", "pending", "Update", "updates"];

/// plan §5.3 的安装包形状（认的是**包的样子**，不认是谁家的包 —— spec §1「命名惯例」那一类）。
const INSTALLER_FILE_PATTERNS: [&str; 10] = [
    "*.exe", "*.msi", "*.msp", "*.nupkg", "*.appx", "*.msix", "*.zip", "*.7z", "*.rar", "*.iso",
];

/// plan §5.4（M5-P1 T3b-i）：**显式模板**那一族 —— 跨设备稳定的工具约定，不是本机特有路径，
/// 也不是 leaf 名单。顺序即名单顺序，与 `core/rules/registry.ts` 的 `devToolCache.paths` 逐字同。
const DEV_TOOL_CACHE_PATHS: [&str; 6] = [
    r"%LOCALAPPDATA%\electron\Cache",
    r"%LOCALAPPDATA%\electron-builder\Cache",
    r"%LOCALAPPDATA%\NuGet\v3-cache",
    r"%LOCALAPPDATA%\NuGet\Cache",
    r"%PROGRAMDATA%\USOShared",
    r"%PROGRAMDATA%\USOPrivate",
];

pub fn builtin_rules() -> Vec<Rule> {
    let mut out = Vec::with_capacity(23);

    // §16 🟢「用户 Temp」。临时文件删掉就是删掉了（不像缓存能再生），
    // 而且里面可能是用户没保存的东西 → 如实标 false
    out.push(Rule {
        id: "windows-temp".into(),
        name: "Windows 临时文件".into(),
        category: RuleCategory::Temp,
        description:
            "当前用户 %TEMP% 及其子目录里的临时文件；安装器、压缩软件、应用崩溃留下的中间产物"
                .into(),
        paths: paths(&["%TEMP%"]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // §16 🟢「浏览器缓存」：只碰 Cache / Code Cache，绝不碰 User Data 下的 Profile
    out.push(Rule {
        id: "browser-cache".into(),
        name: "浏览器缓存".into(),
        category: RuleCategory::BrowserCache,
        description:
            "Chrome / Edge 各 Profile 的 HTTP 缓存与代码缓存；不含书签、密码、历史、扩展等用户数据"
                .into(),
        paths: paths(&[
            r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache",
            r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Code Cache",
            r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Cache",
            r"%LOCALAPPDATA%\Microsoft\Edge\User Data\*\Code Cache",
        ]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // §16 🟢「缩略图缓存」。`Explorer` 目录里同放着 iconcache 与一堆随机名条目，
    // 所以 filePatterns 精确到 `thumbcache_*.db` 而不是把整个目录端走
    out.push(Rule {
        id: "thumbnail-cache".into(),
        name: "缩略图缓存".into(),
        category: RuleCategory::ThumbnailCache,
        description:
            "资源管理器缩略图数据库 thumbcache_*.db（Explorer 目录里的 iconcache 与随机名条目不在范围内）"
                .into(),
        paths: paths(&[r"%LOCALAPPDATA%\Microsoft\Windows\Explorer"]),
        scanner: scan(&["thumbcache_*.db"], None, false),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // §16 🟢「Shader Cache」
    out.push(Rule {
        id: "shader-cache".into(),
        name: "Shader 缓存".into(),
        category: RuleCategory::ShaderCache,
        description:
            "Direct3D 与显卡驱动的着色器编译缓存，清理后由系统/驱动按需重新生成（首次启动会变慢）"
                .into(),
        paths: paths(&[
            r"%LOCALAPPDATA%\D3DSCache",
            r"%LOCALAPPDATA%\NVIDIA\DXCache",
            r"%LOCALAPPDATA%\NVIDIA\GLCache",
            // 免确认清理档（M6）：AMD 驱动这一族的同语义缓存，与上面三处同判据（可再生）
            r"%LOCALAPPDATA%\AMD\DxCache",
            r"%LOCALAPPDATA%\AMD\GLCache",
        ]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // §16 🟢「部分日志」：WER 的队列与归档
    out.push(Rule {
        id: "error-reporting".into(),
        name: "错误报告与崩溃日志".into(),
        category: RuleCategory::ErrorReporting,
        description:
            "Windows Error Reporting 的报告队列与归档（.wer 与随附的转储）；删除后不影响系统，但崩溃现场就没了"
                .into(),
        paths: paths(&[
            r"%LOCALAPPDATA%\Microsoft\Windows\WER\ReportQueue",
            r"%LOCALAPPDATA%\Microsoft\Windows\WER\ReportArchive",
            r"%PROGRAMDATA%\Microsoft\Windows\WER\ReportQueue",
            r"%PROGRAMDATA%\Microsoft\Windows\WER\ReportArchive",
        ]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // 回收站：清空是**不可逆**的用户行为 → 🔴 + manual-only。
    // 引擎照常算出它占多少空间（用户要看），但它永远不进「可回收」合计。
    out.push(Rule {
        id: "recycle-bin".into(),
        name: "回收站".into(),
        category: RuleCategory::RecycleBin,
        description:
            "本卷回收站占用空间（$Recycle.Bin 下各 SID 的内容）。只报告占用，不提供普通清理入口".into(),
        paths: paths(&[r"%SYSTEMDRIVE%\$Recycle.Bin"]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Forbidden,
        clean_strategy: CleanStrategy::ManualOnly,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        // M5-P1 T2 新增的可选字段：内置 15 条都不声明机器事实闸（行为逐字节不变）
        requires_absent_app_fact: None,
    });

    // §26 Phase 4「然后逐步增加」：npm / pip / Gradle / VS Code —— §16 🟡 谨慎。
    // **这四条必须排在 §21 那五条前面**：`claimed` 表是先声明者计账，顺序不同就是两套事实源
    // （顺序=评估顺序，`registry.ts` 的 BUILTIN_RULES 就是这个顺序）。
    out.push(dev_cache(
        "npm-cache",
        "npm 缓存",
        "npm 的内容寻址缓存（_cacache）。清掉后下次安装要重新下载包，不影响已装好的 node_modules",
        &[r"%LOCALAPPDATA%\npm-cache", r"%USERPROFILE%\.npm-global\cache"],
        "npm",
        None,
    ));
    out.push(dev_cache(
        "pip-cache",
        "pip 缓存",
        "pip 的下载与 wheel 构建缓存。清掉后下次 pip install 重新联网下载，不动任何 site-packages",
        &[r"%LOCALAPPDATA%\pip\Cache"],
        "pip",
        None,
    ));
    out.push(dev_cache(
        "gradle-cache",
        "Gradle 缓存",
        "Gradle 的依赖与构建缓存目录 .gradle\\caches（不含 wrapper 下载与 gradle.properties）",
        &[r"%USERPROFILE%\.gradle\caches"],
        "gradle",
        None,
    ));
    out.push(dev_cache(
        "vscode-cache",
        "VS Code 缓存",
        "VS Code（Electron）的 Cache 与 CachedData；settings.json、扩展与全局历史都不在范围内",
        &[r"%APPDATA%\Code\Cache", r"%APPDATA%\Code\CachedData"],
        "vscode",
        None,
    ));

    // §21「Java / Maven」：只认 `.m2\repository`，`.m2\settings.xml` 是配置不是缓存
    out.push(dev_cache(
        "maven-repository",
        "Maven 仓库缓存",
        "Maven 下载的依赖仓库 .m2\\repository。清掉后下次构建重新下载；settings.xml 与本地凭据配置不在范围内",
        &[r"%USERPROFILE%\.m2\repository"],
        "maven",
        None,
    ));
    // §21「Node.js / pnpm store」：两个常见落点都收（v3 与新版默认布局）
    out.push(dev_cache(
        "pnpm-store",
        "pnpm 存储",
        "pnpm 的全局内容存储（硬链接的源头）。清掉后下次 install 重新下载，已链接进项目的文件不受影响",
        &[r"%LOCALAPPDATA%\pnpm-store", r"%LOCALAPPDATA%\pnpm\store"],
        "pnpm",
        None,
    ));
    // §21「Node.js / Yarn cache」：yarn v1 的 `yarn cache dir`
    out.push(dev_cache(
        "yarn-cache",
        "Yarn 缓存",
        "Yarn v1 的全局包缓存（yarn cache dir 指的地方）。项目内的 .yarn/cache 不在范围内，那是项目自己的依赖",
        &[r"%LOCALAPPDATA%\Yarn\Cache"],
        "yarn",
        None,
    ));
    // §21「AI / 本地模型」的**缓存**部分；模型本体按项目书归「大文件」而不是自动删除
    out.push(dev_cache(
        "huggingface-cache",
        "Hugging Face 下载缓存",
        "datasets/transformers 的下载缓存目录 .cache\\huggingface。删了会重新下载；.ollama\\models 这类模型本体不在这里",
        &[r"%USERPROFILE%\.cache\huggingface"],
        "huggingface",
        // §3.5：一键全选点不到它。这个目录名义上是"缓存"，装的实际是模型权重本身 ——
        // `recoverable: true` 说的是"删了还能重新下载"，而重下要网、要几小时、要 HF token。
        // 「可再生」与「可以替用户一键勾掉」是两件事，后者单独设一道闸。
        Some(true),
    ));
    // §21「Android SDK Cache」：只收 SDK 安装器的下载残留
    out.push(dev_cache(
        "android-sdk-temp",
        "Android SDK 安装残留",
        "Android SDK 安装器留下的 .temp 下载包。SDK 组件本身与模拟器镜像（.android\\avd）都不算缓存，不在范围内",
        &[r"%LOCALAPPDATA%\Android\Sdk\.temp"],
        "android-sdk",
        None,
    ));

    /* -------------------------------------------------------------- *
     * M5-P2 P2-T4（plan §2.6 / spec §3 3.5 + §4.3）—— 第 22 条，**表上第一条判据来自
     * 机器事实（而不是路径、形状、命名惯例）的规则**。M5-P3 起它排在既有 15 条**之后**、
     * 下面那六条形状规则**之前**（顺序即 `claimed` 计账顺序，量级见
     * plan `2026-10-14-deepclean-tauri-m5-p3.md` §2.5；这一格由 `engine.rs` 那两条同名孪生守着）。
     * 它与前面二十一条的差别不是"地盘更大"：
     * 那二十一条说"这块地方长得像可删的东西"，这一条说"**这个应用已经不在了**，所以它留下的
     * 设置与数据没人要了" —— 后者是这台机器此刻的状态，规则表里没有，只能由注入的
     * `app_facts` 表给出（`crates/appfacts`，六路只读取证）。
     *
     * 三个安全方向合起来才是这条规则（plan §0.1：它的失败方向是删掉**活应用**的数据，
     * 比 M5-P1 任何一条都重）：
     *  · `requires_absent_app_fact: Some(true)` —— 采集根 = 三根容器的**直属子目录**，
     *    逐格查表，**只有 `Absent` 才收**；`Present` / `Unknown` / 缺键各记一条分名的排除
     *    （plan §2.4，P2-T3 落的引擎半边）。空表 ⇒ 一条都不提议（spec §4.2「缺键 ≠ 可删」）。
     *  · 没有 `leafDirs` / `leafFiles` —— 与 `requiresAbsentAppFact` **互斥**是 P2-T3 的声明层闸
     *    （混给整条拒，`ambiguous-leaf-mode`）；采集根由引擎取直属子目录决定，不由名单在任意深度命中。
     *  · 🟠 + `excluded_from_default_selection: Some(true)` + `recoverable: false`
     *    （spec §4.3 定死的三个值，逐个理由见下面 `ORPHAN_APP_DATA_DESCRIPTION` 的注释与那条用例）。
     *
     * **为什么类别是新的一格 `orphan-data` 而不是 `app-transient`**：那一族的名字承诺的是
     * "运行期产物、删了能被产品自己的动作再生出来"（缓存重下、包重装），而这一条的地盘是某个应用的
     * **设置与数据本体** —— 应用都没了，没有任何产品动作会把它再生成。给它挂 `app-transient`
     * 与给它 `recoverable: true` 是同一个方向的撒谎：两个词都在替用户宣布"失去了也不要紧"。
     * -------------------------------------------------------------- */

    out.push(Rule {
        id: "orphan-app-data".into(),
        name: "卸载残留的应用数据".into(),
        category: RuleCategory::OrphanData,
        description: r"某个应用在这台机器上已经不在了 —— 应用事实探针查得到它的安装痕迹（注册表里的厂商键、服务、计划任务、开始菜单快捷方式），卸载表条目、安装目录、进程镜像与 MSIX 包这四条本体证据却一路都没证出应用还在；而它在 %LOCALAPPDATA%、%APPDATA%、%PROGRAMDATA% 三根的**顶层**留下的那个数据目录还在。删了会失去这个应用的**全部本地设置与数据**：登录态、配置、词库、游戏存档、本地数据库那一类。应用不会再回来把它们重新生成一遍，回收站里也不会有第二份。⚠️ 这是一次**推断，不是事实**：机器上没有任何一条记录写着「这个应用已被卸载」，判据只是「有安装痕迹 ∧ 四路查无本体」。推断错的那一侧是「应用其实还在、只是探针没查到」—— 那样你失去的是一个还在用的应用的设置和数据，而它不会自己回来。探针证出本体在场、取证取到一半取不着、以及根本没被交代去看的目录，一个都不提议，只在报告里逐个点名是哪一种（这也让「这个功能没接线」与「这个功能看过但没查出东西」在报告里分得开）"
            .into(),
        paths: paths(&CONTAINER_ROOTS),
        scanner: app_fact_scan(),
        risk_level: Risk::High,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: Some(true),
        requires_absent_app_fact: Some(true),
    });

    /* -------------------------------------------------------------- *
     * M5-P1 T3a（plan §5.1–§5.3）—— 三条**容器入口 + leaf 判据 + 围栏**。
     *
     * 顺序即地盘：`claimed` 表先声明者计账（`engine.rs::take_file`），所以这三条**必须**排在
     * 既有 15 条之后 —— 它们的路径覆盖了前 15 条的入口容器，插到表头就会把 `npm-cache`（第 7 条）
     * 与 `browser-cache`（第 2 条）的地盘抢走（plan §7 变异 5 钉的就是这件事）。
     * 双计契约由 `engine.rs::app_cache_data_does_not_reclaim_npm_cache_or_browser_cache` 证明。
     * **M5-P3 的改动**：第 22 条（上面那块）现在排在它们**之前**，被它认领走的字节改挂 🟠 且不进
     * 默认勾选（本机 201.56 MiB，plan m5-p3 §2.5）。这一格与变异 5 不冲突 —— 前移的上界仍是
     * 「既有 15 条之后」，由 `rule_22_sits_after_the_baseline_and_before_the_six_shape_rules` 与
     * `engine.rs::the_first_fifteen_rules_never_lose_territory_to_rule_22` 两条一起守。
     * -------------------------------------------------------------- */

    // plan §5.1 🟡「应用缓存与临时数据」
    out.push(Rule {
        id: "app-cache-data".into(),
        name: "应用缓存数据".into(),
        category: RuleCategory::AppTransient,
        description:
            "应用（Chromium / Electron 一族）在 AppData 三根下任意深度、名字是 Cache / Code Cache / GPUCache 等约定名的缓存目录；删了会失去缓存本身，应用会自行重新生成，书签、密码、历史、登录态与用户配置都不在范围内"
                .into(),
        paths: paths(&CONTAINER_ROOTS),
        scanner: leaf_scan(&APP_CACHE_LEAF_DIRS, &[], &[]),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    // plan §5.2 🟡「应用轮转日志」：recoverable **false** —— 日志删了就没了，不像缓存能再生
    out.push(Rule {
        id: "app-rotated-logs".into(),
        name: "应用轮转日志".into(),
        category: RuleCategory::AppTransient,
        description:
            "AppData 三根下任意深度的**轮转**日志（Foo.1.log / Foo.log.01 / *.etl 这些已经封档的名字）；正在被写的同名无后缀日志（Foo.log）一条都不碰。删了会失去历史日志，无法还原"
                .into(),
        paths: paths(&CONTAINER_ROOTS),
        scanner: leaf_scan(&[], &ROTATED_LOG_LEAF_FILES, &[]),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    // plan §5.3 🟡「更新目录里的安装包」：UWP 的 Packages 不在名单里（见 UPDATER_LEAF_DIRS 的注释）
    out.push(Rule {
        id: "installer-artifacts".into(),
        name: "更新目录里的安装包".into(),
        category: RuleCategory::InstallerLeftover,
        description:
            "更新目录（*-updater / pending / Update / updates）里留下的安装包与压缩包（exe / msi / nupkg / zip 一类）。删了会失去这些已经下完的安装包，需要时能重新下载；应用自带的运行时目录与 UWP 的 Packages 每应用状态目录不在范围内"
                .into(),
        paths: paths(&CONTAINER_ROOTS),
        scanner: leaf_scan(&UPDATER_LEAF_DIRS, &[], &INSTALLER_FILE_PATTERNS),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    /* -------------------------------------------------------------- *
     * M5-P1 T3b-i（plan §5.4–§5.5）—— 表尾再追加两条 **app-transient**，
     * 但与上面三条不同一族：这两条**不走 leaf 机制**，判据就是那六个/一个**显式路径模板**
     * （跨设备稳定的工具约定），所以既没有 `leaf*` 也就**没有 `scopeFence`**
     * （围栏是「容器入口 + 任意深度判据」那一族的配件，`validate.rs` 只在有 leaf 判据时才要求它）。
     * 仍然只能追加在表尾 —— 插到既有规则之前就是抢地盘（plan §7 变异 5）。
     * -------------------------------------------------------------- */

    // plan §5.4 🟡「开发工具与更新缓存」。⚠️ 地盘重叠**已登记不是漏做**：
    // `%LOCALAPPDATA%\electron\Cache` 与 `%LOCALAPPDATA%\NuGet\Cache` 的目录名同时命中第 16 条
    // `app-cache-data` 的 leafDirs，而 `claimed` 先声明者计账 —— 那两处字节归第 16 条，
    // 这条名下只剩 `claimed-by-other-rule`。方向是**归属**变化，不是双计（预估不虚高）。
    // 要不要把它排到 `app-cache-data` 之前是 T6 拿真机 golden 判的事。
    out.push(Rule {
        id: "dev-tool-cache".into(),
        name: "开发工具与更新缓存".into(),
        category: RuleCategory::AppTransient,
        description:
            "跨设备固定位置的开发工具与系统更新缓存：Electron 与 electron-builder 的下载缓存、NuGet 的 v3 与包缓存，以及 Windows 更新编排器（USO）的 USOShared / USOPrivate 下载目录。删了会失去这些已经下完的包，需要时能重新下载；工具本体、项目里的 node_modules 与已安装的系统更新都不在范围内"
                .into(),
        paths: paths(&DEV_TOOL_CACHE_PATHS),
        scanner: scan(&[], None, true),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    // plan §5.5 🟡「应用崩溃转储」：recoverable **false** —— 转储是崩溃那一次的现场，删了没有第二份。
    // 与第 5 条 `error-reporting`（WER 的 .wer 队列与归档）是两处地盘，且按 `*.dmp` 精确收、不端目录。
    out.push(Rule {
        id: "crash-dumps".into(),
        name: "应用崩溃转储".into(),
        category: RuleCategory::AppTransient,
        description:
            r"应用崩溃时由 Windows 生成的用户态内存转储（*.dmp），住在 CrashDumps / werdump / DumpFolder / Dumps 这类转储目录里（%LOCALAPPDATA%、%APPDATA%、%PROGRAMDATA% 三根下任意深度）。删了会失去崩溃现场，无法还原，但不影响系统与应用的运行；Windows Error Reporting 的报告队列与归档（.wer）归「错误报告与崩溃日志」那条，不在这里"
                .into(),
        paths: paths(&CONTAINER_ROOTS),
        scanner: leaf_scan(&CRASH_DUMP_LEAF_DIRS, &[], &["*.dmp"]),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    /* -------------------------------------------------------------- *
     * M5-P1 T3b-ii（plan §5.6）—— 表尾这一条是**整张表上第一档 🟠**。
     *
     * 它与前面二十条的差别不在判据（十种包形状与第 18 条 `installer-artifacts` 逐字同一份名单），
     * 在三件事同时变了：地盘是**用户自己的下载目录**、风险 **🟠 High**、**不进默认勾选**。
     * `excluded_from_default_selection: Some(true)` 那道闸原来只有 `huggingface-cache` 一条挂着
     * （§3.5「一键全选点不到 AI 模型」），这条是它的第二个成员 —— 由 `builtin.rs` 与
     * `rules-registry.test.ts` 的 §3.5 派生用例双向点名，两张名单必须同步改。
     *
     * 两个方向合起来才是这条规则的意思，缺一个都是半句话：
     *  · `reclaimable_bytes` **照算**（🟠 不是 🔴：§16 只把 🔴 排除在合计之外，
     *    `reclaimable_of()` = safe + caution + high），用户要能看见它值多少；
     *  · 默认勾选**点不到它**（`defaultUnselectableRuleIds()` 派生，界面只是搬运）。
     * 判据在 `engine.rs` 的 `a_high_rules_bytes_are_reclaimable_but_never_default_selected`
     * 与 `a_non_recursive_rule_claims_the_top_level_only`（TS `rules-registry.test.ts` 各一份同名）。
     * -------------------------------------------------------------- */

    // plan §5.6 🟠「下载目录里的安装包」：`recursive: false` = 只碰 Downloads 顶层，
    // 子目录（用户自己整理的 `Downloads\2023\` 一类）一条都不扫。recoverable **false** ——
    // 那是用户自己下载的文件，不是应用生成的缓存，删了不会自动重新生成。
    out.push(Rule {
        id: "user-downloads-installers".into(),
        name: "下载目录里的安装包".into(),
        category: RuleCategory::InstallerLeftover,
        description: r"当前用户 %USERPROFILE%\Downloads 目录**顶层**（不递归进子目录）里名字像安装包与压缩包的文件（exe / msi / nupkg / zip 一类十种形状）。这是你自己下载的东西，不是应用生成的缓存：里面很可能还有你留着准备以后装机的安装包、驱动、绿色版工具或别人发给你的文件，删了不会自动重新生成，也找不回来，只能重新去官网下载。Downloads 里那些不像安装包的文件（照片、文档、表格）与子目录里的任何东西都不在范围内"
            .into(),
        paths: paths(&[r"%USERPROFILE%\Downloads"]),
        scanner: scan(&INSTALLER_FILE_PATTERNS, None, false),
        risk_level: Risk::High,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: Some(true),
        requires_absent_app_fact: None,
    });

    /* -------------------------------------------------------------- *
     * M6（免确认清理档）—— 表尾第 23 条：显卡驱动安装包残留。
     *
     * 与 T3b-ii 那条的差别：地盘是**驱动安装器的固定现场**（盘根解压目录 + 驱动下载缓存），
     * 不是用户自己的下载目录；内容全部可重下载（官方安装器随时给得出第二份），
     * 所以它挂 🟢 而不是 🟠。显式路径模板那一族（同 dev-tool-cache：不走 leaf、无围栏），
     * 只能追加在表尾 —— 这些路径不与任何既有规则重叠，插前面插后面都不改 claimed 账。
     *
     * ⚠️ DriverStore（`%WINDIR%\System32\DriverStore`）**不在这张地盘里**：那是 Windows
     * 自己管理的驱动库（在用 + 回退两份都在里面），它同时被 §16 🔴 的 `%WINDIR%\System32`
     * 挡在门外 —— 这里的三处全是安装器**外面的**临时现场。
     * -------------------------------------------------------------- */
    out.push(Rule {
        id: "gpu-driver-leftovers".into(),
        name: "显卡驱动安装包残留".into(),
        category: RuleCategory::InstallerLeftover,
        description: r"显卡驱动安装器留下的解压目录与驱动下载缓存：系统盘根的 NVIDIA\ 与 AMD\（驱动安装包的解压现场，装完就没用了）、%PROGRAMDATA%\NVIDIA Corporation\Downloader（GeForce/NVIDIA App 下载完的驱动安装包）。删了会失去这些已经装完/下完的安装包，下次装驱动需要重新下载；驱动本体（DriverStore）、正在使用的驱动与着色器缓存都不在范围内（着色器缓存归「Shader 缓存」那条）"
            .into(),
        paths: paths(&[
            r"%SYSTEMDRIVE%\NVIDIA",
            r"%SYSTEMDRIVE%\AMD",
            r"%PROGRAMDATA%\NVIDIA Corporation\Downloader",
        ]),
        scanner: scan(&[], None, true),
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: false,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    });

    out
}

fn dev_cache(
    id: &str,
    name: &str,
    description: &str,
    p: &[&str],
    detector: &str,
    excluded: Option<bool>,
) -> Rule {
    Rule {
        id: id.into(),
        name: name.into(),
        category: RuleCategory::DevCache,
        description: description.into(),
        paths: paths(p),
        scanner: scan(&[], None, true),
        risk_level: Risk::Caution,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: Some(detector.into()),
        excluded_from_default_selection: excluded,
        requires_absent_app_fact: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M5-P3 的位置判据（TS 同名同形，见 `tests/unit/rules-registry.test.ts`）。
    /// 两份名单抄自 harness 侧的既有分组（`src-tauri/src/golden.rs:30-56`），不指回 `builtin_rules()`
    /// 自己的顺序 —— 拿被测方的顺序当期望集，这条判据就退化成「顺序等于顺序」。
    #[test]
    fn rule_22_sits_after_the_baseline_and_before_the_six_shape_rules() {
        let ids: Vec<String> = builtin_rules().iter().map(|r| r.id.clone()).collect();
        let at = |id: &str| -> usize {
            ids.iter()
                .position(|x| x == id)
                .unwrap_or_else(|| panic!("名单里的 {id} 不在表上"))
        };
        let orphan = at("orphan-app-data");
        const BASELINE_15: [&str; 15] = [
            "windows-temp",
            "browser-cache",
            "thumbnail-cache",
            "shader-cache",
            "error-reporting",
            "recycle-bin",
            "npm-cache",
            "pip-cache",
            "gradle-cache",
            "vscode-cache",
            "maven-repository",
            "pnpm-store",
            "yarn-cache",
            "huggingface-cache",
            "android-sdk-temp",
        ];
        const SHAPE_6: [&str; 6] = [
            "app-cache-data",
            "app-rotated-logs",
            "installer-artifacts",
            "dev-tool-cache",
            "crash-dumps",
            "user-downloads-installers",
        ];
        for id in BASELINE_15 {
            assert!(at(id) < orphan, "基线条目 {id} 排到了第 22 条之后 —— 它会从 🟢🟡 嘴里抢地盘（plan §1.3）");
        }
        for id in SHAPE_6 {
            assert!(at(id) > orphan, "形状规则 {id} 仍排在第 22 条之前 —— plan §2.5 那 201.56 MiB 就还是 🟡");
        }
    }

    #[test]
    fn there_are_twenty_three_rules_with_the_documented_ids() {
        let ids: Vec<String> = builtin_rules().iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            ids,
            vec![
                "windows-temp",
                "browser-cache",
                "thumbnail-cache",
                "shader-cache",
                "error-reporting",
                "recycle-bin",
                "npm-cache",
                "pip-cache",
                "gradle-cache",
                "vscode-cache",
                "maven-repository",
                "pnpm-store",
                "yarn-cache",
                "huggingface-cache",
                "android-sdk-temp",
                // M5-P2 P2-T4：plan §2.6，表上第一条判据来自机器事实的规则。
                // M5-P3（plan m5-p3 §1.3）把它从表尾移到这里 —— 仍在既有 15 条之后，但先于下面六条。
                "orphan-app-data",
                // M5-P1 T3a：那三条（plan §5.1–§5.3），顺序即 `claimed` 计账顺序
                "app-cache-data",
                "app-rotated-logs",
                "installer-artifacts",
                // M5-P1 T3b-i：再两条（plan §5.4–§5.5）
                "dev-tool-cache",
                "crash-dumps",
                // M5-P1 T3b-ii：plan §5.6，表上第一档 🟠
                "user-downloads-installers",
                // M6 免确认清理档：表尾第 23 条，显式路径模板族，不与任何既有规则抢地盘
                "gpu-driver-leftovers",
            ],
            "id 与顺序必须与 registry.ts 的 BUILTIN_RULES 逐字相同"
        );
        // 顺序**不是风格**：`claimed` 表先声明者计账，两条规则地盘重叠时顺序决定谁计账，
        // 而顺序变了 findings 的次序也变。这条曾静默错成「§21 批次在前」——本测试当场打红。
        // 与 TS 的活体对照见 `tests/parity_with_ts.rs`（那边跑真 registry，不看这份字面量）。
        //
        // M5-P1 T3a 起这条同时是**双计契约的地盘声明**：那三条的 `paths` 是 AppData 三根容器，
        // 覆盖第 2 条（browser-cache）与第 7–15 条（dev-cache 一族）的入口。它们只能排在既有 15 条
        // 之后 —— 插到表头就会被它们抢走地盘（plan §7 变异 5），字节方向是虚高，也就是多删。
        // 行为面的证明在 `engine.rs::app_cache_data_does_not_reclaim_npm_cache_or_browser_cache`。
        // M5-P3 起第 22 条插在两者中间（15 条之后、那六条之前）：同一条纪律，上界仍是「不许早于
        // 既有 15 条」，由上面 `rule_22_sits_after_the_baseline_and_before_the_six_shape_rules` 与
        // `engine.rs::the_first_fifteen_rules_never_lose_territory_to_rule_22` 分别钉上下界。
    }

    #[test]
    fn only_the_recycle_bin_is_forbidden_and_manual_only() {
        for r in builtin_rules() {
            let is_bin = r.id == "recycle-bin";
            assert_eq!(r.risk_level == Risk::Forbidden, is_bin, "{} 的风险等级", r.id);
            assert_eq!(r.clean_strategy == CleanStrategy::ManualOnly, is_bin, "{} 的策略", r.id);
        }
    }

    /// §3.5 默认勾选豁免名单。**M5-P1 T3b-ii 改名并扩成两条**（plan §6-T3），
    /// **M5-P2 P2-T4 再扩成三条**（plan §2.6 那条 🟠 `orphan-app-data`）：
    /// 原名 `only_huggingface_is_excluded_from_default_selection` 从第一条 🟠 上表起就说谎了。
    /// plan 建议的名字 `only_the_high_risk_rules_are_excluded_from_default_selection`
    /// 这里**没有采用**：`huggingface-cache` 是 🟡（caution）却挂着豁免，那个名字会断言一件
    /// 表上并不存在的耦合（「🟠 才有豁免」）。所以名单逐条点**字面 id**，另把「🟠 ⇒ 必豁免」
    /// 这条真实在成立的方向单独写成一句 —— 它反过来不成立，正是 `huggingface-cache` 的存在。
    #[test]
    fn only_huggingface_and_the_two_high_risk_rules_are_excluded_from_default_selection() {
        let ex: Vec<String> = builtin_rules()
            .into_iter()
            .filter(|r| r.excluded_from_default_selection == Some(true))
            .map(|r| r.id)
            .collect();
        // 这条钉的是**成员**，不是顺序：M5-P3 把第 22 条前移之后，按表序比会红在产品正确的那句话上
        // （名单还是那三条）。谁排前面由 `rule_22_sits_after_the_baseline_and_before_the_six_shape_rules` 管。
        let mut ex_sorted = ex.clone();
        ex_sorted.sort();
        assert_eq!(
            ex_sorted,
            vec!["huggingface-cache", "orphan-app-data", "user-downloads-installers"],
            "§3.5 的豁免名单只有这三条；多一条就是替用户改了默认勾选，少一条就是一档 🟠 被一键全选勾走了"
        );
        // 表上的两档 🟠（`user-downloads-installers` / `orphan-app-data`）：
        // **每一条 🟠 都不许进默认勾选**。反向不成立（huggingface 是 🟡 也豁免），所以只写这一半。
        for r in builtin_rules() {
            if r.risk_level == Risk::High {
                assert_eq!(
                    r.excluded_from_default_selection,
                    Some(true),
                    "{} 是 🟠 却没被豁免：一键全选会替用户勾掉它",
                    r.id
                );
            }
        }
        // M5-P1 T3a 复核过而不是假设：这三条 🟡 规则全部默认勾选（plan §5 的「默认勾选=是」列）。
        // T3b-i 追加的两条（`dev-tool-cache` / `crash-dumps`）同样是 🟡 默认勾选档。
        // 反面对账：新登记的六条（两条 🟠 在上面已点名）里，🟡 那五条必须在**未豁免**
        // 那一侧，防止有人顺手给它们挂上豁免。
        for id in [
            "app-cache-data",
            "app-rotated-logs",
            "installer-artifacts",
            "dev-tool-cache",
            "crash-dumps",
        ] {
            let r = builtin_rules().into_iter().find(|r| r.id == id).expect(id);
            assert_ne!(
                r.excluded_from_default_selection,
                Some(true),
                "{id} 是 🟡 默认勾选档，不该出现在豁免名单里"
            );
        }
    }

    #[test]
    fn the_dev_cache_rules_require_a_detector_and_the_rest_do_not() {
        for r in builtin_rules() {
            let expect = r.category == RuleCategory::DevCache;
            assert_eq!(r.requires_detector.is_some(), expect, "{} 的 requiresDetector", r.id);
        }
        // 九条 dev-cache 全带探测器：maven / pnpm / yarn / huggingface / android-sdk /
        // npm / pip / gradle / vscode
        assert_eq!(
            builtin_rules().iter().filter(|r| r.requires_detector.is_some()).count(),
            9
        );
        // plan §6-T3：这条不是"顺带还绿"。两个新类别**不挂**探测器是判据本身
        // （`requiresDetector` 的方向是"探测器说没装 → 整条规则消失"，`engine.rs:850-853`，
        // 而 AppData 三根下的缓存/轮转日志/更新包与某个工具有没有装无关）。
        // 显式点名，免得下一个人把新类别并进那一支、让九条的合计静默变十二。
        for r in builtin_rules() {
            if matches!(r.category, RuleCategory::AppTransient | RuleCategory::InstallerLeftover) {
                assert!(r.requires_detector.is_none(), "{} 挂了探测器：新类别不挂", r.id);
            }
        }
        assert_eq!(
            builtin_rules()
                .iter()
                .filter(|r| matches!(r.category, RuleCategory::AppTransient | RuleCategory::InstallerLeftover))
                .count(),
            7,
            "T3a 三条（5.1/5.2/5.3）+ T3b-i 两条（5.4/5.5）+ T3b-ii 一条（5.6）+ M6 一条（gpu-driver-leftovers）"
        );
        // 两条新规则也逐条点名（与上面那条循环同一个方向，这里是把 T3b-i 写死成判据）
        for id in ["dev-tool-cache", "crash-dumps"] {
            let r = builtin_rules().into_iter().find(|r| r.id == id).expect(id);
            assert!(r.requires_detector.is_none(), "{id} 挂了探测器");
            assert!(r.requires_absent_app_fact.is_none(), "{id} 声明了机器事实闸");
        }
        // T3b-ii 同一条纪律：`user-downloads-installers` 判的是「下载目录顶层的名字像安装包」，
        // 与某个工具有没有装无关；机器事实闸（`requiresAbsentAppFact`）是 M5-P2 `orphan-app-data`
        // 那一族的配件，本棒一条都不许挂（plan §0.5「本棒不碰注册表、不碰进程表」）。
        let u = builtin_rules().into_iter().find(|r| r.id == "user-downloads-installers").unwrap();
        assert!(u.requires_detector.is_none(), "user-downloads-installers 挂了探测器");
        assert!(u.requires_absent_app_fact.is_none(), "user-downloads-installers 声明了机器事实闸");
    }

    /// **M5-P1 T3a 改写、T3b-ii 再次改写**（plan §6-T3 点名"这条不改就是假绿"）：原先断言
    /// "只有 thumbnail-cache 带 filePatterns"，再后来断言"全表只它一条不递归"—— 两句都被
    /// `user-downloads-installers`（plan §5.6，`recursive: false`）打破了，所以名字也换了。
    /// 这里断言的是**仍然成立**的那几件事：
    /// ① 不递归的恰好两条，且**都带 filePatterns**（宽目录 + 全收 + 不递归 = 只能收到直属文件，
    ///    而"只碰顶层名字像某种形状的文件"才是不递归这一族的正当用法）；
    /// ② 带 filePatterns 的规则：**M5-P1 T3b-ii 起是四条**（`thumbnail-cache` 精确到
    ///    `thumbcache_*.db`、`installer-artifacts` 与 `user-downloads-installers` 各十种包形状、
    ///    `crash-dumps` 的 `*.dmp`）；
    /// ③ 无 filePatterns 的规则一律递归（不递归又不收扩展名 = 只删直属文件，那是半条规则）；
    /// ④ `olderThanDays` 全表没人用（时间过滤要靠注入的 now_ms，规则不读时钟）。
    #[test]
    fn the_two_non_recursive_rules_both_carry_file_patterns_and_are_thumbnail_and_downloads() {
        let patterned: Vec<String> = builtin_rules()
            .iter()
            .filter(|r| !r.scanner.file_patterns.is_empty())
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(
            patterned,
            vec!["thumbnail-cache", "installer-artifacts", "crash-dumps", "user-downloads-installers"],
            "{patterned:?}"
        );

        let unrecursive: Vec<String> = builtin_rules()
            .iter()
            .filter(|r| !r.scanner.recursive)
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(
            unrecursive,
            vec!["thumbnail-cache", "user-downloads-installers"],
            "不递归只有这两条，各自的地盘都是「顶层 + 精确形状」：宽目录 + 全收 = 顺手扫走邻居"
        );

        for r in builtin_rules() {
            if r.scanner.file_patterns.is_empty() {
                assert!(r.scanner.recursive, "{} 既无 filePatterns 又不递归 = 只能收到直属文件", r.id);
            }
            if r.id == "thumbnail-cache" {
                assert_eq!(r.scanner.file_patterns, vec!["thumbcache_*.db"]);
            }
            assert!(r.scanner.older_than_days.is_none(), "{} 不该有时间过滤", r.id);
        }
    }

    /// plan §5 第一条排除项 + §6-T3 点名的红阻：`Packages` 不许出现在内置表**任何**一条规则的
    /// 任何一份 leafDirs 名单里。
    ///
    /// 为什么判据是「拿 `Packages` 这个整名去过一遍每条规则的 leafDirs glob」而不是
    /// 「名单里没有字面 `Packages`」：后者挡得住有人直接写 `"Packages"`，挡不住
    /// `"*age"`、`"Pack*"` 这种同样能命中它的写法 —— 而那正是围栏要拦的那类误删
    /// （`%LOCALAPPDATA%\Packages` 是 UWP 每应用状态目录，参考机 879.6 MiB / 12,744 文件，
    /// 删掉等于替用户注销并清空每个商店应用的登录态与设置）。用的是引擎那**同一把** glob
    /// （`matcher.rs::name_matches`），不是测试自己抄的第二把。
    #[test]
    fn packages_is_not_in_any_leaf_dir_list() {
        for r in builtin_rules() {
            // ⚠️ 空名单必须先跳过：`name_matches(name, [])` 的语义是"无 pattern = 全收"
            //（与 `filePatterns: []` 同一个方向），拿它去过一条根本不用 leafDirs 的规则会当场误报。
            if r.scanner.leaf_dirs.is_empty() {
                continue;
            }
            assert!(
                !crate::matcher::name_matches("Packages", &r.scanner.leaf_dirs),
                "规则 {} 的 leafDirs 命中 UWP 的 Packages 目录：{} —— 那是每应用状态，不是更新目录",
                r.id,
                r.scanner.leaf_dirs.join("、")
            );
        }
        // leafFiles 同理（当前只有 `app-rotated-logs` 用得上）：不许把商店状态目录点名收走
        for r in builtin_rules() {
            if r.scanner.leaf_files.is_empty() {
                continue;
            }
            assert!(
                !r.scanner.leaf_files.iter().any(|f| f.to_lowercase().contains("package")),
                "规则 {} 的 leafFiles 里出现了 packages：{:?}",
                r.id,
                r.scanner.leaf_files
            );
        }
    }

    /// plan §5.1–§5.3 的**共同形状**逐条钉住（容器入口 = `paths` + `leaf*` + `scopeFence` 三件套）：
    /// 这三样少一样，声明层就把整条拒掉（`validate.rs`），地盘从合计里静默消失。
    /// 这条把"为什么三条都长同一个样子"写成判据，而不是写在注释里。
    #[test]
    fn the_three_container_entry_rules_share_the_app_data_roots_and_a_covering_fence() {
        let fence_env = || {
            let mut m = crate::env::RuleEnv::new();
            for (k, v) in [
                ("SYSTEMDRIVE", "C:"),
                ("WINDIR", r"C:\Windows"),
                ("LOCALAPPDATA", r"C:\Local"),
                ("APPDATA", r"C:\Roam"),
                ("PROGRAMDATA", r"C:\ProgramData"),
                ("PROGRAMFILES", r"C:\Program Files"),
                // CLEANUP-RULES §6 的 deny 根引用到这几个键（`.codex` / `Claude` / `Tencent` 一族）。
                // 少一个 ⇒ `fence_root` 返回 Err ⇒ 覆盖判据一律 false ⇒ 这条用例把"夹具缺键"
                // 报成"围栏漏了一条根"。
                ("USERPROFILE", r"C:\Users\Kano"),
            ] {
                m.insert(k.into(), v.into());
            }
            m
        };
        let e = fence_env();
        for id in ["app-cache-data", "app-rotated-logs", "installer-artifacts"] {
            let r = builtin_rules().into_iter().find(|x| x.id == id).expect(id);
            assert_eq!(r.paths, paths(&CONTAINER_ROOTS), "{id} 的入口就是 AppData 三根");
            assert_eq!(r.risk_level, Risk::Caution, "{id} 是 🟡 档（plan §5）");
            assert_eq!(r.clean_strategy, CleanStrategy::DeleteAll, "{id}");
            let f = r.scanner.scope_fence.clone().expect("三条都是容器入口，必须有围栏");
            assert_eq!(f.allow_roots, paths(&CONTAINER_ROOTS), "{id} 的 allowRoots = 采集面本身");
            // 覆盖判据：**每一条**地板根与禁止根都要被 denyRoots 里**自己那一格**罩住（不是被某个
            // 更宽的祖先顺手罩住）。取等而不是取"任意一条命中"，是因为漏掉一条在真机上的
            // 表现不是报错，而是那一片地盘悄悄进了采集面。
            for req in crate::types::FENCE_MINIMUM_DENY_PATTERNS {
                assert!(
                    f.deny_roots.iter().any(|d| d == req),
                    "{id} 的 denyRoots 少点名了必需根 {req}：{:?}",
                    f.deny_roots
                );
            }
            for req in crate::types::FORBIDDEN_PATH_PATTERNS {
                // 覆盖（不是字面同串）：`%WINDIR%\*` 一条就盖住五条 `%WINDIR%\<组件>`
                let ok = f.deny_roots.iter().any(|d| {
                    let (a, b) = (
                        crate::validate::fence_root(d, &e, true),
                        crate::validate::fence_root(req, &e, true),
                    );
                    match (a, b) {
                        (Ok(d), Ok(q)) => crate::env::path_is_under(&q, &d),
                        _ => false,
                    }
                });
                assert!(ok, "{id} 的 denyRoots 没覆盖禁止根 {req}：{:?}", f.deny_roots);
            }
            // 落在 allowRoots **之内**的禁止根必须被**自己那一格**罩住：一道只靠祖先的围栏
            // （比如指望 `%LOCALAPPDATA%\*` 顺手挡掉 `Microsoft`）在 allow 根一变宽时就静默失效。
            for req in crate::types::FORBIDDEN_PATH_PATTERNS {
                let Ok(q) = crate::validate::fence_root(req, &e, true) else { continue };
                let inside = crate::env::path_is_under(&q, r"C:\Local")
                    || crate::env::path_is_under(&q, r"C:\Roam")
                    || crate::env::path_is_under(&q, r"C:\ProgramData");
                if !inside {
                    continue;
                }
                assert!(
                    f.deny_roots.iter().any(|d| {
                        crate::validate::fence_root(d, &e, true)
                            .map(|r| crate::engine::normalize_key(&r) == crate::engine::normalize_key(&q))
                            .unwrap_or(false)
                    }),
                    "{id} 的 denyRoots 没有把落在 allow 根之内的禁止根 {req}（{q}）点成自己那一格：{:?}",
                    f.deny_roots
                );
            }
            // 判据必须落在 basename 上（leafDirs 或 leafFiles 至少一份非空）
            assert!(
                !r.scanner.leaf_dirs.is_empty() || !r.scanner.leaf_files.is_empty(),
                "{id} 没有 leaf 判据 = 容器地盘"
            );
            assert!(
                !(r.scanner.leaf_dirs.len() == 1 && r.scanner.leaf_dirs[0] == "Packages"),
                "{id} 的 leafDirs 就是 Packages"
            );
        }
        // 三条各自的采集语义（plan §10 裁定 1：leafDirs 与 leafFiles 互斥）。
        // ⚠️ 这里比的是**字面量**，不是 `APP_CACHE_LEAF_DIRS` 那些常量本身 ——
        // 拿常量比常量是自我印证：变异清单把 `*.?.log` 放宽成 `*.log` 时两边一起变，这条照样绿。
        // 判据要有牙就得把期望值写死在这一行（`UPDATER_LEAF_DIRS` 那条同罪，plan §7 变异 3 原本
        // 只能靠 `packages_is_not_in_any_leaf_dir_list` 一条红，现在这里也有一条）。
        let by = |id: &str| builtin_rules().into_iter().find(|r| r.id == id).unwrap();
        assert_eq!(
            by("app-cache-data").scanner.leaf_dirs,
            vec![
                "Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache", "DawnCache",
                "DawnGraphiteCache", "DawnWebGPUCache", "CachedData", "blob_storage", "CacheStorage",
                "component_crx_cache"
            ],
            "plan §5.1 那 12 个名字，逐字同序（与 registry.ts 的 APP_CACHE_LEAF_DIRS 同串）"
        );
        assert!(by("app-cache-data").scanner.leaf_files.is_empty());
        assert!(by("app-cache-data").scanner.file_patterns.is_empty(), "全收（plan §5.1）");
        assert!(by("app-rotated-logs").scanner.leaf_dirs.is_empty());
        assert_eq!(
            by("app-rotated-logs").scanner.leaf_files,
            vec!["*.?.log", "*.log.??", "*.etl"],
            "plan §5.2 只认轮转件：`*.?.log` 放宽成 `*.log` 就是把在写的日志吃掉（plan §7 变异 4）"
        );
        assert_eq!(
            by("installer-artifacts").scanner.leaf_dirs,
            vec!["*updater", "*Updater", "pending", "Update", "updates"],
            "plan §5.3 的更新目录名单：**没有 Packages**（plan §7 变异 3）"
        );
        assert_eq!(
            by("installer-artifacts").scanner.file_patterns,
            vec!["*.exe", "*.msi", "*.msp", "*.nupkg", "*.appx", "*.msix", "*.zip", "*.7z", "*.rar", "*.iso"],
            "plan §5.3 的安装包形状"
        );
        // 风险记账：日志删了就没了（false），缓存与安装包可再生（true）
        assert!(!by("app-rotated-logs").recoverable);
        assert!(by("app-cache-data").recoverable && by("installer-artifacts").recoverable);
        assert_eq!(by("app-cache-data").category, RuleCategory::AppTransient);
        assert_eq!(by("app-rotated-logs").category, RuleCategory::AppTransient);
        assert_eq!(by("installer-artifacts").category, RuleCategory::InstallerLeftover);
    }

    /// M5-P1 T3b-i（plan §5.4–§5.5）那两条的**声明在位**，逐字段比**字面量**（不比 `DEV_TOOL_CACHE_PATHS`
    /// 那个常量本身 —— 拿常量比常量是自我印证，删掉一个模板时两边一起变、照样绿）。
    ///
    /// 这条同时钉住"这一族**不是** leaf 那一族"：`leaf_dirs` / `leaf_files` 必须空、`scope_fence`
    /// 必须 `None`（围栏是容器入口的配件；给显式模板规则挂 leaf 判据 = 把六条固定路径变成任意深度
    /// 的目录名匹配，那是自行扩地盘）。
    #[test]
    fn the_dev_tool_cache_template_and_crash_dumps_container_are_declared_as_documented() {
        let by = |id: &str| builtin_rules().into_iter().find(|r| r.id == id).unwrap();

        // 这六条**彼此**的相对顺序不许变（M5-P1 起就是 `claimed` 计账顺序），且它们仍须排在既有 15 条
        // 之后 —— 但**不写死下标**：M5-P3 把第 22 条插进了这个区间，`ids[18..20]` 那种写法会红在
        // 产品正确的那句话上。上下界由 `rule_22_sits_after_the_baseline_and_before_the_six_shape_rules` 钉。
        let ids: Vec<String> = builtin_rules().iter().map(|r| r.id.clone()).collect();
        let at = |id: &str| -> usize {
            ids.iter()
                .position(|x| x == id)
                .unwrap_or_else(|| panic!("表上没有 {id}：{ids:?}"))
        };
        for pair in [
            ("app-cache-data", "app-rotated-logs"),
            ("app-rotated-logs", "installer-artifacts"),
            ("installer-artifacts", "dev-tool-cache"),
            ("dev-tool-cache", "crash-dumps"),
            ("crash-dumps", "user-downloads-installers"),
        ] {
            assert!(at(pair.0) < at(pair.1), "六条形状规则彼此换了次序：{} 排到了 {} 之后", pair.0, pair.1);
        }
        assert!(at("android-sdk-temp") < at("app-cache-data"), "容器入口那一族排到了既有 15 条之前");

        let d = by("dev-tool-cache");
        assert_eq!(
            d.paths,
            vec![
                r"%LOCALAPPDATA%\electron\Cache",
                r"%LOCALAPPDATA%\electron-builder\Cache",
                r"%LOCALAPPDATA%\NuGet\v3-cache",
                r"%LOCALAPPDATA%\NuGet\Cache",
                r"%PROGRAMDATA%\USOShared",
                r"%PROGRAMDATA%\USOPrivate",
            ],
            "plan §5.4 的六个显式模板，逐字同序（与 registry.ts 的 devToolCache.paths 同串）"
        );
        assert_eq!(d.category, RuleCategory::AppTransient);
        assert_eq!(d.risk_level, Risk::Caution, "plan §5.4 是 🟡");
        assert_eq!(d.clean_strategy, CleanStrategy::DeleteAll);
        assert!(d.recoverable, "缓存删了能重新下载（plan §5.4 recoverable=true）");
        assert!(d.scanner.file_patterns.is_empty(), "全收：这条不靠扩展名过滤");
        assert!(d.scanner.recursive);
        assert!(d.scanner.leaf_dirs.is_empty() && d.scanner.leaf_files.is_empty(), "不走 leaf 机制");
        assert!(d.scanner.scope_fence.is_none(), "显式模板规则没有容器入口，围栏不在这一族");
        assert!(d.scanner.older_than_days.is_none());

        // T6 真机对账之后 crash-dumps 从"显式模板"改成了"容器入口 + 目录名判据"：
        // 原先写死 %LOCALAPPDATA%\CrashDumps，于是 %PROGRAMDATA%\...\werdump 里那 72 MiB 转储
        // 既无 finding 也无排除记录 —— 是**根本没试过**的白漏，不是被别的规则认领走。
        let c = by("crash-dumps");
        assert_eq!(c.paths, vec![r"%LOCALAPPDATA%", r"%APPDATA%", r"%PROGRAMDATA%"], "三条容器入口共用同一份 allow 根");
        assert_eq!(
            c.scanner.leaf_dirs,
            vec!["CrashDumps", "werdump", "DumpFolder", "Dumps"],
            "目录名判据，与 registry.ts 同序同串"
        );
        assert_eq!(c.scanner.file_patterns, vec!["*.dmp"], "plan §5.5 只收转储，不端目录");
        assert!(c.scanner.recursive, "plan §5.5：递归");
        assert!(c.scanner.leaf_files.is_empty(), "这条走目录名那一族，不走 leafFiles");
        assert!(c.scanner.scope_fence.is_some(), "容器入口必须带围栏（plan §0.1）");
        assert_eq!(c.category, RuleCategory::AppTransient);
        assert_eq!(c.risk_level, Risk::Caution, "plan §5.5 是 🟡");
        assert_eq!(c.clean_strategy, CleanStrategy::DeleteAll);
        assert!(!c.recoverable, "转储是崩溃那一次的现场，删了没有第二份");
        assert!(c.scanner.older_than_days.is_none());
    }

    /// M5-P2 P2-T4（plan §2.6 / spec §3 3.5 + §4.3）第 22 条的**声明在位**，逐字段比**字面量**
    /// （不指回 `CONTAINER_ROOTS` / `container_fence()` 那些实现 —— 拿实现比实现是自我印证）。
    ///
    /// 这条钉的是**安全方向的那三个值**：🟠 + `excludedFromDefaultSelection: true` +
    /// `recoverable: false`（spec §4.3 定死），以及 `requiresAbsentAppFact: Some(true)` 与
    /// `leafDirs`/`leafFiles` 的**互斥形状**（P2-T3 的声明层闸：混给整条拒 —— 真混了这条用例先红，
    /// 而它红了就等于表上有一规则会被 `validate_rule_set` 拒掉、地盘从合计里静默消失）。
    /// `orphan-app-data` 也同时是**全表唯一**一条带机器事实闸的规则 —— 那件事由下面那句点名，
    /// 它也正是 `engine.rs::an_empty_app_fact_table_leaves_rule_22_at_zero_bytes…` 那条回归轴的前提。
    #[test]
    fn orphan_app_data_is_high_and_not_in_default_selection() {
        let rules = builtin_rules();
        assert_eq!(rules.len(), 23, "第 22、23 条必须真的在表上，实得 {:?}", rules.iter().map(|r| r.id.clone()).collect::<Vec<_>>());
        let r = rules.iter().find(|x| x.id == "orphan-app-data").expect("表上没有 orphan-app-data");

        // 类别是新的一格，而不是被并进 `app-transient`（理由见 types.rs::RuleCategory::OrphanData 的注释）
        assert_eq!(r.category, RuleCategory::OrphanData, "P2-T4 的类别是新成员");
        assert_eq!(serde_json::to_value(r.category).unwrap().as_str(), Some("orphan-data"));
        assert_eq!(r.name, "卸载残留的应用数据");

        // 采集面 = 三条容器根；**不是**任意深度（那是 leaf 那一族），也不是某个具体应用目录
        assert_eq!(
            r.paths,
            vec![r"%LOCALAPPDATA%", r"%APPDATA%", r"%PROGRAMDATA%"],
            "spec §3 3.5：`paths` = 三根容器，候选是它们的顶层一项"
        );

        // 第三种采集模式的形状：带机器事实闸、**两份 leaf 名单都空**、围栏就是容器规则那一份
        assert_eq!(r.requires_absent_app_fact, Some(true), "不声明这个字段 = 这条规则按普通地盘收");
        assert!(r.scanner.leaf_dirs.is_empty(), "与 requiresAbsentAppFact 互斥（P2-T3 的闸会整条拒）：{:?}", r.scanner.leaf_dirs);
        assert!(r.scanner.leaf_files.is_empty(), "同上：{:?}", r.scanner.leaf_files);
        let f = r.scanner.scope_fence.clone().expect("带机器事实闸的规则必须容器入口 + 围栏（plan §2.5）");
        assert_eq!(f.allow_roots, r.paths, "allowRoots = 采集面本身（与其他容器规则同一个形状）");
        assert_eq!(
            f.deny_roots,
            vec![
                r"%WINDIR%\*",
                r"%SYSTEMDRIVE%\System Volume Information",
                r"%PROGRAMFILES%\*",
                r"%SYSTEMDRIVE%\Program Files (x86)\*",
                r"%PROGRAMDATA%\Microsoft\Windows Defender\*",
                r"%LOCALAPPDATA%\Microsoft",
                r"%LOCALAPPDATA%\Packages",
                r"%PROGRAMDATA%\Package Cache",
                r"%APPDATA%\Claude",
                r"%APPDATA%\OpenAI",
                r"%APPDATA%\ZCode",
                r"%APPDATA%\com.qodercn.app.stable",
                r"%APPDATA%\Tencent",
                r"%APPDATA%\douyin",
                r"%APPDATA%\Spotify",
                r"%APPDATA%\NutstoreClient",
                r"%USERPROFILE%\*",
                r"%LOCALAPPDATA%\Program Files",
                r"%LOCALAPPDATA%\Programs\*",
            ],
            "围栏与 `installer-artifacts` 那一族**同一份** container_fence —— 少一条地板根就被 validate_fence 拒。\
             CLEANUP-RULES §6 补齐后这份围栏从 5 条长到 19 条（地板 5 + 落在 allowRoots 内的禁止根 12 + 容器族补充 2）"
        );
        assert!(r.scanner.file_patterns.is_empty(), "全收：这一条按目录收，不靠扩展名过滤");
        assert!(r.scanner.recursive, "候选目录内部递归（残留数据整棵子树都是它的）");
        assert!(r.scanner.older_than_days.is_none(), "规则不读时钟");

        // spec §4.3 的三个值，少一个都不是"这条规则"而是另一条规则
        assert_eq!(r.risk_level, Risk::High, "spec §4.3：命中项永远 🟠");
        assert_eq!(r.excluded_from_default_selection, Some(true), "spec §4.3：永远不进默认勾选");
        assert!(!r.recoverable, "spec §4.3：「可再生」这个词它不配 —— 没有任何产品动作能生成回这些设置");
        assert_eq!(r.clean_strategy, CleanStrategy::DeleteAll);
        assert!(r.requires_detector.is_none(), "plan §0.3：requiresDetector 的方向与此相反，不许复用");

        // 全表**只**这一条带机器事实闸（多一条就是又有一族规则开始吃注入表）
        let flagged: Vec<String> = rules
            .iter()
            .filter(|x| x.requires_absent_app_fact == Some(true))
            .map(|x| x.id.clone())
            .collect();
        assert_eq!(flagged, vec!["orphan-app-data"], "{flagged:?}");

        // 文案必须把「这是推断、不是事实」与「丢了什么」都说白 —— 界面搬运的就是这一句（T5a），
        // 而 §5 的按档告知那句「删了会失去什么」取的就是 `description`，没有第二个文案字段。
        let d = r.description.replace(' ', "");
        for want in ["推断", "不是事实", "设置", "不会再", "还在用的应用"] {
            assert!(d.contains(want), "description 少了「{want}」这一层：{}", r.description);
        }
    }

    #[test]
    fn node_modules_and_pycache_are_deliberately_absent() {
        // §21 点名了它们，但路径模板语言表达不出来。见到有人"顺手补上"要把这条测试当阻力：
        // 硬凑一层通配只会漏掉所有非顶层项目，看着像实现了、实际是假数字。
        // 只看 **paths**，不看整份 JSON：`npm-cache` 的**描述**里就写着 "不影响已装好的
        // node_modules"，拿整份 JSON 去 grep 会把一句说明当成一条规则（我第一次就这么误报）
        let all_paths: Vec<String> = builtin_rules()
            .into_iter()
            .flat_map(|r| r.paths)
            .collect();
        for p in &all_paths {
            for banned in ["node_modules", "__pycache__", "virtualenv", "Docker"] {
                assert!(!p.contains(banned), "不许硬凑 {banned} 规则：{p}");
            }
        }
    }
}
