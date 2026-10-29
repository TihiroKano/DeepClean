//! v0.1「输出标准化 JSON」的 Tauri 侧（M5-E⑤）。基准：`core/report/scan-report.ts`
//! （`buildScanReport` / `buildErrors` / `summarizeDir`），schema 串、字段名、键缺席规则逐字对齐。
//!
//! ## 这份报告导出的是**同一次扫描**，不是重算一遍
//!
//! 计数一律取快照（`ScanSnapshotWire`），目录树取那棵已建好的 arena。报告与界面、与预估因此
//! 永远同源；如果这里重新走一次盘，两份数字就会在扫描仍在跑的时候分叉，而那是查不出来的分叉。
//!
//! ## 两条"整键缺席"的规矩（不是排版洁癖）
//!
//! - 一个被拒目录都没有 → `errors.sample` **不出现**（给 `[]` 会被读成"这一栏是空的"，
//!   而不是"根本没这一栏"）；
//! - 清单没被截短 → `sampleOverflow` **不出现**（给 0 同理）。
//! 有值时恒等式 `sample.length + (sampleOverflow ?? 0) === denied` 必须成立 —— 这里靠
//! "按快照的 `denied` 截齐、溢出从同一个 `denied` 出发"保证它成立（扫描仍在跑时清单可能更长，
//! 截掉的那几条本来就是快照之后才发生的）。
//!
//! ## 一处 Rust 侧答不出来的东西，点名而不是补一个数
//!
//! TS 那份还有 `peakRssBytes`（进程峰值工作集）。这一侧**没有采**（M1 的量内存是另一条链上的事，
//! 而这里没有现成的数），所以它交 `null` —— 基准的字段类型本来就是 `number | null`，
//! `null` 是"没测"那句话的合法形状，不是 0。基准的调用点今天也传 `null`
//! （`electron/main/ipc-register.ts:50`），所以两侧在真机上是同一个数；差别只在**这一侧没有那条管道**。

use crate::service::{self, ScanSnapshotWire};
use deepclean_rules::engine::normalize_key;
use deepclean_scanner::tree_index::{ChildRef, TreeIndex};
use serde::Serialize;

/// schema 标识 —— 与 TS 的 `SCAN_REPORT_SCHEMA` 逐字同。老读者按名字取字段、多出来的键忽略。
pub const SCAN_REPORT_SCHEMA: &str = "deepclean.scan-report/1";

/// 目录摘要的裁剪参数默认值（与 TS 同：`DEFAULT_MAX_DEPTH = 3` / `DEFAULT_TOP_PER_LEVEL = 12`）。
pub const DEFAULT_MAX_DEPTH: usize = 3;
pub const DEFAULT_TOP_PER_LEVEL: usize = 12;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppTag {
    name: &'static str,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counters3 {
    files: u64,
    dirs: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Speed {
    files_per_sec: f64,
    bytes_per_sec: u64,
    dirs_per_sec: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Errors {
    denied: u64,
    missing: u64,
    busy: u64,
    other_errors: u64,
    /// **= 上面四个错误桶之和**（"试了但没成功"）。它不含下面那三个"没试过"的量 ——
    /// 这一格曾经是最容易被读反的地方：`skipped=0` 不等于"这棵树全看完了"。
    skipped: u64,
    /// 下面三个进报告是为了让"这一轮少看了什么"在**离线拿着 JSON 的时候**也说得出口。
    /// 2026-10-17 用户裁定：与已删 TS 侧 `buildErrors` 的逐字对齐**不再作为约束**，
    /// 所以这三个是净新增字段，`skipped` 那格的算法保持原样（新旧报告仍可逐格对照）。
    skipped_always: u64,
    skipped_reparse: u64,
    depth_capped: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sample: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sample_overflow: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanPart {
    scan_id: String,
    root: String,
    status: String,
    elapsed_ms: u64,
    truncated: bool,
    counters: Counters3,
    errors: Errors,
    speed: Speed,
    /// `null` = 这一侧没采（见文件头那条），不是"峰值是 0 字节"
    peak_rss_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TopRow {
    path: String,
    name: String,
    size: u64,
    mtime_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirSummary {
    path: String,
    size: u64,
    files: usize,
    dirs: usize,
    folded_dirs: usize,
    folded_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    children: Option<Vec<DirSummary>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeLimits {
    max_depth: usize,
    top_per_level: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanReportJson {
    schema: &'static str,
    generated_at_ms: i64,
    app: AppTag,
    scan: ScanPart,
    top_files: Vec<TopRow>,
    tree: DirSummary,
    tree_limits: TreeLimits,
}

/// 两位小数（TS 的 `round2`：`Math.round(x * 100) / 100`，负数方向这里到不了）。
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// §15 的分账 +「有就说、没有就整键缺席」的清单。三份算术在这一个函数里闭合。
fn build_errors(snap: &ScanSnapshotWire, sample: Vec<String>) -> Errors {
    let denied = snap.counters.denied;
    let base = Errors {
        denied,
        missing: snap.counters.missing,
        busy: snap.counters.busy,
        other_errors: snap.counters.other_errors,
        skipped: snap.counters.skipped,
        skipped_always: snap.counters.skipped_always,
        skipped_reparse: snap.counters.skipped_reparse,
        depth_capped: snap.counters.depth_capped,
        sample: None,
        sample_overflow: None,
    };
    if denied == 0 || sample.is_empty() {
        return base;
    }
    let kept: Vec<String> = sample.into_iter().take(denied as usize).collect();
    let overflow = denied - kept.len() as u64;
    Errors {
        sample: if kept.is_empty() { None } else { Some(kept) },
        sample_overflow: if overflow > 0 { Some(overflow) } else { None },
        ..base
    }
}

/// 递归摘要一棵已建好的树。**排序是契约**：大小降序 + 归一化路径升序，
/// 所以同一棵树跑两次，JSON 逐字节相同（有一条用例就钉这件事）。
fn summarize(tree: &TreeIndex, dir_id: i64, path: String, depth: usize, max_depth: usize, top_per_level: usize) -> DirSummary {
    let kids = tree.children_of(dir_id);
    let mut sub: Vec<(String, i64, u64)> = Vec::new();
    let mut files_here = 0usize;
    let mut file_bytes = 0u64;
    for k in kids {
        match k {
            ChildRef::Dir(d) => {
                sub.push((d.path.clone(), d.id, d.size_counted));
            }
            ChildRef::File(f) => {
                files_here += 1;
                file_bytes += f.counted;
            }
        }
    }
    sub.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| normalize_key(&a.0).cmp(&normalize_key(&b.0))));
    let dir_bytes: u64 = sub.iter().map(|s| s.2).sum();
    let mut own = DirSummary {
        path,
        // 与 TS 同：这一格的 size 是"本层文件 + 全部子目录"的和，不是 arena 里那份聚合值
        size: file_bytes + dir_bytes,
        files: files_here,
        dirs: sub.len(),
        folded_dirs: 0,
        folded_bytes: 0,
        children: None,
    };
    if depth >= max_depth || sub.is_empty() {
        return own;
    }
    let total_dirs = sub.len();
    // 折掉的那批先算（`into_iter().take()` 会把 `sub` 移动走，顺序反了就没了）
    own.folded_dirs = total_dirs - top_per_level.min(total_dirs);
    own.folded_bytes = sub.iter().skip(top_per_level).map(|x| x.2).sum();
    let kept: Vec<(String, i64, u64)> = sub.into_iter().take(top_per_level).collect();
    own.children = Some(
        kept.into_iter()
            .map(|(p, id, _)| summarize(tree, id, p, depth + 1, max_depth, top_per_level))
            .collect(),
    );
    own
}

/// 报告本体。`now_ms` / `app_version` 由调用方给（同 TS 把 `nowMs` 做成入参的理由：
/// 这样"同一份输入两次导出逐字节相同"这件事是**可测**的，而不是靠墙钟。
pub fn build_report(
    snap: &ScanSnapshotWire,
    tree: &TreeIndex,
    top_hits: &[deepclean_scanner::model::TopHit],
    app_version: String,
    now_ms: i64,
    max_depth: usize,
    top_per_level: usize,
) -> serde_json::Value {
    let elapsed = snap.elapsed_ms.max(1) as f64;
    let report = ScanReportJson {
        schema: SCAN_REPORT_SCHEMA,
        generated_at_ms: now_ms,
        app: AppTag { name: "DeepClean", version: app_version },
        scan: ScanPart {
            scan_id: snap.scan_id.clone(),
            root: snap.root.clone(),
            status: snap.status.clone(),
            elapsed_ms: snap.elapsed_ms,
            truncated: snap.truncated,
            counters: Counters3 {
                files: snap.counters.files,
                dirs: snap.counters.dirs,
                total_bytes: snap.counters.total_bytes,
            },
            errors: build_errors(snap, service::skipped_sample_of(tree).collect()),
            speed: Speed {
                files_per_sec: round2(snap.counters.files as f64 * 1000.0 / elapsed),
                bytes_per_sec: ((snap.counters.total_bytes as f64 * 1000.0) / elapsed).round() as u64,
                dirs_per_sec: round2(snap.counters.dirs as f64 * 1000.0 / elapsed),
            },
            // 这一侧没采峰值工作集：null 是"没测"的合法形状，不是 0
            peak_rss_bytes: None,
        },
        top_files: top_hits
            .iter()
            .map(|h| TopRow { path: h.path.clone(), name: h.name.clone(), size: h.size, mtime_ms: h.mtime_ms })
            .collect(),
        // rootId 从**树**取，不从快照取：TS 那边踩过一次（快照上没有那个字段 ⇒
        // `childrenOf(undefined)` 静默回 []，报告里目录树全空而计数照常）
        tree: summarize(
            tree,
            deepclean_scanner::tree_index::ROOT_DIR_ID,
            snap.root.clone(),
            0,
            max_depth,
            top_per_level,
        ),
        tree_limits: TreeLimits { max_depth, top_per_level },
    };
    serde_json::to_value(&report).expect("报告结构体不可能序列化成不了")
}

/* ================================================================== *
 * 单测
 *
 * 全部吃一份合成树 + 一份手填的快照，所以"报告导出的是同一次扫描、不是重算一遍"
 * 这条纪律能被反复验，不用真扫一趟。
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use deepclean_scanner::accounting::SkipReason;
    use deepclean_scanner::model::{Counters, ErrorTally, ScanFile, ScanMode, ScanNode, ScanTree, SkippedItem, TopHit};
    use deepclean_scanner::volume::VolumeInfo;
    use serde_json::json;

    /// "这个键在不在"（**在，哪怕值是 `null`**）。不许拿 `v[k].is_null()` 代替：
    /// 显式写出的 `null` 与缺席的键在报告里是两句话（`peakRssBytes: null` 是"没测"，
    /// 而 `sample` 缺席才是"根本没这一栏"）。
    fn has(v: Option<&serde_json::Value>) -> bool {
        v.is_some()
    }

    fn snap(denied: u64) -> ScanSnapshotWire {
        ScanSnapshotWire {
            counters: crate::service::ScanCountersWire {
                files: 10,
                dirs: 4,
                total_bytes: 1000,
                denied,
                missing: 1,
                busy: 2,
                other_errors: 3,
                skipped: denied + 1,
                skipped_always: 0,
                skipped_reparse: 0,
                depth_capped: 0,
            },
            scan_id: "t1".into(),
            root: "D:\\r".into(),
            status: "completed".into(),
            current_path: "D:\\r".into(),
            elapsed_ms: 2000,
            started_at_ms: None,
            finished_at_ms: None,
            truncated: false,
            bytes_logical: 1100,
            unaccounted_bytes: 5,
            deduped_hardlinks: 0,
            scan_mode: "walk".into(),
        }
    }

    /// 两层树：根下 `wide` 个子目录（大小递减）+ 每个里一个文件，根自己一个文件；
    /// `skip_sample` 是清单里真给了几条（可以与 `denied` 不等，那正是要验的形状）。
    fn tree_with(wide: usize, skip_sample: usize) -> TreeIndex {
        let bs = "D:\\r";
        let mut root = ScanNode::dir("r".into(), bs.into());
        for i in 0..wide {
            let size = (wide - i) as u64 * 100;
            let mut kid = ScanNode::dir(format!("d{i}"), format!("{bs}\\d{i}"));
            kid.files.push(ScanFile {
                name: "f.bin".into(),
                size,
                alloc: size,
                counted: size,
                file_id: i as u64 + 1,
                mtime_ms: 1,
                creation_ms: 0,
                attrs: 0,
            });
            kid.size_counted = size;
            kid.file_count = 1;
            root.children.push(kid);
        }
        root.files.push(ScanFile {
            name: "root-a.bin".into(),
            size: 7,
            alloc: 7,
            counted: 7,
            file_id: 900,
            mtime_ms: 2,
            creation_ms: 0,
            attrs: 0,
        });
        root.dir_count = wide as u64;
        root.file_count = 1;
        let mut skipped: Vec<SkippedItem> = Vec::new();
        for i in 0..skip_sample {
            skipped.push(SkippedItem { path: format!("D:\\locked{i}"), reason: SkipReason::Reparse });
        }
        let mut counters = Counters::default();
        // 故意与快照不同：报告必须取快照那一份，不是拿树重算
        counters.files = 999;
        counters.errors = ErrorTally { denied: skip_sample as u64, ..Default::default() };
        TreeIndex::build(&ScanTree {
            top: vec![TopHit { name: "root-a.bin".into(), path: "D:\\r\\root-a.bin".into(), size: 7, mtime_ms: 2 }],
            root,
            counters,
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1 << 62, free_bytes: 0 },
            skipped_sample: skipped,
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        })
    }

    fn build(s: &ScanSnapshotWire, t: &TreeIndex, depth: usize, per: usize) -> serde_json::Value {
        build_report(s, t, t.top_files(), "0.1.0".into(), 1_700_000_000_000, depth, per)
    }

    #[test]
    fn the_schema_is_the_baselines_and_peak_rss_is_null_not_zero() {
        let t = tree_with(2, 0);
        let v = build(&snap(0), &t, DEFAULT_MAX_DEPTH, DEFAULT_TOP_PER_LEVEL);
        // **逐字比基准那个串**，不是比 `SCAN_REPORT_SCHEMA` 自己 —— 拿常量跟自己比，
        // 常量漂一个字母这条用例照样绿（第一版就是这样，电池把它照出来了）。
        assert_eq!(v["schema"], json!("deepclean.scan-report/1"), "schema 串漂一个字母，老读者就当不认识");
        for key in ["generatedAtMs", "app", "scan", "topFiles", "tree", "treeLimits"] {
            assert!(has(v.get(key)), "顶层少了 {key}");
        }
        for key in ["scanId", "root", "status", "elapsedMs", "truncated", "counters", "errors", "speed", "peakRssBytes"] {
            assert!(has(v["scan"].get(key)), "scan 少了 {key}");
        }
        assert_eq!(v["app"]["name"], "DeepClean");
        assert_eq!(v["app"]["version"], "0.1.0");
        // 峰值工作集这一侧没采：null 是"没测"的合法形状，**不许**是 0
        assert!(v["scan"]["peakRssBytes"].is_null(), "0 会被读成一次真实的测量结果");
    }

    #[test]
    fn counters_come_from_the_snapshot_not_from_a_recount() {
        let t = tree_with(2, 0);
        let v = build(&snap(0), &t, 3, 12);
        assert_eq!(v["scan"]["counters"]["files"], 10, "树里那份是 999，取错了就露馅");
        assert_eq!(v["scan"]["counters"]["dirs"], 4);
        assert_eq!(v["scan"]["counters"]["totalBytes"], 1000);
    }

    #[test]
    fn the_two_absence_rules_and_the_sample_identity() {
        // ① 一个被拒都没有 → 两个键都不出现
        let t = tree_with(2, 0);
        let v = build(&snap(0), &t, 3, 12);
        assert!(!has(v["scan"]["errors"].get("sample")), "没有 denied 就不该有 sample 这一栏");
        assert!(!has(v["scan"]["errors"].get("sampleOverflow")));

        // ② denied=3、清单只给 2 条 → sample 2 条 + overflow 1，恒等式成立
        let t2 = tree_with(2, 2);
        let v2 = build(&snap(3), &t2, 3, 12);
        let sample = v2["scan"]["errors"]["sample"].as_array().unwrap();
        assert_eq!(sample.len(), 2);
        let overflow = v2["scan"]["errors"]["sampleOverflow"].as_u64().unwrap_or(0);
        assert_eq!(sample.len() as u64 + overflow, 3, "恒等式 sample + overflow === denied 破了");

        // ③ 清单比 denied 长 → 按快照截齐，且**不给** sampleOverflow: 0
        let v3 = build(&snap(1), &t2, 3, 12);
        assert_eq!(v3["scan"]["errors"]["sample"].as_array().unwrap().len(), 1);
        assert!(!has(v3["scan"]["errors"].get("sampleOverflow")), "0 会被读成一句话");
    }

    #[test]
    fn the_tree_is_pruned_and_the_pruning_is_named() {
        let t = tree_with(15, 0);
        let v = build(&snap(0), &t, 3, 12);
        let tree = &v["tree"];
        assert_eq!(tree["dirs"], 15, "dirs 是全量那一份（不是留下的那几个）");
        let kids = tree["children"].as_array().unwrap();
        assert_eq!(kids.len(), 12, "每层只留 topPerLevel 个");
        assert_eq!(tree["foldedDirs"], 3);
        assert_eq!(tree["foldedBytes"], 100 + 200 + 300, "折掉的必须是最大的三个之外的最小三个");
        assert_eq!(kids[0]["path"], "D:\\r\\d0", "大小降序：第一格是最大的那个");
        assert_eq!(v["treeLimits"], json!({ "maxDepth": 3, "topPerLevel": 12 }));
    }

    /// 三个**大小完全并列**的子目录，按 `dZ, da, db` 的顺序进树。
    fn tree_tied() -> TreeIndex {
        let bs = "D:\\r";
        let mut root = ScanNode::dir("r".into(), bs.into());
        for n in ["dZ", "da", "db"] {
            let mut kid = ScanNode::dir(n.into(), format!("{bs}\\{n}"));
            kid.files.push(ScanFile {
                name: "f.bin".into(),
                size: 500,
                alloc: 500,
                counted: 500,
                file_id: 40,
                mtime_ms: 1,
                creation_ms: 0,
                attrs: 0,
            });
            kid.size_counted = 500;
            kid.file_count = 1;
            root.children.push(kid);
        }
        root.dir_count = 3;
        TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1 << 62, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 1,
        })
    }

    #[test]
    fn tied_sizes_fall_back_to_the_normalized_path_like_the_baseline() {
        // TS 的判据是 `b.size - a.size || cmpPath(a.path, b.path)`（cmpPath = 小写字典序）。
        // 去掉次级键后 `sort_by` 仍然稳定，所以**不会**让"两次导出逐字节相同"那条变红 ——
        // 它红的是"与基准同一棵树同一张表"：并列行会退化成 arena 建序（这里是 dZ, da, db）。
        let t = tree_tied();
        let v = build(&snap(0), &t, 3, 12);
        let kids = v["tree"]["children"].as_array().unwrap();
        let paths: Vec<&str> = kids.iter().map(|k| k["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec!["D:\\r\\da", "D:\\r\\db", "D:\\r\\dZ"], "并列时必须按归一化路径升序");
    }

    #[test]
    fn the_depth_limit_stops_the_recursion_rather_than_lying_about_it() {
        let t = tree_with(2, 0);
        let shallow = build(&snap(0), &t, 1, 12);
        assert!(has(shallow["tree"].get("children")), "depth 1 这一层还要往下走一步");
        assert!(
            !has(shallow["tree"]["children"][0].get("children")),
            "到深度的那一层不该有 children 这一栏（也不该是一个空数组）"
        );
    }

    #[test]
    fn the_root_of_the_tree_is_not_silently_empty() {
        // TS 那边踩过：rootId 从快照取 ⇒ `childrenOf(undefined)` 静默回 []，
        // 于是报告里目录树全空而计数照常。这一格正面钉住它。
        let t = tree_with(3, 0);
        let v = build(&snap(0), &t, 3, 12);
        let kids = v["tree"]["children"].as_array().expect("根必须有 children");
        assert_eq!(kids.len(), 3);
        assert_eq!(v["tree"]["files"], 1);
        assert!(v["tree"]["size"].as_u64().unwrap() > 0);
        assert!(!v["topFiles"].as_array().unwrap().is_empty(), "topFiles 走的是同一棵树那份堆");
    }

    #[test]
    fn the_same_input_twice_is_byte_identical() {
        let t = tree_with(14, 4);
        let a = serde_json::to_string(&build(&snap(3), &t, 3, 12)).unwrap();
        let b = serde_json::to_string(&build(&snap(3), &t, 3, 12)).unwrap();
        assert_eq!(a, b, "同一份输入两次导出不逐字节相同 —— 排序不是契约");
    }

    #[test]
    fn speed_uses_the_net_elapsed_and_is_clamped_like_the_baseline() {
        let t = tree_with(1, 0);
        let v = build(&snap(0), &t, 3, 12);
        assert_eq!(v["scan"]["speed"]["filesPerSec"], 5.0, "10 个 / 2000 ms");
        assert_eq!(v["scan"]["speed"]["bytesPerSec"], 500);
        assert_eq!(v["scan"]["speed"]["dirsPerSec"], 2.0);
        let mut z = snap(0);
        z.elapsed_ms = 0;
        let vz = build(&z, &t, 3, 12);
        assert!(vz["scan"]["speed"]["filesPerSec"].as_f64().unwrap().is_finite(), "除零会一路带到 JSON 里");
        assert_eq!(vz["scan"]["elapsedMs"], 0, "兜底只兜除法，不改写快照那个数");
    }

    /* ------------------------------------------------------------------ *
     * 与 TS 的零容差对账
     *
     * 同一份夹具（`tests/data/m5e-report-parity.json`）两侧各跑一遍。这一步买的是
     * 「schema 串 / 字段名 / 键缺席规则 / 排序 / 裁剪 / round2」这六件事**是真跑出来的**，
     * 不是人眼比对两份代码比出来的。golden 由 `tests/parity_report_ts.mjs` 头那两条命令生成，
     * **改夹具或改本模块之后先重生成并与入库那份 `cmp`**，否则比的是「旧 TS」。
     * ------------------------------------------------------------------ */

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixFile {
        name: String,
        size: u64,
        mtime_ms: i64,
    }

    #[derive(serde::Deserialize)]
    struct FixNode {
        name: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        files: Vec<FixFile>,
        #[serde(default)]
        dirs: Vec<FixNode>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixSnap {
        scan_id: String,
        root: String,
        status: String,
        elapsed_ms: u64,
        truncated: bool,
        files: u64,
        dirs: u64,
        total_bytes: u64,
        denied: u64,
        missing: u64,
        busy: u64,
        other_errors: u64,
        skipped: u64,
        /** 金样是**已删的 TS 侧**产出的，里面没有这三个键 ⇒ 缺键取 0，
         * 不要求回去改那批只读夹具。 */
        #[serde(default)]
        skipped_always: u64,
        #[serde(default)]
        skipped_reparse: u64,
        #[serde(default)]
        depth_capped: u64,
    }

    #[derive(serde::Deserialize)]
    struct FixSkipped {
        sample: Vec<String>,
        overflowed: bool,
    }

    #[derive(serde::Deserialize)]
    struct FixCase {
        name: String,
        snapshot: FixSnap,
        skipped: Option<FixSkipped>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FixTop {
        path: String,
        name: String,
        size: u64,
        mtime_ms: i64,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        app_version: String,
        now_ms: i64,
        max_depth: usize,
        top_per_level: usize,
        root: FixNode,
        top_files: Vec<FixTop>,
        cases: Vec<FixCase>,
    }

    const FIXTURE: &str = include_str!("../tests/data/m5e-report-parity.json");
    const GOLDEN: &str = include_str!("../tests/data/m5e-report-parity.expected.json");

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).expect("夹具必须可解析")
    }

    /// 与 `.mjs` 的 `materialize` 同法：路径按段拼、**目录大小自底上算**（本层文件 + 全部子目录）。
    /// 夹具里不写死目录大小 —— 两侧各算一遍，谁漏算一层都会在报告数字上分叉。
    fn scan_node(spec: &FixNode, path: String) -> ScanNode {
        let mut n = ScanNode::dir(spec.name.clone(), path.clone());
        let mut total = 0u64;
        for f in &spec.files {
            total += f.size;
            n.files.push(ScanFile {
                name: f.name.clone(),
                size: f.size,
                alloc: f.size,
                counted: f.size,
                file_id: 0,
                mtime_ms: f.mtime_ms,
                creation_ms: 0,
                attrs: 0,
            });
        }
        n.file_count = spec.files.len() as u64;
        for d in &spec.dirs {
            let kid = scan_node(d, format!("{path}\\{}", d.name));
            total += kid.size_counted;
            n.dir_count += 1 + kid.dir_count;
            n.children.push(kid);
        }
        n.size_counted = total;
        n
    }

    fn wire(s: &FixSnap) -> ScanSnapshotWire {
        ScanSnapshotWire {
            counters: crate::service::ScanCountersWire {
                files: s.files,
                dirs: s.dirs,
                total_bytes: s.total_bytes,
                denied: s.denied,
                missing: s.missing,
                busy: s.busy,
                other_errors: s.other_errors,
                skipped: s.skipped,
                skipped_always: s.skipped_always,
                skipped_reparse: s.skipped_reparse,
                depth_capped: s.depth_capped,
            },
            scan_id: s.scan_id.clone(),
            root: s.root.clone(),
            status: s.status.clone(),
            current_path: s.root.clone(),
            elapsed_ms: s.elapsed_ms,
            started_at_ms: None,
            finished_at_ms: None,
            truncated: s.truncated,
            // 这三格不进报告（报告只吃 counters），对账里给 0 就够
            bytes_logical: 0,
            unaccounted_bytes: 0,
            deduped_hardlinks: 0,
            scan_mode: "walk".into(),
        }
    }

    fn build_case(fx: &Fixture, c: &FixCase) -> serde_json::Value {
        let root = scan_node(&fx.root, fx.root.path.clone().expect("夹具根必须写出 path"));
        let skipped = c.skipped.as_ref().map(|s| s.sample.clone()).unwrap_or_default();
        let tree = TreeIndex::build(&ScanTree {
            top: fx.top_files
                .iter()
                .map(|t| TopHit { name: t.name.clone(), path: t.path.clone(), size: t.size, mtime_ms: t.mtime_ms })
                .collect(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1 << 62, free_bytes: 0 },
            skipped_sample: skipped
                .into_iter()
                .map(|p| SkippedItem { path: p, reason: SkipReason::Always })
                .collect(),
            skipped_sample_overflowed: c.skipped.as_ref().map(|s| s.overflowed).unwrap_or(false),
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: c.snapshot.elapsed_ms,
        });
        build_report(
            &wire(&c.snapshot),
            &tree,
            tree.top_files(),
            fx.app_version.clone(),
            fx.now_ms,
            fx.max_depth,
            fx.top_per_level,
        )
    }

    /// TS 的 `number` 没有整数/浮点之分：`10000` 与 `10000.0` 是同一个数的两种字面量
    /// （`elapsedMs = 0` 那一格就会撞上）。这里只抹平**表示**（每个数都过一遍 f64），
    /// 不抹平任何值 —— 差 1 字节照样红。
    fn canon(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => serde_json::Value::Object(
                m.iter().map(|(k, x)| (k.clone(), canon(x))).collect(),
            ),
            serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(canon).collect()),
            serde_json::Value::Number(n) => serde_json::Value::from(n.as_f64().unwrap_or(0.0)),
            other => other.clone(),
        }
    }

    /// 2026-10-17 起，报告里比 TS 基准**多**的三个键（用户裁定：与已删 TS 侧的逐字对齐
    /// 不再作为约束；这三个是"这一轮根本没看过的东西"，以前只活在扫描器内部）。
    /// 剥掉它们再比，是为了让这道闸继续钉**其余每一格** —— 不是把闸关掉。
    const TS_DIVERGENT_KEYS: [&str; 3] = ["skippedAlways", "skippedReparse", "depthCapped"];

    fn strip_divergent(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => serde_json::Value::Object(
                m.iter()
                    .filter(|(k, _)| !TS_DIVERGENT_KEYS.contains(&k.as_str()))
                    .map(|(k, x)| (k.clone(), strip_divergent(x)))
                    .collect(),
            ),
            serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(strip_divergent).collect()),
            other => other.clone(),
        }
    }

    #[test]
    fn with_ts_zero_tolerance_on_the_same_tree() {
        let fx = fixture();
        let golden: serde_json::Value = serde_json::from_str(GOLDEN).expect(
            "缺 TS 侧期望值 —— 按 tests/parity_report_ts.mjs 头的两条命令重新生成（不许静默跳过）",
        );
        let cases = golden["cases"].as_array().expect("golden 必须有 cases 数组");
        assert_eq!(fx.cases.len(), cases.len(), "case 数不一致（夹具改了没重生成 golden？）");
        for (c, g) in fx.cases.iter().zip(cases.iter()) {
            assert_eq!(c.name, g["name"], "case 顺序与 golden 不一致");
            let full = canon(&build_case(&fx, c));
            // "剥掉再比"这句话本身可以是万能遮罩，所以先钉它的边界：
            // 三个键必须在 Rust 侧**真存在**、在 TS 侧**真不存在**，除此之外两侧不许有任何差异。
            let rust_errs = full["scan"]["errors"].as_object().expect("Rust 侧没有 errors 这一栏");
            let ts_full = canon(&g["report"]);
            let ts_errs = ts_full["scan"]["errors"].as_object().expect("TS 侧没有 errors 这一栏");
            for k in TS_DIVERGENT_KEYS {
                assert!(rust_errs.contains_key(k), "Rust 侧丢了新键 {k} —— 剥键那道手续会把这伪装成'与 TS 一致'");
                assert!(!ts_errs.contains_key(k), "TS 基准里居然有 {k} —— 分歧清单过期了，更新 TS_DIVERGENT_KEYS 之前先想清楚是谁改的");
            }
            let a = strip_divergent(&full);
            let e = canon(&g["report"]);
            assert_eq!(
                a,
                e,
                "case {} 与 TS 不一致（三个已登记的新键之外，一格都不许差）\nRust: {}\nTS  : {}",
                c.name,
                serde_json::to_string(&a).unwrap(),
                serde_json::to_string(&e).unwrap()
            );
        }
    }

    /// 上面那条"剥掉三个新键再比"的手续，本身需要一个反向证明：**这三个键不是恒 0 的摆设**。
    /// 否则金样比对永远绿，而"这一轮少看了什么"照旧没人说得出 —— 那正是这条账要修的东西。
    #[test]
    fn the_coverage_counters_reach_the_report_and_stay_separate_from_the_error_sum() {
        let mut s = snap(3);
        s.counters.skipped_always = 30_117;
        s.counters.skipped_reparse = 42;
        s.counters.depth_capped = 7;
        let e = build_errors(&s, Vec::new());
        assert_eq!((e.skipped_always, e.skipped_reparse, e.depth_capped), (30_117, 42, 7));
        // `skipped` 原样透传，**没把新增的三个并进去**：把"没试过"混进"试了没成功"，
        // 一次干净的系统卷扫描会报出三万个"错误"。
        // （不在这里断言"skipped == 四桶之和"—— 那是 `service.rs::snapshot_of` 的算术，
        //   而本文件的 `snap()` 夹具为了测 sample 截断故意写成 `denied + 1`，在这儿比只会测到夹具。）
        assert_eq!(e.skipped, s.counters.skipped, "build_errors 不该重算 skipped");
        assert_ne!(e.skipped, e.skipped_always, "两格撞成一个数 = 口径被并掉了");
        let wire = serde_json::to_value(&e).expect("Errors 序列化得出去");
        for k in ["skippedAlways", "skippedReparse", "depthCapped"] {
            assert!(wire.get(k).is_some(), "导出 JSON 里没有 {k} —— 内部有数而报告里说不出，等于没修");
        }
    }

    /// 反空跑（纪律 §5）：夹具里每一格"有意思的形状"都必须至少真被走到一次，
    /// 否则「4 个 case 全等」里可能有一半是同一格在原地打转。
    #[test]
    fn the_fixture_actually_exercises_the_interesting_cells() {
        let fx = fixture();
        assert_eq!((fx.max_depth, fx.top_per_level), (3, 12), "夹具没按默认的裁剪参数跑");
        let v0 = build_case(&fx, &fx.cases[0]);
        let root = &v0["tree"];

        // ① 裁剪真的发生了，而且折掉的正是**并列**那一格（da 与 dZ 同为 200，cmpPath 留下 da）
        let dirs = root["dirs"].as_u64().unwrap();
        assert!(dirs > fx.top_per_level as u64, "根下 {dirs} 格，没超过每层上限 —— 裁剪那条是空跑");
        assert!(root["foldedDirs"].as_u64().unwrap() >= 1);
        assert!(root["foldedBytes"].as_u64().unwrap() >= 1, "折掉的那批必须带字节，否则 foldedBytes 没数据");
        let kids = root["children"].as_array().unwrap();
        assert_eq!(kids.len(), fx.top_per_level, "留下的必须是每层上限那么多格");
        let kept: Vec<&str> = kids.iter().map(|k| k["path"].as_str().unwrap()).collect();
        assert!(kept.iter().any(|p| p.ends_with("da")), "并列时留下的必须是 da（cmpPath 那一支没走到）");
        assert!(!kept.iter().any(|p| p.ends_with("dZ")), "dZ 必须被折掉");

        // ② 深度那一格：到 maxDepth 的层没有 children 键，它上面一层有
        let deep = &kids[0]["children"].as_array().expect("d00 必须往下走一层")[0];
        let deeper = &deep["children"].as_array().expect("deep 必须往下走一层")[0];
        assert!(deep.get("children").is_some(), "第二层就该没有 children 了？那深度上限这一格没测到");
        assert!(deeper.get("children").is_none(), "到 maxDepth 的那层还往下展开，裁剪参数没生效");

        // ③ 三条 errors 形状各一次：有清单有溢出 / denied=0 / 压根没有清单可说
        assert!(v0["scan"]["errors"].get("sample").is_some() && v0["scan"]["errors"].get("sampleOverflow").is_some(), "case 1 没测到「两条都在」");
        let v1 = build_case(&fx, &fx.cases[1]);
        assert!(v1["scan"]["errors"].get("sample").is_none() && v1["scan"]["errors"].get("sampleOverflow").is_none(), "denied=0 那一格没测到");
        let v3 = build_case(&fx, &fx.cases[3]);
        assert!(v3["scan"]["errors"].get("sample").is_none(), "没有清单可说那一格没测到");
        assert_eq!(fx.cases[3].snapshot.denied, 2, "那一格必须是「有 denied、没清单」");

        // ④ 除零兜底那一格
        assert_eq!(fx.cases[2].snapshot.elapsed_ms, 0, "elapsed=0 那一格没在夹具里");
        let v2 = build_case(&fx, &fx.cases[2]);
        assert!(v2["scan"]["speed"]["filesPerSec"].as_f64().unwrap().is_finite());
        // ⑤ topFiles 原序：夹具给的不是降序，两侧谁偷偷排序都会在这里分叉
        let tops = v0["topFiles"].as_array().unwrap();
        let sizes: Vec<u64> = tops.iter().map(|t| t["size"].as_u64().unwrap()).collect();
        assert!(sizes.windows(2).any(|w| w[0] < w[1]), "夹具的 topFiles 本身是降序 —— 那条判据就废了");
    }
}
