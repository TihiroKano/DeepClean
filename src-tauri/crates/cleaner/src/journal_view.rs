//! 清理日志的**目录聚合** —— 纯函数，零 IO。
//!
//! 2026-10-25 重做（设计：`docs/superpowers/specs/2026-10-25-clean-journal-redesign-design.md`）。
//!
//! 旧的「按日期/风险/状态三维筛选 + 分页」整套下线：这一版按**时间**排（30 天窗口本身
//! 就是时间维），列表一次清理一行，详情按**父目录折叠**且**逐层懒加载**。
//!
//! 两个函数就是懒加载的全部内核：
//!
//! - [`summarize_roots`]：一条 run 的第一层 —— 每个顶层目录的文件数与合计字节
//! - [`children_of`]：某个目录的下一层 —— 子目录（含更深层的合计）+ 直属文件
//!
//! **为什么折叠在 Rust 侧而不是渲染层**：渲染层拿不到全部 `files`（懒加载就是为了不一次拉
//! 1.7 万条），它没法自己折叠。这一点在原设计里写反过，2026-10-25 订正。
//!
//! **每条 run 的 `files` 是扁平的**，折叠每次都从它线性扫一遍。1.7 万条的量级下是 O(n)，
//! 可接受；真慢了再加缓存，先用简单实现（设计 §12 登记了这条理由）。
//!
//! 目录比较一律走 `normalize_key`（大小写与正反斜杠折叠）—— 否则 `C:\Temp` 与 `c:\temp`
//! 会被拆成两组，那正是审查者点名的第 5 条风险。

use crate::journal::CleanRun;
use deepclean_rules::engine::normalize_key;
use serde::Serialize;
use std::collections::BTreeMap;

/// 第一层汇总的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirSummary {
    /// 目录的**原样**路径（给人看，不归一化）。
    pub dir: String,
    pub file_count: u64,
    pub bytes: u64,
}

/// 某个目录的下一层：一个子目录或一个直属文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// 原样路径（文件是完整路径，目录也是）。
    pub path: String,
    pub is_dir: bool,
    /// 文件 = 它自己的字节；目录 = 它**子树**的合计字节。
    pub size_bytes: u64,
    /// 文件恒为 1；目录 = 它**子树**的文件数。
    pub file_count: u64,
}

/// 去掉最后一段。`C:\a\b` → `C:\a`；`C:\a` → `C:\`；盘符根返回 `None`。
fn parent_of(path: &str) -> Option<String> {
    let t = path.replace('/', "\\");
    let t = t.trim_end_matches('\\');
    let idx = t.rfind('\\')?;
    let parent = &t[..idx];
    if parent.is_empty() {
        return None;
    }
    // `C:` 这种裸盘符补回 `C:\`
    if parent.len() == 2 && parent.as_bytes().get(1) == Some(&b':') {
        return Some(format!("{parent}\\"));
    }
    Some(parent.to_string())
}


/// 一条 run 的**第一层**：每个顶层目录的文件数与合计字节。
///
/// 「顶层目录」= 把所有成功文件的路径按父目录归并后，取**去重后最浅**的那一组。
/// 返回值按 `dir` 的归一化键升序 —— 渲染层的行序要稳定。
pub fn summarize_roots(run: &CleanRun) -> Vec<DirSummary> {
    // 只处理**文件自己的父目录**，不再往上爬祖先链。
    // 第一版是爬全链再找"最浅"，那会多出 `C:\` 这种祖先路过点（实测红过一次）。
    // 直接用父目录做候选，再去掉"被另一个候选包住"的那些 —— 结果一样，逻辑短得多。
    let mut parents: BTreeMap<String, String> = BTreeMap::new(); // 归一化键 → 原样
    for f in &run.files {
        if let Some(p) = parent_of(&f.path) {
            parents.entry(normalize_key(&p)).or_insert(p);
        }
    }
    // 去掉被其他候选包住的（例如既有 `C:\a\b` 又有 `C:\a\b\c` 时，后者不是顶层）
    let keys: Vec<String> = parents.keys().cloned().collect();
    let mut roots: BTreeMap<String, DirSummary> = BTreeMap::new();
    for k in &keys {
        let swallowed = keys
            .iter()
            .any(|other| other != k && k.starts_with(&format!("{other}\\")));
        if swallowed {
            continue;
        }
        let dir = parents.get(k).cloned().unwrap_or_default();
        let prefix = format!("{k}\\");
        let mut count = 0u64;
        let mut bytes = 0u64;
        for f in &run.files {
            if normalize_key(&f.path).starts_with(&prefix) {
                count += 1;
                bytes += f.size_bytes;
            }
        }
        roots.insert(k.clone(), DirSummary { dir, file_count: count, bytes });
    }
    roots.into_values().collect()
}
/// 某个目录的**下一层**：子目录（带子树合计）+ 直属文件。
///
/// `dir` 不存在于这条 run 里 ⇒ 返回空（不报错 —— "这一层没有东西"与"这个 id 不存在"
/// 在界面上是同一种空态，不该让调用方分两种处理）。
/// 返回顺序：目录在前、文件在后，各自按 `name` 升序。
pub fn children_of(run: &CleanRun, dir: &str) -> Vec<DirEntry> {
    let dk = normalize_key(dir);
    let prefix = format!("{dk}\\");
    let mut dirs: BTreeMap<String, DirEntry> = BTreeMap::new();
    let mut files: Vec<DirEntry> = Vec::new();

    for f in &run.files {
        let fk = normalize_key(&f.path);
        if !fk.starts_with(&prefix) {
            continue;
        }
        // 相对本目录的那一段
        let rest = &f.path.replace('/', "\\");
        let idx = match rest.to_lowercase().find(&prefix) {
            Some(i) => i + prefix.len(),
            None => continue,
        };
        let tail = &rest[idx..];
        if tail.is_empty() {
            continue;
        }
        match tail.find('\\') {
            // 还有下一段 ⇒ 这个文件在某个子目录里
            Some(_) => {
                let name = tail.split('\\').next().unwrap_or_default().to_string();
                let child_path = format!("{dir}\\{name}");
                let ck = normalize_key(&child_path);
                let e = dirs.entry(ck).or_insert_with(|| DirEntry {
                    name,
                    path: child_path,
                    is_dir: true,
                    size_bytes: 0,
                    file_count: 0,
                });
                e.size_bytes += f.size_bytes;
                e.file_count += 1;
            }
            // 本目录的直属文件
            None => files.push(DirEntry {
                name: tail.to_string(),
                path: f.path.clone(),
                is_dir: false,
                size_bytes: f.size_bytes,
                file_count: 1,
            }),
        }
    }

    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let mut out: Vec<DirEntry> = dirs.into_values().collect();
    out.extend(files);
    out
}

/// 这条 run 过没过 30 天保留期（供调用方筛，避免重复写公式）。
pub fn within_retention(run: &CleanRun, now_ms: i64) -> bool {
    !crate::journal::is_expired(run, now_ms)
}

// ─────────────────────────── 日期换算（沿用旧实现） ───────────────────────────
// 这一段是 `local_day` 与 `logline::local_stamp` 共用的原语，**不是**日志页专属。
// 2026-10-25 重做时把上面整套筛选删了，但这一半必须留：`logline.rs:91,203,215` 在用。
/// 把 `epoch_ms` 折成**本地**的 (年, 月, 日, 时, 分, 秒)。换算失败回 `None`。
///
/// 这一格是 `local_day` 与 `logline::local_stamp` **共用**的原语，两件事都在这里：
///
/// 1. **换算的是那一刻，不是"那个 UTC 日的 00:00"**。原来 `local_day` 先按 UTC 取日历日、
///    再把那天零点拿去换算 —— 于是本地时刻落在 `[00:00, 偏移)` 那一段的那些瞬间
///    （本机 UTC+8 ⇒ 每天 0 点到 8 点，等于 UTC 16:00–24:00）会**少一天**。
///    独立口径 `.NET DateTimeOffset.ToLocalTime()` 扫一天 48 个点，16 个不符；
///    node 的 `new Date(ms)` 同样不符。这一格既是筛选键又是显示值，差一天就正好是
///    那句"这行看得见、筛不出来"—— 只不过方向是反的。
/// 2. **只有一份实现**。日期键与日志时间戳各算一次本地日历，就会有那一天两者不一致，
///    而日志文件与记录页是同一件事的两张脸。
///
/// 为什么走 `SystemTimeToTzSpecificLocalTime` 而不是"当前 bias 减一下"：那对处于另一个
/// 夏令时区间的历史时刻会差一天，而 JS 的 `new Date(ms)` 拿的是历史规则这同一份。
#[cfg(windows)]
pub(crate) fn local_system_time(epoch_ms: i64) -> Option<(u32, u32, u32, u32, u32, u32)> {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    extern "system" {
        fn SystemTimeToTzSpecificLocalTime(
            tzi: *const core::ffi::c_void,
            utc: *const SystemTime,
            local: *mut SystemTime,
        ) -> i32;
    }
    let (y, mo, d) = civil_from_epoch_ms(epoch_ms)?;
    let secs = epoch_ms.rem_euclid(86_400_000) / 1000;
    let st = SystemTime {
        w_year: y as u16,
        w_month: mo as u16,
        w_day_of_week: 0,
        w_day: d as u16,
        w_hour: (secs / 3600) as u16,
        w_minute: ((secs % 3600) / 60) as u16,
        w_second: (secs % 60) as u16,
        w_milliseconds: (epoch_ms.rem_euclid(1000)) as u16,
    };
    let mut lt = SystemTime::default();
    // 传 NULL 当"用当前进程的时区"；返回 0 = 失败 ⇒ `None`，让调用方走"这一维不限"／
    // 时间戳缺着，而不是拿一个没换算的 UTC 值去填（那会静默错一天）。
    if unsafe { SystemTimeToTzSpecificLocalTime(core::ptr::null(), &st, &mut lt) } == 0 {
        return None;
    }
    Some((
        lt.w_year as u32,
        lt.w_month as u32,
        lt.w_day as u32,
        lt.w_hour as u32,
        lt.w_minute as u32,
        lt.w_second as u32,
    ))
}

/// 非 Windows 退化：拿 UTC 拆。本项目的目标平台是 Windows，这条只为让单测在别处也能跑。
#[cfg(not(windows))]
pub(crate) fn local_system_time(epoch_ms: i64) -> Option<(u32, u32, u32, u32, u32, u32)> {
    let (y, mo, d) = civil_from_epoch_ms(epoch_ms)?;
    let secs = epoch_ms.rem_euclid(86_400_000) / 1000;
    Some((
        y as u32,
        mo,
        d,
        (secs / 3600) as u32,
        ((secs % 3600) / 60) as u32,
        (secs % 60) as u32,
    ))
}

/// 把 `epoch_ms` 折成本地日历日 `YYYY-MM-DD`，与 JS `new Date(ms)` 的
/// `getFullYear()/getMonth()/getDate()` 同口径。换算失败回空串（调用方走"这一维不限"）。
pub fn local_day(epoch_ms: i64) -> String {
    match local_system_time(epoch_ms) {
        Some((y, mo, d, _, _, _)) => format!("{y:04}-{mo:02}-{d:02}"),
        None => String::new(),
    }
}

/// 把 epoch 毫秒拆成 **UTC** 的年/月/日（Howard Hinnant 的 civil_from_days）。
/// 负数（1970 前）按 floor 语义处理；超出 `u16` 年份范围时回 `None`（SYSTEMTIME 装不下）。
///
/// `pub(crate)` 是被 [`crate::logline::local_stamp`] 拉出来的：日志行的时间戳与记录页的
/// 日期筛选键必须走同一次本地日历换算，各写一份就会差一天。
pub(crate) fn civil_from_epoch_ms(ms: i64) -> Option<(i64, u32, u32)> {
    let days = ms.div_euclid(86_400_000);
    if days > 295_700_0 || days < -295_700 {
        return None; // 9999-12-31 / 1601-01-01 之外，SYSTEMTIME 表达不了
    }
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    Some((if m <= 2 { y + 1 } else { y }, m, d))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{CleanDeletion, CleanDeletionKind, CleanOutcome};

    fn del(path: &str, bytes: u64) -> CleanDeletion {
        CleanDeletion {
            path: path.into(),
            kind: CleanDeletionKind::File,
            bytes,
            ok: true,
            errno: None,
            detail: None,
            attempts: Some(1),
            outcome: Some(CleanOutcome::Ok),
        }
    }

    fn run_of(files: &[(&str, u64)]) -> CleanRun {
        let deleted: Vec<_> = files.iter().map(|(p, b)| del(p, *b)).collect();
        crate::journal::build_run("t-test", 1_000, &deleted).expect("有文件就有条目")
    }

    #[test]
    fn roots_collapse_files_under_their_common_parent_chain() {
        let files = &[
            (r"C:\Users\a\AppData\Local\Temp\x.tmp", 100u64),
            (r"C:\Users\a\AppData\Local\Temp\y.tmp", 200),
            (r"D:\cache\z.bin", 50),
        ];
        let run = run_of(files);
        let roots = summarize_roots(&run);

        // 独立口径（审查者要求）：不调 summarize_roots 自己的中间结构，
        // 直接从原始 files 按 parent 重新算一遍，再与它比。
        let mut want: std::collections::BTreeMap<String, (u64, u64)> = Default::default();
        for (p, b) in files {
            let parent = p.rsplit_once('\\').unwrap().0.to_string();
            let e = want.entry(parent).or_insert((0, 0));
            e.0 += 1;
            e.1 += b;
        }
        assert_eq!(roots.len(), want.len(), "顶层目录数对不上（want={want:?}）");
        for r in &roots {
            let (c, by) = want.get(&r.dir).unwrap_or_else(|| panic!("多出了 {r:?}"));
            assert_eq!(r.file_count, *c, "{} 的文件数", r.dir);
            assert_eq!(r.bytes, *by, "{} 的字节", r.dir);
        }
    }

    #[test]
    fn dir_comparison_ignores_case_and_trailing_separator() {
        let run = run_of(&[(r"C:\Temp\a.tmp", 10), (r"C:\temp\b.tmp", 20), (r"C:\TEMP\c.tmp", 30)]);
        let roots = summarize_roots(&run);
        assert_eq!(roots.len(), 1, "大小写不同是同一个目录，不许拆成三组");
        assert_eq!(roots[0].file_count, 3);
        assert_eq!(roots[0].bytes, 60);
    }

    #[test]
    fn children_of_a_dir_splits_subdirs_from_direct_files() {
        let run = run_of(&[
            (r"C:\T\direct.tmp", 10),
            (r"C:\T\sub\deep.tmp", 20),
            (r"C:\T\sub\deeper\x.tmp", 30),
        ]);
        let kids = children_of(&run, r"C:\T");
        assert_eq!(kids.len(), 2, "一个子目录 + 一个直属文件：{kids:?}");
        let sub = kids.iter().find(|k| k.name == "sub").expect("sub 要出现");
        assert!(sub.is_dir);
        assert_eq!(sub.file_count, 2, "子目录的计数要含更深层");
        assert_eq!(sub.size_bytes, 50);
        let direct = kids.iter().find(|k| k.name == "direct.tmp").unwrap();
        assert!(!direct.is_dir);
        assert_eq!(direct.size_bytes, 10);
    }

    #[test]
    fn children_put_dirs_before_files() {
        let run = run_of(&[(r"C:\T\zzz.tmp", 1), (r"C:\T\aaa\x.tmp", 2)]);
        let kids = children_of(&run, r"C:\T");
        assert!(kids[0].is_dir, "目录排在文件前面");
        assert_eq!(kids[0].name, "aaa");
        assert_eq!(kids[1].name, "zzz.tmp");
    }

    #[test]
    fn an_unknown_dir_returns_empty_not_panic() {
        let run = run_of(&[(r"C:\T\a.tmp", 1)]);
        assert!(children_of(&run, r"D:\nope").is_empty());
        assert!(children_of(&run, r"C:\T\nope").is_empty());
    }

    #[test]
    fn root_list_is_sorted_by_normalized_dir() {
        let run = run_of(&[(r"D:\z\x.tmp", 1), (r"C:\a\x.tmp", 2), (r"D:\a\x.tmp", 3)]);
        let roots = summarize_roots(&run);
        let dirs: Vec<_> = roots.iter().map(|r| normalize_key(&r.dir)).collect();
        let mut sorted = dirs.clone();
        sorted.sort();
        assert_eq!(dirs, sorted, "第一层汇总必须有序（渲染层依赖它稳定）");
    }

    #[test]
    fn parent_of_handles_drive_roots() {
        assert_eq!(parent_of(r"C:\a\b"), Some(r"C:\a".into()));
        assert_eq!(parent_of(r"C:\a"), Some(r"C:\".into()));
        assert_eq!(parent_of(r"C:\"), None);
        assert_eq!(parent_of(r"C:\a\b\"), Some(r"C:\a".into()), "尾斜杠不影响");
        assert_eq!(parent_of(r"C:/a/b"), Some(r"C:\a".into()), "正斜杠也认");
    }
}