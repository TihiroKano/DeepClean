//! 扫一个根目录，把 `ScanReport` 打成 JSON。M1-C 验收用的跑手。
//!
//! 用法：`cargo run --release --example scan_one -- "C:\" [--out=<路径>] [--mode=walk|mft|auto]`
//! （**只读**；不删任何东西）
//!
//! `--mode=walk`（默认）：目录枚举并行档（与产品同路），原样打 JSON。
//! `--mode=mft`：MFT 直读档，需管理员 + 盘符根 + NTFS；probe 不过就退出。
//! `--mode=auto`：probe 过了就 **同卷双跑对账**（MFT 一趟 + walk 一趟），
//!   把 `mft_counted − walk_counted` 的差额逐项分解；probe 不过就回退 walk。
//!   对账跑手给人看摘要，不落 JSON（`--out` 在此模式下被忽略）。
//!
//! `--out` 是给 M1-T6 提权重扫用的：提权跑起来的是另一个进程，结果只能落盘拿。
//!
//! 为什么是 example 而不是 bin：它不是产品的一部分，只在真盘验收时手动跑一次。
//! 打成 bin 会进 `cargo build` 的默认产物，让"扫描器"这个 crate 看起来有两个入口。

use deepclean_scanner::accounting::SKIP_ALWAYS;
use deepclean_scanner::mft::{probe_mft, scan_volume_mft};
use deepclean_scanner::model::{ScanNode, ScanTree};
use deepclean_scanner::report::ScanReport;
use deepclean_scanner::scan::{ScanControl, ScanOptions};
use deepclean_scanner::scan_parallel::scan_tree_parallel_with;
use deepclean_scanner::volume::volume_of;
use std::path::PathBuf;
use std::time::Instant;

/// (当前工作集, 进程峰值工作集)。峰值跨趟单调 —— 对账两趟都打，第二趟的 peak
/// 是历史峰值不是当趟，看 workingset 才是当趟的量。
fn rss_bytes() -> (u64, u64) {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS::default();
    c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // GetCurrentProcess 返回伪句柄（-1），**不需要也不能** CloseHandle
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    if ok == 0 {
        return (0, 0);
    }
    (c.WorkingSetSize as u64, c.PeakWorkingSetSize as u64)
}

/// 逐文件打印 `name size alloc counted file_id`。M1-C 对账要看每一条，不看总数。
fn dump(n: &ScanNode, indent: &str) {
    for f in &n.files {
        eprintln!(
            "{indent}{} size={} alloc={} counted={} id={}",
            f.name, f.size, f.alloc, f.counted, f.file_id
        );
    }
    for c in &n.children {
        eprintln!("{indent}[{}]", c.name);
        dump(c, &format!("{indent}  "));
    }
}

fn main() {
    let arg = std::env::args().nth(1).unwrap_or_else(|| r"C:\".to_string());
    let root = PathBuf::from(&arg);
    // `--out=<路径>`：给提权重扫用（`src/elevate.rs` 的 `helper_command_line` 一定会带上它）。
    // 不给就是老的跑法：只往 stdout 打，人来看。
    let mut out_path: Option<PathBuf> = None;
    let mut mode = "walk".to_string();
    for a in std::env::args().skip(2) {
        if let Some(p) = a.strip_prefix("--out=") {
            out_path = Some(PathBuf::from(p));
        } else if let Some(m) = a.strip_prefix("--mode=") {
            match m {
                "walk" | "mft" | "auto" => mode = m.to_string(),
                other => {
                    eprintln!("未知 --mode={other}（可选 walk|mft|auto）");
                    std::process::exit(2);
                }
            }
        }
    }

    let volume = match volume_of(&root) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("取卷几何失败：{e}");
            std::process::exit(2);
        }
    };
    eprintln!(
        "[卷] {} 序列号={} 总={} 可用={} 已用={}",
        volume.label,
        volume.serial,
        volume.total_bytes,
        volume.free_bytes,
        volume.used_bytes()
    );

    match mode.as_str() {
        "walk" => walk_mode(&root, &volume, out_path.as_deref()),
        "mft" => mft_mode(&root, &volume, out_path.as_deref()),
        "auto" => auto_mode(&root, &volume, out_path.is_some()),
        _ => unreachable!(),
    }
}

fn opts_for(root: &std::path::Path) -> ScanOptions {
    ScanOptions::new(root)
}

// ---------- walk 档 ----------

fn walk_mode(root: &std::path::Path, volume: &deepclean_scanner::volume::VolumeInfo, out: Option<&std::path::Path>) {
    let started = Instant::now();
    let opts = opts_for(root);
    let control = ScanControl::new();
    match scan_tree_parallel_with(&opts, volume, control, |_| {}) {
        Ok(tree) => {
            print_tree(&tree);
            let (ws, peak) = rss_bytes();
            eprintln!(
                "[时] wall={}ms workingset={}B peak_rss={}B",
                started.elapsed().as_millis(),
                ws,
                peak
            );
            dump_if_requested(&tree);
            print_json(&ScanReport::from_tree(&tree).to_json(), out);
        }
        Err(e) => fail_exit(e, out),
    }
}

// ---------- MFT 档 ----------

fn mft_mode(root: &std::path::Path, volume: &deepclean_scanner::volume::VolumeInfo, out: Option<&std::path::Path>) {
    if let Err(e) = probe_mft(root) {
        eprintln!("[MFT] probe 失败：{e}");
        std::process::exit(4);
    }
    let started = Instant::now();
    let opts = opts_for(root);
    let control = ScanControl::new();
    match scan_volume_mft(&opts, volume.clone(), &control, |_| {}) {
        Ok(tree) => {
            print_tree(&tree);
            print_mft_stats(&tree);
            eprintln!(
                "[时] wall={}ms workingset={}B peak_rss={}B",
                started.elapsed().as_millis(),
                rss_bytes().0,
                rss_bytes().1
            );
            dump_if_requested(&tree);
            print_json(&ScanReport::from_tree(&tree).to_json(), out);
        }
        Err(e) => fail_exit(e, out),
    }
}

// ---------- auto：双跑对账 ----------

fn auto_mode(root: &std::path::Path, volume: &deepclean_scanner::volume::VolumeInfo, out_given: bool) {
    if out_given {
        eprintln!("[对账] --out 在 auto 模式下被忽略（对账摘要给人看，不落盘）");
    }
    match probe_mft(root) {
        Err(e) => {
            eprintln!("[MFT] probe 失败（{e}）→ 回退 walk 单趟");
            walk_mode(root, volume, None);
        }
        Ok(()) => {
            eprintln!("[MFT] probe 通过，双跑对账开始（MFT 先行）");
            let mft_started = Instant::now();
            let opts = opts_for(root);
            let control = ScanControl::new();
            let mft_tree = match scan_volume_mft(&opts, volume.clone(), &control, |_| {}) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[MFT] 扫描失败：{e} → 回退 walk 单趟");
                    walk_mode(root, volume, None);
                    return;
                }
            };
            eprintln!(
                "[MFT] wall={}ms workingset={}B peak_rss={}B",
                mft_started.elapsed().as_millis(),
                rss_bytes().0,
                rss_bytes().1
            );
            print_mft_stats(&mft_tree);

            let walk_started = Instant::now();
            let walk_control = ScanControl::new();
            let walk_tree = match scan_tree_parallel_with(&opts, volume, walk_control, |_| {}) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("walk 档扫描失败：{e}");
                    std::process::exit(3);
                }
            };
            eprintln!(
                "[walk] wall={}ms workingset={}B peak_rss={}B",
                walk_started.elapsed().as_millis(),
                rss_bytes().0,
                rss_bytes().1
            );
            print_tree(&walk_tree);
            reconcile(&mft_tree, &walk_tree);
        }
    }
}

/// 差额分解：`Δ = mft_counted − walk_counted`。
///
/// walk 档看不到 / 主动不看的部分，在 MFT 树里都是真实节点，字节可以直接读出来：
/// `$METADATA`、`$ORPHANS`、ADS、`SKIP_ALWAYS` 名单内容（MFT 档不按名跳 ——
/// `mft/mod.rs` 模块头第 31 条）。剩下的归「残差」：驻留取整（MFT 驻留 alloc=0，
/// walk 按目录项的分配值）、两趟之间的磁盘自身变动、walk 的 ACL 拒绝内容
/// （MFT 档没有 denied，那部分字节只出现在 MFT 侧）。
fn reconcile(mft: &ScanTree, walk: &ScanTree) {
    let mc = mft.counters.bytes_counted;
    let wc = walk.counters.bytes_counted;
    let delta = mc as i128 - wc as i128;

    let meta = child_of(mft, "$METADATA").map(|n| n.size_counted).unwrap_or(0);
    let orphan = child_of(mft, "$ORPHANS").map(|n| n.size_counted).unwrap_or(0);
    let ads = mft.mft.map(|s| s.ads_bytes).unwrap_or(0);
    // 名单内容：walk 按名跳过不计，MFT 档树里就在根下。名字大小写无关地找。
    let mut always = 0u64;
    let mut always_hits: Vec<&str> = Vec::new();
    for name in SKIP_ALWAYS {
        if let Some(n) = child_ci(mft, name) {
            always += n.size_counted;
            always_hits.push(&n.name);
        }
    }

    let explained = meta as i128 + orphan as i128 + ads as i128 + always as i128;
    let residual = delta - explained;
    let pct = if mc > 0 { residual.abs() as f64 / mc as f64 * 100.0 } else { 0.0 };

    eprintln!("[对账] mft_counted={mc} walk_counted={wc} Δ(mft−walk)={delta}");
    eprintln!(
        "  + $METADATA 元文件      {:>16}  ({} 条)",
        meta,
        mft.mft.map(|s| s.meta_records).unwrap_or(0)
    );
    eprintln!(
        "  + $ORPHANS 孤儿         {:>16}  ({} 条)",
        orphan,
        mft.mft.map(|s| s.orphan_records).unwrap_or(0)
    );
    eprintln!("  + ADS 备用流            {:>16}", ads);
    eprintln!(
        "  + 名单跳过内容          {:>16}  ({})",
        always,
        if always_hits.is_empty() { "MFT 树根下未见".to_string() } else { always_hits.join(", ") }
    );
    eprintln!("  = 已解释合计            {:>16}", explained);
    eprintln!(
        "  残差(驻留取整/时点/ACL) {:>16}  (walk.denied={} 条、skipped_reparse={} 条的 MFT 侧字节含在其中)",
        residual, walk.counters.errors.denied, walk.counters.skipped_reparse
    );
    eprintln!(
        "[对账] unaccounted={pct:.3}% (验收线 <1%) —— {}",
        if pct < 1.0 { "通过" } else { "超线，需要解释" }
    );
}

fn child_of<'a>(t: &'a ScanTree, name: &str) -> Option<&'a ScanNode> {
    t.root.children.iter().find(|c| c.name == name)
}

fn child_ci<'a>(t: &'a ScanTree, name: &str) -> Option<&'a ScanNode> {
    let lower = name.to_ascii_lowercase();
    t.root.children.iter().find(|c| c.name.to_ascii_lowercase() == lower)
}

// ---------- 公共打印 ----------

fn print_tree(tree: &ScanTree) {
    let r = ScanReport::from_tree(tree);
    eprintln!(
        "[扫] {}ms  files={} dirs={} 占用合计={} 分配之和={} 表观之和={} 去重={} 跳过(链接)={} 跳过(名单)={} 错误 d/m/b/o={}/{}/{}/{} 样本溢出={}",
        r.elapsed_ms,
        r.files,
        r.dirs,
        r.bytes_counted,
        r.bytes_alloc,
        r.bytes_logical,
        r.deduped_hardlinks,
        r.skipped_reparse,
        r.skipped_always,
        r.denied,
        r.missing,
        r.busy,
        r.other_errors,
        tree.skipped_sample_overflowed
    );
    eprintln!(
        "[账] 卷已用={} 占用合计={} 未计入={} 自洽={}",
        r.volume_used_bytes, r.bytes_counted, r.unaccounted_bytes, r.accounting_ok
    );
}

fn print_mft_stats(tree: &ScanTree) {
    let Some(s) = tree.mft else { return };
    eprintln!(
        "[MFT] 记录 总/闲/删/损={}/{}/*/{} 元={} 孤儿={} 扩展丢={} ADS {} 条 {}B",
        s.records_total,
        s.records_free,
        s.records_corrupt,
        s.meta_records,
        s.orphan_records,
        s.extension_missed,
        s.ads_streams,
        s.ads_bytes
    );
}

fn dump_if_requested(tree: &ScanTree) {
    if std::env::var("DC_DUMP_FILES").is_ok() {
        dump(&tree.root, "");
    }
    if std::env::var("DC_DUMP_SKIPPED").is_ok() {
        for it in &tree.skipped_sample {
            eprintln!("[跳过] {:?} {}", it.reason, it.path);
        }
        eprintln!("[跳过] 共 {} 条样本，溢出={}", tree.skipped_sample.len(), tree.skipped_sample_overflowed);
    }
    if std::env::var("DC_TOP_LEVEL").is_ok() {
        let mut kids: Vec<_> = tree.root.children.iter().collect();
        kids.sort_by(|a, b| b.size_counted.cmp(&a.size_counted));
        for c in kids.iter().take(20) {
            eprintln!(
                "[顶层] {:<28} 占用={:>14} 文件={:>8} 目录={:>7} 拒={}",
                c.name,
                c.size_counted,
                c.file_count,
                c.dir_count,
                c.errors.denied + c.errors.other_errors()
            );
        }
    }
}

fn print_json(body: &str, out: Option<&std::path::Path>) {
    println!("{body}");
    if let Some(out) = out {
        // 提权那一跑是**另一个进程**，stdout 回不去，只能落盘。
        // 先写 `.tmp` 再 `rename`：轮询方看到目标文件时，它必然是完整的那一份
        // （直接写目标文件会让轮询读到半截 JSON —— 那是最难查的一格）。
        write_json(out, body);
    }
}

fn fail_exit(e: impl std::fmt::Display, out: Option<&std::path::Path>) {
    let msg = e.to_string();
    eprintln!("扫描失败：{msg}");
    // 失败也要把 out 落下去，否则等结果的轮询方会一直等一个不会出现的文件。
    //
    // **必须走 serde_json 转义**，不许 `format!("{{\"error\":\"{e}\"}}")`：
    // 这些错误信息里带着 Windows 路径（`C:\Documents and Settings`、`C:\Program Files`），
    // 裸拼进字符串就是非法 JSON（`\D` 不是合法转义），轮询方 `JSON.parse` 当场炸。
    // 受影响的正是 `--out` 那条路 —— 提权重扫时结果只能落盘拿，而"根目录打不开"
    // 恰恰是它最可能遇到的失败。
    if let Some(out) = out {
        let body = serde_json::json!({ "error": msg }).to_string();
        write_json(out, &body);
    }
    std::process::exit(3);
}

fn write_json(out: &std::path::Path, body: &str) {
    let tmp = out.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, out);
}
