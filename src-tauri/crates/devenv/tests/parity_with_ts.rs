//! 与 TS 的**零容差对账**（派工单 §4-C）：同一份夹具
//! （`tests/data/d1-parity.json`），TS 的 `core/rules/devenv-view.ts` + `detectors.ts` +
//! `core/analyze/model-files.ts` 与本 crate 各跑一遍，**逐字段**比。
//!
//! 期望值由 `tests/parity_devenv_ts.mjs` 生成（命令写在该文件头上），落在
//! `tests/data/d1-parity.expected.json`。本测试**不现起 node** —— 快、不依赖网络与 esbuild；
//! 代价是 golden 会静默过期：**跑本测试之前先重生成并与入库那份 `cmp`**，
//! 不同就说明比的是「旧 TS」。
//!
//! 归一化**一格都没有**：判定层零 IO、零失败路径，两侧唯一的差异来源就是判据本身
//! （与 M5-B 那份对账同一 posture，但这里连 `errno` 那类需要抹平的东西都不存在）。
//!
//! 第二、三条测试是**夹具质量闸**（纪律 §5）：
//! - `the_fixture_actually_exercises_every_state` —— 三态、两种 0、残留的 `None`/`Some(0)`/`Some(n)`、
//!   Docker 四格、模型的下界与坏数，每一样都必须**至少被一个 case 真的跑到**。
//!   否则「18 case 全等」里可能有一半是同一格在原地打转。
//! - `the_wire_shape_round_trips` —— 证明新加的 `Deserialize` 没把 `Serialize` 的形状带歪
//!   （`pruneCommand` / `modelFiles` 那种「缺键 vs null」的三格尤其容易在一次 derive 之后变成两格）。

use deepclean_devenv::{
    base_name, build_dev_env_view, collect_install_status, detector_for_rule, dev_env_detectors,
    dev_env_detectors_with_docker, ext_of, model_tally_from, read_docker_disk_usage,
    Detector, DetectorProbe, DevEnvView, DevEnvViewInput, DockerCliOutcome, DockerVerdict,
    ExtTotals, ModelTally, ModelTallyEnv, RuleOccupancy,
};
use deepclean_rules::builtin_rules;
use deepclean_rules::engine::TerritoryFact;
use deepclean_rules::types::{Rule, RuleCategory};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    #[serde(default)]
    detectors_table: Option<String>,
    probe: ProbeSpec,
    #[serde(default)]
    install_status_omit: Vec<String>,
    #[serde(default)]
    install_status_force: BTreeMap<String, bool>,
    #[serde(default)]
    bytes_by_rule: BTreeMap<String, RuleOccupancy>,
    #[serde(default)]
    territories: Vec<TerritoryFact>,
    #[serde(default)]
    model_tally_input: Option<TallyInput>,
    #[serde(default)]
    scanned_root: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeSpec {
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    dirs: Vec<String>,
    /// `None`（夹具里写 `null`）= 探针**没有** Docker 只读查询能力面
    #[serde(default)]
    docker: Option<DockerCliOutcome>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TallyInput {
    totals: ExtTotals,
    env: ModelTallyEnv,
}

fn data_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("data").join(name)
}

fn load_fixture() -> Fixture {
    let text = std::fs::read_to_string(data_path("d1-parity.json")).expect(
        "夹具必须在 tests/data/（不许叫 fixtures/ —— 那被 .gitignore 静默吞掉，「没跑」与「通过」长得一样）",
    );
    serde_json::from_str(&text).expect("夹具 JSON 必须可解析")
}

/* ------------------------------------------------------------------ *
 * 假探针（与 .mjs 的 makeProbe 同形：同序、同折叠口径、同记账）
 * ------------------------------------------------------------------ */

struct ScriptedProbe {
    commands: BTreeSet<String>,
    dirs: BTreeSet<String>,
    docker: Option<DockerCliOutcome>,
    asked_commands: RefCell<Vec<String>>,
    asked_dirs: RefCell<Vec<String>>,
}

impl ScriptedProbe {
    fn new(spec: &ProbeSpec) -> Self {
        ScriptedProbe {
            commands: spec.commands.iter().cloned().collect(),
            dirs: spec.dirs.iter().map(|d| d.to_lowercase()).collect(),
            docker: spec.docker.clone(),
            asked_commands: RefCell::new(Vec::new()),
            asked_dirs: RefCell::new(Vec::new()),
        }
    }
}

impl DetectorProbe for ScriptedProbe {
    fn command_available(&self, command: &str) -> bool {
        self.asked_commands.borrow_mut().push(command.to_string());
        self.commands.contains(command)
    }
    fn path_exists(&self, path_template: &str) -> bool {
        // 记账记**原样**的模板（证明这一层没改写它），比较才折叠大小写（Windows 口径住在探针）
        self.asked_dirs.borrow_mut().push(path_template.to_string());
        self.dirs.contains(&path_template.to_lowercase())
    }
    fn query_docker_disk_usage(&self) -> Option<DockerCliOutcome> {
        self.docker.clone()
    }
}

/* ------------------------------------------------------------------ *
 * 投影（与 parity_devenv_ts.mjs 的 PROJECTED / project 逐字段对应）
 * ------------------------------------------------------------------ */

fn v<T: serde::Serialize>(x: &T) -> Value {
    serde_json::to_value(x).unwrap()
}

fn run_case(c: &Case) -> (Vec<String>, Vec<String>, BTreeMap<String, bool>, deepclean_devenv::DockerDiskUsage, bool, Option<ModelTally>, DevEnvView) {
    let probe = ScriptedProbe::new(&c.probe);
    let with_docker = c.detectors_table.as_deref() == Some("withDocker");
    let table: &[Detector] = if with_docker { dev_env_detectors_with_docker() } else { dev_env_detectors() };

    let mut install_status = collect_install_status(&probe, table);
    for k in &c.install_status_omit {
        install_status.remove(k);
    }
    for (k, val) in &c.install_status_force {
        install_status.insert(k.clone(), *val);
    }

    let docker_usage = read_docker_disk_usage(&probe);
    let docker_installed = deepclean_devenv::DOCKER_DETECTOR.is_installed(&probe);

    let model_tally = c
        .model_tally_input
        .as_ref()
        .map(|t| model_tally_from(&t.totals, &t.env));

    let rules = builtin_rules();
    // 塑形 2 的 Rust 半边：夹具 probe.docker 为 null（没有那一格能力面）= 壳层这次没查过 → None
    let docker_for_view = if c.probe.docker.is_none() { None } else { Some(docker_usage.clone()) };
    let input = DevEnvViewInput {
        rules: &rules,
        install_status: install_status.clone(),
        docker: docker_for_view,
        bytes_by_rule: c.bytes_by_rule.clone(),
        model_files: model_tally.clone(),
        territories: &c.territories,
        scanned_root: c.scanned_root.clone(),
    };
    let view = build_dev_env_view(&input);
    let asked_commands = probe.asked_commands.borrow().clone();
    let asked_dirs = probe.asked_dirs.borrow().clone();
    (
        asked_commands,
        asked_dirs,
        install_status,
        docker_usage,
        docker_installed,
        model_tally,
        view,
    )
}

fn detector_by_rule(table: &[Detector]) -> BTreeMap<String, Option<String>> {
    let mut ids: Vec<String> = builtin_rules()
        .iter()
        .filter(|r| r.category == RuleCategory::DevCache)
        .map(|r| r.id.clone())
        .collect();
    ids.push("windows-temp".to_string());
    ids.push("docker".to_string());
    ids.into_iter()
        .map(|id| {
            let found = detector_for_rule(&id, table).map(|d| d.id.to_string());
            (id, found)
        })
        .collect()
}

fn project_case(c: &Case) -> Value {
    let (asked_commands, asked_dirs, install_status, docker_usage, docker_installed, model_tally, view) =
        run_case(c);
    let table: &[Detector] = if c.detectors_table.as_deref() == Some("withDocker") {
        dev_env_detectors_with_docker()
    } else {
        dev_env_detectors()
    };
    json!({
        "name": c.name,
        "installStatus": v(&install_status),
        "dockerUsage": v(&docker_usage),
        "dockerInstalled": docker_installed,
        "askedCommands": asked_commands,
        "askedDirs": asked_dirs,
        "detectorByRule": v(&detector_by_rule(table)),
        "modelTally": v(&model_tally),
        "view": v(&view),
    })
}

/* ------------------------------------------------------------------ *
 * §4-C 零容差对账
 * ------------------------------------------------------------------ */

#[test]
fn with_ts_zero_tolerance_over_the_fixture() {
    let fixture = load_fixture();
    let expected_text = std::fs::read_to_string(data_path("d1-parity.expected.json"))
        .expect("缺 TS 侧期望值 —— 按 tests/parity_devenv_ts.mjs 头的两条命令重新生成（不许静默跳过）");
    let expected: Value = serde_json::from_str(&expected_text).unwrap();

    let actual: Vec<Value> = fixture.cases.iter().map(project_case).collect();
    let exp = expected["cases"].as_array().expect("golden 必须有 cases 数组");
    assert_eq!(actual.len(), exp.len(), "case 数不一致（夹具改了没重生成 golden？）");
    for (a, e) in actual.iter().zip(exp.iter()) {
        assert_eq!(
            a,
            e,
            "case {} 与 TS 不一致\nRust: {}\nTS  : {}",
            a["name"],
            serde_json::to_string_pretty(a).unwrap(),
            serde_json::to_string_pretty(e).unwrap()
        );
    }
}

/* ------------------------------------------------------------------ *
 * 夹具质量闸：每一格都得真有 case 跑到（反空跑）
 * ------------------------------------------------------------------ */

fn rows(view: &Value) -> Vec<Value> {
    view["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| g["rows"].as_array().unwrap().iter().cloned())
        .collect()
}

#[test]
fn the_fixture_actually_exercises_every_state() {
    let fixture = load_fixture();
    assert!(
        fixture.cases.len() >= 12,
        "夹具退化到 {} 个 case，覆盖面不可能还成立",
        fixture.cases.len()
    );
    let mut names = BTreeSet::new();
    let projections: Vec<Value> = fixture
        .cases
        .iter()
        .map(|c| {
            assert!(names.insert(c.name.clone()), "case 名字重复：{}", c.name);
            project_case(c)
        })
        .collect();

    let all_rows: Vec<Value> = projections.iter().flat_map(|p| rows(&p["view"])).collect();
    let count_state = |s: &str| {
        all_rows
            .iter()
            .filter(|r| r["installState"].as_str() == Some(s))
            .count()
    };
    // ①③④ 三态各自都要有行：任何一格缺席，「三态没塌」这句话就没被验过
    assert!(count_state("installed") >= 3, "installed 只有 {} 行", count_state("installed"));
    assert!(count_state("not-installed") >= 3, "not-installed 只有 {} 行", count_state("not-installed"));
    assert!(count_state("unknown") >= 3, "unknown 只有 {} 行（「不知道」那一格没被跑到）", count_state("unknown"));

    // 「unknown 不许出数字」：所有 unknown 行的 displayBytes 必须是 null
    for r in all_rows.iter().filter(|r| r["installState"] == "unknown") {
        assert!(r["displayBytes"].is_null(), "unknown 行端出了数字：{}", r["ruleId"]);
    }
    for r in all_rows.iter().filter(|r| r["installState"] == "not-installed") {
        assert!(r["displayBytes"].is_null(), "未装的行端出了数字：{}", r["ruleId"]);
    }

    // 两种 0：真量到 0（displayBytes = 0）与「这块地不在树上」（territoryMissing）都得出现
    let real_zero = all_rows
        .iter()
        .filter(|r| r["installState"] == "installed" && r["displayBytes"] == json!(0))
        .count();
    assert!(real_zero >= 1, "「量过且真是 0」那一格一次都没出现");
    let missing = all_rows
        .iter()
        .filter(|r| r["territoryMissing"] == true)
        .count();
    assert!(missing >= 1, "「这棵树上没有它的地盘」那一格一次都没出现");

    // 残留的三种字节形状：Some(n) / Some(0 但界面不报) / None（没量过）都要有
    let residuals: Vec<&Value> = all_rows.iter().filter(|r| !r["residual"].is_null()).collect();
    assert!(
        residuals
            .iter()
            .any(|r| r["residual"]["bytes"].as_u64().map(|b| b > 0).unwrap_or(false)),
        "残留没有一个真数（⑤ 的正面半边空了）"
    );
    assert!(
        residuals.iter().any(|r| r["residual"]["bytes"].is_null()),
        "残留没有一次是「目录看到了、字节没量过」（⑤ 的 null 半边空了）"
    );
    assert!(
        residuals.iter().any(|r| r["residual"]["bytes"] == json!(0)),
        "残留没有一次是 0 字节（那支由界面挡掉的用例就没数据可钉）"
    );
    // 一条地盘都没看到的残留**必须**什么都不报
    let gradle_missing = all_rows
        .iter()
        .find(|r| r["ruleId"] == "gradle-cache" && r["territoryMissing"] == true)
        .expect("夹具必须有一格「地盘整块不在树上」");
    assert!(gradle_missing["residual"].is_null(), "missing 那一格不该同时报残留");

    // Docker 四格：measured / absent / unmeasurable（含 cli-missing + where 反证）/ 没能力面
    let verdicts: Vec<&str> = projections
        .iter()
        .filter_map(|p| p["dockerUsage"]["verdict"].as_str())
        .collect();
    for want in ["measured", "absent", "unmeasurable"] {
        assert!(verdicts.contains(&want), "Docker 的 {want} 那一格没被跑到");
    }
    assert!(
        projections
            .iter()
            .any(|p| p["dockerUsage"]["detail"]
                .as_str()
                .unwrap_or("")
                .contains("没有 Docker 只读查询能力面")),
        "「探针没这能力面」那一格没被跑到（问不出 ≠ 没装，这条最容易被漏）"
    );
    assert!(
        projections.iter().any(|p| p["dockerUsage"]["verdict"] == "absent" && p["dockerInstalled"] == false),
        "absent 必须让 is_installed 写 false（引擎那条轴只认这个）"
    );
    assert!(
        projections
            .iter()
            .any(|p| p["dockerUsage"]["verdict"] == "unmeasurable" && p["dockerInstalled"] == true),
        "unmeasurable 被当成了未安装"
    );
    // 「量不到」与「没装」都不许塌成 0 字节
    for p in &projections {
        if p["dockerUsage"]["verdict"] != "measured" {
            assert!(p["dockerUsage"]["reclaimableBytes"].is_null(), "非 measured 的一格给出了字节：{}", p["name"]);
        }
    }

    // 模型计数：坏数挡住的那一支、下界（running + truncated）那一支都要有
    let tallies: Vec<&Value> = projections.iter().map(|p| &p["modelTally"]).filter(|t| !t.is_null()).collect();
    assert!(
        tallies.iter().any(|t| t["scanStatus"] == "running" && t["truncated"] == true),
        "没跑完的那一趟（下界）一次都没测"
    );
    assert!(
        tallies.iter().any(|t| t["count"] == json!(0) && t["bytes"] == json!(0)),
        "坏数挡下来那一支一次都没测（夹具喂的 -3 / 1e400 没落到 0？）"
    );
    // 计数住在分组上，不住在行上
    for p in &projections {
        for r in rows(&p["view"]) {
            assert!(r.get("modelFiles").is_none(), "行上长出了模型计数：{}", p["name"]);
        }
        for g in p["view"]["groups"].as_array().unwrap() {
            let id = g["id"].as_str().unwrap();
            if id == "ai" {
                assert!(g.get("modelFiles").is_some(), "AI 分组缺 modelFiles：{}", p["name"]);
            } else {
                assert!(g.get("modelFiles").is_none(), "{id} 分组不该问模型计数：{}", p["name"]);
            }
        }
    }

    // 两级取或的**目录那一半**必须真被走到（否则「只看 PATH」的实现照样全绿）：
    // 找得出一个 case —— 它一个命令都没给，却仍然有探测器被判成已装（只能是靠目录那一半）。
    let dirs_only_hit = fixture.cases.iter().zip(projections.iter()).any(|(c, p)| {
        c.probe.commands.is_empty()
            && p["installStatus"]
                .as_object()
                .unwrap()
                .values()
                .any(|v| v == &json!(true))
    });
    assert!(dirs_only_hit, "没有一个 case 是「命令一个都没给、只靠目录判成已装」（IDE 内置 gradle 那一支）");

    // 大小写不同的同一路径必须真出现在 ask 日志里（证明模板原样递出去、折叠只住在探针）
    let asked = projections
        .iter()
        .flat_map(|p| p["askedDirs"].as_array().unwrap().iter().filter_map(|d| d.as_str().map(|s| s.to_string())))
        .collect::<Vec<String>>();
    assert!(
        asked.iter().any(|a| a.chars().any(|c| c.is_uppercase()) && a.starts_with('%')),
        "ask 日志里没有 %VAR% 模板原样串：{asked:?}"
    );
    let fixture_dirs: Vec<String> = fixture
        .cases
        .iter()
        .flat_map(|c| c.probe.dirs.clone())
        .collect();
    assert!(
        fixture_dirs.iter().any(|d| *d != d.to_uppercase() && d.to_lowercase() != *d),
        "夹具的 dirs 里没有大小写混合的模板（那条折叠半边没测到）"
    );

    // extOf / baseName 这两份口径两侧同源的那一面：拿夹具里的中文与混合大小写路径点一遍
    assert_eq!(ext_of(r"C:\Users\楠楠想睡觉了\.cache\huggingface\hub\X.GGUF"), ".gguf");
    assert_eq!(base_name(r"C:\Users\楠楠想睡觉了\AppData\Local\pip\Cache"), "Cache");
}

#[test]
fn the_wire_shape_round_trips() {
    // 证明新加的 `Deserialize` derive 没把 `Serialize` 的形状带歪：
    // TS 侧那份投影（golden）读进来 → 类型化 → 再序列化出去，必须与 golden 逐字段相同。
    // 「缺键」与「null」的差别（pruneCommand / modelFiles）是这里最容易被 derive 掉的一格。
    let expected_text = std::fs::read_to_string(data_path("d1-parity.expected.json")).unwrap();
    let expected: Value = serde_json::from_str(&expected_text).unwrap();
    let cases = expected["cases"].as_array().unwrap();
    let mut ai_cells_seen = 0usize;
    let mut prune_seen = 0usize;
    for c in cases {
        let view: DevEnvView = serde_json::from_value(c["view"].clone()).unwrap_or_else(|e| {
            panic!("case {} 的视图读不回本类型（线形状漂了）：{e}", c["name"]);
        });
        let back = serde_json::to_value(&view).unwrap();
        assert_eq!(back, c["view"], "case {} 过一遍线形状就变了", c["name"]);
        for g in &view.groups {
            if g.id == deepclean_devenv::DevEnvGroupId::Ai {
                ai_cells_seen += 1;
            }
        }
        for r in c["view"]["groups"].as_array().unwrap().iter().flat_map(|g| g["rows"].as_array().unwrap().iter()) {
            if r.get("pruneCommand").is_some() {
                prune_seen += 1;
                assert_eq!(r["ruleId"].as_str(), Some("docker"), "非 Docker 行带了 pruneCommand");
            }
        }
    }
    assert!(ai_cells_seen >= 18, "每个 case 都该有一个 AI 分组（实到 {ai_cells_seen}）");
    assert!(prune_seen >= 18, "每个 case 都该有一行 Docker（实到 {prune_seen}）");
}

#[test]
fn the_projection_field_lists_agree_with_the_harness() {
    // 两侧字段清单必须同一份（.mjs 的 PROJECTED 少一格/多一格，这里就该红）
    let fixture = load_fixture();
    let p = project_case(&fixture.cases[0]);
    let keys: Vec<String> = p.as_object().unwrap().keys().cloned().collect();
    let want = [
        "name",
        "installStatus",
        "dockerUsage",
        "dockerInstalled",
        "askedCommands",
        "askedDirs",
        "detectorByRule",
        "modelTally",
        "view",
    ];
    // serde_json::Map 按键升序，PROJECTED 的顺序不参与比较，只比集合
    let mut a = keys.clone();
    a.sort();
    let mut b: Vec<String> = want.iter().map(|s| s.to_string()).collect();
    b.sort();
    assert_eq!(a, b, "投影的字段集合与 .mjs 的 PROJECTED 不同");

    // 反空跑：投影里那一格「detectorByRule」必须既有非 null 也有 null（否则反查判据是空跑）
    let dbr = p["detectorByRule"].as_object().unwrap();
    assert!(dbr.values().any(|v| !v.is_null()), "反查一次都没命中");
    assert!(dbr.values().any(|v| v.is_null()), "反查一次都没落空（null 那一支没测）");
    assert_eq!(dbr["docker"], json!(null), "Docker 不把关任何规则");
    assert_eq!(dbr["npm-cache"], json!("npm"));
    assert_eq!(dbr["windows-temp"], json!(null));
}

#[test]
fn a_row_missing_a_group_mapping_panics_instead_of_vanishing() {
    // 与 TS 的 `throw` 同形：这里靠**造一条没归组的规则**来验，不靠读源码
    let mut rule: Rule = builtin_rules()
        .into_iter()
        .find(|r| r.category == RuleCategory::DevCache)
        .unwrap()
        .clone();
    rule.id = "brand-new-cache".to_string();
    let r = rule.clone();
    let input = DevEnvViewInput::new(std::slice::from_ref(&r));
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_dev_env_view(&input)));
    assert!(out.is_err(), "漏了归组必须当场抛，不许静默少一行");
}

#[test]
fn the_docker_verdict_never_reaches_the_engine_axis_as_false() {
    // 把夹具里每一个 docker 结局都过一遍：只有 absent 才允许 is_installed = false
    let fixture = load_fixture();
    for c in &fixture.cases {
        let probe = ScriptedProbe::new(&c.probe);
        let u = read_docker_disk_usage(&probe);
        let installed = deepclean_devenv::DOCKER_DETECTOR.is_installed(&probe);
        if u.verdict == DockerVerdict::Absent {
            assert!(!installed, "{}: absent 必须写 false", c.name);
        } else {
            assert!(installed, "{}: 非 absent 被写成了未安装", c.name);
        }
    }
}

#[test]
fn the_builtin_dev_cache_table_and_the_detector_table_close_each_other() {
    // 双向闭合（拿真返回值比）：规则写的 id 全在表里，表里把关的规则也全在规则里
    let declared: BTreeSet<String> = builtin_rules()
        .iter()
        .filter_map(|r| r.requires_detector.clone())
        .collect();
    let guarded: BTreeSet<String> = dev_env_detectors()
        .iter()
        .map(|d| d.id.to_string())
        .collect();
    assert_eq!(declared, guarded, "探测器表与内置表的把关关系分叉了");
}
