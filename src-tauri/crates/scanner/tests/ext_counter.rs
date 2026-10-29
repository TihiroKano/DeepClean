//! §3.6「这棵树上躺着几个模型权重」那一格的**唯一数据源**：遍历途中的扩展名累加。
//!
//! 基准是 `core/scan/tree-store.ts` 的 `countExts` / `extTotals()`（`:290-312, 380-398`）。
//! 这一格之所以值得单独一个文件，是因为它错起来**不报错**：漏计在界面上长得和
//! 「这台机器上一个 `.gguf` 都没有」一模一样，而那正是本项目全程在躲的虚报形状的反面 —— 少报。
//!
//! 夹具只落 `D:\deepclean-fixture\`（项目纪律：绝不写 C:），每个用例一个独立目录。

use deepclean_scanner::model::ext_of;
use deepclean_scanner::scan::{normalize_count_exts, ScanOptions};
use deepclean_scanner::volume::volume_of;
use std::fs;
use std::path::PathBuf;

/// 五份权重 + 三份不相干：`model.gguf`(1000) / `upper.GGUF`(2000) / `w.safetensors`(3000)
/// / `note.txt` / `.gguf`（**点就是首字符**，那不是扩展名）/ `archive.tar.gz`（多重点取最后一段）。
fn fixture(tag: &str) -> PathBuf {
    let root = PathBuf::from(format!(r"D:\deepclean-fixture\m5d-ext\{tag}"));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("model.gguf"), vec![0u8; 1000]).unwrap();
    fs::write(root.join("upper.GGUF"), vec![0u8; 2000]).unwrap();
    fs::write(root.join("w.safetensors"), vec![0u8; 3000]).unwrap();
    fs::write(root.join("note.txt"), vec![0u8; 7]).unwrap();
    fs::write(root.join(".gguf"), vec![0u8; 4242]).unwrap();
    fs::write(root.join("archive.tar.gz"), vec![0u8; 8]).unwrap();
    fs::write(root.join("sub").join("deep.pt"), vec![0u8; 11]).unwrap();
    root
}

fn run(root: &PathBuf, opts: ScanOptions) -> deepclean_scanner::model::Counters {
    let volume = volume_of(root).unwrap();
    deepclean_scanner::scan::scan_tree(&opts, &volume, |_| {})
        .expect("夹具应当扫得动")
        .counters
}

#[test]
fn counts_only_the_injected_extensions_and_sums_logical_bytes() {
    let root = fixture("basic");
    let c = run(
        &root,
        ScanOptions::new(&root).with_count_exts(&[".gguf", ".safetensors"]),
    );
    // 1000 + 2000（大写那一份也算，归一在小写这一侧）+ 3000
    assert_eq!(c.ext_count, 3, "三条权重");
    assert_eq!(c.ext_bytes, 6000, "字节口径是**表观**大小，不是分配大小");
    // 对照：分配口径在这里明显更大（4096 簇上每个文件至少占一簇），所以这两个数不是一回事
    assert_ne!(c.ext_bytes, 3 * 4096, "若相等说明这条判据退化成按簇猜");

    // `.gguf`（点打头）与 `archive.tar.gz` 都不该进这一格：前者的"扩展名"是整张文件名
    assert_eq!(c.files, 7, "件数轴不受注入影响");
}

#[test]
fn the_counter_runs_before_the_truncation_gate() {
    // 这是本文件存在的理由。`max_files_per_dir = 1` 时 `node.files` 只留 1 条，
    // 而累加必须在**截断闸之前**（TS 与 `directFileCount` 同一侧）：少了的那几个 G
    // 一旦不算，界面上就是一句「这台机器上没有」。
    let root = fixture("truncated");
    let volume = volume_of(&root).unwrap();
    let mut opts = ScanOptions::new(&root).with_count_exts(&[".gguf", ".safetensors", ".pt"]);
    opts.max_files_per_dir = 1;
    let tree = deepclean_scanner::scan::scan_tree(&opts, &volume, |_| {}).unwrap();
    let c = tree.counters;
    assert_eq!(c.ext_count, 4, "3 份注入命中 + 子目录那份 .pt，一律要数到");
    assert_eq!(c.ext_bytes, 1000 + 2000 + 3000 + 11);
    // 这一句证明这个夹具真的走过了那道闸；闸没生效时上面那条断言什么都没验
    assert!(tree.root.files_truncated, "夹具没触发截断 ⇒ 这条判据失去对象");
    assert_eq!(tree.root.files.len(), 1, "截断闸本身还在位（清单只留 1 条）");
    assert_eq!(c.files, 7, "件数轴照旧全量");
}

#[test]
fn an_unnormalized_list_would_count_zero_forever() {
    // 「没点的键不会报错，只会永远数出 0」—— 归一是判据不是礼貌，所以这里**故意**传两种脏写法，
    // 要求归一之后仍然数得出同一条命中。
    let root = fixture("normalize");
    let c = run(&root, ScanOptions::new(&root).with_count_exts(&["GGUF", ".SafeTensors"]));
    assert_eq!(c.ext_count, 3, "传 `GGUF`（没点、大写）与传 `.gguf` 必须同果");
    assert_eq!(c.ext_bytes, 6000);

    // 归一函数的形状单独钉一条：补点、小写、去重
    let set = normalize_count_exts(["gguf", ".GGUF", "safetensors"].iter().copied());
    assert_eq!(set.len(), 2, "归一后 `gguf` 与 `.GGUF` 是同一个键");
    assert!(set.contains(".gguf") && set.contains(".safetensors"));
}

#[test]
fn no_injection_is_zero_but_a_request_is_a_measurement() {
    // 没注入 ⇒ 恒 {0,0}；「没要过」那句话由调用方带着 `count_exts` 存不存在来回答，不住在这一层。
    let root = fixture("none");
    let c = run(&root, ScanOptions::new(&root));
    assert_eq!((c.ext_count, c.ext_bytes), (0, 0));
    // 空清单 = 没注入（TS 的 `countExts: []` 同形），不许变成一个"什么都数"的集合
    let c2 = run(&root, ScanOptions::new(&root).with_count_exts(&[]));
    assert_eq!((c2.ext_count, c2.ext_bytes), (0, 0));
}

#[test]
fn ext_of_matches_the_pathutil_rule_it_ports() {
    // 基准 `core/fs/pathutil.ts:38-42`：先取父名，再取最后一个点起的串；`i <= 0` → 空。
    assert_eq!(ext_of("model.gguf"), ".gguf");
    assert_eq!(ext_of("MODEL.GGUF"), ".gguf", "小写化");
    assert_eq!(ext_of("archive.tar.gz"), ".gz", "多个点取最后一段");
    assert_eq!(ext_of("README"), "", "没点");
    assert_eq!(ext_of(".gitignore"), "", "点就是首字符 → 那是文件名不是扩展名");
    assert_eq!(ext_of("model."), ".", "尾点：TS 同样交出 \".\"");
    assert_eq!(ext_of(""), "");
}
