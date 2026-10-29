//! M1-T3 的真机验收：三条硬规则在真实 NTFS 上成立。
//!
//! 夹具只落 `D:\deepclean-fixture\`。每个用例一个独立目录（Cargo 并行跑测试）。

use deepclean_scanner::model::SkipReason;
use deepclean_scanner::scan::{scan_tree, ScanFailure, ScanOptions};
use deepclean_scanner::volume::{volume_of, VolumeInfo};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// root/
///   unique.bin   5000 B
///   hardA.bin    3000 B
///   hardB.bin    hardA.bin 的硬链接（同 inode）
///   vac/vac.bin  7 B
///   link         junction -> vac（重解析点，不许进入）
fn fixture(tag: &str) -> PathBuf {
    let root = PathBuf::from(format!(r"D:\deepclean-fixture\m1-rules\{tag}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("vac")).unwrap();
    fs::write(root.join("unique.bin"), vec![0u8; 5000]).unwrap();
    fs::write(root.join("hardA.bin"), vec![1u8; 3000]).unwrap();
    fs::hard_link(root.join("hardA.bin"), root.join("hardB.bin")).unwrap();
    fs::write(root.join("vac").join("vac.bin"), vec![2u8; 7]).unwrap();

    let out = Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root.join("link"))
        .arg(root.join("vac"))
        .output()
        .expect("跑 mklink");
    assert!(
        out.status.success(),
        "建 junction 失败（夹具前提不成立，不许静默跳过）：{}",
        String::from_utf8_lossy(&out.stdout)
    );
    root
}

fn scan(root: &Path) -> deepclean_scanner::model::ScanTree {
    let volume = volume_of(root).expect("夹具所在卷应当可读");
    scan_tree(&ScanOptions::new(root), &volume, |_| {}).expect("扫描应当成功")
}

#[test]
fn the_three_hard_rules_hold_on_real_ntfs() {
    let root = fixture("rules");
    let t = scan(&root);
    let c = &t.counters;

    assert_eq!(c.files, 4, "unique + hardA + hardB + vac/vac.bin");
    assert_eq!(c.dirs, 1, "vac 是唯一的真目录；junction 被跳过，不算目录");
    assert_eq!(c.deduped_hardlinks, 1, "hardB 是第二条硬链接");
    assert_eq!(c.skipped_reparse, 1, "junction 必须被跳过并且**报数**");
    assert_eq!(c.skipped_always, 0);

    // 两条独立累加路径必须相等（counters 与根节点的合计）
    assert_eq!(c.bytes_counted, t.root.size_counted);
    assert_eq!(c.bytes_alloc, t.root.size_alloc);
    assert_eq!(c.bytes_logical, t.root.size_logical);
    assert_eq!(c.files, t.root.file_count);
    assert_eq!(c.dirs, t.root.dir_count);

    // 硬链接只算一次：占用合计必须**小于**分配大小之和，差值正是被去重的那一份。
    // 精确的"那一份是多少"由下一条测试（删掉 hardB 后对比）给出，这里不硬编码簇大小。
    assert!(c.bytes_counted < c.bytes_alloc, "去重没生效才会相等");
    assert_eq!(t.root.children.len(), 1, "只有 vac 一个子目录节点（junction 不进树）");
    assert_eq!(t.root.children[0].files.len(), 1);

    // 抽样清单里必须点名那条 junction，且理由正确
    let j = t
        .skipped_sample
        .iter()
        .find(|s| s.path.ends_with("link"))
        .expect("被跳过的东西必须能在样本里点名到");
    assert_eq!(j.reason, SkipReason::Reparse);
    assert!(!t.skipped_sample_overflowed);
}

/// **去重语义的本质检验**：删掉第二条硬链接，占用合计**一个字节都不该变**，
/// 而表观/分配之和应当掉掉那一份。
///
/// 这条比任何数值断言都硬 —— 它直接编码了 V0.6 那个教训（"删掉 N−1 条硬链接
/// 一个字节都不释放"），而且**不依赖任何硬编码的簇大小**。
#[test]
fn deleting_the_second_hard_link_changes_nothing_counted() {
    let root = fixture("dedupe-proof");
    let before = scan(&root);
    fs::remove_file(root.join("hardB.bin")).unwrap();
    let after = scan(&root);

    assert_eq!(
        before.counters.bytes_counted, after.counters.bytes_counted,
        "去掉一条硬链接不释放任何空间，占用合计必须不变"
    );
    assert!(
        before.counters.bytes_alloc > after.counters.bytes_alloc,
        "表观/分配之和必须掉掉那一份 —— 否则说明去重根本没发生、两个数是一回事"
    );
    assert_eq!(before.counters.files, after.counters.files + 1);
}

/// junction 指向的目录**不许被走两遍**：去掉 junction 之后，文件数应当不变。
#[test]
fn the_junction_target_is_not_walked_a_second_time() {
    let root = fixture("junction-proof");
    let with = scan(&root);
    fs::remove_dir(root.join("link")).unwrap(); // 只删 junction 本身，target 还在
    let without = scan(&root);

    assert_eq!(with.counters.files, without.counters.files, "junction 走了两遍才会多出文件");
    assert_eq!(with.counters.bytes_counted, without.counters.bytes_counted);
    assert_eq!(without.counters.skipped_reparse, 0);
}

/// 哨兵：占用合计超过卷已用 0.5% 就整轮判失败。
/// **用一个捏出来的小卷**触发 —— 这正是"80G 扫出 90G"那一族的机器可判信号。
#[test]
fn impossible_accounting_is_a_hard_failure() {
    let root = fixture("sentinel");
    let tiny = VolumeInfo {
        serial: 1,
        label: "tiny".into(),
        total_bytes: 1000,
        free_bytes: 900, // used = 100，而夹具至少要几千字节
    };
    match scan_tree(&ScanOptions::new(&root), &tiny, |_| {}) {
        Err(ScanFailure::ImpossibleAccounting { counted, used }) => {
            assert!(counted > used);
            assert_eq!(used, 100);
        }
        other => panic!("必须判 ImpossibleAccounting，实得 {other:?}"),
    }
}

/// 报告层的恒等式：未计入 = 卷已用 − 占用合计（**减法本身**，不是某个魔数）。
#[test]
fn report_identity_holds_on_a_real_scan() {
    let root = fixture("report");
    let t = scan(&root);
    let r = deepclean_scanner::ScanReport::from_tree(&t);
    assert_eq!(
        r.unaccounted_bytes,
        r.volume_used_bytes as i64 - r.bytes_counted as i64
    );
    assert!(r.accounting_ok);
    // 夹具只有几十 KB，整卷已用以 GB 计 —— 未计入必然是正的一大块
    assert!(r.unaccounted_bytes > 0);
    let round: deepclean_scanner::ScanReport = serde_json::from_str(&r.to_json()).unwrap();
    assert_eq!(round, r);
}
