//! M1-T2 的真机验收：`read_dir_entries` 拿到的清单必须与另一套完全不同的 API
//! （`std::fs::read_dir` + `metadata`）逐名一致。
//!
//! 夹具只落 `D:\deepclean-fixture\`（项目纪律：绝不写 C:）。
//!
//! **每个用例一个独立目录**：Cargo 默认并行跑测试，共用一个夹具目录时，
//! 一个用例的 `remove_dir_all` 会把另一个正在写的文件删掉，报出来的却是
//! 「系统找不到指定的路径」—— 看着像产品缺陷，其实是夹具打架。

use deepclean_scanner::enumerate::read_dir_entries;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

fn fixture(tag: &str) -> PathBuf {
    let root = PathBuf::from(format!(r"D:\deepclean-fixture\m1-enum\{tag}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("a.bin"), vec![0u8; 5000]).unwrap();
    fs::write(root.join("tiny.bin"), vec![0u8; 100]).unwrap();
    fs::write(root.join("empty.txt"), b"").unwrap();
    fs::write(root.join("sub").join("b.bin"), vec![1u8; 10]).unwrap();
    root
}

#[test]
fn enumerates_a_known_fixture_with_ids_and_allocation() {
    let root = fixture("basic");
    let entries = read_dir_entries(&root).expect("夹具目录应当可枚举");
    let find = |n: &str| {
        entries
            .iter()
            .find(|e| e.name == n)
            .unwrap_or_else(|| panic!("缺 {n}；实到 {:?}", entries.iter().map(|e| &e.name).collect::<Vec<_>>()))
    };

    assert_eq!(find("a.bin").size, 5000, "逻辑大小");
    assert!(find("a.bin").alloc_size > 0, "有内容的文件分配大小不应为 0");
    // ⚠️ **不能断言"分配大小一律按簇对齐"** —— 这是本次实测纠正的一条：
    // 5000 B 的文件在 4096 簇的卷上报 8192（非常驻，按簇），而 100 B 的文件报 104
    // （**常驻**：数据直接存在 MFT 记录里，NTFS 报的是按 8 字节对齐的数据长度）。
    // 断言写死"必是 4096 的倍数"会被常驻文件当场打红。
    assert_eq!(find("a.bin").alloc_size, 8192, "5000 B 在 4096 簇上占两个簇");
    assert_eq!(find("tiny.bin").alloc_size, 104, "100 B 是常驻文件，报 8 字节对齐的数据长度");
    assert_eq!(find("empty.txt").size, 0);
    assert_eq!(find("empty.txt").alloc_size, 0, "0 字节文件不占簇");
    assert!(find("sub").is_dir);
    assert!(!find("sub").is_reparse);
    assert!(find("a.bin").last_write_ms > 0, "写入时间应当是有效时刻");
    assert!(find("a.bin").creation_ms > 0, "创建时间从目录项里就有（TS 侧拿不到，见计划前提更正）");

    // `.` / `..` 必须已被跳过：件数应当正好是 4（a.bin / tiny.bin / empty.txt / sub）
    assert_eq!(entries.len(), 4, "`.` / `..` 没跳干净");
}

#[test]
fn file_id_is_stable_across_enumerations_and_not_zero() {
    let root = fixture("stable-id");
    let first = read_dir_entries(&root).unwrap();
    let id1 = first.iter().find(|e| e.name == "a.bin").unwrap().file_id;
    assert_ne!(id1, 0, "NTFS 上文件 ID 不该是 0");

    let again = read_dir_entries(&root).unwrap();
    let id2 = again.iter().find(|e| e.name == "a.bin").unwrap().file_id;
    assert_eq!(id1, id2, "同一文件两次枚举必须给同一个 ID —— 去重键靠的就是它");
}

#[test]
fn hard_links_share_a_file_id() {
    let root = fixture("hardlink");
    fs::hard_link(root.join("a.bin"), root.join("a_link.bin")).expect("建硬链接");
    let entries = read_dir_entries(&root).unwrap();
    let a = entries.iter().find(|e| e.name == "a.bin").unwrap();
    let l = entries.iter().find(|e| e.name == "a_link.bin").unwrap();
    assert_eq!(a.file_id, l.file_id, "硬链接必须共享文件 ID —— 这是去重的唯一凭据");
    assert_eq!(a.alloc_size, l.alloc_size);
}

/// 独立口径：另一套完全不同的 API 给出同一份清单。
#[test]
fn agrees_with_std_fs_on_names_sizes_and_dirs() {
    let root = fixture("oracle");
    let mine: BTreeMap<String, (u64, bool)> = read_dir_entries(&root)
        .unwrap()
        .into_iter()
        .map(|e| (e.name, (e.size, e.is_dir)))
        .collect();

    let theirs: BTreeMap<String, (u64, bool)> = fs::read_dir(&root)
        .unwrap()
        .map(|d| {
            let d = d.unwrap();
            let md = d.metadata().unwrap();
            (d.file_name().to_string_lossy().into_owned(), (md.len(), md.is_dir()))
        })
        .collect();

    assert_eq!(mine, theirs, "两套 API 的 (名字, 逻辑大小, 是否目录) 必须逐名相同");
}

/// **多轮缓冲**：一个目录的条目放不进一轮 64 KiB 时，必须靠"不 restart 的第二次调用"接着读。
/// 这条是拿真盘抓出来的：`C:\Windows\WinSxS` 顶层 8 万多个文件，而实现只交回 262 条
/// —— 一轮缓冲的量，且**没有任何错误**（ok 非 0 直接返回了）。
#[test]
fn enumerates_a_directory_that_does_not_fit_in_one_buffer() {
    let root = fixture("many");
    const N: usize = 1500;
    for i in 0..N {
        fs::write(root.join(format!("f{i:04}.dat")), vec![0u8; 8]).unwrap();
    }
    let mine = read_dir_entries(&root).unwrap();
    let theirs = fs::read_dir(&root).unwrap().count();
    assert!(theirs >= N, "独立口径至少要看到 {N} 条，实到 {theirs}");
    assert_eq!(mine.len(), theirs, "两套 API 的条目数必须相同（一轮缓冲放不下 {N} 条）");
}
