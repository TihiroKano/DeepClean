//! §3.6 AI 那一行要的「检测到 N 个大模型文件（共 X GB）」—— TS `core/analyze/model-files.ts`
//! 的逐字对应移植。
//!
//! 这个模块只做两件纯事：**口径清单**，以及**把数配上它的出身**。
//!
//! 「数本身不在这里数」这条在 Tauri 侧同样成立：真正的累加住在扫描途中
//! （Electron 是 `TreeStore.addFilesToDir` 的 `countExts`），理由是 V0.7 的一条实测而不是感觉：
//! 备选方案「点开页面时现扫一遍内存树」在同一棵 **30 万文件 / 3 万目录**的树上要 **0.72–1.49 秒**，
//! 而这趟跑在主进程上。顺带累加的代价落在噪声里（2.44–2.66 s 对 2.69–2.74 s）。
//! 本 crate 因此提供的是**同一个口径的纯聚合函数** [`tally_model_files`]：给它一串
//! `(名字, 字节)`，它按同一份扩展名清单数一遍 —— 判定层不碰磁盘，也不认识「扫描」这个概念。
//!
//! ### 为什么计数不是从榜里数出来的
//!
//! `topHeap` 容量 100，从榜里数出来的「个数」在一个装了 400 个权重的目录里会稳定念 100。
//! 所以 [`tally_model_files`] 逐条累加、与任何榜单无关，且累加发生在任何截断闸**之前**
//! （`directFileCount` 同一侧）—— 少了几个 G 的模型没被数，在界面上会伪装成「这台机器上没有」。
//!
//! ### 口径：按扩展名，且刻意不含 `.bin`
//!
//! `.bin` 不是模型专属 —— `data.bin`、各类安装包、numpy 缓存都叫这个名，把它算进来，
//! 那一格的「共 X GB」就变成一堆不相干字节的合订本，而那正是本项目全程在躲的虚报形状。
//! **代价是少报**：早期 HF 检查点惯用的 `pytorch_model.bin` 不进这一格。
//! 宁可少报并把口径点名给用户（`extensions` 字段就是为这句话存在的），不可虚报。
//!
//! ### 扩展名判据不在这里重写
//!
//! 大小写归一、多重扩展名取最后一段，全部沿用 [`ext_of`]（TS 侧是 `core/fs/pathutil` 的 `extOf`）——
//! 也就是与 §3 文件类型统计表、`topHeap` 同一户口径。这里再造一份「最后一个点」等于让两张表
//! 对「什么是 .gguf」各说一套，而它们会同屏出现。

use serde::{Deserialize, Serialize};

/// 哪些扩展名算「大模型文件」。带点小写、不重复 —— 三条各由用例钉着，因为 [`ext_of`] 的产物就是
/// 小写带点串，这里破任何一条都会**静默漏计**（漏计在界面上长得像「这台机器没有」）。
///
/// `.bin` **不在**这张表里（上面的裁定）。
pub const MODEL_FILE_EXTENSIONS: [&str; 8] = [
    ".safetensors",
    ".gguf",
    ".ckpt",
    ".pt",
    ".pth",
    ".onnx",
    ".h5",
    ".tflite",
];

/// 扫描状态的线形状（`shared/types.ts` 的 `ScanStatus`）。
///
/// **原样带过去，不在这一层压成「完没完」一个布尔**：running / paused 与 cancelled / failed
/// 在界面上是两句不同的话（前者还在长，后者已经不会长了），而 `completed` 是唯一能让那一格
/// 念成结论的一档。`idle` 那一档压根没有树 —— 「只数到 0 个」会是一句有主语的假话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
}

/// 扫描层交回来的两个数（TS `ExtTotals`，即 `TreeStore.extTotals()` 的形状）。
///
/// 这里刻意用 `f64` 而不是 `u64`：JS 那两个数是**无类型**的，`f.size` 坏了会把 `NaN` / `-1`
/// 一路带到那一格，而 [`model_tally_from`] 的挡坏数判据必须能被同样地喂到（夹具里就有这种坏数）。
/// 真实的扫描层给出的是整数条数与整数字节，所以正常路径上这个 `f64` 只会装整数。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ExtTotals {
    pub count: f64,
    pub bytes: f64,
}

/// 这两个数是在什么处境下数出来的 —— 没有这一半，前面那两个数就是无主的两位数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTallyEnv {
    /// 被扫的那棵树的根。未完 #4 那句「要说是哪棵树量的」用的就是它。
    pub root_path: String,
    /// 这棵树里见过的**全部**文件条数（分母：N 个权重是从 M 个文件里数出来的）。
    pub files_seen: u64,
    /// 存储层因 `maxFiles` 丢过记录：条数仍是全量，但「这棵树」只是磁盘的一部分。
    pub truncated: bool,
    /// 扫描状态**原样**带过去。
    pub scan_status: ScanStatus,
}

/// 线格式（`ModelTallyWire`）。字段名与 TS 逐字同，因为界面那份 React 代码不改。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTally {
    pub count: u64,
    pub bytes: u64,
    /// 被量的那棵树的根。
    pub root_path: String,
    /// 这棵树里见过的**全部**文件条数（N 个权重是从 M 个文件里数出来的）。
    pub files_seen: u64,
    /// 存储层因 `maxFiles` 丢过记录。
    pub truncated: bool,
    /// 原样带出，不在这一层压成布尔 —— running / cancelled / completed 在界面上是三句话。
    pub scan_status: ScanStatus,
    /// 本次口径的原样回声：渲染层那句「只数这些扩展名…」必须有数据背书，不许手抄名单。
    pub extensions: Vec<String>,
}

/// 坏数挡在这里，不在界面挡：`formatBytes(NaN)` 会印出 `NaN GB`，而那一格长得跟一句真话一模一样。
/// 与 TS 的 `whole` 同形（先验后计，坏值点名而不是静默吞）。
///
/// ⚠️ 与 TS 唯一可观察的分叉：**小数**。TS 原样放行（`2.5 → 2.5`），Rust 的线形状是 `u64` ⇒ 截断
/// （`2.5 → 2`）。真实的扫描层只会交出整数，所以夹具不喂小数；这一条由
/// `whole_guards_bad_numbers` 显式钉住并在 `lib.rs` 的偏离清单里点名，不当它不存在。
fn whole(v: f64) -> u64 {
    if v.is_finite() && v > 0.0 {
        v as u64
    } else {
        0
    }
}

/// 把两个数与它的出身拼成视图要的那一格。
pub fn model_tally_from(totals: &ExtTotals, env: &ModelTallyEnv) -> ModelTally {
    ModelTally {
        count: whole(totals.count),
        bytes: whole(totals.bytes),
        root_path: env.root_path.clone(),
        files_seen: env.files_seen,
        truncated: env.truncated,
        scan_status: env.scan_status,
        extensions: MODEL_FILE_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
    }
}

/// 与 TS `baseName` 逐字同形：先去掉**尾部连续的 `\`**，再取最后一个 `\` 之后的部分。
/// 注意只认反斜杠（Windows 口径），不认 `/` —— 这里造第二套分隔符判据就会与 `extOf` 分叉。
pub fn base_name(p: &str) -> String {
    let s = p.trim_end_matches('\\');
    match s.rfind('\\') {
        None => s.to_string(),
        Some(i) => s[i + 1..].to_string(),
    }
}

/// 小写扩展名（含点）；无扩展名 / 点开头的名字（`.gitignore`）返回空串。
pub fn ext_of(p: &str) -> String {
    let b = base_name(p);
    match b.rfind('.') {
        Some(i) if i > 0 => b[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// 按注入的扩展名清单累加。清单的归一方式与 TS 的 `TreeStore` 构造函数逐字同：
/// **补点 + 小写**，不要求调用方传对 —— 一个没点的键不会报错，只会**永远数出 0**，
/// 而 0 在界面上是一句看起来可信的话。清单为空 → 与 TS 的「没注入」同形：恒为 `{0,0}`。
///
/// 每条都问，不看任何截断闸（计数在截断闸之前，与 `directFileCount` 同一侧）。
pub fn tally_model_files<'a, I>(items: I, extensions: &[&str]) -> ExtTotals
where
    I: IntoIterator<Item = (&'a str, u64)>,
{
    let wanted: std::collections::BTreeSet<String> = if extensions.is_empty() {
        std::collections::BTreeSet::new()
    } else {
        extensions
            .iter()
            .map(|e| {
                let t: &str = *e;
                let with_dot = if t.starts_with('.') { t.to_string() } else { format!(".{t}") };
                with_dot.to_lowercase()
            })
            .collect()
    };
    let mut count = 0f64;
    let mut bytes = 0f64;
    if wanted.is_empty() {
        return ExtTotals { count, bytes };
    }
    for (name, size) in items {
        let ext = ext_of(name);
        if wanted.contains(&ext) {
            count += 1.0;
            bytes += size as f64;
        }
    }
    ExtTotals { count, bytes }
}

/// 用本模块那份口径清单累加（§3.6 那一格用的就是这个）。
pub fn tally_model_files_default<'a, I>(items: I) -> ExtTotals
where
    I: IntoIterator<Item = (&'a str, u64)>,
{
    tally_model_files(items, &MODEL_FILE_EXTENSIONS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(status: ScanStatus) -> ModelTallyEnv {
        ModelTallyEnv {
            root_path: r"C:\Users\楠楠\AppData\Local".to_string(),
            files_seen: 300_000,
            truncated: false,
            scan_status: status,
        }
    }

    // ---------- 口径清单 ----------

    #[test]
    fn the_extension_list_is_dotted_lowercase_and_unique() {
        // 三条只要破一条，扫描途中的过滤就会**静默漏计**（漏计在界面上长得像「这台机器没有」）
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for e in MODEL_FILE_EXTENSIONS {
            assert!(e.starts_with('.'), "{e} 没带点");
            assert_eq!(e, e.to_lowercase(), "{e} 不是小写");
            assert!(!e[1..].contains('.'), "{e} 带了两个点");
            assert!(seen.insert(e.to_string()), "{e} 重复登记");
        }
    }

    #[test]
    fn dot_bin_is_deliberately_excluded_and_the_reason_is_paid_for() {
        // V0.7 定过的裁定：`.bin` 不是模型专属（安装包 / data.bin / numpy 缓存都叫这个名），
        // 算进来那格「共 X GB」就成了不相干字节的合订本。
        // **代价是少报**：早期 HF 检查点惯用的 pytorch_model.bin 不进这一格。
        assert!(!MODEL_FILE_EXTENSIONS.contains(&".bin"));
        let items = [
            ("model-00001-of-00002.safetensors", 7_000_000_000u64),
            ("pytorch_model.bin", 13_000_000_000),
            ("installer.data.bin", 900_000_000),
            ("llama-7b.Q4_K_M.gguf", 4_000_000_000),
        ];
        let t = tally_model_files_default(items.iter().map(|(n, s)| (*n, *s)));
        assert_eq!(t.count, 2.0, "只数 safetensors + gguf，两个 .bin 一律不算");
        assert_eq!(t.bytes, 11_000_000_000.0);
    }

    #[test]
    fn the_modern_weight_formats_are_all_in_the_caliber() {
        // 少一条就是那一格当着用户的面少数一种模型
        for e in [".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".onnx", ".h5", ".tflite"] {
            assert!(MODEL_FILE_EXTENSIONS.contains(&e), "{e} 漏了");
        }
        assert_eq!(MODEL_FILE_EXTENSIONS.len(), 8, "清单与「当代常见」必须一字不多一字不少");
    }

    // ---------- extOf 的口径（与 §3 统计表、topHeap 同一户） ----------

    #[test]
    fn ext_of_matches_the_ts_pathutil_shape() {
        assert_eq!(ext_of("model.SAFETENSORS"), ".safetensors", "大小写归一");
        assert_eq!(ext_of("q2.R1.gguf"), ".gguf", "多重扩展名取最后一段");
        assert_eq!(ext_of(".gitignore"), "", "点开头的名字不是扩展名");
        assert_eq!(ext_of("LICENSE"), "", "无扩展名给空串");
        assert_eq!(ext_of(r"C:\模型权重\权重 1.PTH"), ".pth", "中文目录名与空格都要能走过去");
        // TS 的 baseName 只认反斜杠（Windows 口径）：带 / 的名字整串当一个名字
        assert_eq!(ext_of(r"dir/model.bin"), ".bin");
        assert_eq!(
            ext_of(r"C:\a\b\model.pt\"),
            ".pt",
            "尾随反斜杠**先被剥掉**（TS 的 `replace(/\\\\+$/, '')`），所以目录形状的路径照样读出 .pt —— \
             这条不是巧合：扫描层把名字递进来时尾斜杠出现过一次，判据必须认得它"
        );
        assert_eq!(base_name(r"C:\a\b\"), "b", "baseName 与 TS 同形：先剥尾斜杠再取最后一段");
    }

    #[test]
    fn injected_extension_keys_are_normalized_not_trusted() {
        // 一个没点的键不会报错，只会**永远数出 0** —— 而 0 在界面上是一句看起来可信的话。
        // 所以清单在构造时就补点 + 小写（与 TS 的 TreeStore 构造函数同形）。
        let items = [("llama.GGUF", 10u64), ("a.safetensors", 20)];
        let t = tally_model_files(items.iter().map(|(n, s)| (*n, *s)), &["gguf", "SAFETENSORS"]);
        assert_eq!(t.count, 2.0, "调用方漏写点 / 写了大写都照样命中");
    }

    #[test]
    fn an_empty_caliber_counts_nothing_rather_than_everything() {
        // 「没要过」与「数出来是零」是两句话，那句话由调用方带着清单存不存在来回答；
        // 这一层的职责是：清单为空时不许把全部文件算进去。
        let items = [("a.pt", 5u64), ("b.txt", 6)];
        let t = tally_model_files(items.iter().map(|(n, s)| (*n, *s)), &[]);
        assert_eq!((t.count, t.bytes), (0.0, 0.0));
    }

    #[test]
    fn counting_happens_before_any_truncation_gate() {
        // 300 个权重必须念 300，与「榜只有 100 条」无关：这一层压根没有榜
        let items: Vec<(String, u64)> = (0..300).map(|i| (format!("w{i:03}.gguf"), 1_000)).collect();
        let borrowed: Vec<(&str, u64)> = items.iter().map(|(n, s)| (n.as_str(), *s)).collect();
        let t = tally_model_files_default(borrowed);
        assert_eq!(t.count, 300.0);
        assert_eq!(t.bytes, 300_000.0);
    }

    // ---------- 把数配上它的出身 ----------

    #[test]
    fn whole_guards_bad_numbers() {
        assert_eq!(whole(f64::NAN), 0);
        assert_eq!(whole(f64::INFINITY), 0);
        assert_eq!(whole(-1.0), 0, "负数会被渲染成「-1 GB」这样一句看起来正常的谎");
        assert_eq!(whole(0.0), 0);
        assert_eq!(whole(7.0), 7);
        // ⚠️ 与 TS 唯一可观察的分叉（小数）：TS 原样放行 2.5，线形状是 u64 ⇒ 截断成 2。
        // 真实扫描层只交整数；这条点名写在 lib.rs 的偏离清单，不当它不存在。
        assert_eq!(whole(2.5), 2);
    }

    #[test]
    fn out_of_range_json_does_not_even_reach_the_guard() {
        // 与 TS 的一条**已测量到的**分叉（写在 lib.rs 偏离清单第 2 条）：
        // `JSON.parse('1e400')` = Infinity → TS 的 whole() 挡成 0；
        // serde_json 对这个字面量直接报错，所以这一层根本没有「拿到 Infinity」这条路。
        // 这条用例钉的是「分叉长在哪一层」，不是「我们赢了」。
        let err = serde_json::from_str::<ExtTotals>(r#"{"count":1e400,"bytes":1}"#)
            .expect_err("serde_json 对超范围字面量是拒绝，不是给 Infinity");
        assert!(err.to_string().contains("number out of range"), "错误形状变了：{err}");
        // 而负数与 0 是两侧都能收的形状（夹具走的就是这一支）
        let ok: ExtTotals = serde_json::from_str(r#"{"count":-3,"bytes":-7}"#).unwrap();
        assert_eq!(whole(ok.count), 0);
        assert_eq!(whole(ok.bytes), 0);
    }

    #[test]
    fn tally_carries_its_origin_and_the_caliber_echo() {
        let t = model_tally_from(
            &ExtTotals { count: 137.0, bytes: (137 * 1024) as f64 },
            &ModelTallyEnv { root_path: r"D:\模型".to_string(), files_seen: 41_000, truncated: true, scan_status: ScanStatus::Cancelled },
        );
        assert_eq!((t.count, t.bytes), (137, 140_288));
        assert_eq!(t.root_path, r"D:\模型", "rootPath 是那句「量的是哪棵树」唯一的数据来源");
        assert_eq!(t.files_seen, 41_000);
        assert!(t.truncated, "截断过必须留痕：条数仍是全量，但那棵树只是磁盘的一部分");
        assert_eq!(t.scan_status, ScanStatus::Cancelled);
        assert_eq!(t.extensions, MODEL_FILE_EXTENSIONS.iter().map(|s| s.to_string()).collect::<Vec<String>>(),
            "口径的原样回声：界面那句「只数这些扩展名」得有数据背书，不能是渲染层手抄");
    }

    #[test]
    fn scan_status_is_not_collapsed_into_a_boolean() {
        // running / paused 与 cancelled / failed 在界面上是两句不同的话（前者还在长，后者已经不会长了），
        // 而 completed 是唯一能让那一格念成结论的一档。压成布尔 = 把「下界」冒充「检测到」。
        for status in [
            ScanStatus::Idle,
            ScanStatus::Running,
            ScanStatus::Paused,
            ScanStatus::Completed,
            ScanStatus::Cancelled,
            ScanStatus::Failed,
        ] {
            let t = model_tally_from(&ExtTotals { count: 3.0, bytes: 30.0 }, &env(status));
            assert_eq!(t.scan_status, status);
        }
    }

    #[test]
    fn zero_hits_are_a_real_answer_not_a_missing_field() {
        // count=0、bytes=0，但出身三件套照样带得齐 —— 否则「没扫过」与「扫了没有」分不开
        let t = model_tally_from(&ExtTotals::default(), &env(ScanStatus::Completed));
        assert_eq!((t.count, t.bytes), (0, 0));
        assert_eq!(t.files_seen, 300_000);
        assert_eq!(t.scan_status, ScanStatus::Completed);
    }

    #[test]
    fn the_same_input_serializes_the_same_twice() {
        let totals = ExtTotals { count: 12.0, bytes: 999.0 };
        let a = serde_json::to_value(model_tally_from(&totals, &env(ScanStatus::Running))).unwrap();
        let b = serde_json::to_value(model_tally_from(&totals, &env(ScanStatus::Running))).unwrap();
        assert_eq!(a, b);
        // 线格式的键名逐字对齐 shared/types.ts（界面那份 React 代码不改）
        let obj = a.as_object().unwrap();
        for key in ["count", "bytes", "rootPath", "filesSeen", "truncated", "scanStatus", "extensions"] {
            assert!(obj.contains_key(key), "线格式缺键 {key}");
        }
        assert_eq!(obj["scanStatus"].as_str(), Some("running"));
    }
}
