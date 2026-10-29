//! 设置的落盘 —— Tauri 侧唯一读写 `settings.json` 的地方。基准：`electron/services/settings-service.ts`
//! 与 `shared/settings.ts`（清洗那三条口径住在那儿，这里逐字照抄语义）。
//!
//! 三条不显然的规矩原样搬过来，每条都对应一种会骗到界面的失败：
//!
//! 1. **读的那一刻不抛**。`dc_settings_get` 是被设置页直接 `.then` 出去的，一次抛错在那一格的
//!    表现是「永远转圈」；而**文件不存在是正常初态**（第一次运行时根本没有这个文件）。
//!    写的那一侧故意相反：存不下就要抛（`E_SETTINGS_WRITE`），吞掉它等于告诉界面「保存成功」。
//! 2. **坏文件要点名**。回默认值是对的，但静默兜底会让「我刚存的值没生效」和「存好了」在屏幕上
//!    长得一模一样。TS 那边往日志文件里点名；**这一侧还没有文件日志**（记录页那句 `logPath: null`
//!    就是这件事的登记），所以点名走 `eprintln!` —— 那在 dev 构建里看得见，在打包版里进不了任何
//!    用户界面，是比"没有"好一点、比"有日志"差一点的过渡形态，写在 [`SettingsFallback`] 上。
//! 3. **写是原子的**：先写 `settings.json.tmp` 再 `rename` 覆盖。临时文件落在**同一个目录**：
//!    `rename` 要原子，前提就是它与目标同卷；跨卷会退化成「复制 + 删除」，既不原子也多一条会失败的调用。
//!
//! 这里**不许虚设字段**：`dupMinSizeMb` 有真读者（[`crate::dupes`] 的兜底门槛与重复页那一格预读），
//! 加设置的人要同时动「这个结构、读它的那段真逻辑、界面那一格控件」三处。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 下界 1 MB：再低就等于「全盘所有文件都进候选」，那是 §20 成本红线明确禁止的形态。
pub const MIN_DUP_MIN_SIZE_MB: u64 = 1;
/// 上界 1024 MB：超过它的门槛会让重复检测在绝大多数机器上找不大任何东西，而界面只显示
/// 「没有发现完全重复的文件」—— 一句真话、全错的脸。
pub const MAX_DUP_MIN_SIZE_MB: u64 = 1024;
/// 默认 4 MB **就是 `detect.ts` / `deepclean-dupes` 从 V0.4 起写死的那个数**，不许顺手挪。
/// 「只是加了个设置页」的改动若同时改了默认门槛，等于在用户一个控件都没碰的情况下
/// 改变了删除建议的口径 —— 那种变化不会有任何一条测试是他自己触发的。
pub const DEFAULT_DUP_MIN_SIZE_MB: u64 = 4;

/* ---------------- 外观四格（2026-10-27） ---------------- */

/// 这四格的界与 `shared/settings.ts` 逐条同一份。理由（那边也写了一遍，因为两处都要有人看见）：
///  - `blur 0–60px`：0 是"完全不平滑"，60 已超出默认 30 一倍，更高在 1080p 上就是一片糊；
///  - `saturate 0.5–2.5`：低于 0.5 变灰白，高于 2.5 发荧光；
///  - `brightness 0.5–1.6`：高于 1.6 文字对比度会塌；
///  - `opacity 0.06–0.9`：**下界不是 0** —— 0 会让"板"消失而盒子还在，看着像渲染坏了。
pub const MIN_GLASS_BLUR_PX: f64 = 0.0;
pub const MAX_GLASS_BLUR_PX: f64 = 60.0;
pub const MIN_GLASS_SATURATE: f64 = 0.5;
pub const MAX_GLASS_SATURATE: f64 = 2.5;
pub const MIN_GLASS_BRIGHTNESS: f64 = 0.5;
pub const MAX_GLASS_BRIGHTNESS: f64 = 1.6;
pub const MIN_GLASS_OPACITY: f64 = 0.06;
pub const MAX_GLASS_OPACITY: f64 = 0.9;

/// 默认值**必须与 `global.css` / `glass/tokens.css` 里的现值逐字相同**：
/// 不同的话，用户第一次打开设置页、什么都还没碰，界面就会跳到另一个样子。
/// 这条由 `the_glass_defaults_match_the_stylesheets` 直接读 CSS 文件钉住。
pub const DEFAULT_GLASS_BLUR_PX: f64 = 30.0;
pub const DEFAULT_GLASS_SATURATE: f64 = 1.5;
pub const DEFAULT_GLASS_BRIGHTNESS: f64 = 1.05;
pub const DEFAULT_GLASS_OPACITY: f64 = 0.36;

/// 内置壁纸的 id 闭集（今天只有一张夜山）。加一张要同时加文件与 `renderer` 那条拼 URL 的路。
pub const BUILTIN_WALLPAPERS: [&str; 1] = ["mountain"];
/// 默认壁纸。
pub const DEFAULT_WALLPAPER: &str = "builtin:mountain";

const SETTINGS_FILE_NAME: &str = "settings.json";

/// 设置里的**一件**真事：
///
/// - `dup_min_size_mb`：重复文件检测的最小尺寸，单位 MB（= 1024×1024 字节）。
///   界面上念「MB」而除数按 1024，与 `shared/format.ts` 的 `formatBytes` 同一把尺子。
///
/// ## `auto_clean_enabled` 哪去了（2026-10-24 删）
///
/// 人类伙伴当天定的是「一键清理去掉开关，点击后只清理勾选的内容」。那个开关原先的
/// 唯一读者是 [`crate::service::run_auto_clean`] 的总闸 —— 关着时整条回
/// `E_AUTO_CLEAN_DISABLED`。它被删掉之后就没有任何一段真逻辑读它了，而**一个没人读的设置
/// 就是这一页的一格假控件**（`shared/settings.ts` 那段注释点名的缺陷形态）。
///
/// 所以它从三处一起消失：这个结构、Rust 那道闸、设置页那一格。老用户的
/// `settings.json` 里若还留着 `autoCleanEnabled`，读的时候会被忽略（`sanitize_settings`
/// 只认它认识的键），写的时候会被丢掉 —— 一个已经没有任何读者的字段留在文件里，
/// 比删掉更容易让人以为它还在生效。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub dup_min_size_mb: u64,
    /// 外观四格（2026-10-27）。真读者是渲染端 `settingsToCssVars` → 那三条 CSS 变量。
    /// `f64` 没有 `Eq`（与 `SettingsFallback::Clamped` 同一个理由：数是从文件里读出来的原值）。
    pub glass_blur_px: f64,
    pub glass_saturate: f64,
    pub glass_brightness: f64,
    pub glass_opacity: f64,
    /// 壁纸引用。收的是 `builtin:<id>` / `file:<文件名>` 两种形状之一，见 [`sanitize_wallpaper`]。
    pub wallpaper: String,
}

impl AppSettings {
    /// ⚠️ **不是 `const`**（2026-10-27）：`wallpaper` 是 `String`，而 `to_string()` 不是 const fn。
    /// 改成 `pub fn default()` 而不是把 `wallpaper` 降成 `&'static str` 的理由：
    /// 设置是会被**改写**的一份数据，`&'static str` 在 `save_settings` 合并那一步要到处转手；
    /// 而 `String` 就是它从 json 里读出来的形状。
    pub fn default() -> AppSettings {
        AppSettings {
            dup_min_size_mb: DEFAULT_DUP_MIN_SIZE_MB,
            glass_blur_px: DEFAULT_GLASS_BLUR_PX,
            glass_saturate: DEFAULT_GLASS_SATURATE,
            glass_brightness: DEFAULT_GLASS_BRIGHTNESS,
            glass_opacity: DEFAULT_GLASS_OPACITY,
            wallpaper: DEFAULT_WALLPAPER.to_string(),
        }
    }
}

/// 读的那四条兜底路，各说各的话（并成一句「设置文件有问题」，三种人里只有第一种能得到正确提示）。
/// 「文件不在」不在这张表里 —— 那是第一次运行的正常样子，走 `None`，不是一种兜底。
// 没有 `Eq`：`Clamped { got }` 里那个数是 f64（它是从文件里读出来的原值，不许先转成整数再点名）
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsFallback {
    /// 读不动（权限 / 磁盘 / 它是个目录）
    Unreadable,
    /// json 坏了，多半是手改过：下一步动作是删掉重来
    NotJson,
    /// 读得出来但没有能用的那个键（改名 / 写了字符串 / 压根没有 / `1e999` 那种非有限数）
    NoUsableKey,
    /// 是个有限数但出了界：意图被接受了、只是撞到边界，所以要写出**夹完是多少**
    Clamped { got: f64, used: u64 },
}

/// 那个文件在哪。`dir` 由调用方给（同 TS 把 `app.getPath('userData')` 留在 IPC 那一侧取），
/// 这一层因此能在不碰 Tauri 的前提下被单测反复验。
pub fn settings_file_path(dir: &Path) -> PathBuf {
    dir.join(SETTINGS_FILE_NAME)
}

/// 把**任何**来源的一份设置收进合法区间（磁盘上那个 json、渲染端跨 IPC 传来的半个 patch）。
///
/// `dupMinSizeMb` 的三条口径（沿袭自 TS 基准）：
///   - 结构不对（不是对象 / 没有这个键 / 键不是数字 / 非有限数）→ 回默认值。让 NaN 一路
///     乘进字节数的话，`k.size < NaN` 恒假，于是**一个文件都不会被跳过**，整棵树全灌进
///     哈希候选 —— 症状是重复检测跑很久，看不出跟一个坏掉的配置文件有任何关系。
///   - 是有限数但出了界 → **夹住**，不回落默认值：写了 99999 的人要的是「别炸」，
///     给他 1024 而不是偷偷换成 4，后者会让「我明明改了」和「改动根本没生效」在界面上同形。
///   - 顺手取整：那一格只有整数档。存进 4.5 会让界面显示一个它自己列不出来的数。
///
/// 与 TS `Math.round` 的一处可观察分叉：`.5` 的**负数**（`-2.5`）TS 给 `-2`、这里给 `-3`
/// （Rust 的 `round` 是远离零取整）。两者随后都被夹到下界 1，所以这一格分叉**不可观测**；
/// 记在这里是因为它长得像一条真能走通的路。
///
/// 2026-10-24：`autoCleanEnabled` 那一支随字段一起删了。老文件里留着它不会报错，
/// 只是**被忽略**（不认识的键不进结构）；写的时候也不会被带回文件。
pub fn sanitize_settings(raw: &serde_json::Value) -> AppSettings {
    let Some(obj) = raw.as_object() else {
        return AppSettings::default();
    };
    let dup_min_size_mb = obj
        .get("dupMinSizeMb")
        .and_then(|v| v.as_f64())
        .filter(|d| d.is_finite())
        .map(|declared| declared.round().clamp(MIN_DUP_MIN_SIZE_MB as f64, MAX_DUP_MIN_SIZE_MB as f64) as u64)
        .unwrap_or(DEFAULT_DUP_MIN_SIZE_MB);
    // 外观四格：**逐键回落**，不是一个坏键把整份打回默认 ——
    // 后者会让"我调了亮度"与"我的模糊半径设置丢了"变成同一件事，用户看不出哪一格出问题。
    let num = |key: &str, min: f64, max: f64, fallback: f64| -> f64 {
        obj.get(key)
            .and_then(|v| v.as_f64())
            .filter(|d| d.is_finite())
            .map(|d| d.clamp(min, max))
            .unwrap_or(fallback)
    };
    AppSettings {
        dup_min_size_mb,
        glass_blur_px: num("glassBlurPx", MIN_GLASS_BLUR_PX, MAX_GLASS_BLUR_PX, DEFAULT_GLASS_BLUR_PX),
        glass_saturate: num("glassSaturate", MIN_GLASS_SATURATE, MAX_GLASS_SATURATE, DEFAULT_GLASS_SATURATE),
        glass_brightness: num(
            "glassBrightness",
            MIN_GLASS_BRIGHTNESS,
            MAX_GLASS_BRIGHTNESS,
            DEFAULT_GLASS_BRIGHTNESS,
        ),
        glass_opacity: num("glassOpacity", MIN_GLASS_OPACITY, MAX_GLASS_OPACITY, DEFAULT_GLASS_OPACITY),
        wallpaper: sanitize_wallpaper(obj.get("wallpaper")),
    }
}

/// 壁纸引用收进两种合法形状之一，认不出就回默认。
///
/// `file:` 那一路只放行**裸文件名**：不含目录分隔符、不是 `.` / `..`、不以点开头、
/// 不含 `..`，且扩展名在白名单里。这条与 `shared/settings.ts` 的 `sanitizeWallpaper`
/// 逐条同一份 —— 两处口径不一致时，渲染端放行的东西服务端会丢，
/// 而界面上表现成"选了图但没生效"。
///
/// **为什么只存文件名**：绝对路径会被渲染端直接拼进 `url()`，越界由自定义协议的
/// 作用域来挡；存绝对路径等于把"选一张图"变成"读任意文件"。
pub fn sanitize_wallpaper(raw: Option<&serde_json::Value>) -> String {
    let Some(s) = raw.and_then(|v| v.as_str()).map(str::trim) else {
        return DEFAULT_WALLPAPER.to_string();
    };
    if let Some(id) = s.strip_prefix("builtin:") {
        return if BUILTIN_WALLPAPERS.contains(&id) {
            format!("builtin:{id}")
        } else {
            DEFAULT_WALLPAPER.to_string()
        };
    }
    let Some(name) = s.strip_prefix("file:") else {
        return DEFAULT_WALLPAPER.to_string();
    };
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || name.contains("..")
        || name.contains('\\')
        || name.contains('/')
        || name.contains(':');
    if bad {
        return DEFAULT_WALLPAPER.to_string();
    }
    let lower = name.to_ascii_lowercase();
    let ok_ext = [".png", ".jpg", ".jpeg", ".webp", ".bmp"].iter().any(|e| lower.ends_with(e));
    if !ok_ext {
        return DEFAULT_WALLPAPER.to_string();
    }
    format!("file:{name}")
}

/// 读设置。**任何一条文件侧的失败都回一份合法值，绝不抛**（第二条返回值是给日志的点名）。
pub fn load_settings(path: &Path) -> (AppSettings, Option<SettingsFallback>) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::NotFound {
                (AppSettings::default(), None)
            } else {
                (AppSettings::default(), Some(SettingsFallback::Unreadable))
            };
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        // 只截一段原文进点名：一个坏文件可以是几百 MB 的垃圾，那不是一行日志该装的东西
        Err(e) => {
            let head: String = text.chars().take(120).collect();
            eprintln!("[dc] 设置文件不是合法 JSON，用默认值：{path:?}（{e}）开头是 {head:?}");
            return (AppSettings::default(), Some(SettingsFallback::NotJson));
        }
    };
    let declared = parsed
        .as_object()
        .and_then(|o| o.get("dupMinSizeMb"))
        .and_then(|v| v.as_f64());
    // 清洗先行。2026-10-27：外观那几格走**逐键回落**（一个坏键不影响别的键），
    // 所以下面那条点名只报 dup 与"整份不是对象"这两类 —— 外观出界时按格点名，
    // 免得一句笼统的 Clamped 把"是哪一格"吃掉。
    let next = sanitize_settings(&parsed);
    let glass_out_of_range = {
        let obj = parsed.as_object();
        [
            ("glassBlurPx", next.glass_blur_px, MIN_GLASS_BLUR_PX, MAX_GLASS_BLUR_PX),
            ("glassSaturate", next.glass_saturate, MIN_GLASS_SATURATE, MAX_GLASS_SATURATE),
            ("glassBrightness", next.glass_brightness, MIN_GLASS_BRIGHTNESS, MAX_GLASS_BRIGHTNESS),
            ("glassOpacity", next.glass_opacity, MIN_GLASS_OPACITY, MAX_GLASS_OPACITY),
        ]
        .into_iter()
        .filter_map(|(key, used, min, max)| {
            let raw = obj.and_then(|o| o.get(key)).and_then(|v| v.as_f64()).filter(|d| d.is_finite())?;
            (raw != used && raw >= min && raw <= max).then_some((key, raw, used))
        })
        .collect::<Vec<_>>()
    };
    for (key, got, used) in &glass_out_of_range {
        eprintln!("[dc] 设置值出了界，已夹住：{path:?}（{key} got={got} used={used}）");
    }
    let fallback = if let Some(declared) = declared.filter(|d| d.is_finite()) {
        if next.dup_min_size_mb as f64 != declared {
            eprintln!(
                "[dc] 设置值出了界，已夹住：{path:?}（got={declared} used={}）",
                next.dup_min_size_mb
            );
            Some(SettingsFallback::Clamped { got: declared, used: next.dup_min_size_mb })
        } else {
            None
        }
    } else {
        let got = parsed
            .as_object()
            .and_then(|o| o.get("dupMinSizeMb"))
            .map(|v| match v {
                serde_json::Value::String(s) => format!("{s:?}"),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "absent".to_string());
        // 连类型一起记：`got=8` 分不清文件里写的是 8 还是 "8"，而这两种的修法完全不同
        eprintln!("[dc] 设置文件里没有可用的 dupMinSizeMb，这一键用默认值：{path:?}（got={got}）");
        Some(SettingsFallback::NoUsableKey)
    };
    (next, fallback)
}

/// 写设置：拿渲染端那份 partial patch 叠在当前值上，清洗之后**整份**落盘，回存下来的那份。
///
/// 为什么回整份而不是回 `ok:true`：这是那一页唯一能证明「你选的那档真的被存下来了」的东西。
/// 界面拿返回值画那一格，而不是拿自己刚发出去的请求画 —— 后者正是「看着接上了其实没有」的写法：
/// 服务端把 99999 夹成 1024 之后，界面还显示 99999，用户下一次点开的就是一个不存在的值。
pub fn save_settings(path: &Path, patch: &serde_json::Value) -> Result<AppSettings, String> {
    let (current, _) = load_settings(path);
    // 合并的基线是**当前整份**（六个键），不是只有 dup 那一格。
    // 用 `to_value` 走一次序列化，是为了让"字段加了、这里忘了"变成编译期/运行期都会炸的事：
    // 手写六个 `merged.insert` 时，第七个字段加进来那天不会有任何东西提醒写这一行。
    let mut base = serde_json::to_value(&current).map_err(|e| write_error(path, &e.to_string()))?;
    let base_obj = base
        .as_object_mut()
        .ok_or_else(|| write_error(path, "AppSettings 序列化出来不是对象"))?;
    if let Some(obj) = patch.as_object() {
        // patch 里**只认这六个键**：野字段进了文件就是第二份真相开始住的地方。
        // 2026-10-24：`autoCleanEnabled` 那一支随字段一起删了 —— 老文件里带着它也会被这次整份重写丢掉。
        for key in [
            "dupMinSizeMb",
            "glassBlurPx",
            "glassSaturate",
            "glassBrightness",
            "glassOpacity",
            "wallpaper",
        ] {
            if let Some(v) = obj.get(key) {
                base_obj.insert(key.to_string(), v.clone());
            }
        }
    }
    let next = sanitize_settings(&base);
    let body = serde_json::to_string_pretty(&next).map_err(|e| write_error(path, &e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Err(write_error(path, &e.to_string()));
        }
    }
    // 目录可能还不存在（`app_data_dir()` 只是算出那个路径，并不创建它），上面那条就是为这一句铺路
    if let Err(e) = std::fs::write(&tmp, format!("{body}\n")).and_then(|()| std::fs::rename(&tmp, path)) {
        return Err(write_error(path, &e.to_string()));
    }
    Ok(next)
}

fn write_error(path: &Path, why: &str) -> String {
    // 留下的那个 .tmp 不清理：它不是读的那条路径（`load_settings` 只认 `path` 本身），
    // 而下次成功写入会直接覆盖它。为一个用不上的文件再加一条能失败的调用不值。
    format!("E_SETTINGS_WRITE：设置没能写到 {path:?}（{why}）")
}

/// 设置落在哪个目录：`override_dir`（dev-only 验收口子，见 `main.rs` 那批 `DC_*`）优先，
/// 否则应用数据目录本身（TS 那边就是 `userData/settings.json`，不另开子目录）。
/// 给覆盖但**去空白后为空**按没给处理 —— 空串会把文件指到当前工作目录，
/// 那种目录既不在交付路径上、也不在卸载清理范围内。（同 `service::license_dir` 那条判据。）
pub fn settings_dir_in(override_dir: Option<String>, app_data: PathBuf) -> PathBuf {
    match override_dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => app_data,
    }
}

/// 真机那一份：从 Tauri 拿应用数据目录。拿不到**要报错**，不许回一个猜的目录 ——
/// 「读的那一刻不抛」管的是文件那一侧，目录算不出来是另一件事（它会整条链都失效）。
pub fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let override_dir = {
        #[cfg(debug_assertions)]
        { std::env::var("DC_SETTINGS_DIR").ok() }
        #[cfg(not(debug_assertions))]
        { None }
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_SETTINGS_DIR: 拿不到应用数据目录：{e}"))?;
    Ok(settings_file_path(&settings_dir_in(override_dir, app_data)))
}

/* ================================================================== *
 * 单测
 *
 * 全部走一个临时目录（`D:\deepclean-fixture\`，项目纪律：绝不写 C:），
 * 所以「文件不存在」「坏 JSON」「写不进去」这三条都能被反复验，不用碰用户的真配置。
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(format!(r"D:\deepclean-fixture\m5e-settings\{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_covers_the_three_calibers() {
        // ① 结构不对 → 默认值（不是"半个值"、不是抛）
        for bad in [json!(null), json!(4), json!("4"), json!([]), json!({}), json!({"dup": 8})] {
            assert_eq!(sanitize_settings(&bad), AppSettings::default(), "{bad} 该回默认值");
        }
        // 键在但类型不对 / 非有限数（`1e999` 在 JSON 里就是 Infinity）
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": "8"})), AppSettings::default());
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": null})), AppSettings::default());
        // 非有限数这一支**从 JSON 文件里进不来**：`serde_json` 对 `1e999` 直接报
        // "number out of range"（TS 的 `JSON.parse` 给 Infinity）。所以那条守卫是纵深防御，
        // 真机可观察的行为是「整份读不成」→ `NotJson`，由下面 `load_...` 那条钉住。
        // ② 有限数但出了界 → **夹住**，不回落默认值
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": 99999})).dup_min_size_mb, 1024);
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": 0})).dup_min_size_mb, 1);
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": -5})).dup_min_size_mb, 1);
        // ③ 顺手取整（那一格只有整数档）
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": 4.4})).dup_min_size_mb, 4);
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": 4.6})).dup_min_size_mb, 5);
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": 7.0})).dup_min_size_mb, 7);

        // 2026-10-24：`autoCleanEnabled` 已从结构里删掉。老文件里留着它**不报错、被忽略** ——
        // 这条判据钉的是"删字段之后老配置仍然读得动"，而不是"读出来还是那个值"。
        assert_eq!(sanitize_settings(&json!({"autoCleanEnabled": true})), AppSettings::default());
        assert_eq!(sanitize_settings(&json!({})), AppSettings::default());
        // dup 键坏了 → 回默认值（现在只有这一个键，没有"连坐"这回事了）
        assert_eq!(sanitize_settings(&json!({"dupMinSizeMb": "8", "autoCleanEnabled": true})), AppSettings::default());
    }

    #[test]
    fn load_never_throws_and_names_each_fallback_apart() {
        let dir = temp_dir("load");
        let path = settings_file_path(&dir);

        // ① 文件不在：默认值，**不点名**（第一次运行的正常样子，不该冒充一次故障）
        let (v, note) = load_settings(&path);
        assert_eq!(v, AppSettings::default());
        assert!(note.is_none(), "ENOENT 不是故障：{note:?}");

        // ② 坏 json
        fs::write(&path, "{ 这不是 json").unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v, AppSettings::default());
        assert_eq!(note, Some(SettingsFallback::NotJson));

        // ③ 读得出来但那个键不可用（写了字符串）
        fs::write(&path, r#"{"dupMinSizeMb":"8"}"#).unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v, AppSettings::default());
        assert_eq!(note, Some(SettingsFallback::NoUsableKey));

        // ③' 2026-10-24：`autoCleanEnabled` 已从结构里删掉。老文件里留着它时行为是
        //     **被忽略**（不认识的键不进结构），而 dup 那一键照常读出来 ——
        //     这条钉的是"删字段之后老配置仍然读得动"，不是"读出来还是那个值"。
        fs::write(&path, r#"{"dupMinSizeMb":"8","autoCleanEnabled":true}"#).unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v.dup_min_size_mb, 4, "dup 键坏了照旧回默认");
        assert_eq!(note, Some(SettingsFallback::NoUsableKey));

        // ③'' 老文件里 dup 是好的、只多一个已删字段：整份读得动、值逐字正确、不点名
        fs::write(&path, r#"{"dupMinSizeMb":12,"autoCleanEnabled":"on"}"#).unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v.dup_min_size_mb, 12);
        assert_eq!(note, None, "已删字段不是故障，不该走任何点名通道");

        // ④ 出界：夹住，且点名的那一份里同时写着**夹完是多少**
        fs::write(&path, r#"{"dupMinSizeMb":99999}"#).unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v.dup_min_size_mb, 1024);
        assert_eq!(note, Some(SettingsFallback::Clamped { got: 99999.0, used: 1024 }));

        // ④' 超范围的数：Rust 侧整份 JSON 读不进来（TS 那边是 Infinity → 那个键不可用）。
        //     两种走法都回默认值，但点名的那一格不同 —— 这条就是两侧唯一可观察的分叉。
        fs::write(&path, r#"{"dupMinSizeMb":1e999}"#).unwrap();
        let (v, note) = load_settings(&path);
        assert_eq!(v, AppSettings::default());
        assert_eq!(note, Some(SettingsFallback::NotJson), "1e999 在 serde_json 里是解析失败，不是 Infinity");

        // ⑤ 路径本身是个目录（读不动那一格）
        let (v, note) = load_settings(&dir);
        assert_eq!(v, AppSettings::default());
        assert_eq!(note, Some(SettingsFallback::Unreadable));
    }

    #[test]
    fn save_returns_the_copy_that_actually_landed() {
        let dir = temp_dir("roundtrip");
        let path = settings_file_path(&dir);

        let back = save_settings(&path, &json!({ "dupMinSizeMb": 12 })).unwrap();
        assert_eq!(back.dup_min_size_mb, 12, "回的是**存下来的那份**，不是请求里那份");
        assert_eq!(load_settings(&path).0.dup_min_size_mb, 12);

        // 出界的 patch：界面拿这一份画那一格，于是 99999 不会显示成一个不存在的值
        let back = save_settings(&path, &json!({ "dupMinSizeMb": 99999 })).unwrap();
        assert_eq!(back.dup_min_size_mb, 1024);
        assert_eq!(load_settings(&path).0.dup_min_size_mb, 1024);

        // 叠在当前值上：patch 里没那个键 → 原值不动（TS 的 `{...load, ...patch}` 同一语义）
        let back = save_settings(&path, &json!({})).unwrap();
        assert_eq!(back.dup_min_size_mb, 1024);

        // 2026-10-24：`autoCleanEnabled` 已删。老调用方**还会**发 `{autoCleanEnabled:true}`
        // （旧界面/旧脚本），此时的行为必须是「不报错、不落盘、dup 原值不动」——
        // 而不是把整个保存弄成失败，也不是把它写进文件里当第二个键。
        let back = save_settings(&path, &json!({ "autoCleanEnabled": true })).unwrap();
        assert_eq!(back.dup_min_size_mb, 1024, "已删字段不许连坐真键");
        let raw = fs::read_to_string(&path).unwrap();
        assert!(
            !raw.contains("autoCleanEnabled"),
            "已删字段不许被写回文件（否则下一个人会以为它还在生效）：{raw}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stray_fields_never_reach_the_file() {
        // 野字段进了文件就是第二份真相开始住的地方：将来某处读到 `dupMinSizeMbytes` 而没人清洗它
        let dir = temp_dir("stray");
        let path = settings_file_path(&dir);
        save_settings(
            &path,
            &json!({ "dupMinSizeMb": 9, "theme": "midnight", "dupMinSizeMbytes": 999999 }),
        )
        .unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let obj = parsed.as_object().unwrap();
        /**
         * 2026-10-27 改口径：真键从 1 个变 6 个（外观四格 + 壁纸）。所以这条判据从
         * "只许有一个键"改成"**恰好是这六个**、且野字段一个都不在里面"。
         *
         * ⚠️ 不许退回成 `obj.len() <= 6` 那种松判据：那样"加了一个野字段、
         * 顺手删了一个真键"也会绿，而表现是设置页某一格永远显示默认值。
         */
        let mut keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "dupMinSizeMb",
                "glassBlurPx",
                "glassBrightness",
                "glassOpacity",
                "glassSaturate",
                "wallpaper"
            ],
            "文件里的键集必须是这六个（多一个是野字段，少一个是那一格永远显示默认值）：{raw}"
        );
        // 点名那两个野字段**具体**不在（比"键集恰好对"更直白地指出错在哪）
        assert!(!obj.contains_key("theme"), "野字段 theme 进了文件：{raw}");
        assert!(!obj.contains_key("dupMinSizeMbytes"), "野字段 dupMinSizeMbytes 进了文件：{raw}");
        // 线形状那个名字要正是渲染端读的（camelCase），漂一个字母那一格就永远显示默认值
        assert!(raw.contains("\"dupMinSizeMb\": 9"), "{raw}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_says_so_instead_of_lying_about_success() {
        // 父路径是一个**文件** → 建目录必然失败。这一条链上唯一诚实的失败信号就是「没存上」，
        // 吞掉它等于告诉界面「保存成功」。
        let dir = temp_dir("write-fail");
        fs::write(dir.join("blocked"), b"x").unwrap();
        let path = settings_file_path(&dir.join("blocked"));
        let err = save_settings(&path, &json!({ "dupMinSizeMb": 8 })).unwrap_err();
        assert!(err.starts_with("E_SETTINGS_WRITE："), "{err}");
        assert!(err.contains("settings.json"), "错误里要点名是哪个文件：{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_tmp_file_lands_next_door_and_not_in_the_temp_dir() {
        // 原子写的前提是**同卷**：跨卷 rename 会退化成「复制 + 删除」。
        // 这一条盯的就是有人把临时文件挪去 `std::env::temp_dir()` 那类地方。
        let dir = temp_dir("tmp-sibling");
        let path = settings_file_path(&dir);
        save_settings(&path, &json!({ "dupMinSizeMb": 16 })).unwrap();
        assert!(path.exists());
        assert!(
            !dir.join("settings.json.tmp").exists(),
            "成功之后不该留一个 .tmp（它不是读的那条路径，但留着就是下次读不到的样子）"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_default_threshold_is_the_same_number_the_detector_uses() {
        // 反漂移：「设置页的默认值」与「重复检测的兜底门槛」今天必须是同一个数。
        // 两边各写一份字面量时，谁改了其中一个只有另一个会跟着变 —— 而症状是
        // 「界面上写着 ≥ 4.0 MB、服务端按别的数扫」，正对着 `wire_of` 那句回显。
        //
        // ~~`deepclean_dupes::DEFAULT_MIN_SIZE`~~：重复文件检测（§20）下线后那一半没有了，
        // 这条反漂移随之退化成「设置默认值自洽」—— 三个边界常量仍然钉在这里，
        // 因为它们决定 `wire_of` 回给界面的那一格，而界面按它显示「≥ N MB」。
        // 字节换算只住在这里（生产路径上换算住在 `shared/settings.ts` 的 `dupMinSizeBytesOf`，
        // 界面把**字节**递过 IPC，壳层不需要再算一遍）—— 所以这条反漂移用同一算法就地展开。
        // 注意 4 MB × 1024 × 1024 是**这个默认值自己**的字节数，不是"检测器门槛"：
        // 检测器下线后不再有第二个数可以对，这里只证明换算口径自洽。
        assert_eq!(
            AppSettings::default().dup_min_size_mb * 1024 * 1024,
            4 * 1024 * 1024
        );
        assert_eq!(DEFAULT_DUP_MIN_SIZE_MB, 4);
        assert_eq!(MIN_DUP_MIN_SIZE_MB, 1);
        assert_eq!(MAX_DUP_MIN_SIZE_MB, 1024);
    }

    /// 「先写 `settings.json.tmp` 再 `rename` 盖过去」这件事**只靠读代码不算验过**：
    /// 让最后那一步 `rename` 失败（目标位置站着一个**目录**），如果盘上留下的是同目录里
    /// 那个 `.tmp`，就证明写的是两步、且临时文件与目标同卷（跨卷 rename 会退化成复制+删除，
    /// 那既不原子也多一条会失败的调用）。
    #[test]
    fn a_failed_rename_proves_the_tmp_landed_next_door() {
        let dir = temp_dir("rename-fail");
        fs::create_dir(dir.join("settings.json")).unwrap(); // 目标站着一个目录 → rename 必失败
        let path = settings_file_path(&dir);
        let err = save_settings(&path, &json!({ "dupMinSizeMb": 24 })).unwrap_err();
        assert!(err.starts_with("E_SETTINGS_WRITE："), "{err}");
        let tmp = dir.join("settings.json.tmp");
        let left = fs::read_to_string(&tmp).unwrap_or_else(|e| panic!("同目录没留下 .tmp（{e}）→ 写的不是两步"));
        assert!(left.contains("\"dupMinSizeMb\""), "临时文件里那份不是清洗过的：{left}");
        assert!(left.contains("24"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 线形状：渲染端读的就是这几个 camelCase 键名。
    ///
    /// 2026-10-27 从"只有一个键"扩成六个。这条判据**逐字**写出整份默认对象 ——
    /// 而不是只断言 `contains_key`：后者在有人多加一个键时照样绿，
    /// 而多加一个键就是"文件里躺着没人读的字段"（本文件顶部点名的那种）。
    ///
    /// 同日第二次改：`glassOpacity` 从 0.22 变 **0.36**。设置卡改用深色档之后，
    /// 滑块调的是 `--settings-card-fill`（quiet 那一档的色相），默认值必须等于
    /// `--glass-fill-quiet` 的 alpha —— 否则第一次打开设置页、什么都没碰，卡会跳一下。
    #[test]
    fn the_wire_shape_is_what_the_settings_page_reads() {
        let body = serde_json::to_value(AppSettings::default()).unwrap();
        assert_eq!(
            body,
            json!({
                "dupMinSizeMb": 4,
                "glassBlurPx": 30.0,
                "glassSaturate": 1.5,
                "glassBrightness": 1.05,
                "glassOpacity": 0.36,
                "wallpaper": "builtin:mountain",
            }),
            "键名漂一个字母，那一格永远显示默认值"
        );
    }

    /// **外观四格的默认值必须与样式表逐字相同**（2026-10-27）。
    ///
    /// 不同的话，用户第一次打开设置页、什么都还没碰，界面就跳到另一个样子。
    /// 这条**直接读那两个 CSS 文件**取值 —— 不是在 Rust 里再抄一份常数
    /// （抄一份的话，样式表改了而这里不知道，那正是"两处真相"的起点）。
    ///
    /// 与 `tests/unit/settings-glass-bounds.test.ts` 的 ① 是同一件事的两侧：
    /// 那条从 TS 往 CSS 对，这条从 Rust 往 CSS 对。两侧都对上，才排除了"TS 与 Rust
    /// 一起漂、而 CSS 没动"这一种。
    #[test]
    fn the_glass_defaults_match_the_stylesheets() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let tokens = std::fs::read_to_string(root.join("src/renderer/styles/glass/tokens.css"))
            .expect("读不到 glass/tokens.css");
        let global = std::fs::read_to_string(root.join("src/renderer/styles/global.css"))
            .expect("读不到 global.css");

        // 从一段 CSS 里抠 `--name: value;` 的值
        let var = |src: &str, name: &str| -> String {
            let at = src.find(&format!("{name}:")).unwrap_or_else(|| panic!("样式表里找不到 {name}"));
            let rest = &src[at + name.len() + 1..];
            let end = rest.find(';').expect("那个变量没有以分号收口");
            rest[..end].trim().to_string()
        };

        assert_eq!(
            var(&tokens, "--glass-blur-page"),
            format!("{}px", DEFAULT_GLASS_BLUR_PX),
            "模糊半径默认值与样式表不一样 ⇒ 第一次打开设置页界面会跳一下"
        );
        assert_eq!(var(&tokens, "--glass-saturate"), DEFAULT_GLASS_SATURATE.to_string());
        assert_eq!(var(&tokens, "--glass-brightness"), DEFAULT_GLASS_BRIGHTNESS.to_string());

        // 透明度那一格对的是 `--glass-fill-quiet` 的 **alpha**。
        //
        // 2026-10-27 改口径：设置卡改用深色档（人类伙伴：「设置页面的框色彩改成和这个一样」，
        // 指开发环境页那副材质）之后，滑块调的是 `--settings-card-fill`，而它的默认值
        // 必须等于 quiet 这一档 —— 否则第一次打开设置页、什么都还没碰，卡的颜色会跳一下。
        // 色相与三档填充的关系由 global.css 决定，设置只换 alpha。
        let fill = var(&global, "--glass-fill-quiet");
        let open = fill.find('(').expect("--glass-fill-quiet 不是函数形状");
        let parts: Vec<&str> = fill[open + 1..]
            .trim_end_matches(')')
            .split(',')
            .map(str::trim)
            .collect();
        assert_eq!(parts.len(), 4, "--glass-fill-quiet 应该是 rgba(r, g, b, a)：{fill}");
        assert_eq!(parts[..3], ["10", "28", "70"], "色相不该被设置改（只改 alpha）：{fill}");
        let alpha: f64 = parts[3].parse().expect("alpha 不是数字");
        assert_eq!(
            alpha, DEFAULT_GLASS_OPACITY,
            "透明度默认值与样式表不一样：{fill}"
        );
    }

    #[test]
    fn wallpaper_sanitizer_is_a_closed_set() {
        // 认两种形状
        assert_eq!(sanitize_wallpaper(Some(&json!("builtin:mountain"))), "builtin:mountain");
        assert_eq!(sanitize_wallpaper(Some(&json!("file:wallpaper-a.png"))), "file:wallpaper-a.png");
        assert_eq!(sanitize_wallpaper(Some(&json!("file:我的图.jpg"))), "file:我的图.jpg");

        // 越界的一律回默认。这一批与 `shared/settings.ts` 的 `sanitizeWallpaper` 那张表**同一批输入**
        for evil in [
            "file:../secret.png",
            "file:..\\secret.png",
            "file:sub/dir/a.png",
            "file:C:/windows/a.png",
            "file:.hidden.png",
            "file:a.gif",
            "javascript:alert(1)",
            "builtin:nope",
            "",
            "   ",
        ] {
            assert_eq!(
                sanitize_wallpaper(Some(&json!(evil))),
                DEFAULT_WALLPAPER,
                "{evil} 不该被接受"
            );
        }
        // 类型不对 / 缺键
        assert_eq!(sanitize_wallpaper(None), DEFAULT_WALLPAPER);
        assert_eq!(sanitize_wallpaper(Some(&json!(42))), DEFAULT_WALLPAPER);

        // 反面对照：合法的那种必须**不等于**默认（否则上面那批断言是空的）
        assert_ne!(sanitize_wallpaper(Some(&json!("file:a.png"))), DEFAULT_WALLPAPER);
    }

    /// 外观四格逐键回落：一个坏键不许连坐别的键。
    ///
    /// 这条与 TS 侧 `settings-glass-bounds.test.ts` 的「逐键回落」是同一件事的两侧。
    /// 整份打回默认的表现是"我调了亮度，模糊半径却丢了" —— 用户看不出是哪一格出问题。
    #[test]
    fn a_bad_glass_key_never_poisons_the_others() {
        let s = sanitize_settings(&json!({
            "dupMinSizeMb": 4,
            "glassBlurPx": "not a number",
            "glassSaturate": 2.0,
            "glassBrightness": 1.2,
            "glassOpacity": 0.4,
            "wallpaper": "builtin:mountain",
        }));
        assert_eq!(s.glass_blur_px, DEFAULT_GLASS_BLUR_PX, "坏的那个回默认");
        assert_eq!(s.glass_saturate, 2.0, "好的键不许被连坐");
        assert_eq!(s.glass_brightness, 1.2);
        assert_eq!(s.glass_opacity, 0.4);

        // 出界是**夹住**，不是回默认（用户写 9999 要的是"别炸"，不是"偷偷变成 30"）
        let clamped = sanitize_settings(&json!({
            "glassBlurPx": 9999.0,
            "glassSaturate": -1.0,
            "glassOpacity": 0.0,
        }));
        assert_eq!(clamped.glass_blur_px, MAX_GLASS_BLUR_PX);
        assert_eq!(clamped.glass_saturate, MIN_GLASS_SATURATE);
        assert_eq!(clamped.glass_opacity, MIN_GLASS_OPACITY, "透明度下界不是 0");
    }

    #[test]
    fn the_dev_override_treats_blank_as_absent() {
        let app_data = PathBuf::from(r"D:\appdata");
        assert_eq!(settings_dir_in(None, app_data.clone()), app_data);
        for blank in [Some("".to_string()), Some("   ".to_string())] {
            assert_eq!(
                settings_dir_in(blank.clone(), app_data.clone()),
                app_data,
                "空串覆盖会把设置文件指到当前工作目录"
            );
        }
        assert_eq!(settings_dir_in(Some(r"D:\elsewhere".into()), app_data), PathBuf::from(r"D:\elsewhere"));
    }
}
