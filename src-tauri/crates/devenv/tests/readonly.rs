//! **只读静态闸**：本 crate 的生产代码（`src/*.rs` 里 `#[cfg(test)]` 之前的部分）
//! 结构上进不了「摸机器」这条路 —— 不起进程、不碰文件系统、不读环境表。
//!
//! 这一条是派工单 §1 的硬边界：判定层必须是**纯判定层**，否则「全绿」的含义会从
//! 「每一条判据都验过」退化成「**这台**机器上装的东西恰好让每一条判据都绿」。
//! 形状照抄 `crates/dupes/tests/readonly.rs`（目录枚举而不是点名清单，免得新加一个文件就漏一个洞）。
//!
//! 与那份一样，本闸**不剥注释**：剥注释等于给真违禁形状开一个藏身处。
//! 代价是 `src/*.rs` 的措辞不许原样拼出这些字面量（要提它们就换一种写法），
//! `src/lib.rs` 里那句闸的说明就是这么改写的。
//!
//! ## 反空跑（两条，缺一条这道闸就是装饰）
//! 1. **每个针都要真抓得住自己的反例**（`every_needle_has_teeth`）：只证明「至少一个针能抓」
//!    的话，另外四个针写错了也照样绿 —— 那与「扫不到东西」在输出里长得一样。
//! 2. **扫到的文件数有下限 + 四个模块逐个点名**（`production_sources_never_touch_the_machine`）：
//!    枚举落空时下面那句「没抓到」永真。

use std::path::Path;

/// 违禁形状。拼出来写：闸文件自己不算生产代码，但「一个完整字面量都不落在被扫文件里」
/// 这条 posture 要保持（谁哪天把 `tests/` 也扫进来，不会当场误报成自己的针）。
fn needles() -> [&'static str; 5] {
    [
        concat!("std::pro", "cess::Command"),
        concat!("std::", "fs::"),
        concat!("env:", ":va", "r"),
        concat!("whi", "ch"),
        concat!("GetEnv", "ironmentVariable"),
    ]
}

/// 一个反例：形状出现在**生产片段**里。每个针配一条，且必须被**自己**那一根抓到。
fn canaries() -> [(&'static str, &'static str); 5] {
    [
        (
            "起进程查命令",
            concat!("fn a() { std::pro", "cess::Command::new(\"npm\").output(); }"),
        ),
        (
            "读目录",
            concat!("fn b() { let _ = std::", "fs::read_dir(r#\"C:\\Users\"#) }"),
        ),
        (
            "读环境变量",
            concat!("fn c() { let _ = std::env:", ":var(\"USERPROFILE\"); }"),
        ),
        (
            "外部 which 工具",
            "fn d() { run_external(\"which\", [\"npm\"]) }",
        ),
        (
            "Win32 环境表",
            concat!("fn e() { GetEnv", "ironmentVariableW(p) }"),
        ),
    ]
}

/// 剥掉 `#[cfg(test)]` 之后的生产片段里逐针查找。返回命中的（文件, 针）。
fn find_violations(prod: &str, needles: &[&'static str]) -> Vec<&'static str> {
    needles.iter().copied().filter(|n| prod.contains(n)).collect()
}

fn production_slice(src: &str) -> &str {
    match src.find("#[cfg(test)]") {
        Some(i) => &src[..i],
        None => &src[..],
    }
}

fn production_files() -> Vec<(std::path::PathBuf, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("src/ 必须可读") {
        let p = entry.unwrap().path();
        if p.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let src = std::fs::read_to_string(&p).unwrap();
        out.push((p, production_slice(&src).to_string()));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn production_sources_never_touch_the_machine() {
    let needles = needles();
    let files = production_files();
    // 反空跑②：下限。本 crate 的生产文件是 lib + detectors + view + model_files 四份。
    assert!(
        files.len() >= 4,
        "枚举落空 = 下面那句「没抓到」永真（只扫到 {} 个文件）",
        files.len()
    );
    for (path, prod) in &files {
        let hits = find_violations(prod, &needles);
        assert!(
            hits.is_empty(),
            "{} 的生产片段里出现了 {hits:?} —— 判定层只吃注入的事实，\
             真机探测住在壳层（D2）：掺进一次真 stat，「全绿」就退化成「这台机器上全绿」",
            path.display()
        );
    }
    // 反空跑②的另一半：扫到的确实是本 crate 那四份，不是空的目录
    let names: Vec<String> = files
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    for want in ["lib.rs", "detectors.rs", "view.rs", "model_files.rs"] {
        assert!(names.iter().any(|n| n == want), "闸没扫到 {want}：{names:?}");
    }
}

#[test]
fn every_needle_has_teeth() {
    // 反空跑①：**每个针各自**抓住一个真违例。只证「有一个针能用」的话，
    // 写错的那四个会与「扫不到东西」在输出里长得一样。
    let needles = needles();
    assert_eq!(
        needles.len(),
        canaries().len(),
        "针与反例必须一比一（加针不加反例 = 那根针没人验过）"
    );
    for (idx, (label, canary)) in canaries().iter().enumerate() {
        let hits = find_violations(canary, &needles);
        assert!(
            hits.contains(&needles[idx]),
            "第 {idx} 根针 {:?}（管着「{label}」）抓不住自己的反例：{canary} —— 这根针是空的",
            needles[idx],
        );
    }
    // 反向半边：干净的代码不许命中任何针，否则这道闸会恒红（并把真问题淹在噪声里）
    let clean = concat!("pub fn pure(x: u64) -> u64 { x.saturating_add(1) }", "\n", "// 只报关系，不改账");
    assert!(find_violations(clean, &needles).is_empty(), "干净片段被误伤");
}

#[test]
fn the_test_marker_split_actually_splits() {
    // 「剥掉 `#[cfg(test)]` 之后」这一句必须真在做事：拿一份「测试片段里有违例、生产片段没有」的
    // 假源码验证两侧不同，否则这个切分是装饰（而装饰会让下一棒以为测试可以随便起进程）。
    let fake = concat!(
        "pub fn pure() -> u64 { 1 }\n",
        "#[cfg(test)]\nmod tests {\n    fn t() { let _ = std::",
        "fs::read_dir(\"x\"); }\n}\n"
    );
    let prod = production_slice(fake);
    assert!(!prod.contains("mod tests"), "切分没切开：生产片段还留着测试模块");
    assert!(fake.contains(concat!("std::", "fs::")), "反例本身没造出违例形状");
    assert!(
        find_violations(fake, &needles()).contains(&concat!("std::", "fs::")),
        "整份扫必须抓到（说明切分才是唯一让它放行的原因）"
    );
    assert!(find_violations(prod, &needles()).is_empty(), "切完之后应当干净");
}
