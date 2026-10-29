//! 清理日志的**落盘** —— 原子写、schema 守卫、坏文件保留。
//!
//! 2026-10-25 重做（设计：`docs/superpowers/specs/2026-10-25-clean-journal-redesign-design.md` §10.3/§10.4）。
//!
//! 旧账本只在内存里（`service.rs` 的 `Mutex<Vec<JournalEntry>>`），进程一退就没了，
//! 谈「保留 30 天」根本无从谈起。这一层把它变成一份真实的文件：
//!
//! `%APPDATA%\com.deepclean.app\logs\clean-journal.json`
//!
//! 四条纪律（每条都有用例钉着）：
//!
//! 1. **写是原子的**：先写 `clean-journal.json.tmp` 再 `rename`。
//!    临时文件落在**同一个目录**——`rename` 要原子，前提就是它与目标同卷；
//!    跨卷会退化成「复制 + 删除」，既不原子也多一条会失败的调用。
//!    （与 `settings.rs:13` 同一条手法与同一条理由。）
//! 2. **版本号守卫**：文件头 `"schema": 1`。读到**更高**版本 ⇒ 不解析、**也不许覆盖**。
//!    降级运行时把新格式当旧格式解析会静默丢数据；宁可不读，也不能把用户的记录写坏。
//! 3. **坏文件保留**：解析失败 ⇒ 改名 `clean-journal.broken-<毫秒>.json` 留着。
//!    那是用户 30 天的记录，直接覆盖等于销毁证据。
//! 4. **文件不存在是正常态**：第一次跑的时候本来就没有。返回空账本，不打日志、不报错。
//!
//! ⚠️ 本模块**只碰一个文件**，不做任何删除动作 —— 淘汰（`prune`）改的是内存里的
//! `Vec<CleanRun>`，落盘是调用方的事。这样"删数据"与"删文件"是两件分开的事。

use deepclean_cleaner::journal::{CleanRun, JOURNAL_RETENTION_MS};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 当前格式版本。读到更高版本时不解析也不覆盖（见文件头纪律 2）。
pub const SCHEMA: u32 = 1;

/// 落盘文件的顶层形状。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    schema: u32,
    runs: Vec<CleanRun>,
}

/// 内存里的账本 + 它能不能写回去。
#[derive(Debug, Default)]
pub struct JournalStore {
    runs: Vec<CleanRun>,
    /// `false` = 读到的是**更高版本**的文件，不许覆盖它。
    ///
    /// 这一格刻意做成私有 + 默认 `true`：调用方不需要知道为什么不能写，
    /// 只需要看 `save` 的 `Result`。让每个调用点自己判断一次，就会有漏判的那一处。
    writable: bool,
}

impl JournalStore {
    /// 空账本（可写）。
    pub fn new() -> Self {
        Self { runs: Vec::new(), writable: true }
    }

    /// 从盘上读。**任何**失败都返回一个可用的空账本，不 `Err` ——
    /// 日志页读不出来时显示「还没有清理日志」，比让整个命令失败好。
    pub fn load(path: &Path) -> Self {
        let body = match std::fs::read_to_string(path) {
            // 去掉 UTF-8 BOM（`EF BB BF`）。**这不是洁癖**：PowerShell 5.1 的
            // `Set-Content -Encoding utf8` 会加 BOM，而 `serde_json` 不认它 ⇒ 解析失败 ⇒
            // 一份好好的文件被改名成 `.broken-`。2026-10-25 真机验证时第一版就是这么撞上的。
            // 用户用记事本手改过一次日志也会带来同样的问题。
            Ok(b) => b.trim_start_matches('\u{feff}').to_string(),
            // 不存在 = 第一次跑，正常态
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::new(),
            // 读不了（权限/IO）：按空账本跑，但**不覆盖**未知状态的既有文件
            Err(e) => {
                eprintln!("[dc] 清理日志读不了（{e}）→ 本次按空账本跑，不覆盖原文件");
                return Self { runs: Vec::new(), writable: false };
            }
        };

        // ⚠️ **必须先单独读 schema，再解 runs**（2026-10-25 实测踩到）：
        // 第一版直接 `from_str::<Wire>`，结果高版本文件里 `runs` 的元素形状不同 ⇒
        // **反序列化先失败了**，于是走进"坏文件改名"那条路 —— 把一份完好的新版本文件
        // 改名成了 `.broken-`，正是纪律 2 明令不许发生的事。
        // 判据与坏文件的判据是两件事，先后不能颠倒：先问"这是不是我认识的版本"，
        // 再问"这份字节能不能解析"。
        let declared = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("schema").and_then(|s| s.as_u64()))
            .unwrap_or(0);

        if declared as u32 > SCHEMA {
            eprintln!("[dc] 清理日志是更高的格式版本（{declared} > {SCHEMA}）→ 不读也不覆盖");
            return Self { runs: Vec::new(), writable: false };
        }

        match serde_json::from_str::<Wire>(&body) {
            Ok(w) => Self { runs: w.runs, writable: true },
            Err(e) => {
                // 坏文件：改名保留，再按空账本跑
                let kept = broken_path(path);
                match std::fs::rename(path, &kept) {
                    Ok(()) => eprintln!("[dc] 清理日志解析失败（{e}）→ 已保留为 {kept:?}，本次按空账本跑"),
                    Err(re) => eprintln!("[dc] 清理日志解析失败（{e}），且改名也失败（{re}）→ 不动它"),
                }
                Self::new()
            }
        }
    }

    /// 原子写。`Err` 的三种来源都要让调用方看得见（不是静默吞掉）。
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if !self.writable {
            return Err("E_JOURNAL_SCHEMA：盘上是更高版本的清理日志 → 拒绝覆盖".to_string());
        }
        let wire = Wire { schema: SCHEMA, runs: self.runs.clone() };
        let body = serde_json::to_string_pretty(&wire).map_err(|e| format!("序列化失败：{e}"))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("建不出目录 {dir:?}：{e}"))?;
        }
        // 临时文件必须与目标**同目录**（理由见文件头纪律 1）
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, format!("{body}\n"))
            .and_then(|()| std::fs::rename(&tmp, path))
            .map_err(|e| {
                // 写失败时把 tmp 清掉，免得留下一个永不清理的残骸
                let _ = std::fs::remove_file(&tmp);
                format!("写不进 {path:?}：{e}")
            })
    }

    /// 淘汰超过 30 天的。返回删了几条。
    ///
    /// 判据走 `journal::is_expired` —— 那一格是开区间（正好 30 天不删），
    /// 公式只有一份，这里不重写。
    pub fn prune(&mut self, now_ms: i64) -> usize {
        let before = self.runs.len();
        self.runs.retain(|r| !deepclean_cleaner::journal::is_expired(r, now_ms));
        before - self.runs.len()
    }

    pub fn push(&mut self, run: CleanRun) {
        self.runs.push(run);
    }

    pub fn runs(&self) -> &[CleanRun] {
        &self.runs
    }

    /// 只读查询用：按 id 找一条。
    pub fn get(&self, id: &str) -> Option<&CleanRun> {
        self.runs.iter().find(|r| r.id == id)
    }
}

/// `clean-journal.json` → `clean-journal.broken-<毫秒>.json`。
fn broken_path(path: &Path) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!("clean-journal.broken-{stamp}.json"))
}

/// 保留期常量转出来，免得调用方各自 `use crate::journal::…`。
///
/// ⚠️ 目前**没有调用方**：`prune` 自己走 `journal::is_expired`，列表走
/// `journal_view::within_retention`，两边都不需要这个别名。留着是因为它是这一层的
/// 公开常量面（外部要知道"30 天"这个数该从哪取），不是因为有人在用。
/// 真要收掉就得连 `JOURNAL_RETENTION_MS` 一起挪，那是另一件事。
#[allow(dead_code)]
pub const RETENTION_MS: i64 = JOURNAL_RETENTION_MS;

#[cfg(test)]
mod tests {
    use super::*;
    use deepclean_cleaner::executor::{CleanDeletion, CleanDeletionKind, CleanOutcome};

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deepclean-journal-store-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("临时目录建得出");
        dir
    }

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

    fn run_of(id: &str, ended_at_ms: i64, files: &[(&str, u64)]) -> CleanRun {
        let deleted: Vec<_> = files.iter().map(|(p, b)| del(p, *b)).collect();
        let mut r = deepclean_cleaner::journal::build_run(id, ended_at_ms, &deleted).expect("有文件就有条目");
        r.id = id.into();
        r
    }

    #[test]
    fn saved_runs_survive_a_reload() {
        let dir = tmp("roundtrip");
        let p = dir.join("clean-journal.json");
        let mut s = JournalStore::new();
        s.push(run_of("t1", 1_000, &[(r"C:\a\x.tmp", 10)]));
        s.save(&p).expect("写得进");

        let back = JournalStore::load(&p);
        assert_eq!(back.runs().len(), 1, "重读必须拿回那条");
        assert_eq!(back.runs()[0].freed_bytes, 10);
        assert_eq!(back.runs()[0].drives, vec!["C:\\".to_string()], "盘符也要活过一轮 JSON");
    }

    #[test]
    fn load_of_absent_file_is_an_empty_store() {
        let dir = tmp("absent");
        let s = JournalStore::load(&dir.join("nope.json"));
        assert!(s.runs().is_empty());
        assert!(s.writable, "第一次跑必须是可写的（否则永远存不下）");
    }

    #[test]
    fn a_higher_schema_is_neither_read_nor_overwritten() {
        let dir = tmp("schema");
        let p = dir.join("clean-journal.json");
        std::fs::write(&p, r#"{"schema":99,"runs":[{"id":"future"}]}"#).unwrap();

        let s = JournalStore::load(&p);
        assert!(s.runs().is_empty(), "不认识的版本当空账本");
        assert!(s.save(&p).is_err(), "不许把高版本文件写坏");

        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.contains("\"schema\":99"), "原文件一个字节都不许动");
    }

    #[test]
    fn a_corrupt_file_is_kept_as_broken_instead_of_being_overwritten() {
        let dir = tmp("corrupt");
        let p = dir.join("clean-journal.json");
        std::fs::write(&p, "{not json").unwrap();

        let s = JournalStore::load(&p);
        assert!(s.runs().is_empty());

        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("clean-journal.broken-"))
            .collect();
        assert_eq!(kept.len(), 1, "坏文件要改名保留，不许直接覆盖");
        assert!(!p.exists(), "原位置该让出来");
    }

    /// BOM 不许把一份好文件判成坏文件（2026-10-25 真机验证撞到的）。
    #[test]
    fn a_utf8_bom_is_tolerated_not_treated_as_corruption() {
        let dir = tmp("bom");
        let p = dir.join("clean-journal.json");
        let mut s = JournalStore::new();
        s.push(run_of("t1", 1_000, &[(r"C:\a\x.tmp", 10)]));
        s.save(&p).unwrap();
        // 前面塞一个 BOM
        let body = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, format!("\u{feff}{body}")).unwrap();

        let back = JournalStore::load(&p);
        assert_eq!(back.runs().len(), 1, "带 BOM 的文件必须照读，不许改名成 broken");

        let broken: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("broken"))
            .collect();
        assert!(broken.is_empty(), "不该产生 broken 文件");
    }

    #[test]
    fn prune_drops_only_expired_runs() {
        let mut s = JournalStore::new();
        s.push(run_of("old", 0, &[(r"C:\a\x", 1)]));
        s.push(run_of("new", JOURNAL_RETENTION_MS, &[(r"C:\a\y", 1)]));

        let removed = s.prune(JOURNAL_RETENTION_MS + 1);
        assert_eq!(removed, 1);
        assert_eq!(s.runs().len(), 1);
        assert_eq!(s.runs()[0].id, "new");
    }

    #[test]
    fn save_creates_the_parent_directory() {
        let dir = tmp("mkdir");
        let p = dir.join("logs").join("clean-journal.json");
        let mut s = JournalStore::new();
        s.push(run_of("t", 1, &[(r"C:\a\x", 1)]));
        s.save(&p).expect("目录该被建出来");
        assert!(p.exists());
    }

    #[test]
    fn no_tmp_file_is_left_behind_after_a_successful_save() {
        let dir = tmp("notmp");
        let p = dir.join("clean-journal.json");
        let mut s = JournalStore::new();
        s.push(run_of("t", 1, &[(r"C:\a\x", 1)]));
        s.save(&p).unwrap();
        let tmp_left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(tmp_left.is_empty(), "成功写完不许留 tmp 残骸");
    }
}
