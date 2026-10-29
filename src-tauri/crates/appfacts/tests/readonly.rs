//! **只读静态闸**：`crates/appfacts` 的生产片段（`src/*.rs` 里 `#[cfg(test)]` 之前的部分）
//! 结构上不具备「动这台机器」的能力 —— 不写、不删、不建、不改名、不起进程、不读真实环境表。
//!
//! 形状照抄 `crates/devenv/tests/readonly.rs`（那里又照抄 `crates/dupes/tests/readonly.rs`），
//! 但**违禁集不一样**，这一点要说清：
//!
//! - `devenv` 是纯判定层，连 `std::fs::` 与 `env::var` 都在禁列；
//! - `appfacts` 是**探针**，读盘读注册表读进程表正是它存在的理由（计划 §1.3），
//!   禁的是另一件事：**它的结论后面接的是删除**。探针自己动了盘，
//!   「这台机器上现在装着什么」就变成「探针走后剩下什么」。
//! - 「全靠注入」这条也归这里管：`env::var` / `GetEnvironmentVariable*` 在禁列，
//!   于是根清单只能由调用方递进来（`ProbeRoots::from_env_vars` 吃的是**参数里那张表**），
//!   用例才能在一棵 `%TEMP%` 下的假树上穷举而不碰真机。
//!
//! 与那两份一样，本闸**不剥注释**：剥注释等于给真违禁形状开一个藏身处。
//! 代价是 `src/*.rs` 的措辞不许原样拼出这些字面量（要提它们就换一种写法，
//! `lib.rs` 与 `fs_probe.rs` 的模块文档就是这么写的）。
//!
//! ## 反空跑（三条，缺一条这道闸就是装饰）
//!
//! 1. **每个针都要真抓得住自己的反例**（`every_needle_has_teeth`）：只证「至少一个针能抓」的话，
//!    其余针写错了也照样绿 —— 那与「扫不到东西」在输出里长得一样。
//! 2. **扫到的文件数有下限 + 两份生产文件逐个点名**（`production_sources_are_read_only…`）：
//!    枚举落空时下面那句「没抓到」永真。
//! 3. **拿真文件走一遍红**（`the_readonly_gate_itself_goes_red_on_a_planted_violation`，
//!    计划 §3-P2-T1 点名的那条）：把生产片段复制成一份副本、往副本里塞一个
//!    `std::fs::remove_dir_all`，闸必须红；把那行拿掉必须重新绿。
//!    第 1 条只测「针能抓字符串」，这一条测的是**整条扫描链路**（枚举 → 切分 → 判红），
//!    而且顺带钉住「恒红」那一侧：副本没塞东西时必须不红。
//!
//! ## P2-T2 的白名单（**已经生效**，不再是接缝）
//!
//! 注册表（C1/C2）与进程快照（C5）落地时用到的 Win32 名字只在
//! [`P2_T2_READONLY_ALLOWLIST`] 里。它们**不该**被下面任何一根针抓到（由
//! `the_p2_t2_read_api_allowlist_is_not_caught` 当场验一遍）；而进程创建那一族
//! 永远在禁列 —— 「不 spawn 任何进程」是计划 §Global Constraints，不是这一棒的偏好。
//!
//! P2-T2 同时**加**了四根针：这一棒把注册表与进程那两套 API 请进了依赖面，
//! 只禁文件系统写与 spawn 的那套清单就漏了整整一半的新攻击面 ——
//! 写值那一族、删键那一族、建键那一族、终止进程那一族，现在都各有一根针配一个反例。

use std::path::{Path, PathBuf};

/// 违禁形状。**拼出来写**：闸文件自己不算生产代码，但「一个完整字面量都不落在被扫文件里」
/// 这条 posture 要保持（谁哪天把 `tests/` 也扫进来，不会当场误报成自己的针）。
fn needles() -> [&'static str; 16] {
    [
        concat!("File::", "create"),
        concat!("Open", "Options"),
        concat!("cre", "ate_"),
        concat!("remove_", "dir"),
        concat!("remove_", "file"),
        concat!("re", "name("),
        concat!("wr", "ite"),
        concat!("fs::", "copy"),
        concat!("std::pro", "cess::Command"),
        concat!("Create", "Process"),
        concat!("env::", "var"),
        concat!("GetEnv", "ironmentVariable"),
        // P2-T2 新增：注册表那一侧的写/删/建，与进程那一侧的终止。
        concat!("Reg", "SetValue"),
        concat!("Reg", "Delete"),
        concat!("RegCreate", "Key"),
        concat!("Terminate", "Process"),
    ]
}

/// 每个针一个反例，**顺序一比一**。标签是给失败输出看的，不参与判定。
fn canaries() -> [(&'static str, &'static str); 16] {
    [
        (
            "建新文件",
            concat!("fn a() { std::fs::File::", "create(p).unwrap(); }"),
        ),
        (
            "带写模式打开",
            concat!("fn b() { std::fs::", "Open", "Options::new().append(true).open(p); }"),
        ),
        (
            "建目录/建链接",
            concat!("fn c() { std::fs::cre", "ate_dir_all(p).unwrap(); }"),
        ),
        (
            "删目录",
            concat!("fn d() { std::fs::remove_", "dir_all(p).ok(); }"),
        ),
        (
            "删文件",
            concat!("fn e() { std::fs::remove_", "file(p).ok(); }"),
        ),
        (
            "改名/挪位置",
            concat!("fn f() { std::fs::re", "name(from, to).unwrap(); }"),
        ),
        (
            "写内容",
            concat!("fn g() { let _ = f.wr", "ite_all(b\"x\"); }"),
        ),
        (
            "复制文件",
            concat!("fn h() { std::", "fs::copy", "(from, to).unwrap(); }"),
        ),
        (
            "起子进程（含 Get-AppxPackage）",
            concat!("fn i() { std::pro", "cess::Command::new(\"powershell\").output(); }"),
        ),
        (
            "Win32 进程创建",
            concat!("fn j() { unsafe { Create", "ProcessW(n, c, ..) } }"),
        ),
        (
            "读真实环境表",
            concat!("fn k() { let _ = std::env::", "var(\"LOCALAPPDATA\"); }"),
        ),
        (
            "Win32 读环境变量",
            concat!("fn l() { GetEnv", "ironmentVariableW(p, buf, n) }"),
        ),
        (
            "往注册表写值",
            concat!("fn m() { unsafe { Reg", "SetValueExW(h, n, 0, t, v, s) } }"),
        ),
        (
            "删注册表键",
            concat!("fn n() { unsafe { Reg", "DeleteKeyW(h, n) } }"),
        ),
        (
            "建注册表键",
            concat!("fn o() { unsafe { RegCreate", "KeyExW(h, n, 0, 0, sa, k, &mut out) } }"),
        ),
        (
            "终止进程",
            concat!("fn p() { unsafe { Terminate", "Process(h, 0) } }"),
        ),
    ]
}

/// P2-T2 **实际用到**的只读 Win32 名字：注册表只读枚举四件、进程快照三件、
/// 查询用句柄那一族四件。它们必须一根针都抓不住（否则这一棒的通道一落地闸就恒红）。
const P2_T2_READONLY_ALLOWLIST: [&'static str; 15] = [
    "RegOpenKeyExW",
    "RegEnumKeyExW",
    "RegQueryValueExW",
    "RegCloseKey",
    "CreateToolhelp32Snapshot",
    "Process32FirstW",
    "Process32NextW",
    "QueryFullProcessImageNameW",
    concat!("Open", "Process"),
    "CloseHandle",
    "GetLastError",
    "KEY_READ",
    "KEY_WOW64_64KEY",
    "KEY_WOW64_32KEY",
    "PROCESS_QUERY_LIMITED_INFORMATION",
];

fn find_violations(prod: &str, needles: &[&'static str]) -> Vec<&'static str> {
    needles.iter().copied().filter(|n| prod.contains(n)).collect()
}

fn production_slice(src: &str) -> &str {
    match src.find("#[cfg(test)]") {
        Some(i) => &src[..i],
        None => &src[..],
    }
}

/// 目录里每个 `.rs` 的生产片段。（测试夹具要动盘，所以只扫 `#[cfg(test)]` 之前 ——
/// 与 `dupes`/`devenv` 那两份闸同一个口径，切分本身由最后一条用例验。）
fn production_files_in(dir: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).expect("扫描面必须可读") {
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

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// 对一个目录跑整条链路，返回**红了的那些文件**与命中的针。
fn scan(dir: &Path, needles: &[&'static str]) -> Vec<(PathBuf, Vec<&'static str>)> {
    production_files_in(dir)
        .into_iter()
        .filter_map(|(p, prod)| {
            let hits = find_violations(&prod, needles);
            (!hits.is_empty()).then_some((p, hits))
        })
        .collect()
}

#[test]
fn production_sources_are_read_only_and_spawn_nothing() {
    let needles = needles();
    let files = production_files_in(&src_dir());
    // 反空跑②：下限 + 逐个点名。枚举落空时下面那句「没抓到」永真。
    // 下限从 P2-T1 的 2 提到 P2-T2 的 5：这一棒多了 `channel.rs`/`registry.rs`/`procs.rs`，
    // 而**新来的那两份正是唯一允许碰 Win32 的**——扫面少一份，那一份就没人管。
    assert!(
        files.len() >= 5,
        "本 crate 的生产文件至少是 lib.rs + channel.rs + fs_probe.rs + registry.rs + procs.rs 五份，\
         只扫到 {} 个 = 枚举落空",
        files.len()
    );
    let names: Vec<String> = files
        .iter()
        .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    for want in ["lib.rs", "channel.rs", "fs_probe.rs", "registry.rs", "procs.rs"] {
        assert!(names.iter().any(|n| n == want), "闸没扫到 {want}：{names:?}");
    }
    for (path, prod) in &files {
        let hits = find_violations(prod, &needles);
        assert!(
            hits.is_empty(),
            "{} 的生产片段里出现了 {hits:?} —— 这一层只许「看」：探针的结论后面接的是删除，\
             它自己动一次盘，「这台机器上装着什么」就变成「探针走后剩下什么」",
            path.display()
        );
    }
}

#[test]
fn every_needle_has_teeth() {
    // 反空跑①：每个针**各自**抓住一个真违例。
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
    // 反向半边：干净的读盘代码不许被误伤，否则这道闸恒红、把真问题淹在噪声里。
    let clean = concat!(
        "pub fn peek(dir: &std::path::Path) -> std::io::Result<Vec<String>> {\n",
        "    let mut names = Vec::new();\n",
        "    for e in std::fs::read_dir(dir)? { names.push(e?.file_name().to_string_lossy().into_owned()); }\n",
        "    Ok(names)\n}\n",
        "// 只报「装没装着」，不动任何东西\n"
    );
    assert!(find_violations(clean, &needles).is_empty(), "干净片段被误伤");
}

#[test]
fn the_p2_t2_read_api_allowlist_is_not_caught() {
    // 白名单里的名字一个都不许被抓住（P2-T2 一落地就恒红 = 那道闸会被绕过而不是被遵守）；
    // 同一段里只要混进一个 CreateProcess*，针必须立刻转红。
    let needles = needles();
    let snippet = P2_T2_READONLY_ALLOWLIST.join("(") + ")";
    assert!(
        find_violations(&snippet, &needles).is_empty(),
        "只读注册表/进程快照的 API 被禁列误伤了：{:?}",
        find_violations(&snippet, &needles)
    );
    let mixed = snippet + concat!(" Create", "ProcessW(a, b)");
    assert!(
        find_violations(&mixed, &needles)
            .iter()
            .any(|n| *n == concat!("Create", "Process")),
        "白名单扩出去的那一刻（进程创建）必须当场转红"
    );
}

#[test]
fn the_readonly_gate_itself_goes_red_on_a_planted_violation() {
    // 计划 §3-P2-T1 点名的那条：先塞一个 remove_dir_all 进**扫描面**，闸必须红，再拿掉。
    // 与 every_needle_has_teeth 的分工：那条测针，这条测「枚举 → 切分 → 判红」整条链路，
    // 并且把恒红那一侧一起钉住（没塞东西的副本必须不红）。
    let dir = std::env::temp_dir().join(format!(
        "deepclean-appfacts-readonly-plant-pid{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("扫描面副本目录");

    let real = production_files_in(&src_dir());
    assert!(real.len() >= 2, "真源码至少两份，拿到 {} 份 = 扫描面是空的", real.len());
    for (path, prod) in &real {
        std::fs::write(dir.join(path.file_name().unwrap()), prod).expect("复制生产片段");
    }

    let needles = needles();
    // ① 副本先要绿：证明「复制」这一步不造出违例，下面的红只能来自塞进去的那一行。
    assert!(
        scan(&dir, &needles).is_empty(),
        "刚复制出来的副本就是红的：{:?}",
        scan(&dir, &needles)
    );

    // ② 塞违规样例进去（拼出来写，免得这个文件自己带一个完整字面量）。
    //     P2-T2 起**每份生产文件都塞一遍**，不再只塞 `fs_probe.rs`：这一棒新来的
    //     `registry.rs`/`procs.rs` 是唯一允许碰 Win32 的两份，红证明必须逐份拿到，
    //     不然「闸在某个文件上其实根本不响」这件事和绿长得一模一样。
    let planted = concat!(
        "\npub fn oops(p: &std::path::Path) { let _ = std::fs::remove_",
        "dir_all(p); }\n"
    );
    for (path, body) in &real {
        let target = dir.join(path.file_name().unwrap());
        std::fs::write(&target, format!("{body}{planted}")).expect("塞进违规样例");

        let hits = scan(&dir, &needles);
        assert!(!hits.is_empty(), "闸没红 = 它是装饰（在 {} 里塞了 remove_dir_all 都没抓到）", target.display());
        let (file, caught) = &hits[0];
        assert_eq!(
            file.file_name().unwrap().to_string_lossy(),
            path.file_name().unwrap().to_string_lossy(),
            "红的必须是塞了样例的那一份（{}），实际 {hits:?}",
            target.display()
        );
        assert!(
            caught.contains(&concat!("remove_", "dir")),
            "报告要点名到那根针，实际 {caught:?}"
        );

        // ③ 拿掉：同一份扫描面必须重新绿（否则「闸会红」不等于「代码有问题」）。
        std::fs::write(&target, body).expect("拿掉违规样例");
        assert!(
            scan(&dir, &needles).is_empty(),
            "拿掉样例后还红 = 恒红闸（{}）：{:?}",
            target.display(),
            scan(&dir, &needles)
        );
    }

    // ④ 真源码同一条链路跑一遍也是绿的（这条断言的全部意义在上面三步：它能红）。
    assert!(
        scan(&src_dir(), &needles).is_empty(),
        "真源码被自己的闸判红：{:?}",
        scan(&src_dir(), &needles)
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_test_marker_split_actually_splits() {
    // 「剥掉 `#[cfg(test)]` 之后」这一句必须真在做事，否则下一棒会以为测试也可以随便动盘，
    // 而那正是本闸放行动机（夹具要造树）被撑破的开始。
    let fake = concat!(
        "pub fn peek(p: &std::path::Path) -> std::io::Result<usize> { std::fs::read_dir(p).map(|d| d.count()) }\n",
        "#[cfg(test)]\nmod tests {\n    fn fixture() {\n",
        "        let _ = std::fs::remove_",
        "dir_all(\"x\");\n    }\n}\n"
    );
    let prod = production_slice(fake);
    assert!(!prod.contains("mod tests"), "切分没切开：生产片段还留着测试模块");
    assert!(fake.contains(concat!("remove_", "dir")), "反例本身没造出违例形状");
    assert!(
        find_violations(fake, &needles()).contains(&concat!("remove_", "dir")),
        "整份扫必须抓到（说明切分才是它放行的唯一原因）"
    );
    assert!(
        find_violations(prod, &needles()).is_empty(),
        "切完之后应当干净：{:?}",
        find_violations(prod, &needles())
    );
}
