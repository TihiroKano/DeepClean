//! P2-T2 的**跨语言对账**（计划 §3-P2-T2 第四条判据）：同一份夹具
//! （`tests/data/reference-shapes.json`），Rust 的 `deepclean-appfacts` 与 TS 的
//! `core/facts/appfacts.ts` 各跑一遍，比的是**同一张表**。
//!
//! 三条各自的分工：
//! - `the_ts_and_rust_tables_agree_on_the_same_fixture`（本文件）：Rust 侧逐格比夹具的 `expect`，
//!   并把算出来的表投影进 `tests/data/reference-shapes.rust-table.json`。TS 侧
//!   （`tests/unit/appfacts.test.ts`）拿同一份夹具跑自己的实现，**既比 `expect` 也比这份投影** ——
//!   于是「两侧同意」不是两句各自的话，是同一张表被真比了一遍。
//! - 投影文件是**产物**：改了判据而不重生成，npm 侧就会红（漂移探测器，不是归档）。
//!   重生成的命令写在下面 `regen_hint` 里，与 `crates/devenv/tests/parity_devenv_ts.mjs` 同一条 posture。
//! - `the_projection_is_committed_and_matches_this_run`：本用例**不现起 node**（快、不依赖网络），
//!   代价就是上一条：golden 会静默过期，所以它自己也要跟入库那份比一次。
//!
//! 归一化一格都没有：`expect` 与投影都只装三档档位。`why` 是中文措辞，两侧各写一份，
//! 把它钉进等式判据得到的只会是一条天天红的闸（计划 §4.3 同一条口径）。

mod common;

use deepclean_appfacts::{self, AppFact};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn projection_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("data")
        .join("reference-shapes.rust-table.json")
}

const REGEN_HINT: &str = "重生成：APPFACTS_REGEN=1 cargo test -p deepclean-appfacts --test parity_ts";

/// 把 Rust 算出来的表投影成入库那份 JSON（手写格式化，两侧的读法都不依赖 serde derive）。
fn render(projection: &[(String, BTreeMap<String, &'static str>)]) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str("  \"_generatedBy\": \"cargo test -p deepclean-appfacts --test parity_ts (APPFACTS_REGEN=1)\",\n");
    out.push_str("  \"_note\": \"Rust 侧在 tests/data/reference-shapes.json 上算出的表投影。TS 侧 tests/unit/appfacts.test.ts 拿同一份夹具跑 core/facts/appfacts.ts，逐格比这份文件 + 比夹具里的 expect。改判据不重生成 = npm 侧红，这是刻意的漂移探测。\",\n");
    out.push_str("  \"cases\": [\n");
    for (i, (name, table)) in projection.iter().enumerate() {
        out.push_str("    { \"name\": \"");
        out.push_str(name);
        out.push_str("\", \"table\": {");
        for (j, (key, state)) in table.iter().enumerate() {
            if j > 0 {
                out.push_str(", ");
            }
            out.push_str(&format!("\"{key}\": \"{state}\""));
        }
        out.push_str("} }");
        if i + 1 < projection.len() {
            out.push_str(",\n");
        } else {
            out.push_str("\n");
        }
    }
    out.push_str("  ]\n}\n");
    out
}

fn fact_state(f: &AppFact) -> &'static str {
    common::project(f)
}

#[test]
fn the_ts_and_rust_tables_agree_on_the_same_fixture() {
    let fixture = common::load();
    let cases = common::cases(&fixture);
    assert!(!cases.is_empty(), "夹具是空的 —— 那「两侧同意」是拿零条用例达成的");

    let mut projection: Vec<(String, BTreeMap<String, &'static str>)> = Vec::new();
    for c in &cases {
        let m = common::Machine::new(c);
        // ① Rust 的表 == 夹具声明的期望（TS 侧拿同一份期望再断一遍）。
        let table = m.projection();
        m.check();
        // ② 每一格都要有档位（三态不许塌成两态：缺档 = 这条判据没跑到）。
        for (key, state) in &table {
            assert!(
                matches!(*state, "present" | "absent" | "unknown"),
                "case「{}」的「{key}」交出了一个不在三档里的档位：{state:?}",
                m.name
            );
            // 第二次实算单独存下来：出错时要能点名是哪一路通道弃的权（工作树全量跑时
            // 观察过一次瞬时抖动：present→unknown，而原消息只给两个档位，查不出是谁）。
            let again = m.collect_table()[key].clone();
            assert_eq!(
                *state,
                fact_state(&again),
                "投影与实算对不上（case「{}」的「{key}」）：第一次 {state}，第二次 {again:?} —— \
                 同一份输入两次结果不同，最可能是某条通道对刚建好的夹具树拿到了瞬时错误\
                 （共享占用 / 杀软扫描）。弃权原话：{}",
                m.name,
                again.why().unwrap_or("(这一档不带理由)"),
            );
        }
        projection.push((m.name.clone(), table));
    }

    // 三个 §0.2 反例 + §4.4 那条，在对账里也必须各自点名（夹具被改瘦小时这里要红）。
    for want in [
        "claude-msix",
        "kazumi-running",
        "urban-no-evidence",
        "d-drive-name-mismatch",
        "acme-residual",
    ] {
        assert!(
            projection.iter().any(|(n, _)| n == want),
            "夹具里没有 case「{want}」—— 反例/刀锋形状退出了对账面"
        );
    }
    let by_name = |n: &str| -> BTreeMap<String, &'static str> {
        projection
            .iter()
            .find(|(k, _)| k == n)
            .unwrap_or_else(|| panic!("没有 case「{n}」"))
            .1
            .clone()
    };
    assert_eq!(by_name("claude-msix")["claude"], "present");
    assert_eq!(by_name("kazumi-running")["kazumi"], "present");
    assert_eq!(by_name("urban-no-evidence")["urban-friendship-story"], "unknown");
    assert_eq!(by_name("d-drive-name-mismatch")["urban-friendship-story"], "present");
    assert_eq!(by_name("acme-residual")["acme-tool"], "absent");

    let rendered = render(&projection);
    let path = projection_path();
    let regen = std::env::var("APPFACTS_REGEN").unwrap_or_default();
    if regen == "1" {
        std::fs::write(&path, &rendered).expect("投影文件写不出去");
        eprintln!("已重生成投影：{}", path.display());
        return;
    }
    let committed = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("入库的投影读不出来 {}：{e}\n{REGEN_HINT}", path.display()));
    let a: Value = serde_json::from_str(&committed).expect("入库的投影不是合法 JSON");
    let b: Value = serde_json::from_str(&rendered).expect("本次生成的投影不是合法 JSON");
    assert_eq!(
        a, b,
        "Rust 这次算出来的表与入库那份投影**不一致** —— 要么判据改了没重生成，要么 TS 侧那半边\
         正比着一份过期的 golden。{REGEN_HINT}\n入库：{committed}\n本次：{rendered}"
    );
}

#[test]
fn the_projection_covers_every_channel_at_least_once() {
    // 反空跑：投影里三档都要出现，而且 `absent` 至少一格 —— 否则「两侧同意」可以是
    // 「两侧都只会弃权」达成的，那种 agreeing 一点价值都没有。
    let fixture = common::load();
    let mut seen: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut absent_cases: Vec<String> = Vec::new();
    for c in common::cases(&fixture) {
        let m = common::Machine::new(c);
        for (key, fact) in m.collect_table() {
            *seen.entry(fact_state(&fact)).or_insert(0) += 1;
            if matches!(fact, AppFact::Absent) {
                absent_cases.push(format!("{}/{}", m.name, key));
            }
        }
    }
    for want in ["present", "absent", "unknown"] {
        assert!(
            seen.get(want).copied().unwrap_or(0) > 0,
            "夹具跑出来一格里「{want}」都没有 —— 那一档的判据没被对账过：{seen:?}"
        );
    }
    assert!(!absent_cases.is_empty(), "整份夹具跑不出一个 absent：Absent 又变成到不了的了");
}

#[test]
fn the_fixture_does_not_double_as_a_real_machine_probe() {
    // 「全靠注入」这条边界的对账面版本：夹具的 `expect` 里不许出现只有真机才有的东西 ——
    // 所有路径都必须是虚拟路径段（`C:/Users/x/…`），任何一条 case 的 key 都不该长得像
    // %TEMP% 下的真目录名。这一条测的是**夹具本身**没被写成一次真机快照。
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("data")
            .join(common::FIXTURE),
    )
    .expect("夹具可读");
    let fixture: Value = serde_json::from_str(&raw).expect("夹具是合法 JSON");
    for banned in ["AppData\\\\Local\\\\Temp", "deepclean-appfacts-", "楠楠", "C:\\\\Users\\\\"] {
        assert!(
            !raw.contains(banned),
            "夹具里出现了「{banned}」—— 那是把真机路径当夹具，全绿就退化成「这台机器上全绿」"
        );
    }
    // 而 Rust 侧搬树用的那段代码确实跑在 %TEMP% 下（这条断言测的是「假机器是搭出来的，
    // 不是读出来的」）：夹具的根是虚拟路径，搬完之后每一根都落在临时目录下。
    let first = common::cases(&fixture)
        .into_iter()
        .next()
        .expect("夹具至少一条 case");
    let m = common::Machine::new(first);
    assert!(
        m.tmp.starts_with(std::env::temp_dir()),
        "假机器没搭在临时目录下，那它读的就是这台真机：{}",
        m.tmp.display()
    );
    for r in &m.input.roots.install_roots {
        assert!(
            r.path.starts_with(&m.tmp),
            "安装根没被搬到假机器里（这条用例就在读真机）：{}",
            r.path.display()
        );
    }
    assert!(
        !m.input.registry.uninstall.is_empty(),
        "注册表那一格是空的 —— 空快照在判据里是「没看成」，这条对账就没测到 C1"
    );
}
