//! 夹具加载器（P2-T2）：把 `tests/data/reference-shapes.json` 那一台**假机器**搬进测试。
//!
//! 为什么住在 `tests/common/` 而不是各自一份：`collect.rs`（七条硬判据）与 `parity_ts.rs`
//! （与 TS 的对账）跑的是**同一份**夹具 —— 夹具一旦有两份，「TS 与 Rust 在同一份夹具上同意」
//! 就退化成「两边各自跟自己的副本同意」。
//!
//! Rust 侧多做一件事：把 `contents` 那棵**虚拟树**搬到 `%TEMP%` 下真建出来，然后让
//! `fs_probe` 真的去 `read_dir`。这样对账覆盖的是整条 `collect_app_facts` 生产路径
//! （含根清单推导与目录枚举），而不只是判据函数。TS 侧不碰盘，`contents` 就是它的全部机器 ——
//! 这一格差异**不在** parity 的等式里（它是 Rust 独占的读盘面，`collect.rs` 里另有用例钉）。
//!
//! 三种 `status` 的搬法（两侧必须同判据）：
//! - `listed` → 建目录（枚举得到 = 「看过了」）；
//! - `missing` → **不建**（`read_dir` 报 `NotFound` = 「看过，那个位置不存在」）；
//! - `unavailable` → 在那条路径上建一个**文件**：对文件 `read_dir` 报的不是 `NotFound`，
//!   于是 `fs_probe` 只能落 `Unavailable` —— 「没看成」与「看成空的」在夹具里也分得开。

#![allow(dead_code)]

use deepclean_appfacts::{
    procs::{ProcessRecord, ProcessSnapshot},
    registry::{RegistrySnapshot, RootStatus, UninstallEntry, UninstallRoot, VendorRoot},
    ProbeInput, ProbeRoots,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const FIXTURE: &str = "reference-shapes.json";

/// 读夹具原文（`CARGO_MANIFEST_DIR` 下的 `tests/data/`，与 TS 侧同一份文件）。
pub fn load() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join(FIXTURE);
    let raw = std::fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("夹具读不出来 {}：{e}", p.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("夹具不是合法 JSON：{e}"))
}

pub fn cases(root: &Value) -> Vec<&Value> {
    root["cases"]
        .as_array()
        .expect("夹具要有 cases 数组")
        .iter()
        .collect()
}

/// 虚拟路径 → 真路径：`C:/Program Files` → `<tmp>/C_/Program Files`。
/// 段名里的 `:` 换成 `_`（Windows 的目录名不许有冒号），其余原样 ——
/// **最后一段（basename）一格都不动**，而判据只认 basename。
pub fn realize(tmp: &Path, virtual_path: &str) -> PathBuf {
    let mut out = tmp.to_path_buf();
    for seg in virtual_path.replace('\\', "/").split('/') {
        if seg.is_empty() {
            continue;
        }
        out.push(seg.replace(':', "_"));
    }
    out
}

/// 这条虚拟路径是不是「看起来绝对」（有盘符或 UNC）—— 决定它要不要在 %TEMP% 下建出来。
fn looks_like_absolute(v: &str) -> bool {
    let s = v.replace('/', "\\");
    let b = s.as_bytes();
    s.starts_with("\\\\") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

fn status_of(v: &Value, default: &str) -> String {
    v.get("status").and_then(Value::as_str).unwrap_or(default).to_string()
}

fn reg_status(v: &Value) -> RootStatus {
    match status_of(v, "listed").as_str() {
        "missing" => RootStatus::Missing,
        "unavailable" => RootStatus::Unavailable(
            v.get("why")
                .and_then(Value::as_str)
                .unwrap_or("夹具没写原因")
                .to_string(),
        ),
        _ => RootStatus::Listed,
    }
}

/// 建出这台假机器：`contents` 的每个目录 + 每条能定位的 `InstallLocation` + 每个 `listed` 根。
fn materialize(tmp: &Path, case: &Value) {
    let contents = case
        .get("contents")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (dir, entries) in &contents {
        let real = realize(tmp, dir);
        std::fs::create_dir_all(&real)
            .unwrap_or_else(|e| panic!("夹具建目录 {}：{e}", real.display()));
        for item in entries.as_array().cloned().unwrap_or_default() {
            let name = item["name"].as_str().expect("contents 条目要有 name").to_string();
            let kind = item["kind"].as_str().unwrap_or("dir");
            let child = real.join(&name);
            if kind == "dir" {
                std::fs::create_dir_all(&child)
                    .unwrap_or_else(|e| panic!("夹具建子目录 {}：{e}", child.display()));
            } else {
                if let Some(parent) = child.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::File::create(&child)
                    .unwrap_or_else(|e| panic!("夹具建文件 {}：{e}", child.display()));
            }
        }
    }

    // 卸载表里的 InstallLocation：能定位的那些也在 %TEMP% 下建出来（§4.4 的反馈环要真的落盘）。
    if let Some(uninstall) = case["registry"]["uninstall"].as_array() {
        for root in uninstall {
            for e in root["entries"].as_array().cloned().unwrap_or_default() {
                if let Some(raw) = e.get("installLocation").and_then(Value::as_str) {
                    if looks_like_absolute(raw) {
                        let real = realize(tmp, raw);
                        let _ = std::fs::create_dir_all(&real);
                    }
                }
            }
        }
    }

    // 根清单：listed → 必须在；missing → 必须不在；unavailable → 占一个**文件**。
    for r in case["roots"].as_array().cloned().unwrap_or_default() {
        let path = r["path"].as_str().expect("root 要有 path");
        let real = realize(tmp, path);
        match status_of(&r, "listed").as_str() {
            "missing" => {
                let _ = std::fs::remove_dir_all(&real);
                let _ = std::fs::remove_file(&real);
            }
            "unavailable" => {
                if let Some(parent) = real.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::remove_dir(&real);
                std::fs::File::create(&real)
                    .unwrap_or_else(|e| panic!("夹具把 {} 建成文件（模拟读不出来）失败：{e}", real.display()));
            }
            _ => {
                let _ = std::fs::remove_file(&real);
                std::fs::create_dir_all(&real)
                    .unwrap_or_else(|e| panic!("夹具建根 {}：{e}", real.display()));
            }
        }
    }
}

/// `InstallLocation` 从虚拟路径改写真路径（只有看起来绝对的那些；`%GAMEDIR%/…` 原样留着，
/// 那正是「展不开」那一档要测的东西）。
fn rewrite_install_locations(case: &Value, tmp: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    for root in case["registry"]["uninstall"].as_array().cloned().unwrap_or_default() {
        let built: Vec<Value> = root["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut e| {
                if let Some(raw) = e.get("installLocation").and_then(Value::as_str) {
                    if looks_like_absolute(raw) {
                        e["installLocation"] =
                            Value::String(realize(tmp, raw).to_string_lossy().into_owned());
                    }
                }
                e
            })
            .collect();
        out.push(serde_json::json!({
            "path": root["path"], "status": root["status"], "why": root.get("why"), "entries": built
        }));
    }
    out
}

fn registry_snapshot(case: &Value, tmp: &Path) -> RegistrySnapshot {
    let uninstall = rewrite_install_locations(case, tmp)
        .into_iter()
        .map(|r| UninstallRoot {
            path: r["path"].as_str().unwrap_or("").to_string(),
            status: reg_status(&r),
            entries: r["entries"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|e| UninstallEntry {
                    key: e["key"].as_str().unwrap_or("").to_string(),
                    display_name: e.get("displayName").and_then(Value::as_str).map(str::to_string),
                    install_location: e
                        .get("installLocation")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect(),
        })
        .collect();
    let vendors = case["registry"]["vendors"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| VendorRoot {
            path: r["path"].as_str().unwrap_or("").to_string(),
            status: reg_status(&r),
            keys: r["keys"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect(),
        })
        .collect();
    RegistrySnapshot { uninstall, vendors }
}

fn process_snapshot(case: &Value) -> ProcessSnapshot {
    let p = &case["processes"];
    match status_of(p, "listed").as_str() {
        "unavailable" => ProcessSnapshot::unavailable(
            p.get("why")
                .and_then(Value::as_str)
                .unwrap_or("夹具没写原因"),
        ),
        _ => ProcessSnapshot::listed(
            p["records"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|r| ProcessRecord {
                    exe: r["exe"].as_str().unwrap_or("").to_string(),
                    image: r.get("image").and_then(Value::as_str).map(str::to_string),
                })
                .collect(),
        ),
    }
}

fn probe_roots(case: &Value, tmp: &Path) -> ProbeRoots {
    let mut roots = ProbeRoots::default();
    for r in case["roots"].as_array().cloned().unwrap_or_default() {
        let path = r["path"].as_str().expect("root 要有 path");
        let real = realize(tmp, path);
        match r["channel"].as_str().expect("root 要有 channel") {
            "packages" => roots.packages = Some(real),
            "startMenu" => roots.start_menu_roots.push(real),
            _ => {
                if r["extra"].as_bool().unwrap_or(false) {
                    roots.push_extra_install_root(real);
                } else {
                    roots.push_standard(real);
                }
            }
        }
    }
    roots
}

fn env(case: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(map) = case.get("env").and_then(Value::as_object) {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// 一台搬好的假机器。
pub struct Machine {
    pub tmp: PathBuf,
    pub name: String,
    pub candidates: Vec<String>,
    pub input: ProbeInput,
    pub expect: BTreeMap<String, String>,
}

/// 把一条 case 搬成 `%TEMP%` 下一台可扫的假机器。
pub fn machine(case: &Value) -> Machine {
    let name = case["name"].as_str().unwrap_or("unnamed").to_string();
    let tmp = std::env::temp_dir().join(format!(
        "deepclean-appfacts-fixture-{}-pid{}-{}",
        name.replace('-', "_"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("夹具根目录");
    materialize(&tmp, case);
    let input = ProbeInput {
        roots: probe_roots(case, &tmp),
        registry: registry_snapshot(case, &tmp),
        processes: process_snapshot(case),
        env: env(case),
    };
    let candidates = case["candidates"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.as_str().map(str::to_string))
        .collect();
    let mut expect = BTreeMap::new();
    if let Some(map) = case.get("expect").and_then(Value::as_object) {
        for (k, v) in map {
            expect.insert(k.to_lowercase(), v.as_str().unwrap_or("").to_string());
        }
    }
    Machine { tmp, name, candidates, input, expect }
}

impl Machine {
    pub fn new(case: &Value) -> Self {
        machine(case)
    }

    pub fn input(&self) -> ProbeInput {
        self.input.clone()
    }

    /// 按夹具自带的候选清单跑一遍（对账用的就是这一格）。
    pub fn collect_table(&self) -> deepclean_appfacts::AppFactsTable {
        deepclean_appfacts::collect_app_facts(&self.candidates, &self.input)
    }

    /// 换一份输入跑（`install_location_feeds_extra_roots_…` 那条的对照半边要用）。
    pub fn collect_with(&self, input: &ProbeInput, candidates: &[&str]) -> deepclean_appfacts::AppFactsTable {
        deepclean_appfacts::collect_app_facts(
            &candidates.iter().map(|s| s.to_string()).collect::<Vec<String>>(),
            input,
        )
    }

    pub fn collect(&self, candidates: &[&str]) -> deepclean_appfacts::AppFactsTable {
        self.collect_with(&self.input, candidates)
    }

    /// Rust 侧算出来的表 → 投影（与 `expect` 同形状，比对与写投影文件都用它）。
    pub fn projection(&self) -> BTreeMap<String, &'static str> {
        self.collect_table()
            .iter()
            .map(|(k, f)| (k.clone(), project(f)))
            .collect()
    }

    /// 逐格比 `expect`，并把两侧共同依赖的那份投影交出去。
    pub fn check(&self) -> BTreeMap<String, &'static str> {
        let table = self.collect_table();
        for (key, want) in &self.expect {
            let got = project(
                table
                    .get(key)
                    .unwrap_or_else(|| panic!("case「{}」的表里没有「{key}」这一格：{table:?}", self.name)),
            );
            assert_eq!(
                got, want.as_str(),
                "case「{}」的「{key}」：期望 {want}，实得 {got}（{:?}）",
                self.name, table[key]
            );
        }
        assert_eq!(
            table.len(),
            self.expect.len(),
            "case「{}」的表比 expect 多出了格子（夹具的候选与期望没对上）：{table:?}",
            self.name
        );
        self.projection()
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        // 只有测试夹具动盘（`src/*.rs` 的生产片段由 `tests/readonly.rs` 钉住）。
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

/// 三态 → 投影串（两侧同口径；`why` **不进**投影，理由写在夹具的 `_comment` 里）。
pub fn project(fact: &deepclean_appfacts::AppFact) -> &'static str {
    match fact {
        deepclean_appfacts::AppFact::Present => "present",
        deepclean_appfacts::AppFact::Absent => "absent",
        deepclean_appfacts::AppFact::Unknown { .. } => "unknown",
    }
}
