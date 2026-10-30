#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! DeepClean 的 Tauri 外壳。
//!
//! M2 起：命令层（`commands`）+ 扫描会话服务（`service`）。扫描内核在
//! `deepclean-scanner` crate 里，本文件只负责把它接上 Tauri。

mod cleanlog;
mod commands;
mod dev_env;
mod journal_store;
mod license_table;
mod netprobe;
mod paths;
mod report;
mod settings;
mod service;
mod wallpaper;
#[cfg(test)]
mod perf;
#[cfg(test)]
mod golden;

// `Manager` 提供三样这一层在**两个档**都要用的东西：
//  - `app.path()`（`dc-wallpaper` 协议要拿应用数据目录去解析壁纸文件名）；
//  - `app.get_webview_window("main")`（`dc_pick_wallpaper` 要拿主窗口句柄当对话框的父窗口）；
//  - `dev_autoscan` 里那几处（只在 debug 档编译）。
//
// ⚠️ 2026-10-27 踩过：这个 import 原先挂着 `#[cfg(debug_assertions)]`，因为那时
// **只有** `dev_autoscan` 用它。加了壁纸那两条之后，release 档编译报
// `E0599: no method named 'path' found for &AppHandle` —— 而 debug 编得过。
// 也就是说：**那条 `cargo build`（debug）能过、`tauri build`（release）过不去**的分叉
// 只在出包时暴露。别再把它按 debug 门控。
use tauri::Manager;

/// 壁纸文件名 → MIME。认不出就 `application/octet-stream`（浏览器不会拿它当背景图，
/// 但也不会因为一个猜错的 `image/png` 去尝试解码一张 jpg）。
fn content_type_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        "application/octet-stream"
    }
}

/// `%20` 那一族的最小解码。
///
/// 为什么不用库：本仓零运行时依赖，而这里只需要解百分号与 `+`（后者按 RFC 3986 在**路径**里
/// 不是空格，但文件名里出现 `+` 的机率与出现 `%2B` 的机率一样低，统一按字面 `+` 处理更安全 ——
/// 反正 `wallpaper_path` 会再挡一次分隔符）。
/// 非法的百分号序列（`%ZZ`）回 `None`：让它 400，而不是猜一个字符出来。
fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let v = u8::from_str_radix(hex, 16).ok()?;
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn main() {
    // M0-A 起立的核心 crate；这里只需确认它们被链进产物（各自的测试在各自 crate 里跑）
    let _ = (
        deepclean_scanner::name(),
        deepclean_rules::name(),
        deepclean_cleaner::name(),
        deepclean_license::name(),
    );
    tauri::Builder::default()
        .manage(service::AppState::default())

        /*
         * `dc-wallpaper://<文件名>` —— 把用户选的那张图喂给 CSS 的唯一通道（2026-10-27）。
         *
         * **为什么要有这一条，而不是让渲染端拼 `file://` 绝对路径**：
         * 渲染端拿到的只有文件名（`settings::sanitize_wallpaper` 只放行裸名字），
         * 拼路径这件事留在服务端，于是"越界读写"这条路在结构上不存在 ——
         * 一个 `../` 在 `wallpaper::wallpaper_path` 那里就被挡掉了。
         *
         * **为什么不用 `data:` URL**：用户选的图可能几 MB，转 base64 要吃掉 4/3 的内存
         * 且塞进 DOM 属性里；每次设置页重渲染都会重新解码一遍。协议这条路是流式的。
         *
         * 回 `404` 而不是回一张占位图：占位图在界面上看起来"加载成功了"，而真相是那张
         * 图被用户删了 —— 那种"看起来正常"的假结论正是本仓反复点名的缺陷形态。
         */
        .register_uri_scheme_protocol("dc-wallpaper", |ctx, request| {
            use tauri::http::Response;
            let deny = |code: u16| {
                Response::builder()
                    .status(code)
                    .header("Content-Type", "text/plain; charset=utf-8")
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new()))
            };
            // 路径形如 `dc-wallpaper://localhost/<name>`，取出最后一段当文件名。
            let raw = request.uri().path().trim_start_matches('/');
            let name = match percent_decode(raw) {
                Some(n) => n,
                None => return deny(400),
            };
            let Ok(app_data) = ctx.app_handle().path().app_data_dir() else {
                return deny(500);
            };
            let dir = wallpaper::wallpaper_dir(&app_data);
            let Some(path) = wallpaper::wallpaper_path(&dir, &name) else {
                return deny(404);
            };
            let Ok(bytes) = std::fs::read(&path) else {
                return deny(404);
            };
            Response::builder()
                .status(200)
                .header("Content-Type", content_type_of(&name))
                // 壁纸换了要立刻看见：不缓存。这张图最多几 MB，重读一次比"换了没生效"便宜。
                .header("Cache-Control", "no-store")
                .body(bytes)
                .unwrap_or_else(|_| Response::new(Vec::new()))
        })

        // 首启投递激活码清单（`codes.sha256`）。走在两个 license 命令**之前**：状态查询也要读
        // 这份表（核对 license.dat 里的 code_hash），只在激活前补一句会让已激活用户断网重开时
        // 读到 `table-unavailable`。投递失败不拦启动 —— 理由与代价写在 `service.rs` 那句注释。
        .setup(|app| {
            if let Err(e) = service::materialize_code_table(app.handle()) {
                eprintln!("[dc] 激活码清单投递失败：{e}");
            }
            // §29 的逐条删除日志：必须在**第一趟 `dc_execute` 之前**挂上，晚一步就是那批删除
            // 没有日志，而"少了一段日志"这件事界面上没有任何提示。建不出来不拦启动
            // （理由与代价写在 `service::init_clean_log` 与 `cleanlog.rs` 顶部）。
            service::init_clean_log(app.handle());
            // 清理日志的账本（2026-10-25）：读盘 + 起每小时淘汰线程。
            // 必须在任何一次 `record_journal` 之前 —— 晚一步那一次清理就不会进盘，
            // 而"少了一条日志"界面上看不出来。
            service::init_journal_store(app.handle());
            service::spawn_journal_pruner(app.handle().clone());
            // 原来这条闭包参数写作 `_app`，是因为 dev 自动扫描是 release 里唯一用到它的一句。
            // 现在清单投递在两个构建里都用它，下划线去掉；`dev_autoscan` 仍按 cfg 门控，
            // 打包版拿不到它。
            #[cfg(debug_assertions)]
            dev_autoscan(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::dc_drives,
            commands::dc_start,
            commands::dc_cancel,
            commands::dc_pause,
            commands::dc_resume,
            commands::dc_snapshot,
            commands::dc_children,
            commands::dc_skipped,
            commands::dc_dir_stats,
            commands::dc_preview,
            commands::dc_dev_env_view,
            commands::dc_settings_get,
            commands::dc_settings_set,
            commands::dc_pick_wallpaper,
            commands::dc_export_report,
            commands::dc_set_excluded,
            commands::dc_clear_exclusions,
            commands::dc_reveal_path,
            commands::dc_open_item,
            commands::dc_execute,
            commands::dc_auto_clean,
            commands::dc_cancel_cleanup,
            commands::dc_clean_task,
            commands::dc_list_clean_tasks,
            commands::dc_journal_runs,
        commands::dc_journal_dir_tree,
        commands::dc_journal_dir_children,
            commands::dc_license_activate,
            commands::dc_license_status,
            commands::dc_app_version,
            commands::dc_hardware,

        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {});
}

/// **dev-only 自动扫描**：`DC_AUTOSCAN=<绝对路径>` 时，窗口起来后自己开一轮扫描。
///
/// 用途与现行 Electron 侧的 `--shot` / `--clean-env-root` 同类：验收需要一张**真数据**的
/// 空间地图，而"点一下那个按钮"这件事在屏幕自动化上不稳（窗口被别的程序盖住就点空，
/// 而点空和"按钮坏了"在日志里长得一样）。它走的是**同一条服务路径**（`service::start_scan`），
/// 不是绕过 UI 另开一条后门，所以它验的东西和用户点出来的是同一份。
///
/// `debug_assertions` 门控 ⇒ **打包版拿不到它**。
#[cfg(debug_assertions)]
fn dev_autoscan(app: tauri::AppHandle) {
    let Ok(root) = std::env::var("DC_AUTOSCAN") else { return };
    if root.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        // 等 WebView2 挂上再开扫：事件是推给前端的，太早发的那几条没人接
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let state = app.state::<service::AppState>();
        // 卷几何在这里现取：这条线程本来就是 dev 专用的，它不在任何用户可见的调用路径上。
        let vol = match deepclean_scanner::volume::volume_of(std::path::Path::new(&root)) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[dc] DC_AUTOSCAN 失败：{e}");
                return;
            }
        };
        match service::start_scan(app.clone(), &state, root.clone(), vol) {
            Ok(id) => eprintln!("[dc] DC_AUTOSCAN 已启动：{root} -> {id}"),
            Err(e) => eprintln!("[dc] DC_AUTOSCAN 失败：{e}"),
        }
    });
}
