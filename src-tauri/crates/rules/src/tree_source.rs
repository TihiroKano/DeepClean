//! 把**真扫描出来的树**接到评估层：`RuleSource for TreeIndex`。
//!
//! 引擎核心（`engine`/`env`/`matcher`/`validate`/`builtin`）一行都不 import scanner ——
//! 那些判据必须能在一棵合成树上跑。本模块是唯一的接缝，也只做一件事：**视图翻译**。
//!
//! 两条口径必须与 TS 侧逐字对齐，否则同一棵树在两套引擎里会给出不同结论：
//!  · 路径归一化只有一把：`engine::normalize_key`。`claimed` 表与这里的 `by_path` 索引共用它 ——
//!    两处两种归一化就是两套真相。
//!  · 文件路径只有一把拼法：`engine::join_win`（对应 TS 的 `pathutil.joinWin`，
//!    `tree-store.ts:120` 的 `fileView` 用的就是它）。
//!
//! **属性（§28 原则二）走的是真数据**：`ScanFile.attrs` 是父目录那条目录项里的
//! `FileAttributes` 位掩码，目录本身的属性同源。两套引擎在这条判据上因此**同源同口径** ——
//! 曾经这里是 `attrs: None`（"没采到" → 不保护），那会让一个带 SYSTEM 的缓存文件
//! 被 Rust 认领、被 TS 拒绝，方向是**多删**。修法不是"补一条判据"，而是把已经拿到手的位传下去。

use crate::engine::{normalize_key, NodeKind, NodeView, RuleSource};
use deepclean_scanner::tree_index::{ChildRef, TreeIndex};
use std::collections::BTreeMap;

/// `TreeIndex` 的只读取数面。**建一次索引，之后每次查询都是 O(log n)**。
pub struct TreeSource<'a> {
    idx: &'a TreeIndex,
    /// `归一化路径 → dir_id`。这就是 `openDir` 的第一件事（`dirIdByPath`）。
    by_path: BTreeMap<String, i64>,
}

impl<'a> TreeSource<'a> {
    pub fn new(idx: &'a TreeIndex) -> Self {
        let mut by_path = BTreeMap::new();
        for d in idx.iter_dirs() {
            let key = normalize_key(&d.path);
            // 同一条归一化路径只可能有一个目录记录；真撞上说明树本身重了，
            // 保留先到的（根先入 arena，所以根赢）而不是静默覆盖成后者。
            by_path.entry(key).or_insert(d.id);
        }
        TreeSource { idx, by_path }
    }

    /// 建了多少条索引（判据要看它，不是"看着像建了"）。
    pub fn indexed_dirs(&self) -> usize {
        self.by_path.len()
    }
}

impl RuleSource for TreeSource<'_> {
    fn dir_id_by_path(&self, path: &str) -> Option<i64> {
        self.by_path.get(&normalize_key(path)).copied()
    }

    fn children_of(&self, dir_id: i64) -> Vec<NodeView> {
        let Some(dir) = self.idx.dir(dir_id) else {
            return Vec::new();
        };
        let parent_path = dir.path.clone();
        self.idx
            .children_of(dir_id)
            .into_iter()
            .map(|c| match c {
                ChildRef::Dir(d) => NodeView {
                    kind: NodeKind::Directory,
                    name: d.name.clone(),
                    path: d.path.clone(),
                    size: d.size_counted,
                    mtime_ms: d.mtime_ms,
                    // 目录属性是真的（来自父目录那条目录项），但引擎一次都不读它 ——
                    // TS 那边目录恒为 `null`（它不为目录 stat），两边的差异因此**不可观测**。
                    attrs: Some(d.attrs),
                },
                ChildRef::File(f) => NodeView {
                    kind: NodeKind::File,
                    name: f.name.clone(),
                    path: crate::engine::join_win(&parent_path, &f.name),
                    size: f.counted,
                    mtime_ms: f.mtime_ms,
                    // §28 原则二的真判据要靠它。`ScanFile.attrs` 来自父目录那条目录项
                    // （`FileIdBothDirectoryInfo.FileAttributes`），零额外 syscall。
                    attrs: Some(f.attrs),
                },
            })
            .collect()
    }

    /// 子树合计。**`None` = 没这个目录**，绝不退成 `Some(0)` ——
    /// 0 会被下游念成"这个目录是空的"。
    fn size_of(&self, dir_id: i64) -> Option<u64> {
        self.idx.dir(dir_id).map(|d| d.size_counted)
    }
}

/// **已删路径过滤层**（2026-10-24：清理完成后，图二数值要变）。
///
/// 预览读的是扫描那棵**不可变快照树**，清理删的是磁盘文件，树没动 —— 所以只清缓存重算，
/// 报告还是旧数。这一层包在真正的 `RuleSource` 外面，把「已经删掉的那些文件路径」从
/// `children_of` 的清单里摘掉，报告与预览的字节数自然就跟着少掉。
///
/// 三条边界：
/// 1. **只影响估价，不影响执行**：执行器的清单来自清理前那份报告，不是这份过滤后的。
///    它只服务「清理之后这一页显示的数字」，不参与任何删除判定。
/// 2. `size_of` **透传**：它只在 `resolve_territory` 里给 ledger 的 `present` 一格用，
///    最终字节是逐路径求和，不是 `size_of`；而且 `TreeIndex::size_of` 是扫描时的子树
///    合计，没有「减掉某些文件」的语义。真正的口径修正发生在 `children_of`。
/// 3. 目录**不摘**：文件删空之后目录行还在（`dirsRemoved` 里的是被整个删掉的目录，
///    那类目录本来就不在扫描树的 `children_of` 里）。空目录显示 0 字节是诚实的读数。
pub struct FilteredSource<'a, S: RuleSource + ?Sized> {
    inner: &'a S,
    /// 已删文件的归一化路径键集合。
    deleted: std::collections::BTreeSet<String>,
}

impl<'a, S: RuleSource + ?Sized> FilteredSource<'a, S> {
    pub fn new(inner: &'a S, deleted: &std::collections::BTreeSet<String>) -> Self {
        Self {
            inner,
            deleted: deleted.clone(),
        }
    }
}

impl<S: RuleSource + ?Sized> RuleSource for FilteredSource<'_, S> {
    fn dir_id_by_path(&self, path: &str) -> Option<i64> {
        self.inner.dir_id_by_path(path)
    }

    fn children_of(&self, dir_id: i64) -> Vec<NodeView> {
        self.inner
            .children_of(dir_id)
            .into_iter()
            .filter(|n| n.kind == NodeKind::Directory || !self.deleted.contains(&normalize_key(&n.path)))
            .collect()
    }

    fn size_of(&self, dir_id: i64) -> Option<u64> {
        self.inner.size_of(dir_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::builtin_rules;
    use crate::engine::{evaluate_rules, EvaluateOptions};
    use crate::env::RuleEnv;
    use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
    use deepclean_scanner::volume::VolumeInfo;

    fn f(name: &str, counted: u64) -> ScanFile {
        ScanFile {
            name: name.into(),
            size: counted,
            alloc: counted,
            counted,
            file_id: 1,
            mtime_ms: 1,
            creation_ms: 0,
            attrs: 0,
        }
    }

    /// root(C:\) ├ Windows\System32\{k.dll 999} ├ Temp\{a.tmp 100, b.tmp 200}
    ///           ├ $Recycle.Bin\{gone.bin 500}  └ Local\npm-cache\{c.bin 700}
    ///
    /// 目录摆位是照着**注入的 env** 铺的（`LOCALAPPDATA = C:\Local`、`TEMP = C:\Temp`）——
    /// 夹具与 env 对不上时规则会安静地报 0 字节，而这看起来和"这台机器上没这块缓存"一样。
    fn idx() -> TreeIndex {
        let mut root = ScanNode::dir("C:".into(), r"C:\".into());
        root.attrs = 0x10;

        let mut win = ScanNode::dir("Windows".into(), r"C:\Windows".into());
        let mut sys32 = ScanNode::dir("System32".into(), r"C:\Windows\System32".into());
        sys32.files.push(f("k.dll", 999));
        sys32.size_counted = 999;
        win.children = vec![sys32];
        win.size_counted = 999;

        let mut temp = ScanNode::dir("Temp".into(), r"C:\Temp".into());
        temp.files.push(f("a.tmp", 100));
        temp.files.push(f("b.tmp", 200));
        temp.size_counted = 300;

        let mut bin = ScanNode::dir("$Recycle.Bin".into(), r"C:\$Recycle.Bin".into());
        bin.files.push(f("gone.bin", 500));
        bin.size_counted = 500;

        let mut npm = ScanNode::dir("npm-cache".into(), r"C:\Local\npm-cache".into());
        npm.files.push(f("c.bin", 700));
        npm.size_counted = 700;
        let mut local = ScanNode::dir("Local".into(), r"C:\Local".into());
        local.children = vec![npm];
        local.size_counted = 700;

        root.children = vec![win, temp, bin, local];
        root.size_counted = 999 + 300 + 500 + 700;

        let t = ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 99999, free_bytes: 1 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        };
        TreeIndex::build(&t)
    }

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("WINDIR".into(), r"C:\Windows".into());
m.insert("PROGRAMFILES".into(), r"C:\\Program Files".into());
m.insert("PROGRAMDATA".into(), r"C:\\ProgramData".into());
m.insert("USERPROFILE".into(), r"C:\\Users\\Kano".into());
m.insert("APPDATA".into(), r"C:\\Users\\Kano\\AppData\\Roaming".into());
m.insert("LOCALAPPDATA".into(), r"C:\\Users\\Kano\\AppData\\Local".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Local".into());
        m
    }

    #[test]
    fn the_index_resolves_every_dir_including_the_root() {
        let ix = idx();
        let src = TreeSource::new(&ix);
        assert_eq!(src.indexed_dirs(), ix.dirs_len(), "每个目录记录都要进索引");
        assert_eq!(src.dir_id_by_path(r"C:\"), Some(-1));
        assert_eq!(src.dir_id_by_path(r"c:/temp"), src.dir_id_by_path(r"C:\Temp"), "归一化要对斜杠与大小写免疫");
        assert!(src.dir_id_by_path(r"C:\nope").is_none(), "没扫到的目录必须回 None（≠ 存在）");
        // 段边界：`C:\Tem` 不是 `C:\Temp`
        assert!(src.dir_id_by_path(r"C:\Tem").is_none());
    }

    #[test]
    fn a_file_child_gets_its_full_path_from_the_parent() {
        let ix = idx();
        let src = TreeSource::new(&ix);
        let temp = src.dir_id_by_path(r"C:\Temp").unwrap();
        let kids = src.children_of(temp);
        let mut paths: Vec<String> = kids.iter().map(|k| k.path.clone()).collect();
        // `children_of` 是计价口径，按容量降序 —— 所以 b.tmp(200) 在 a.tmp(100) 前面
        assert_eq!(paths, vec![r"C:\Temp\b.tmp", r"C:\Temp\a.tmp"]);
        // 根下的直接子目录路径不能拼出 `C:\\Windows` 那种双分隔符
        let root = src.dir_id_by_path(r"C:\").unwrap();
        let root_paths: Vec<String> = src.children_of(root).iter().map(|k| k.path.clone()).collect();
        assert!(root_paths.contains(&r"C:\Windows".to_string()), "实得 {root_paths:?}");
        assert!(!root_paths.iter().any(|p| p.contains(r"\\")), "双分隔符：{root_paths:?}");
        paths.clear();
    }

    #[test]
    fn size_of_is_subtree_total_and_none_for_missing() {
        let ix = idx();
        let src = TreeSource::new(&ix);
        assert_eq!(src.size_of(src.dir_id_by_path(r"C:\").unwrap()), Some(2499));
        assert_eq!(src.size_of(src.dir_id_by_path(r"C:\Windows").unwrap()), Some(999));
        assert_eq!(src.size_of(4242), None, "缺目录回 None，不许退成 Some(0)");
    }

    /// **集成判据**：真树 + 内置表跑一遍，🔴 回收站照常报占用但不进可回收，
    /// 两条 🟢/🟡 规则的地盘与 `children_of` 口径逐字对上。
    #[test]
    fn the_builtin_table_over_a_real_tree_reports_the_bin_but_never_reclaims_it() {
        let ix = idx();
        let src = TreeSource::new(&ix);
        let r = evaluate_rules(&src, &builtin_rules(), &env(), &EvaluateOptions::default());
        assert!(!r.safety_blocked, "完整 env 下不该 fail-safe");

        let of = |id: &str| r.findings.iter().find(|f| f.rule_id == id).unwrap().total_bytes;
        assert_eq!(of("windows-temp"), 300, "a.tmp + b.tmp");
        assert_eq!(of("npm-cache"), 700, "C:\\Local\\npm-cache\\c.bin");
        assert_eq!(of("recycle-bin"), 500, "🔴 照常识别容量");
        assert_eq!(r.reclaimable_bytes, 1000, "🔴 那 500 不许进可回收");
    }

    /// 真树上的**评估层禁止根闸**：`%SYSTEMDRIVE%\W*` 带通配 ⇒ 静态闸看不到会展开成 `C:\Windows`
    /// （禁止根 `C:\Windows\System32` 的祖先），评估层展开后由收尾把关整块拒掉。
    /// 这条只有走真树才连得上 `join_win`、`dir_id_by_path` 与根路径边界。
    #[test]
    fn a_wildcard_rule_over_a_real_tree_is_refused_by_the_ancestor_gate() {
        use crate::engine::ExclusionReason;
        use crate::types::{CleanStrategy, Risk, Rule, RuleCategory, RuleScanner};
        let ix = idx();
        let src = TreeSource::new(&ix);
        let greedy = Rule {
            id: "wild-sweep".into(),
            name: "通配套住禁止根".into(),
            category: RuleCategory::Temp,
            description: "d".into(),
            paths: vec![r"%SYSTEMDRIVE%\W*".into()],
            scanner: RuleScanner { file_patterns: vec![], older_than_days: None, recursive: true, ..Default::default() },
            risk_level: Risk::Safe,
            clean_strategy: CleanStrategy::DeleteAll,
            recoverable: true,
            requires_detector: None,
            excluded_from_default_selection: None,
            requires_absent_app_fact: None,
        };
        let r = evaluate_rules(&src, &[greedy], &env(), &EvaluateOptions::default());
        assert_eq!(r.findings[0].total_bytes, 0, "地盘是 C:\\Windows → 整块不认");
        assert!(
            r.exclusions.iter().any(|e| e.reason == ExclusionReason::AncestorOfProtected),
            "实得 {:?}",
            r.exclusions.iter().map(|e| e.reason).collect::<Vec<_>>()
        );
        assert_eq!(r.reclaimable_bytes, 0);
    }

    /// **这条是「清理后数字没变」那个缺陷的判据**（2026-10-25）。
    ///
    /// `FilteredSource` 是整条刷新链里唯一把"已删文件"从字节里去掉的地方，
    /// 而它**在此之前一条测试都没有** —— 链路上其余每一段（前端 nonce、缓存失效、
    /// deleted_paths 记账）都各自有注释说他处已验，唯独真正减字节的这一层没验过。
    ///
    /// 这里用固定夹具直接量：删掉 `C:\Temp\a.tmp`（100）之后，`windows-temp`
    /// 那条规则的字节必须从 300 变成 200。
    #[test]
    fn a_deleted_file_lowers_the_rule_total_by_exactly_its_size() {
        use crate::engine::normalize_key;

        let ix = idx();
        let src = TreeSource::new(&ix);
        let rules = builtin_rules();
        let env = env();

        let before = evaluate_rules(&src, &rules, &env, &EvaluateOptions::default());
        let before_bytes = before
            .findings
            .iter()
            .find(|f| f.rule_id == "windows-temp")
            .map(|f| f.total_bytes);
        assert_eq!(before_bytes, Some(300), "夹具里 Temp 下两个文件共 300");

        let mut deleted = std::collections::BTreeSet::new();
        deleted.insert(normalize_key(r"C:\Temp\a.tmp"));
        let filtered = super::FilteredSource::new(&src, &deleted);

        let after = evaluate_rules(&filtered, &rules, &env, &EvaluateOptions::default());
        let after_bytes = after
            .findings
            .iter()
            .find(|f| f.rule_id == "windows-temp")
            .map(|f| f.total_bytes);
        assert_eq!(
            after_bytes,
            Some(200),
            "删掉 100 之后必须剩 200 —— 这一格不动就是这个缺陷"
        );
    }

    /// 对照半边：已删集合里放一个**不相干**的路径，字节不许变。
    /// 没有这一条，上面那条会被"无条件减点东西"这种错实现蒙过去。
    #[test]
    fn an_unrelated_deleted_path_changes_nothing() {
        use crate::engine::normalize_key;

        let ix = idx();
        let src = TreeSource::new(&ix);
        let mut deleted = std::collections::BTreeSet::new();
        deleted.insert(normalize_key(r"C:\Somewhere\else.bin"));
        let filtered = super::FilteredSource::new(&src, &deleted);

        let after = evaluate_rules(&filtered, &builtin_rules(), &env(), &EvaluateOptions::default());
        assert_eq!(
            after
                .findings
                .iter()
                .find(|f| f.rule_id == "windows-temp")
                .map(|f| f.total_bytes),
            Some(300),
            "不相干的路径不许影响这一条"
        );
    }
}
