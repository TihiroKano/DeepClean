//! 扫描途中那个 top-N 堆在**真 NTFS** 上的两条形状（M5-E④）。
//! 合成树上验不到这两件事：一条要真目录项的 `size`/`last_write_ms`，一条要真路径拼接。

use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::volume::volume_of;
use std::fs;
use std::path::PathBuf;

fn fixture(tag: &str) -> PathBuf {
    let root = PathBuf::from(format!(r"D:\deepclean-fixture\m5d-top\{tag}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("zero-a.bin"), b"").unwrap();
    fs::write(root.join("zero-b.bin"), b"").unwrap();
    fs::write(root.join("small.bin"), vec![1u8; 100]).unwrap();
    fs::write(root.join("big.bin"), vec![2u8; 900]).unwrap();
    fs::write(root.join("sub").join("deep.bin"), vec![3u8; 500]).unwrap();
    root
}

#[test]
fn zero_byte_files_never_enter_the_heap_and_paths_are_complete() {
    let root = fixture("zeros");
    let volume = volume_of(&root).unwrap();
    let mut opts = ScanOptions::new(&root);
    // 容量**大于**非零文件数：这一格才能把"0 字节占位"照出来。容量 3 的话 0 字节那份
    // 迟早被更大的顶掉，两种实现给出同一张表 —— 那是判据没有分辨力，不是实现正确。
    opts.top_n = 8;
    let tree = scan_tree(&opts, &volume, |_| {}).expect("夹具应当扫得动");

    assert_eq!(tree.counters.files, 5, "夹具本身：五个文件");
    assert_eq!(tree.top.len(), 3, "0 字节文件进了堆（表上会出现 0 B 那一行）");
    let mut sizes: Vec<u64> = tree.top.iter().map(|h| h.size).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![100, 500, 900], "0 字节文件不许占堆位（一个满盘树里它们能有几万个）");

    // 路径是完整的（`ScanFile` 只存名字，这一格要能被表格直接打开/定位）
    let deep = tree.top.iter().find(|h| h.name == "deep.bin").expect("子目录那份要在");
    assert_eq!(deep.path, format!(r"{}\sub\deep.bin", root.display()));
    assert!(!deep.path.contains(r"\\"), "拼出来的路径不许有双分隔符：{}", deep.path);
    assert!(deep.mtime_ms > 0, "修改时间从目录项里就有，表上那一列要用它");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn top_n_zero_records_nothing_rather_than_everything() {
    // 容量 0 是"什么都不记"，不是"无限记" —— 后者会让那张表在关掉功能时反而变大
    let root = fixture("cap0");
    let volume = volume_of(&root).unwrap();
    let mut opts = ScanOptions::new(&root);
    opts.top_n = 0;
    let tree = scan_tree(&opts, &volume, |_| {}).expect("夹具应当扫得动");
    assert!(tree.top.is_empty(), "容量 0 该是空表，实际 {:?}", tree.top.len());
    assert_eq!(tree.counters.files, 5, "但扫描本身照常计数（这不是跳过）");
    let _ = fs::remove_dir_all(&root);
}
