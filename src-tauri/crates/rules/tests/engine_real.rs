//! **真盘上的评估层**：真建目录、真文件、真属性位 → 真扫描 → 真评估。
//!
//! 为什么必须有这一层：合成树（`FakeTree` / 夹具 JSON）证明不了"扫描内核 → `TreeIndex`
//! → `RuleSource` 适配器 → 评估层"这条链上没有任何一段把数据吃掉。这一轮的三个真缺陷里
//! 有两个（文件属性位被丢、`open_dir` 的路径拼法）**只在真链路上才看得见**。
//!
//! 夹具建在系统临时目录下，跑完自删。不用 `D:\deepclean-fixture\`：那台机器上才有的路径
//! 会让这条判据在别的机器上静默不跑 —— 而"没跑"与"通过"长得一样。

use deepclean_rules::engine::{evaluate_rules, EvaluateOptions, ExclusionReason, RuleSource};
use deepclean_rules::env::RuleEnv;
use deepclean_rules::tree_source::TreeSource;
use deepclean_rules::types::{CleanStrategy, Risk, Rule, RuleCategory, RuleScanner};
use deepclean_rules::builtin::builtin_rules;
use deepclean_scanner::model::ScanTree;
use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::tree_index::TreeIndex;
use deepclean_scanner::volume::VolumeInfo;
use std::path::{Path, PathBuf};

/// 建好的夹具目录，`Drop` 时整棵删掉（判据红/panic 时也删）。
struct Fixture(PathBuf);

/// 每个夹具一个**独立**目录名。同一测试二进制里的用例是并行跑的，
/// 而 `std::process::id()` 对它们全都一样 —— 只用 pid 命名会让四条用例互相删对方的夹具
/// （症状是"单独跑全绿、workspace 跑红一条"，而且每次红的还不是同一条）。
static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

impl Fixture {
    fn new() -> Self {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("deepclean-m3-real-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(r"Temp\sub")).unwrap();
        std::fs::create_dir_all(root.join("NotClaimed")).unwrap();

        write(&root.join(r"Temp\a.tmp"), 100);
        write(&root.join(r"Temp\sub\deep.tmp"), 400);
        write(&root.join(r"NotClaimed\x.bin"), 50);
        // 这一条带真 SYSTEM 属性 —— §28 原则二的判据只有它验得到
        let sys = root.join(r"Temp\sys.tmp");
        write(&sys, 700);
        mark_system(&sys);
        Fixture(root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn write(p: &Path, bytes: u64) {
    std::fs::write(p, vec![0u8; bytes as usize]).unwrap();
}

fn mark_system(p: &Path) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::{
        SetFileAttributesW, FILE_ATTRIBUTE_ARCHIVE, FILE_ATTRIBUTE_SYSTEM,
    };
    let wide: Vec<u16> = p.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    // SYSTEM 单打会失败（Win32 要求至少再带一个可写位），所以连同 ARCHIVE 一起设
    let ok = unsafe {
        SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_SYSTEM | FILE_ATTRIBUTE_ARCHIVE)
    };
    let err = unsafe { GetLastError() };
    assert_ne!(ok, 0, "打 FILE_ATTRIBUTE_SYSTEM 失败 err={err}：{}", p.display());
    eprintln!("marked {} err={err}", p.display());
}

/// 卷信息只为过 `scan_tree` 的那道哨兵（`counted > used + used/200` ⇒ 整轮失败）：
/// 给一个"用不完"的卷，免得夹具一建就把哨兵撞红。
/// **不能用 `u64::MAX`**：哨兵那句 `used + used / 200` 会在那儿直接溢出 panic。
fn volume() -> VolumeInfo {
    VolumeInfo { serial: 1, label: "fixture".into(), total_bytes: 1u64 << 62, free_bytes: 0 }
}

fn scan(root: &Path) -> TreeIndex {
    let tree: ScanTree = scan_tree(&ScanOptions::new(root), &volume(), |_| {}).expect("扫描夹具");
    TreeIndex::build(&tree)
}

fn env(root: &Path) -> RuleEnv {
    let mut m = RuleEnv::new();
    m.insert("SYSTEMDRIVE".into(), "C:".into());
    m.insert("WINDIR".into(), r"C:\Windows".into());
    m.insert("TEMP".into(), root.join("Temp").to_string_lossy().into_owned());
    m.insert("LOCALAPPDATA".into(), root.to_string_lossy().into_owned());
    // M5-P1 T3a：表尾三条是容器入口规则，围栏的 denyRoots 要点名 `%PROGRAMFILES%\*`（plan §4.1
    // 的第 8 个变量键），`allowRoots` 要点名 APPDATA / PROGRAMDATA。**少任何一个键，那三条会被
    // 声明层 fail-closed 整条拒掉** —— 于是 `findings.len()` 停在 15 而这条回归轴照样绿（假绿）。
    // 生产侧八个键全注入（`src-tauri/src/service.rs` 遍历 `RULE_ENV_KEYS`），这里复现那个形状。
    //
    // `USERPROFILE` 也必须给：CLEANUP-RULES §6 R-DENY-AIDATA 之后，禁止根模板里有
    // `%USERPROFILE%\.codex` 一族。少这一个键 ⇒ 禁止根解析不出 ⇒ `safety_blocked`
    // ⇒ 本文件四条用例全红，而红的原因是"夹具缺键"不是"引擎坏了"。
    //
    // ~~原来故意不给它，靠它产生 `unresolved-env` 排除记录~~：那条判据在本 crate 的
    // **单元测试**里已经有两处（`engine.rs` 对 `UnresolvedEnv` 的断言，用的是缺变量的自定义规则），
    // 不需要这份**整表**夹具来兼职 —— 整表夹具一旦缺键，它量的就不再是"内置表在真树上跑得怎么样"。
    m.insert("APPDATA".into(), root.join("Roaming").to_string_lossy().into_owned());
    m.insert("PROGRAMDATA".into(), root.join("ProgramData").to_string_lossy().into_owned());
    m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
    // ⚠️ 必须指到夹具**外部**（与 `PROGRAMFILES` 同一姿态）：指进 root 底下时
    // `%USERPROFILE%\.codex` 会解析成 root 的**后代**，于是 root 自己被判成
    // "套住了受保护路径"（`AncestorOfProtected`）—— 那是夹具自伤，不是引擎结论。
    m.insert("USERPROFILE".into(), r"C:\Users\Fixture".into());
    m
}

fn mk(id: &str, paths: &[String]) -> Rule {
    Rule {
        id: id.into(),
        name: id.into(),
        category: RuleCategory::Temp,
        description: "d".into(),
        paths: paths.to_vec(),
        scanner: RuleScanner { file_patterns: vec![], older_than_days: None, recursive: true, ..Default::default() },
        risk_level: Risk::Safe,
        clean_strategy: CleanStrategy::DeleteAll,
        recoverable: true,
        requires_detector: None,
        excluded_from_default_selection: None,
        requires_absent_app_fact: None,
    }
}

/// 真 SYSTEM 属性的文件**在真链路上**被 §28 原则二挡住 —— 这是"属性位有没有被
/// 从 `FileIdBothDirectoryInfo` 一路带到评估层"唯一站得住的证据。
#[test]
fn a_real_system_attributed_file_is_excluded_on_a_real_tree() {
    let fx = Fixture::new();
    let idx = scan(&fx.0);
    let src = TreeSource::new(&idx);
    let report = evaluate_rules(
        &src,
        &[mk("temp", &[r"%TEMP%".to_string()])],
        &env(&fx.0),
        &EvaluateOptions::default(),
    );
    assert!(!report.safety_blocked);

    // 断言不写死字节数：`counted` 是**分配口径**，MFT 常驻文件的 AllocationSize 按 8 字节对齐
    // （100 字节 → 104），写死 500 只会测出"我不懂这个口径"。这里改成对着**同一棵树**的关系式：
    // 认领合计必须等于"整层合计减去那个带 SYSTEM 的文件的字节"。
    let temp_id = src.dir_id_by_path(&fx.0.join("Temp").to_string_lossy()).unwrap();
    let kids = src.children_of(temp_id);
    let all: u64 = kids.iter().map(|k| k.size).sum();
    let sys = kids.iter().find(|k| k.name == "sys.tmp").expect("夹具里那个 SYSTEM 文件").size;
    assert!(sys >= 700, "它在树上要带着自己的字节：{sys}");

    let f = &report.findings[0];
    assert_eq!(f.file_count, 2, "a.tmp + sub\\deep.tmp");
    assert_eq!(f.total_bytes, all - sys, "整层合计减去被 §28 原则二挡掉的那个");
    assert!(f.total_bytes < all, "SYSTEM 文件必须真的从合计里被减掉，而不是顺带算进来");
    assert!(
        report
            .exclusions
            .iter()
            .any(|e| e.reason == ExclusionReason::ProtectedAttrs && e.path.ends_with("sys.tmp")),
        "带 SYSTEM 的那个必须被点名，实得 {:?}",
        report
            .exclusions
            .iter()
            .map(|e| (e.reason, e.path.clone()))
            .collect::<Vec<_>>()
    );
}

/// 计划 Task 2 Step 1④ 的那条不变量：点名要全量清单时，
/// `all_paths` 与 `file_count` / `total_bytes` **同一口径**（条数相等、字节和相等）。
/// 它守的是"报告里的采样数与合计是同一份账"这件事 —— 采样被截断时它们会分叉。
#[test]
fn the_named_all_paths_agree_with_the_count_and_the_total() {
    let fx = Fixture::new();
    let idx = scan(&fx.0);
    let src = TreeSource::new(&idx);
    let mut opts = EvaluateOptions::default();
    opts.collect_all_paths_for.insert("temp".to_string());
    let report = evaluate_rules(&src, &[mk("temp", &[r"%TEMP%".to_string()])], &env(&fx.0), &opts);

    let f = &report.findings[0];
    let all = f.all_paths.as_ref().expect("点名了就必须挂上完整清单");
    assert_eq!(all.len() as u64, f.file_count, "条数必须与 file_count 相等");
    assert_eq!(all.iter().map(|p| p.size).sum::<u64>(), f.total_bytes, "字节和必须与 total_bytes 相等");
    // 合计不许超过地盘的子树合计（过滤只许让数字变小，不许变大）
    let roots: u64 = f.matched_roots.iter().filter_map(|r| src.dir_id_by_path(r)).filter_map(|id| src.size_of(id)).sum();
    assert!(f.total_bytes <= roots, "{} > {}", f.total_bytes, roots);
}

/// 没扫到的地盘必须点名 `not-scanned`，而不是安静地算 0 ——
/// "这台机器上没有这块缓存"与"这次没扫到那块地"是两句话。
#[test]
fn a_territory_that_was_not_scanned_is_named() {
    let fx = Fixture::new();
    let idx = scan(&fx.0);
    let src = TreeSource::new(&idx);
    let missing = r"%LOCALAPPDATA%\D3DSCache".to_string();
    let report = evaluate_rules(&src, &[mk("shader", &[missing])], &env(&fx.0), &EvaluateOptions::default());

    assert_eq!(report.findings[0].total_bytes, 0);
    assert!(report.findings[0].matched_roots.is_empty());
    assert!(
        report.exclusions.iter().any(|e| e.reason == ExclusionReason::NotScanned),
        "实得 {:?}",
        report.exclusions.iter().map(|e| e.reason).collect::<Vec<_>>()
    );
}

/// 内置 23 条在真树上跑一遍：不 panic、不 fail-safe，且账目自洽。
/// 真树上没有 `%WINDIR%\System32`（夹具不在 C 盘），所以这条只验"跑得通且账目对得上"。
///
/// **23 条表 ⇒ 22 条 finding**：差的那一条是表上第 22 条 `orphan-app-data`。这一轮的选项表是空的
/// （真链路对账不该拿真机的注册表去喂引擎，见 `EvaluateOptions::app_facts` 那段注释），
/// 空表 = 缺键 = 一律弃权 ⇒ 它按 `evaluate_rules` 里那条 `continue` 不出 finding（TS 同一条）。
/// 第 23 条（`gpu-driver-leftovers`）的地盘不在夹具里，照旧出一条 0 字节 finding
/// （显式路径模板族与 dev-tool-cache 同一姿势）。这条差在**真链路上**看得见才有意义：
/// `TreeSource` 把真目录一层层交出来，第三种采集模式（`collect_app_fact_entry`）第一次跑的是
/// 真树而不是 `FakeTree`。
#[test]
fn the_builtin_table_evaluates_cleanly_on_a_real_tree() {
    let fx = Fixture::new();
    let idx = scan(&fx.0);
    let src = TreeSource::new(&idx);
    let report = evaluate_rules(&src, &builtin_rules(), &env(&fx.0), &EvaluateOptions::default());
    assert!(!report.safety_blocked);
    assert_eq!(report.findings.len(), 22, "既有二十二条都要上线（真树上没有它们的命中，0 字节也要出 finding）");
    assert!(
        !report.findings.iter().any(|f| f.rule_id == "orphan-app-data"),
        "空表之下第 22 条却出了 finding ⇒ 缺键被当成了 Absent（真机上这就是一份能删活应用数据的清单）"
    );
    // 它没出 finding，但它**看过**的每一个候选都得点名 —— 这条就是"功能没接线"与
    // "接了、看了、什么都没判出来"的分界（夹具的 `%LOCALAPPDATA%` 就是这棵树根，
    // 直属子目录是 `NotClaimed` 与 `Temp`；`%APPDATA%` / `%PROGRAMDATA%` 那两个根没被扫到）。
    let mut named: Vec<String> = report
        .exclusions
        .iter()
        .filter(|e| e.rule_id.as_deref() == Some("orphan-app-data"))
        .filter(|e| e.reason == ExclusionReason::AppFactKeyMissing)
        .map(|e| e.path.rsplit('\\').next().unwrap_or("").to_string())
        .collect();
    named.sort();
    assert_eq!(
        named,
        vec!["NotClaimed".to_string(), "Temp".to_string()],
        "第 22 条看过的候选必须逐个点名，实得 {:?}",
        report
            .exclusions
            .iter()
            .filter(|e| e.rule_id.as_deref() == Some("orphan-app-data"))
            .map(|e| (e.reason, e.path.clone()))
            .collect::<Vec<_>>()
    );
    // 被拒的规则**不出 finding、也不报错**，只把地盘从合计里静默撤走。上一条数的是二十一条，
    // 这一条数的是"零条被拒" —— 少了这条，21 会因为别的规则掉出去而照样凑得出某个数。
    assert!(report.rejected_rules.is_empty(), "内置表在真树上被声明层拒了：{:?}", report.rejected_rules);

    // 夹具里只有 `%TEMP%` 有命中，可回收 = Temp 那一层减去被 §28 原则二挡掉的 SYSTEM 文件
    let temp_id = src.dir_id_by_path(&fx.0.join("Temp").to_string_lossy()).unwrap();
    let kids = src.children_of(temp_id);
    let all: u64 = kids.iter().map(|k| k.size).sum();
    let sys = kids.iter().find(|k| k.name == "sys.tmp").unwrap().size;
    assert_eq!(report.reclaimable_bytes, all - sys, "实得 {}", report.reclaimable_bytes);

    let temp = report.findings.iter().find(|f| f.rule_id == "windows-temp").unwrap();
    assert_eq!(temp.file_count, 2, "递归到 sub\\deep.tmp；sys.tmp 被挡");
}
