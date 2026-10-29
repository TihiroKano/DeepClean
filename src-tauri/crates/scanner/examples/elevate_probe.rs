//! M1-T6 的真机跑手：**会弹一次 UAC**，需要人工点"是"。
//!
//! 用法（两个参数都必须给，缺一个就大声失败，不许静默跳过）：
//!   cargo run --release -p deepclean-scanner --example elevate_probe -- \
//!     "<要扫的根>" "<scan_one.exe 的绝对路径>"
//!
//! 它做的事就四步，每一步都打印自己那一格的事实：
//!   1. 以**当前（非提权）**身份扫一趟，记下 `files` / `denied`；
//!   2. 问 `should_offer_elevation` 该不该提权（不该提权就直接停 —— 那才是这一格的判据在说话）；
//!   3. 用 `runas` 起助手（就是这里弹 UAC），把结果落到一个临时 JSON；
//!   4. 读回来对比：**提权后应当扫到更多文件、被拒更少**。少了哪一半都不算过。
//!
//! 为什么结果只能落盘拿：提权跑起来的是另一个进程，它的 stdout 回不到这个非提权进程里。
//! 为什么判据是"更多文件 + 更少被拒"而不是"跑成功了"：一次什么都没多扫到的提权
//! 完全可以"成功"（UAC 点了是、助手跑了、报告照样是那份），那种成功什么也没证明。

use deepclean_scanner::elevate::{helper_command_line, launch_elevated, should_offer_elevation};
use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::volume::volume_of;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let (Some(root_s), Some(helper_s)) = (argv.first(), argv.get(1)) else {
        eprintln!("用法：elevate_probe \"<要扫的根>\" \"<scan_one.exe 路径>\"");
        std::process::exit(2);
    };
    let root = PathBuf::from(root_s);
    let helper = PathBuf::from(helper_s);
    assert!(root.is_dir(), "要扫的根不在：{root:?}");
    assert!(helper.exists(), "助手不在盘上：{helper:?}（先 cargo build --release --example scan_one）");

    let volume = volume_of(&root).expect("取卷几何");
    let t = Instant::now();
    let plain = scan_tree(&ScanOptions::new(&root), &volume, |_| {}).expect("非提权那一趟不该失败");
    println!(
        "PROBE 1 非提权：files={} dirs={} denied={} 用时={}ms",
        plain.counters.files,
        plain.counters.dirs,
        plain.counters.errors.denied,
        t.elapsed().as_millis()
    );

    if !should_offer_elevation(&plain.counters) {
        println!("PROBE 2 判据说这一轮不需要提权（一条都没被拒）—— 这一格到此为止，不算失败也不算通过");
        return;
    }
    println!("PROBE 2 判据：denied > 0 ⇒ 该提权重扫（现在会弹 UAC，请点\"是\"）");

    let out = std::env::temp_dir().join(format!("deepclean-elevate-probe-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let args = helper_command_line(&root, &out);
    println!("PROBE 3 助手参数串：{args}");
    if let Err(e) = launch_elevated(&helper, &args) {
        println!("PROBE 3 启动失败：{e}");
        std::process::exit(4);
    }

    let deadline = Instant::now() + Duration::from_secs(600);
    while Instant::now() < deadline {
        if out.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let text = match std::fs::read_to_string(&out) {
        Ok(t) => t,
        Err(e) => {
            println!("PROBE 4 10 分钟内没拿到助手的结果文件（{out:?}：{e}）—— 提权被拒？助手还在跑？");
            std::process::exit(5);
        }
    };
    let v: serde_json::Value = serde_json::from_str(&text).expect("助手写的必须是合法 JSON");
    if let Some(err) = v.get("error") {
        println!("PROBE 4 助手那一趟失败了：{err}");
        std::process::exit(6);
    }
    let (ef, ed, eden) = (
        v["files"].as_u64().unwrap_or(u64::MAX),
        v["dirs"].as_u64().unwrap_or(u64::MAX),
        v["denied"].as_u64().unwrap_or(u64::MAX),
    );
    println!(
        "PROBE 4 提权：files={ef} dirs={ed} denied={eden}（非提权是 files={} denied={}）",
        plain.counters.files, plain.counters.errors.denied
    );
    let more = ef > plain.counters.files;
    let fewer = eden < plain.counters.errors.denied;
    println!(
        "PROBE 结论：{}{} ⇒ {}",
        if more { "多扫到文件 " } else { "没多扫到文件 " },
        if fewer { "且被拒变少" } else { "但被拒没变少" },
        if more && fewer { "提权真的看见了之前看不见的东西" } else { "这一格没成立" }
    );
    let _ = std::fs::remove_file(&out);
    if !(more && fewer) {
        std::process::exit(7);
    }
}
