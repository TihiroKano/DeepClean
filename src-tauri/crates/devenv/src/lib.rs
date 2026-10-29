//! `deepclean-devenv` —— 「开发环境识别」的**纯判定层**（M5-D 的第一棒）。
//!
//! 行为基准（逐字照抄语义，优化过的那份不算基准）：
//! - `core/rules/detectors.ts` → [`detectors`]
//! - `core/rules/devenv-view.ts` → [`view`]
//! - `core/analyze/model-files.ts` → [`model_files`]
//! - 线格式：`shared/types.ts` 的 `DevEnvViewWire` / `DevEnvRowWire` / `DevEnvGroupWire` /
//!   `ModelTallyWire` / `TerritoryFact`（字段名逐字对齐，serde `camelCase`），因为
//!   `src/renderer/pages/DevEnv.tsx` 那份 React 代码**不改**。
//!
//! ## 这一层零文件、零进程、零环境读取
//!
//! 判定只吃**注入的事实**：某个命令能不能跑、某个 `%VAR%` 模板目录在不在、那份 `docker system df`
//! 的原文、这张树上看到了哪几块地盘。真机探测（`where npm`、目录存在性、起进程）住在壳层 ——
//! Electron 是 `electron/services/detect-env.ts`，Tauri 是 D2 那一棒。
//!
//! 这条边界不是风格：它决定了「全绿」这个词的意思。掺进一次真 `stat`，全绿就变成
//! 「**这台**机器上全绿」，换一个操作员装了什么就换一个结论（V0.7 给 `--shot` 补
//! `--shot-detectors` 那个参数，钉的正是同一件事）。所以本 crate 的每条判据都能在
//! **不碰磁盘**的前提下穷举验证，并由 `tests/readonly.rs` 那道只读静态闸守着。
//! 闸的违禁形状是：进程创建、`std` 的文件系统模块、环境变量读取、Unix 那条「找命令」的外部
//! 工具、Win32 读环境变量的那个 API。
//! （闸**不剥注释**，所以这一句刻意不拼出那些字面量本身 —— 引入一个注释剥离器等于给真违禁形状
//! 开一个藏身处，代价换不起。）
//!
//! ## 三态不许塌成两态（产品口径）
//!
//! 「装了 / 不知道 / 没装」是三个答案，界面对应五句措辞，**顺序是钉住的**
//! （理由全在 `docs/acceptance/2026-10-07-v0.7-devenv.md` 未完 #4）：
//!
//! ```text
//! 「未检测到该工具」 > 「不确定装没装」 > 「这棵树上没有它的地盘」 > 「这次没量到」 > 数字
//! ```
//!
//! 措辞住在界面，**每一格的区分度住在这一层**：
//! - `InstallState` 三格；`install_status` 的「不知道」住在**键的缺席**里（`get() == None`），
//!   与 `deepclean_rules::engine` 的 `detector_status` 同一套读法；
//! - `display_bytes: Option<u64>` —— `None`（没量过）与 `Some(0)`（量到 0）是两句话；
//! - `territory_missing: bool` 是第三种 0（这块地盘不在这棵被扫的树上）；
//! - `DevEnvResidual.bytes: Option<u64>` —— 「目录看到了、字节没量过」不退成 0；
//! - `DockerDiskUsage.reclaimable_bytes: Option<u64>` —— 量不到不许印成 `0 B`；
//! - `ModelFilesCell` 三格（不问 / 没扫过 / 有读数）。
//!
//! 塌成一态就是让「没量过」冒充「没有」。
//!
//! ## 与 TS 的已知分叉（三条，都不是「顺手优化」，各自点名）
//!
//! 1. **`whole()` 对小数**：TS 原样放行（`2.5 → 2.5`），本层线形状是 `u64` ⇒ 截断成 `2`。
//!    真实扫描层只会交出整数条数与整数字节；夹具不喂小数。由
//!    `model_files::tests::whole_guards_bad_numbers` 显式钉住这一支。
//! 2. **超范围的数进不到这一层**：JS 的 `JSON.parse('1e400')` 给出 `Infinity`，TS 的 `whole()`
//!    把它挡成 `0`；Rust 侧 `serde_json` 对同一个字面量直接报 `number out of range`，整份 JSON
//!    读不进来（由 `model_files::tests::out_of_range_json_does_not_even_reach_the_guard` 钉住）。
//!    同一个原因落在 df 输出上：本层走「不是合法 JSON」那一格，TS 走「读不成字节」那一格 ——
//!    **结论同为「量不到」，只有 detail 串分叉**。有限但大到装不进 `u64` 的读数（如 `1e308`）
//!    同理：TS 原样交出，本层交不出。方向上是**少说**，不是虚报；夹具两侧都不喂这种数。
//! 3. **`ScanStatus` 在这里有一份自己的枚举**：`shared/types.ts` 那一族六个字面量在 Rust 侧
//!    原先只住在 `src-tauri/src/service.rs`（壳层，本棒不许动），crates 之间没有可复用的那一份。
//!    D2 接线时从壳层的状态映射过来即可（六个字面量逐字同）。

pub mod detectors;
pub mod model_files;
pub mod view;

pub use detectors::{
    collect_install_status, collect_install_status_default, detector_for_rule, dev_env_detectors,
    dev_env_detectors_with_docker, read_docker_disk_usage, Detector, DetectorProbe, DockerCliOutcome,
    DockerDiskUsage, DockerUsageCategory, DockerVerdict, Judgment, DOCKER_DETECTOR,
};
pub use model_files::{
    base_name, ext_of, model_tally_from, tally_model_files, tally_model_files_default, ExtTotals,
    ModelTally, ModelTallyEnv, ScanStatus, MODEL_FILE_EXTENSIONS,
};
pub use view::{
    build_dev_env_view, group_include_ids, group_label, group_of_rule, row_has_delete_control,
    DevEnvGroup, DevEnvGroupId, DevEnvResidual, DevEnvRow, DevEnvRowAction, DevEnvView,
    DevEnvViewInput, InstallState, ModelFilesCell, RuleOccupancy, GROUP_ORDER,
};

pub fn name() -> &'static str {
    "deepclean-devenv"
}
