//! P2-T2 的判据（计划 §3-P2-T2）+ 原样带着 P2-T1 那五条。
//!
//! 一次都不碰真机：环境表、`Packages` 容器、安装根、开始菜单根是 `%TEMP%` 下一棵假树，
//! 注册表与进程表是**手搭的快照**（`registry::RegistrySnapshot` / `procs::ProcessSnapshot`）——
//! 这一棒新加的两条通道也照样只在注入数据上跑。真机采集入口 `collect_snapshot()` /
//! `collect_process_snapshot()` 在这里**一次都不调**（它们只被壳层调，P2-T4）。
//!
//! P2-T1 那五条的用意**不变**（两半都成立才 Absent / 缺通道 → 弃权 / Present 单向 /
//! 包族名口径 / §4.4 额外根），但其中「本轮 Absent 结构上到不了」那一半作废了：
//! C1/C2/C5 落地后 `Absent` 是**可达**的，所以那些断言从「到不了」改成「只有这一种形状到得了」。
//! 改动的逐条理由记在计划 §5 的 P2-T2 那节。

mod common;

use common::Machine;
use deepclean_appfacts::fs_probe;
use deepclean_appfacts::procs::{ProcessRecord, ProcessSnapshot};
use deepclean_appfacts::registry::{
    RegistrySnapshot, RootStatus, UninstallEntry, UninstallRoot, VendorRoot,
};
use deepclean_appfacts::{
    channel::ChannelScan, judge, scan_all, AppFact, AppFactsTable, CandidateEvidence, FactScan,
    InstallRoot, Probe, ProbeInput, ProbeRoots, CH_INSTALL_ROOTS, CH_PACKAGES, CH_PROCESSES,
    CH_START_MENU, CH_UNINSTALL, CH_VENDOR_KEYS,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

// ---------------------------------------------------------------- 假机器

/// 一台假机器：`%TEMP%` 下的一棵树 + 一份配套的**干净且已取证**的注册表/进程快照。
///
/// 「干净」这件事也必须是**采集过的**：默认值（`RegistrySnapshot::default()` /
/// `ProcessSnapshot::default()`）在判据眼里是「没看成」，用它搭一台「什么都没装着」的机器
/// 会得到一整张 `Unknown`，那条用例测的就不是判据而是接线了。
struct FakeMachine {
    root: PathBuf,
}

impl FakeMachine {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "deepclean-appfacts-{}-pid{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("假机器根");
        let m = Self { root };
        for d in [
            "local/Packages",
            "local/Programs",
            "pf",
            "pf86",
            "programdata/Microsoft/Windows/Start Menu/Programs",
            "roaming/Microsoft/Windows/Start Menu/Programs",
        ] {
            m.dir(d);
        }
        m
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        std::fs::create_dir_all(&p).expect("假机器建目录（只有测试夹具动盘，生产片段由 tests/readonly.rs 钉住）");
        p
    }

    fn file(&self, rel: &str) -> PathBuf {
        let p = self.root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("夹具的父目录");
        }
        std::fs::File::create(&p).expect("夹具建文件");
        p
    }

    fn env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        env.insert("LOCALAPPDATA".into(), self.p("local"));
        env.insert("APPDATA".into(), self.p("roaming"));
        env.insert("ProgramData".into(), self.p("programdata"));
        env.insert("ProgramFiles".into(), self.p("pf"));
        env.insert("ProgramFiles(x86)".into(), self.p("pf86"));
        env.insert("ProgramW6432".into(), self.p("pf"));
        env
    }

    fn p(&self, rel: &str) -> String {
        self.root.join(rel).to_string_lossy().into_owned()
    }

    fn roots(&self) -> ProbeRoots {
        ProbeRoots::from_env_vars(&self.env())
    }

    /// 一条**跑成功了、什么都没看到**的卸载表根（三根都有，才是「证完了」）。
    fn clean_uninstall_roots(&self) -> Vec<UninstallRoot> {
        ["HKLM 64", "HKLM WOW6432Node", "HKCU"]
            .iter()
            .map(|h| UninstallRoot {
                path: format!(r"{h}\…\Uninstall"),
                status: RootStatus::Listed,
                entries: Vec::new(),
            })
            .collect()
    }

    fn clean_vendor_roots(&self, keys: Vec<String>) -> Vec<VendorRoot> {
        vec![
            VendorRoot { path: r"HKLM\SOFTWARE（64 位视图顶层键）".into(), status: RootStatus::Listed, keys },
            VendorRoot {
                path: r"HKCU\SOFTWARE（顶层键）".into(),
                status: RootStatus::Listed,
                keys: vec!["Microsoft".into()],
            },
        ]
    }

    /// 默认快照：什么都看完了、什么都没命中（一条无关进程，保证 C5 是「跑完了」而不是「空的」）。
    fn clean_snapshot(&self) -> (RegistrySnapshot, ProcessSnapshot) {
        (
            RegistrySnapshot { uninstall: self.clean_uninstall_roots(), vendors: self.clean_vendor_roots(vec![]) },
            ProcessSnapshot::listed(vec![ProcessRecord {
                exe: "System.exe".into(),
                image: Some(self.p("pf/System/System.exe")),
            }]),
        )
    }

    fn input(&self) -> ProbeInput {
        let (registry, processes) = self.clean_snapshot();
        self.input_with(registry, processes)
    }

    fn input_with(&self, registry: RegistrySnapshot, processes: ProcessSnapshot) -> ProbeInput {
        ProbeInput { roots: self.roots(), registry, processes, env: self.env() }
    }

    fn collect(&self, candidates: &[&str]) -> AppFactsTable {
        self.collect_with(&self.input(), candidates)
    }

    fn collect_with(&self, input: &ProbeInput, candidates: &[&str]) -> AppFactsTable {
        deepclean_appfacts::collect_app_facts(&cands(candidates), input)
    }
}

impl Drop for FakeMachine {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn cands(names: &[&str]) -> Vec<String> {
    names.iter().map(|s| (*s).to_string()).collect()
}

fn fact_of(table: &AppFactsTable, key: &str) -> AppFact {
    table
        .get(key)
        .unwrap_or_else(|| panic!("表里没有「{key}」这一格：{table:?}"))
        .clone()
}

fn probe_detail(scan: &FactScan, channel: &'static str, key: &str) -> String {
    match scan.probe_for(channel, key) {
        Probe::Hit(detail) => detail,
        other => panic!("通道 {channel} 对「{key}」应当命中，实际 {other:?}"),
    }
}

/// 把某条通道改成「取不到证据」（挖掉判据的一条腿）。
fn knock_out(ev: &mut CandidateEvidence, channel: &str, why: &str) {
    for c in ev.body.iter_mut().chain(ev.traces.iter_mut()) {
        if c.channel == channel {
            c.probe = Probe::Unavailable(why.to_string());
        }
    }
}

// ---------------------------------------------------------------- §3-P2-T2：C1

#[test]
fn c1_uninstall_entry_makes_it_present() {
    let m = FakeMachine::new("c1-uninstall");
    // 三个根都要真的读到：条目只登记在 **WOW6432Node** 那一条上（32 位安装包的真形状），
    // 只读 HKLM 64 位视图的实现会把它漏成「无本体」—— 那正是多删的一半。
    let (mut registry, processes) = m.clean_snapshot();
    registry.uninstall[1].entries.push(UninstallEntry {
        key: "{6F2C5A9B-1D3E-4C7A}".into(),
        display_name: Some("Acme Notepad".into()),
        install_location: None,
    });
    let table = m.collect_with(&m.input_with(registry.clone(), processes.clone()), &["acme-notepad"]);
    let acme = fact_of(&table, "acme-notepad");
    assert_eq!(
        acme,
        AppFact::Present,
        "卸载表里有这一条（32 位视图），它就不是残留：{acme:?}"
    );

    // 命中细节点得出是**哪一路**（报告要说得出话）。
    let scan = scan_all(&m.input_with(registry.clone(), processes.clone()));
    let detail = probe_detail(&scan, CH_UNINSTALL, "acme-notepad");
    assert!(detail.contains("Acme Notepad"), "C1 的命中要报出条目名：{detail}");

    // 子键名也能顶（很多 MSI 只有 GUID 键 + 空 DisplayName）：这一条**不能**命中，
    // 因为 GUID 与候选目录名没有任何字面关系 —— 它落哪儿由痕迹那一半决定，不许落 absent。
    let mut guid_only = registry.clone();
    guid_only.uninstall[0].entries.push(UninstallEntry {
        key: "D8A1F2B3-11C2-4A5E-9F01".into(),
        display_name: None,
        install_location: Some(m.p("pf/SomeOtherApp")),
    });
    let t2 = m.collect_with(&m.input_with(guid_only, processes.clone()), &["acme-notepad"]);
    assert!(
        !t2["acme-notepad"].is_absent(),
        "一条 GUID 卸载项把无关候选判成了残留：{:?}",
        t2["acme-notepad"]
    );

    // 反向半边：C1 **取不到证据**时，同一条目在场也不许把结论抬成 Present，
    // 也不许被折叠成「卸载表里没有它」→ absent。
    let mut broken = registry.clone();
    broken.uninstall[0].status = RootStatus::Unavailable("RegOpenKeyExW 失败（错误码 5）".into());
    broken.uninstall[1].entries.clear();
    let t3 = m.collect_with(&m.input_with(broken, processes.clone()), &["acme-notepad"]);
    let fact = fact_of(&t3, "acme-notepad");
    assert!(matches!(fact, AppFact::Unknown { .. }), "C1 没看成 → 弃权：{fact:?}");
    assert!(
        fact.why().unwrap().contains("C1"),
        "弃权理由要点名 C1：{}",
        fact.why().unwrap()
    );
}

// ---------------------------------------------------------------- §3-P2-T2：C2

#[test]
fn c2_vendor_key_alone_is_only_a_trace() {
    let m = FakeMachine::new("c2-trace");
    let (registry, processes) = m.clean_snapshot();
    // 只有一条顶层厂商键指向它：本体四条全部「证完了、没有」。
    let mut reg = registry.clone();
    reg.vendors[0].keys = vec!["Zebrafish".into()];
    let scan = scan_all(&m.input_with(reg.clone(), processes.clone()));

    // ① 痕迹**不是** Present：厂商键在 ≠ 应用还在（它可能是卸载后留的壳）。
    assert!(
        !matches!(scan.probe_for(CH_UNINSTALL, "zebrafish"), Probe::Hit(_)),
        "厂商键不该被当成卸载条目"
    );
    let ev = scan.evidence_for("zebrafish");
    assert!(
        !matches!(
            ev.body.iter().find(|c| c.channel == CH_VENDOR_KEYS),
            Some(_)
        ),
        "厂商键走错表了：它不是本体通道"
    );
    assert!(matches!(
        ev.traces.iter().find(|c| c.channel == CH_VENDOR_KEYS).unwrap().probe,
        Probe::Hit(_)
    ));
    // 本体四条都是「证完了、没有」+ 一条痕迹 ⇒ 这一格才是 absent（也是唯一能进删除建议的一格）。
    assert_eq!(judge(&ev), AppFact::Absent, "两半都成立才走到这一档：{:?}", judge(&ev));

    // ② 任务书那一半：**每条本体通道都要报「看成了、确实是空的」**才许 absent。
    //    逐条把一条腿挖成「没看成」→ 立刻退回弃权。
    let mut one_at_a_time = ev.clone();
    knock_out(&mut one_at_a_time, CH_UNINSTALL, "根打不开");
    assert!(matches!(judge(&one_at_a_time), AppFact::Unknown { .. }));
    for ch in [CH_PACKAGES, CH_INSTALL_ROOTS, CH_PROCESSES] {
        let mut broken = ev.clone();
        knock_out(&mut broken, ch, "这一路没取到证据");
        let fact = judge(&broken);
        assert!(
            matches!(fact, AppFact::Unknown { .. }),
            "{ch} 取不到证据却仍给出删除建议：{fact:?}"
        );
        assert!(fact.why().unwrap().contains(ch), "why 要点名 {ch}：{}", fact.why().unwrap());
    }
    // 痕迹那一路自己取不到证据也一样退弃权（那一半同样不许被折叠成「没有痕迹」→ 第 ③ 步）。
    let mut trace_broken = ev.clone();
    knock_out(&mut trace_broken, CH_VENDOR_KEYS, "SOFTWARE 顶层枚举断了");
    assert!(matches!(judge(&trace_broken), AppFact::Unknown { .. }));

    // ③ 厂商键的口径**不含路径**：叫 `Windows` / `CurrentVersion` 的候选目录不许凭路径混进 absent。
    let pathy = RegistrySnapshot {
        uninstall: m.clean_uninstall_roots(),
        vendors: vec![VendorRoot {
            path: r"HKLM\SOFTWARE（64 位视图顶层键）".into(),
            status: RootStatus::Listed,
            keys: vec!["Microsoft".into()],
        }],
    };
    let s2 = scan_all(&m.input_with(pathy, processes));
    for k in ["windows", "currentversion", "uninstall"] {
        assert!(
            !matches!(s2.probe_for(CH_VENDOR_KEYS, k), Probe::Hit(_)),
            "厂商键的证据里混进了路径段，候选「{k}」白拿一条痕迹"
        );
    }
}

// ---------------------------------------------------------------- §3-P2-T2：C5

#[test]
fn c5_a_running_process_makes_it_present() {
    let m = FakeMachine::new("c5-process");
    let (registry, _) = m.clean_snapshot();
    let snap = ProcessSnapshot::listed(vec![
        ProcessRecord { exe: "svchost.exe".into(), image: Some(r"C:\Windows\System32\svchost.exe".into()) },
        // 装在 D 盘、没登记卸载表、没有包、没有安装根目录 —— 只有进程在跑（kazumi 那一类）。
        ProcessRecord {
            exe: "Zoom.exe".into(),
            image: Some("D:/Apps/Zoom/bin/Zoom.exe".into()),
        },
    ]);
    let table = m.collect_with(&m.input_with(registry.clone(), snap.clone()), &["zoom"]);
    assert_eq!(fact_of(&table, "zoom"), AppFact::Present, "进程在跑就是本体在：{:?}", table);
    let scan = scan_all(&m.input_with(registry.clone(), snap.clone()));
    let detail = probe_detail(&scan, CH_PROCESSES, "zoom");
    assert!(detail.contains("Zoom.exe"), "C5 的命中要报出镜像名：{detail}");

    // 完整路径拿不到（保护进程 / 别人的会话）**不**降级：名字来自枚举本身。
    let unnamed = ProcessSnapshot::listed(vec![ProcessRecord { exe: "Zoom.exe".into(), image: None }]);
    let t2 = m.collect_with(&m.input_with(registry.clone(), unnamed), &["zoom"]);
    assert_eq!(fact_of(&t2, "zoom"), AppFact::Present, "少一条完整路径就丢了 Present：{t2:?}");

    // 快照压根没采集 / 中途断了 / 表里一个进程都没有 —— 三档都不许被读成「它没在跑」。
    for broken in [
        ProcessSnapshot::default(),
        ProcessSnapshot::unavailable("Process32NextW 在第 12 个进程处中断（错误码 5）"),
        ProcessSnapshot::listed(vec![]),
    ] {
        let t3 = m.collect_with(&m.input_with(registry.clone(), broken), &["zoom"]);
        let fact = fact_of(&t3, "zoom");
        assert!(
            matches!(fact, AppFact::Unknown { .. }),
            "取不到证据的进程快照被读成结论了：{fact:?}"
        );
        assert!(fact.why().unwrap().contains("C5"), "why 要点名 C5：{}", fact.why().unwrap());
    }

    // 而且**痕迹也没有**时那一格仍然不许 absent（这里 C5 是唯一被挖掉的腿）。
    let mut reg_with_trace = registry;
    reg_with_trace.vendors[0].keys = vec!["Zoom".into()];
    let t4 = m.collect_with(
        &m.input_with(reg_with_trace, ProcessSnapshot::default()),
        &["zoom"],
    );
    assert!(!t4["zoom"].is_absent(), "「进程表没看成」被当成「没在跑」：{:?}", t4["zoom"]);
}

// ---------------------------------------------------------------- §4.4 硬判据

#[test]
fn install_location_feeds_extra_roots_so_d_drive_apps_are_present() {
    let fixture = common::load();
    let cases = common::cases(&fixture);
    let by_name = |n: &str| -> &Value {
        cases.iter().find(|c| c["name"].as_str() == Some(n)).unwrap_or_else(|| panic!("夹具没有 case「{n}」"))
    };

    // ── 参考机那类（任务书点名的形状）：`Claude` 登记了、InstallLocation 在 D 盘。
    let registered = Machine::new(by_name("claude-registered-on-d"));
    let input = registered.input();
    let fed = deepclean_appfacts::roots_with_feedback(&input.roots, &input.registry, &input.env);
    let extras: Vec<String> = fed
        .install_roots
        .iter()
        .filter(|r| r.extra)
        .map(|r| r.path.to_string_lossy().into_owned())
        .collect();
    assert!(
        extras.iter().any(|p| p.ends_with("Claude") || p.ends_with("Claude\\")),
        "§4.4：InstallLocation 没被反推成 C4 的额外根：{extras:?}"
    );
    let table = registered.collect(&["Claude"]);
    assert_eq!(fact_of(&table, "claude"), AppFact::Present, "装在别的盘 != 残留：{table:?}");
    let scan = scan_all(&input);
    let detail = probe_detail(&scan, CH_INSTALL_ROOTS, "claude");
    assert!(
        detail.contains("Claude"),
        "C4 的命中细节要能指到那个额外根：{detail}"
    );

    // ── 刀锋那一半：卸载条目的**名字对不上候选目录名**，只有 InstallLocation 的最后一段对得上。
    //    这一条才是「少了反馈环就多判 Absent（多删）」的逐字证明。
    let mismatch = Machine::new(by_name("d-drive-name-mismatch"));
    let min = mismatch.input();
    let key = "urban-friendship-story";
    let with = mismatch.collect(&[key]);
    assert_eq!(
        fact_of(&with, key),
        AppFact::Present,
        "§4.4 的反馈环没生效：装在 D 盘的应用被提议删除了"
    );

    // 对照（**摘掉反馈环**）：同一台机器、同一份快照，只是不把 InstallLocation 喂给 C4。
    // 这一步必须得到 Absent —— 否则上面那句 Present 测的就不是反馈环，而是别的什么东西在兜底。
    let bare = FactScan::from_parts(
        &fs_probe::scan(&min.roots),
        &min.registry,
        &min.processes,
    );
    let bare_fact = judge(&bare.evidence_for(key));
    assert_eq!(
        bare_fact,
        AppFact::Absent,
        "对照不成立：摘掉 §4.4 的反馈环之后这一格不是 Absent（{bare_fact:?}），\
         那上面那句 Present 就没测到反馈环"
    );

    // 反方向的钉子：额外根**不存在**时不许凭空 Present，但「看过、那个位置不在」要进报告。
    let m = FakeMachine::new("4-4-stale");
    let (mut reg, procs) = m.clean_snapshot();
    reg.uninstall[0].entries.push(UninstallEntry {
        key: "{A1B2C3D4-E5F6-4A7B}".into(),
        display_name: None, // GUID-only 条目：C1 的名字这一路对不上候选
        install_location: Some(m.p("D-gone/GoneApp")), // 这个位置**没建出来**
    });
    reg.vendors[0].keys = vec!["GoneApp".into()]; // 痕迹在 ⇒ 少了本体证据就会落 absent
    let stale = m.collect_with(&m.input_with(reg.clone(), procs.clone()), &["goneapp"]);
    assert!(
        !matches!(stale["goneapp"], AppFact::Present),
        "一个不存在的额外根被当成了本体证据：{:?}",
        stale["goneapp"]
    );
    assert!(
        stale["goneapp"].is_absent(),
        "陈旧 InstallLocation 该被这条判据**认下来**（这里没有别的证据说它装着）：{:?}",
        stale["goneapp"]
    );
    let scan2 = scan_all(&m.input_with(reg, procs.clone()));
    let cs = scan2.channels.get(CH_INSTALL_ROOTS).expect("C4 在表里");
    assert!(
        cs.empty_notes.iter().any(|n| n.contains("不存在")),
        "陈旧的 InstallLocation 没被记成「看过、那个位置不存在」：{:?}",
        cs.empty_notes
    );
    // 而「展不开的」那一串（`%GAMEDIR%\…`）走盲区，绝不当成「看过、那里没有」。
    // 这一格的痕迹是**字面同名**的快捷方式（不是厂商键 —— 厂商键与候选名要归一才匹配得上，
    // 而痕迹那一半的窄口径在 P2-T2 裁定为不归一）。少了盲区它就是 absent。
    m.file("roaming/Microsoft/Windows/Start Menu/Programs/gone-app.lnk");
    let mut blind_reg = m.clean_snapshot().0;
    blind_reg.uninstall[0].entries.push(UninstallEntry {
        key: "D8A1F2B3".into(),
        display_name: None,
        install_location: Some("%GAMEDIR%/gone-app".into()),
    });
    let blind = m.collect_with(&m.input_with(blind_reg, m.clean_snapshot().1), &["gone-app"]);
    assert!(
        matches!(blind["gone-app"], AppFact::Unknown { .. }),
        "展不开的 InstallLocation 被丢了，候选直接落进删除建议：{:?}",
        blind["gone-app"]
    );
    assert!(
        blind["gone-app"].why().unwrap().contains("安装根"),
        "弃权理由要说的是 C4 那一路的盲区：{}",
        blind["gone-app"].why().unwrap()
    );
}

// ---------------------------------------------------------------- §0.2 三个反例

#[test]
fn the_three_reference_counterexamples_never_come_back_absent() {
    // 三个反例现在是 `tests/data/reference-shapes.json` 里的**真形状夹具**（P2-T1 之前是
    // 写在本文件里的字面量）；同一份文件也被 TS 侧 `core/facts/appfacts.ts` 跑。
    let fixture = common::load();
    let cases = common::cases(&fixture);
    let get = |n: &str| -> &Value {
        cases.iter().find(|c| c["name"].as_str() == Some(n)).unwrap_or_else(|| panic!("夹具没有 case「{n}」"))
    };

    let claude = Machine::new(get("claude-msix"));
    let kazumi = Machine::new(get("kazumi-running"));
    let story = Machine::new(get("urban-no-evidence"));

    let mut all: Vec<(String, AppFact)> = Vec::new();
    for m in [&claude, &kazumi, &story] {
        for (key, fact) in m.collect_table() {
            all.push((key, fact));
        }
    }
    for (key, fact) in &all {
        assert!(
            !fact.is_absent(),
            "§0.2 的反例「{key}」回来了 absent —— 这一档后面接的是删除：{fact:?}"
        );
    }
    let table = claude.collect_table();
    assert_eq!(fact_of(&table, "claude"), AppFact::Present, "Claude 是已装 MSIX：{:?}", table);
    let kt = kazumi.collect_table();
    assert_eq!(fact_of(&kt, "kazumi"), AppFact::Present, "kazumi 的包 + 活进程：{:?}", kt);
    // golden 那 367.8 MiB 的真身份要靠目录嵌套才知道，而这一层的判据只有名字 ——
    // 拿不到归属就弃权，不许 absent（少提议是这一版唯一允许的错法）。
    assert!(
        matches!(fact_of(&kt, "flutter_webview_windows"), AppFact::Unknown { .. }),
        "外层目录名拿不到归属却落进了某一档：{:?}",
        kt["flutter_webview_windows"]
    );
    let st = story.collect_table();
    assert!(
        matches!(fact_of(&st, "urban-friendship-story"), AppFact::Unknown { .. }),
        "游戏存档那一格必须是弃权（六条通道一条痕迹都没有）：{:?}",
        st["urban-friendship-story"]
    );
}

// ---------------------------------------------------------------- 核心 fail-safe

#[test]
fn an_unavailable_channel_can_never_be_read_as_checked_and_empty() {
    // 「couldn't look」≠「looked and found nothing」。这一条测的是六路**每一路**：
    // 先搭一台「痕迹在、四条本体全空」的机器（唯一能出 absent 的形状），再逐条把一条腿
    // 换成「没看成」，每一换都必须把 absent 打回弃权、并且点名是哪一路。
    let m = FakeMachine::new("fail-safe-every-leg");
    let (registry, processes) = m.clean_snapshot();
    let mut reg = registry.clone();
    reg.vendors[0].keys = vec!["Ghost".into()];
    m.file("roaming/Microsoft/Windows/Start Menu/Programs/Ghost.lnk");
    let base = m.input_with(reg.clone(), processes.clone());
    assert_eq!(
        deepclean_appfacts::collect_app_facts(&cands(&["ghost"]), &base)["ghost"],
        AppFact::Absent,
        "基线形状本身就出不了 absent，那下面每一换都测不到东西"
    );

    // ① C1：一根打不开。
    let mut r = reg.clone();
    r.uninstall[0].status = RootStatus::Unavailable("RegOpenKeyExW 失败（错误码 5）".into());
    expect_blind(&m, &m.input_with(r, processes.clone()), CH_UNINSTALL);

    // ② C2：顶层厂商键枚举断了。
    let mut r = reg.clone();
    r.vendors[0].status = RootStatus::Unavailable("RegEnumKeyExW 中断（错误码 5）".into());
    expect_blind(&m, &m.input_with(r, processes.clone()), CH_VENDOR_KEYS);

    // ③ C3：包目录容器读不出来 —— 在那个路径上放一个**文件**。
    //    对文件 `read_dir` 报的不是 `NotFound`，所以它落 `Unavailable` 而不是「看过、空的」。
    let shadow_root = m.dir("local/Packages");
    std::fs::remove_dir_all(&shadow_root).expect("夹具自己建的目录");
    m.file("local/Packages");
    let roots = ProbeRoots {
        packages: Some(shadow_root),
        ..m.roots()
    };
    expect_blind(
        &m,
        &ProbeInput { roots, registry: reg.clone(), processes: processes.clone(), env: m.env() },
        CH_PACKAGES,
    );

    // ④ C4：一个安装根都没配（覆盖面是空的，不是「都空着」）。
    expect_blind(
        &m,
        &ProbeInput {
            roots: ProbeRoots { packages: m.roots().packages, install_roots: vec![], start_menu_roots: m.roots().start_menu_roots },
            registry: reg.clone(),
            processes: processes.clone(),
            env: m.env(),
        },
        CH_INSTALL_ROOTS,
    );

    // ⑤ C5：进程快照没采集（默认值那一侧）。
    expect_blind(&m, &m.input_with(reg.clone(), ProcessSnapshot::default()), CH_PROCESSES);

    // ⑥ 整张表都没接线（`FactScan` 里一条通道都没有）—— 兜底分支那一侧。
    let nothing = FactScan::default();
    let table = nothing.collect(&cands(&["ghost"]));
    assert!(
        !table["ghost"].is_absent(),
        "六条通道全无取证结果却给出删除建议：{:?}",
        table["ghost"]
    );
    let why = table["ghost"].why().expect("弃权要带 why");
    for ch in [CH_UNINSTALL, CH_PACKAGES, CH_INSTALL_ROOTS, CH_PROCESSES, CH_VENDOR_KEYS, CH_START_MENU] {
        assert!(why.contains(ch), "why 要逐条点名是哪一路没取证，缺 {ch}：{why}");
    }

    // ⑦ 一个「没登记在通道表里的通道」也必须有同一张脸（替没跑过的通道作证那条防线）。
    assert!(matches!(
        nothing.probe_for("C7 某个还没影的通道", "ghost"),
        Probe::Unavailable(_)
    ));
}

/// 换掉一条腿之后：这一格必须是弃权，且 `why` 点名到那一路。
fn expect_blind(_m: &FakeMachine, input: &ProbeInput, channel: &'static str) {
    let table = deepclean_appfacts::collect_app_facts(&cands(&["ghost"]), input);
    let fact = table["ghost"].clone();
    assert!(
        !fact.is_absent(),
        "通道「{channel}」取不到证据却仍给出删除建议：{fact:?}"
    );
    assert!(
        matches!(fact, AppFact::Unknown { .. }),
        "通道「{channel}」取不到证据，这一格应是弃权：{fact:?}"
    );
    let why = fact.why().expect("弃权必须说得出理由");
    assert!(
        why.contains(channel),
        "why 要点名到取不到的那一路「{channel}」：{why}"
    );
}

// ---------------------------------------------------------------- P2-T1 那五条（用意不变，断言跟着接缝闭合改）

#[test]
fn absent_requires_both_a_trace_and_no_body() {
    let m = FakeMachine::new("both-halves");
    // 痕迹：公共开始菜单的二级目录里一个 .lnk（顺带钉住「递归 ≤ 2 层」这一层收得到）。
    m.file("programdata/Microsoft/Windows/Start Menu/Programs/Accessories/Ghost App.lnk");
    let ghost = fact_of(&m.collect(&["ghost"]), "ghost");

    // ① 痕迹有了（`Ghost App` 字面上**含**候选名 `ghost`，双向包含的 `t.contains(key)` 那一支），
    //    四条本体通道又逐条证完 ⇒ 这才是 absent。P2-T1 在这一格断的是「到不了 absent」，
    //    那当时是结构事实；接缝闭合之后它变成判据事实，所以断言反过来写（计划 §5 登记）。
    assert_eq!(ghost, AppFact::Absent, "两半都成立才走到这一档：{ghost:?}");
    // ② 痕迹**不是**本体：absent 不等于 Present，快捷方式永远不许把格子抬成「还在」。
    assert!(
        !matches!(ghost, AppFact::Present),
        "开始菜单快捷方式只能当痕迹，不能当「还在」：{ghost:?}"
    );

    // ③ 一条痕迹也没有 ⇒ 第 ③ 步接住：弃权，不是 absent。
    let clean = FakeMachine::new("both-halves-no-trace");
    let none = fact_of(&clean.collect(&["ghost"]), "ghost");
    assert!(
        matches!(none, AppFact::Unknown { .. }),
        "「这台机器装过它」都没证出来，却给出了删除建议：{none:?}"
    );
    assert!(none.why().unwrap().contains("痕迹"), "理由要说的是痕迹那一半：{}", none.why().unwrap());

    // ④ 反向半边：四条本体通道里挖掉一条（不是「没有」，是「没看到」）→ 立刻退回 Unknown。
    let (mut r2, p2) = m.clean_snapshot();
    r2.vendors[0].keys = vec!["Ghost".into()];
    let ev = scan_all(&m.input_with(r2, p2)).evidence_for("ghost");
    assert_eq!(judge(&ev), AppFact::Absent, "这一格的基线形状就该是 absent，否则下面挖腿测不到东西");
    let mut broken = ev.clone();
    knock_out(&mut broken, CH_INSTALL_ROOTS, "安装根读不出来（权限拒）");
    assert!(
        matches!(judge(&broken), AppFact::Unknown { .. }),
        "任一路取不到证据就不许 absent：{:?}",
        judge(&broken)
    );
    assert_eq!(ev.body.len(), 4, "本体这一半是四条：C1/C3/C4/C5");
    assert_eq!(ev.traces.len(), 2, "痕迹这一半是两条：C2/C6");
}

#[test]
fn a_missing_channel_yields_unknown_not_absent() {
    let m = FakeMachine::new("missing-channel");
    // 快捷方式名与候选目录名要在**字面**上对得上：`Acme Tool`（空格）与 `acme-tool`（连字符）
    // 在双向包含下不匹配。P2-T2 裁定继续保留这个窄口径 —— 放宽**痕迹**那一半等于降低
    // `Absent` 的门槛，而 `Absent` 后面接的是删除（计划 §0.1）。见
    // `trace_matching_stays_literal_by_p2_t2_adjudication`（fs_probe 的单元测试）。
    m.file("roaming/Microsoft/Windows/Start Menu/Programs/Acme-tool.lnk");

    // 故意交不出根：C3 的容器推导不出来（env 表里没有 LOCALAPPDATA）、C4 一个根都没配。
    let roots = ProbeRoots {
        packages: None,
        install_roots: vec![],
        start_menu_roots: m.roots().start_menu_roots.clone(),
    };
    let (registry, processes) = m.clean_snapshot();
    let input = ProbeInput { roots, registry, processes, env: m.env() };
    let table = m.collect_with(&input, &["acme-tool", "anything-else"]);
    assert!(
        table.values().all(|f| matches!(f, AppFact::Unknown { .. })),
        "两条本体通道没取证时整张表都该弃权：{table:?}"
    );
    for (key, fact) in &table {
        let why = fact.why().unwrap_or_default();
        assert!(!why.trim().is_empty(), "「{key}」这一格的弃权没有理由");
        assert!(
            why.contains("一个根都没配上") || why.contains("推导不出来"),
            "「{key}」的 why 要说出是哪一路取不到：{why}"
        );
    }
    let acme = fact_of(&table, "acme-tool");
    assert!(!acme.is_absent(), "痕迹有 + 两条本体通道没跑 = 判不出残留：{acme:?}");
    assert!(acme.why().unwrap().contains(CH_PACKAGES), "why 要点名 C3：{}", acme.why().unwrap());
    assert!(acme.why().unwrap().contains(CH_INSTALL_ROOTS), "why 要点名 C4：{}", acme.why().unwrap());
}

#[test]
fn present_evidence_is_one_way_never_inferred_from_absence() {
    // ① 什么都没有的假机器：不许 Present，也不许 Absent（六条通道里 C1/C2 没采集 ⇒ 弃权）。
    let empty = FakeMachine::new("one-way-empty");
    let nothing = ProbeInput {
        roots: empty.roots(),
        registry: RegistrySnapshot::nothing_collected(),
        processes: ProcessSnapshot::default(),
        env: empty.env(),
    };
    let table = empty.collect_with(&nothing, &["ghost", "claude", "kazumi"]);
    for (key, fact) in &table {
        assert!(
            !matches!(fact, AppFact::Present),
            "「{key}」：一条本体证据都没有，不许 Present：{fact:?}"
        );
        assert!(
            !fact.is_absent(),
            "「{key}」：通道没取证却给出了删除建议：{fact:?}"
        );
        assert!(fact.why().is_some(), "「{key}」：弃权要带 why");
    }

    // ② 加上一条 Packages 证据 → 只可能往 Present 走；撤掉 → 退回弃权，**不是**退回 absent。
    //    （假机器的 tag 里**不许**含候选名：C5 的进程镜像挂在这棵树的路径上，
    //    tag 叫 "one-way-claude" 就会让 `<tmp>/…-claude/…` 变成一条凭空的 Present 证据 ——
    //    这个坑 P2-T2 实跑踩过，正对着 `procs::image_parent_name` 那条「整条路径不进证据」的理由。）
    let m = FakeMachine::new("one-way");
    let pkg = m.dir("local/Packages/Claude_pzs8sxrjxfjjc");
    let with = m.collect(&["Claude"]);
    assert_eq!(fact_of(&with, "claude"), AppFact::Present);

    std::fs::remove_dir_all(&pkg).expect("撤掉夹具里的包目录");
    let after = fact_of(&m.collect(&["Claude"]), "claude");
    assert!(!matches!(after, AppFact::Present), "证据撤掉了还 Present：{after:?}");
    assert!(
        !after.is_absent(),
        "「Packages 里没有」被当成残留的证据了 —— 那正是 §1.2 写明不许的反方向：{after:?}"
    );

    // ③ 本体证据得是**目录**：同名的一个文件不算「装着」。
    let m2 = FakeMachine::new("one-way-not-a-dir");
    m2.file("local/Packages/NotAPkg_aaaaaaaaaaaaa");
    let t2 = m2.collect(&["notapkg"]);
    assert!(
        !matches!(fact_of(&t2, "notapkg"), AppFact::Present),
        "Packages 里一个同名**文件**被当成本体证据了：{:?}",
        t2["notapkg"]
    );

    // ④ 痕迹永远抬不到 Present：只留一个 .lnk 的应用，格子**不许**是「还在」。
    //    而四条本体通道都「证完了、没有」+ 这一条痕迹 ⇒ 它就是 absent —— 这正是这条规则
    //    唯一该提议删除的那种形状（卸载后留在开始菜单的壳）。P2-T1 在这一格断的是 Unknown，
    //    因为那时 absent 结构上到不了；接缝闭合之后断言换成「不是 Present，是 absent」。
    let m3 = FakeMachine::new("one-way-trace-only");
    m3.file("roaming/Microsoft/Windows/Start Menu/Programs/OnlyATrace.lnk");
    let t3 = m3.collect(&["onlyatrace"]);
    let trace = fact_of(&t3, "onlyatrace");
    assert!(!matches!(trace, AppFact::Present), "一条快捷方式被当成了「还在」：{trace:?}");
    assert!(
        matches!(trace, AppFact::Absent) || matches!(trace, AppFact::Unknown { .. }),
        "痕迹 + 四条本体全空，落点只能是 absent（提议删那个壳）或某一路没取证时的弃权：{trace:?}"
    );
    assert_eq!(trace, AppFact::Absent, "这台假机器的六条通道都证完了，就该是 absent");
    // 而同样的痕迹，只要有一条本体通道**没看成**，就立刻退回弃权（方向永远是少删）。
    let (r4, p4) = m3.clean_snapshot();
    let mut r4 = r4;
    r4.uninstall[0].status = RootStatus::Unavailable("RegOpenKeyExW 失败（错误码 5）".into());
    let t4 = m3.collect_with(&m3.input_with(r4, p4), &["onlyatrace"]);
    assert!(
        matches!(t4["onlyatrace"], AppFact::Unknown { .. }),
        "C1 没看成却仍然给出删除建议：{:?}",
        t4["onlyatrace"]
    );
}

#[test]
fn packages_prefix_matches_the_package_family_shape() {
    let m = FakeMachine::new("package-shape");
    m.dir("local/Packages/Claude_pzs8sxrjxfjjc");
    m.dir("local/Packages/com.flutter.kazumi_wbnnev551gwxy");
    m.dir("local/Packages/WindowsTerminalManager_8wekyb3d8bbwe");

    let scan = scan_all(&m.input());
    let table = m.collect(&["Claude", "kazumi", "flutter_webview_windows", "urban-friendship-story"]);

    assert_eq!(fact_of(&table, "claude"), AppFact::Present);
    assert_eq!(fact_of(&table, "kazumi"), AppFact::Present);
    let hit = probe_detail(&scan, CH_PACKAGES, "kazumi");
    assert!(hit.contains("com.flutter.kazumi"), "命中细节要报出包族名：{hit}");

    let outer = fact_of(&table, "flutter_webview_windows");
    assert!(!matches!(outer, AppFact::Present), "外层名字不该被包族名顶上去：{outer:?}");
    assert!(!outer.is_absent(), "拿不到归属就不许提议删除：{outer:?}");
    let why = outer.why().expect("弃权要带 why");
    assert!(why.contains("痕迹"), "这一格的弃权理由是「装过都证不出来」那一半：{why}");

    let story = fact_of(&table, "urban-friendship-story");
    assert!(!story.is_absent(), "{story:?}");
    assert!(!matches!(story, AppFact::Present), "{story:?}");

    assert_eq!(
        fs_probe::package_family("com.flutter.kazumi_wbnnev551gwxy"),
        "com.flutter.kazumi"
    );
    assert_eq!(fs_probe::package_family("Claude_pzs8sxrjxfjjc"), "Claude");
}

#[test]
fn c4_extra_roots_are_honoured() {
    let m = FakeMachine::new("extra-roots");
    let app_dir = m.dir("Browser/Claude");
    let mut roots = m.roots();
    let (registry, processes) = m.clean_snapshot();
    let base = ProbeInput { roots: roots.clone(), registry: registry.clone(), processes: processes.clone(), env: m.env() };
    let unseen = fact_of(&m.collect_with(&base, &["Claude"]), "claude");
    assert!(
        !matches!(unseen, AppFact::Present),
        "没配额外根时不该看见它（看见了这条对照就测不到 §4.4 那个洞）：{unseen:?}"
    );

    // 形状 A：额外根 = 应用的**父目录**（`D:\Browser`），命中走一级目录名。
    roots.push_extra_install_root(m.root.join("Browser"));
    let by_child = m.collect_with(
        &ProbeInput { roots: roots.clone(), registry: registry.clone(), processes: processes.clone(), env: m.env() },
        &["Claude"],
    );
    assert_eq!(
        fact_of(&by_child, "claude"),
        AppFact::Present,
        "额外根的一级目录没被当成安装证据"
    );

    // 形状 B：额外根 = `InstallLocation` 反推出来的**应用自己那一层**。
    let mut roots2 = m.roots();
    roots2.push_extra_install_root(app_dir.clone());
    let by_self = m.collect_with(
        &ProbeInput { roots: roots2, registry, processes, env: m.env() },
        &["Claude"],
    );
    assert_eq!(
        fact_of(&by_self, "claude"),
        AppFact::Present,
        "InstallLocation 反推出来的额外根没生效（§4.4 的硬判据）"
    );

    // 额外根不能污染默认根的判断。
    let defaults = m.roots();
    let standard_only: Vec<PathBuf> = defaults
        .install_roots
        .iter()
        .map(|r: &InstallRoot| r.path.clone())
        .collect();
    assert!(!standard_only.contains(&m.root.join("Browser")), "额外根漏进了默认根表：{standard_only:?}");
    assert!(
        defaults.install_roots.iter().all(|r| !r.extra),
        "from_env_vars 推出的默认根里出现了 extra 标记"
    );
}

// ---------------------------------------------------------------- 闸本身的非空跑

#[test]
fn the_fixture_actually_exercises_every_state() {
    // 夹具质量闸：present / absent / unknown 三档、`missing` 根、`unavailable` 根、
    // 拿不到镜像路径的进程、Guid 键的卸载项、长度闸下的短候选 —— 每一样都要**至少被一条 case
    // 真跑到**，否则「九条 case 两侧全等」里可能有一半是同一格在原地打转。
    let fixture = common::load();
    let cases = common::cases(&fixture);
    assert!(cases.len() >= 8, "夹具只剩 {} 条 case，这不够覆盖三档 + 两类没看成", cases.len());
    let text = fixture.to_string(); // serde_json 的**紧凑**投影：针串按紧凑写法配
    for want in [
        r#""absent""#,
        r#""present""#,
        r#""unknown""#,
        r#""missing""#,
        r#""unavailable""#,
        r#""image":null"#,
        r#""displayName":null"#,
        "urban-friendship-story",
        "com.flutter.kazumi_wbnnev551gwxy",
        "Claude_pzs8sxrjxfjjc",
    ] {
        assert!(text.contains(want), "夹具里没有 {want} 这一格，判据的覆盖面塌了");
    }
    // 每条 case 的 expect 都要覆盖它自己的全部候选（否则「两侧同意」可以靠漏项达成）。
    for c in &cases {
        let name = c["name"].as_str().unwrap_or("?");
        for cand in c["candidates"].as_array().cloned().unwrap_or_default() {
            let key = deepclean_appfacts::fact_key(cand.as_str().unwrap_or(""));
            let have = c["expect"].get(&key).is_some();
            assert!(have, "case「{name}」的候选「{key}」在 expect 里没有对应格子");
        }
    }
}

/// P2-T1 那条「接缝报警」的用例换成 P2-T2 的形状：`ChannelScan` 的顺序判据本身。
#[test]
fn channel_probe_orders_hit_before_gap_before_no_roots() {
    let mut cs = ChannelScan {
        roots_configured: 1,
        roots_verified: 1,
        gaps: vec!["Ghost".into()],
        entries: vec!["Ghost".into()],
        ..Default::default()
    };
    assert!(matches!(cs.probe("ghost"), Probe::Hit(_)), "命中必须优先于一切");
    cs.entries.clear();
    assert!(matches!(cs.probe("ghost"), Probe::Unavailable(_)), "命中撤掉后盲区要接住");
    assert!(matches!(cs.probe("other"), Probe::CheckedNoHit), "无关候选不该被盲区连带");
    cs.failures.push("根读不出来".into());
    assert!(matches!(cs.probe("other"), Probe::Unavailable(_)), "有失败时不许报「证完了」");
    let mut none = ChannelScan::default();
    none.gaps.push("Ghost".into());
    assert!(
        matches!(none.probe("nothing"), Probe::Unavailable(_)),
        "一个根都没配 = 覆盖面是空的"
    );
}
