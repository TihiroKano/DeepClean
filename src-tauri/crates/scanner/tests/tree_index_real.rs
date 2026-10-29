//! M2-T1 的真机验收：`TreeIndex` 在**真扫出来的树**上满足那条核心恒等式。
//!
//! 恒等式：对**每一个**目录，`dir.size_counted == Σ children_of(dir).size()`。
//! 它把"树折成 arena"这一步的正确性钉死 —— 折错一层、漏挂一个子节点、聚合少加一次，
//! 这条都会红。单元测试里的手搭树证明不了这一点（手搭树是我自己写的，错法一致就看不出来）。

use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::tree_index::{SizeBasis, TreeIndex, ROOT_DIR_ID};
use deepclean_scanner::volume::volume_of;
use std::fs;
use std::path::PathBuf;

/// **每个用例一个独立目录** —— Cargo 并行跑测试，共用目录时一个用例的 `remove_dir_all`
/// 会删掉另一个正在写的文件。这条在 M1 的枚举测试里已经踩过一次（见那里的注释）。
fn fixture(tag: &str) -> PathBuf {
    let root = PathBuf::from(format!(r"D:\deepclean-fixture\m2-index\{tag}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("a").join("deep").join("deeper")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::write(root.join("root.bin"), vec![0u8; 3000]).unwrap();
    fs::write(root.join("a").join("a1.bin"), vec![1u8; 5000]).unwrap();
    fs::write(root.join("a").join("deep").join("d1.bin"), vec![2u8; 900]).unwrap();
    fs::write(root.join("a").join("deep").join("deeper").join("z.bin"), vec![3u8; 7]).unwrap();
    fs::write(root.join("b").join("b1.bin"), vec![4u8; 12000]).unwrap();
    fs::hard_link(root.join("root.bin"), root.join("root_link.bin")).unwrap();
    root
}

#[test]
fn arena_identity_holds_for_every_directory_on_a_real_scan() {
    let root = fixture("identity");
    let volume = volume_of(&root).unwrap();
    let tree = scan_tree(&ScanOptions::new(&root), &volume, |_| {}).unwrap();
    let idx = TreeIndex::build(&tree);

    // 根：arena 的合计必须等于扫描器的占用合计（两条独立累加路径）
    assert_eq!(idx.dir(ROOT_DIR_ID).unwrap().size_counted, tree.counters.bytes_counted);

    let mut checked = 0;
    let mut ids = vec![ROOT_DIR_ID];
    ids.extend(1..idx.dirs_len() as i64); // 下标 0 是根（id=-1），其余 id 就是下标

    for id in ids {
        let d = idx.dir(id).expect("arena 里的每个 id 都必须能解出来");
        let sum = idx.sum_children_of(id);
        assert_eq!(
            d.size_counted, sum,
            "目录 {} 的合计 {} != 它完整清单之和 {}",
            d.path, d.size_counted, sum
        );
        // 收窄不许动计价口径（红线哨兵在真树上再跑一次）
        for cap in [0usize, 1, 3] {
            let _ = idx.level_of(id, cap, &std::collections::BTreeSet::new());
        }
        assert_eq!(idx.sum_children_of(id), sum, "收窄之后计价口径变了");
        checked += 1;
    }
    assert!(checked >= 5, "至少该有根 + a + a/deep + a/deep/deeper + b 五个目录，实到 {checked}");
}

#[test]
fn payload_equation_holds_on_a_real_scan() {
    let root = fixture("payload");
    let volume = volume_of(&root).unwrap();
    let tree = scan_tree(&ScanOptions::new(&root), &volume, |_| {}).unwrap();
    let idx = TreeIndex::build(&tree);

    let p = idx.payload(ROOT_DIR_ID, 2, "completed", &std::collections::BTreeSet::new(), (0, 0), SizeBasis::Allocated).unwrap();
    let kept: u64 = p.children.iter().map(|c| c.size).sum();
    assert_eq!(p.total_children, 4, "root.bin / root_link.bin / a / b");
    assert_eq!(kept + p.folded_bytes, idx.sum_children_of(ROOT_DIR_ID));
    assert_eq!(p.excluded_count, 0);
    assert_eq!(p.excluded_bytes, 0);
    assert!(!p.truncated, "夹具没触发 maxFiles 截断");
}
