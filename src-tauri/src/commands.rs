//! Tauri 命令层。**只做转发** —— 逻辑在 `service.rs`，判据在 `deepclean-scanner` 的测试里。
//!
//! ~~M2 只接**九个**命令（前端 `DeepCleanApi` 有 20 个方法，其余 11 个在 M2 就该报错，
//! 见 `src/renderer/tauri-bridge.ts` 的 `E_NOT_IMPLEMENTED`）。~~
//! **这句到 2026-10-12 已经过期，留在这里是因为它没人删过**：M5-E 收尾时桥里最后一个桩被拔掉，
//! 现在 `generate_handler!` 注册的每一条都有人调（`registration_tests::
//! every_registered_command_is_actually_called_from_the_bridge` 钉的就是这个方向 ——
//! 那句话能活这么久，正是因为此前只量过"定义了必须注册"，没量过"注册了必须有人调"）。

use crate::service::{self, AppState, ScanSnapshotWire, DEFAULT_LEVEL_CAP};
use deepclean_scanner::tree_index::ChildrenPayload;
use tauri::State;

#[tauri::command]
pub async fn dc_drives() -> Vec<service::DriveInfoWire> {
    // 26 次 `GetVolumePathNameW` + `GetVolumeInformationW` + `GetDiskFreeSpaceExW`：
    // 每个盘符 3 次系统调用，拔出/断连的盘符会等到卷管理器回话。实测本机 2 个卷 ~0.8 ms，
    // 但**断连的网络盘/光驱**能到秒级 —— 与 `dc_dev_env_view` 同一类，走阻塞线程池。
    tauri::async_runtime::spawn_blocking(service::list_drives)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn dc_start(app: tauri::AppHandle, state: State<'_, AppState>, root: String) -> Result<String, String> {
    // `volume_of(&root)` 是一次 `GetVolumePathNameW`：扫描根填成断连的网络路径时它会等。
    // 这一句（也只这一句）走阻塞线程池 —— 后面 `start_scan` 自己起线程就返回，不占调用线程。
    // ⚠️ 不能整段塞进 `spawn_blocking`：`State<'_, AppState>` 借的是 Tauri 的托管对象，
    // 活不过 `'static` 闭包（E0521）。要真做到整段异步，得先把 `AppState` 换成 `Arc` 托管，
    // 那是架构改动，为一次系统调用换它不划算。
    let root2 = root.clone();
    let vol = tauri::async_runtime::spawn_blocking(move || deepclean_scanner::volume::volume_of(std::path::Path::new(&root2)))
        .await
        .map_err(|e| format!("E_START_JOIN：取卷几何的线程挂了：{e}"))?
        .map_err(|e| format!("取卷几何失败：{e}"))?;
    service::start_scan(app, &state, root, vol)
}

#[tauri::command]
pub fn dc_cancel(state: State<'_, AppState>, scan_id: String) -> Result<bool, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    match s {
        Some(s) => {
            s.control.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub fn dc_pause(state: State<'_, AppState>, scan_id: String) -> Result<bool, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    match s {
        Some(s) => {
            s.control.pause();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub fn dc_resume(state: State<'_, AppState>, scan_id: String) -> Result<bool, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    match s {
        Some(s) => {
            s.control.resume();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn dc_snapshot(state: State<'_, AppState>, scan_id: String) -> Result<Option<ScanSnapshotWire>, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    Ok(s.map(|s| s.snapshot()))
}

#[tauri::command]
pub async fn dc_children(
    state: State<'_, AppState>,
    scan_id: String,
    dir_id: i64,
    cap: Option<usize>,
    // 字节口径：`"apparent"`（表观，缺省，与 SpaceSniffer 同口径）或 `"allocated"`
    // （分配且硬链接去重，与卷容量可比）。**认不出的一律回表观**，不让一个拼错的
    // 口径名把整页地图打不开（见 `SizeBasis::parse`）。
    size_basis: Option<String>,
) -> Result<Option<ChildrenPayload>, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    let Some(s) = s else {
        return Ok(None)
    };
    // **树先克隆出来、锁立刻放掉**（`Arc`，一次指针克隆）。`payload()` 要为一个目录把子项
    // 全部展开成线格式（宽目录 5 万文件实测 3.52 ms），并且内部 `dirs.iter().any(..)` 走全树。
    // 原先抱着会话锁做这段，而扫描线程的进度回调每秒也要这把锁 —— 两边互相排队。
    let (tree, status, excluded, totals) = {
        let st = s.state.lock().unwrap();
        let Some(tree) = st.tree.as_ref() else {
            return Ok(None);
        };
        (
            tree.clone(),
            st.status.wire(),
            st.view_excluded.clone(),
            service::session_excluded_totals_of(&st),
        )
    };
    // 本轮累计那两份**必须**跟着载荷一起下去：少了它们，侧栏那句
    // 「已排除 N 个目录（本轮累计）」永远出不来（真机第一次就是这么漏的）。
    Ok(tree.payload(
        dir_id,
        cap.unwrap_or(DEFAULT_LEVEL_CAP),
        status,
        &excluded,
        totals,
        deepclean_scanner::tree_index::SizeBasis::parse(size_basis.as_deref()),
    ))
}

#[tauri::command]
pub async fn dc_skipped(state: State<'_, AppState>, scan_id: String) -> Result<Option<serde_json::Value>, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    let Some(s) = s else { return Ok(None) };
    // 同 `dc_children`：树克隆出来、锁放掉，`skipped_sample_of` 的全树收集在锁外跑。
    let (tree, c) = {
        let st = s.state.lock().unwrap();
        let Some(tree) = st.tree.as_ref() else { return Ok(None) };
        (tree.clone(), st.counters)
    };
    let tree = &tree;
    let sample: Vec<String> = crate::service::skipped_sample_of(tree).into_iter().take(200).collect();
    let total = c.errors.denied + c.errors.missing + c.errors.busy + c.errors.other_errors();
    Ok(Some(serde_json::json!({
        "total": total,
        "denied": c.errors.denied,
        "missing": c.errors.missing,
        "busy": c.errors.busy,
        "otherErrors": c.errors.other_errors(),
        "sample": sample,
        "sampleOverflow": total as i64 - sample.len() as i64,
        "skippedReparse": c.skipped_reparse,
        "skippedAlways": c.skipped_always,
        "overflowed": tree.skipped_overflowed,
    })))
}

#[tauri::command]
pub async fn dc_dir_stats(
    state: State<'_, AppState>,
    scan_id: String,
    dir_id: i64,
) -> Result<Option<deepclean_scanner::tree_index::DirStats>, String> {
    let s = state.sessions.lock().unwrap().get(&scan_id).cloned();
    let Some(s) = s else { return Ok(None) };
    let st = s.state.lock().unwrap();
    Ok(st.tree.as_ref().and_then(|t| t.dir_stats(dir_id)))
}

/// §17：预览 + 可选「确认」。**只读** —— 没有执行入口，回执里也不含路径清单。
///
/// ~~`dupGroupIds` / `dupExclusions` 是 §20 那一路~~ 重复文件检测下线后这两格一并撤掉：
/// 渲染端只报「勾了哪几条规则」与「从地图加进来的路径」，路径清单由服务端从已扫好的树里取
/// （与 `dc_execute` 只认指纹是同一条纪律 —— 渲染进程报上来的路径清单一律不作数，
/// 否则"哪些文件会被删"这件事就变成客户端说了算）。
#[tauri::command]
pub async fn dc_preview(
    state: State<'_, AppState>,
    scan_id: String,
    selection: serde_json::Value,
    confirm: Option<bool>,
    // M5-P1 T4：用户**按到哪一档**（`'safe' | 'caution' | 'high'`，与 TS 侧 `Risk` 同一个闭集）。
    // `None` 的口径与 `service::build_preview` 里那条注释同：按 🟡 算 —— 服务端**不许**替用户按 🟠。
    // 渲染端带真实档位是 T5b 那一格（按档文案 + 高风险档确认框）。
    acknowledged_risk: Option<deepclean_rules::types::Risk>,
    tile_paths: Option<Vec<serde_json::Value>>,
) -> Result<Option<service::PreviewPayloadWire>, String> {
    service::build_preview(&state, &scan_id, selection, confirm, acknowledged_risk, tile_paths)
}

/* ------------------------------------------------------------------ *
 * 设置（M5-E）
 * ------------------------------------------------------------------ */

/// 读设置。**文件那一侧的失败永不报错**（第一次运行时那个文件本就不存在），
/// 只有目录算不出来才报 —— 那件事会让整条链失效，回一份默认值等于骗界面「存好了」。
#[tauri::command]
pub fn dc_settings_get(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::settings::AppSettings, String> {
    let path = crate::settings::settings_path(&app)?;
    let s = crate::settings::load_settings(&path).0;
    /*
     * 抄一份进 `AppState` 的缓存（2026-10-30）。
     *
     * 为什么读的时候也要写：`execute_plan` 里那格「删除速率」的真读者拿不到
     * `AppHandle`，只能读缓存。而"用户从没打开过设置页"时，**只有这一条路会跑** ——
     * 不写的话缓存里永远是产品默认值，用户在文件里手改的并发度不会生效。
     */
    *state.cached_settings.lock().unwrap() = s.clone();
    Ok(s)
}

/// 写设置。回的是**存下来的那一份**（不是请求里那份）：界面拿它画那一格，
/// 于是「我把 99999 填进去了」与「它被夹到 1024」是屏幕上看得见的一件事，不是一句悄悄话。
#[tauri::command]
pub fn dc_settings_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<crate::settings::AppSettings, String> {
    let path = crate::settings::settings_path(&app)?;
    let saved = crate::settings::save_settings(&path, &patch)?;
    // 回执赢的实现同一条：缓存抄的是**存下来那份**（夹过的），不是请求里那份。
    *state.cached_settings.lock().unwrap() = saved.clone();
    Ok(saved)
}

/// 选一张图当背景壁纸（2026-10-27）。
///
/// 回三态，**每一态在界面上的说法都不一样**：
/// - `{ok:true, wallpaper:"file:<名>", name:"<源名>"}` —— 已复制进应用数据目录、设置也已落盘；
/// - `{ok:true, cancelled:true}` —— **用户按了取消。不是错误**，界面一个字都不该变；
/// - `{ok:false, error:"E_WALLPAPER_…"}` —— 真失败（类型不对 / 读不到 / 复制失败）。
///
/// 为什么 `cancelled` 走 `ok:true`：这一格唯一的消费者是设置页那个按钮，
/// 它要区分的是"该不该说点什么"，而不是"HTTP 199/400"。取消之后弹一条红字是错误的反馈 ——
/// 那会让用户以为点坏了。
///
/// `async` + `spawn_blocking`：系统文件对话框会阻塞调用线程直到用户点完（可能几十秒）。
/// 它是**模态**的，钉住线程就等于钉住窗口消息泵 —— 那正是本仓在 `dc_preview` 上记过的
/// 「未响应」形状。
#[tauri::command]
pub async fn dc_pick_wallpaper(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let app_for_task = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        // 父窗口句柄：让对话框挂在主窗口上（模态）。拿不到就退化成无主框，不拦。
        let parent = app_for_task
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize);
        crate::wallpaper::pick_image(parent)
    })
    .await
    .map_err(|e| format!("E_WALLPAPER_PICK：对话框那条线程没跑完（{e}）"))??;

    let source = match picked {
        crate::wallpaper::PickOutcome::Cancelled => {
            return Ok(serde_json::json!({ "ok": true, "cancelled": true }));
        }
        crate::wallpaper::PickOutcome::Picked(p) => p,
    };

    let dir = crate::wallpaper::wallpaper_dir(
        &app.path()
            .app_data_dir()
            .map_err(|e| format!("E_WALLPAPER_DIR：拿不到应用数据目录：{e}"))?,
    );
    let stored = crate::wallpaper::store_wallpaper(&dir, &source)?;
    let done = format!("file:{stored}");

    // 存完之后**顺手把设置落盘**：只复制不记设置的话，用户重启之后看到的是旧背景，
    // 而磁盘上躺着一张没人引用的图 —— 那是"看着接上了其实没有"的典型形状。
    let settings_path = crate::settings::settings_path(&app)?;
    let saved = crate::settings::save_settings(&settings_path, &serde_json::json!({ "wallpaper": done }))?;

    let shown = source.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    Ok(serde_json::json!({
        "ok": true,
        "name": shown,
        // 回**存下来那份**里的 wallpaper，不是我们拼的那个串 —— 与 `dc_settings_set` 同一条纪律：
        // 服务端要是把文件名消毒掉了，界面要看得见。
        "wallpaper": saved.wallpaper,
    }))
}

/* ------------------------------------------------------------------ *
 * §报告导出（M5-E⑤）
 * ------------------------------------------------------------------ */

/// 把这一趟扫描换成一份带 schema 版本的 JSON，交给**用户选的位置**。
///
/// 三条与基准同形的判断，都写在这里而不是藏在某个 helper 里：
/// - 会话不在了 → `{ok:false, error:"E_NO_SCAN：…"}`，不弹框（弹一个"存什么"的框而答案是没有）；
/// - 用户取消 → `{ok:false, error:"已取消"}`。**取消不是错误也不是失败**，所以 `ok:false` 但
///   不带 `E_` 前缀 —— 界面那句是照抄回来的原话；
/// - 写失败 → `{ok:false, error:"E_WRITE：…"}`，点名写到哪一格失败了。
///
/// `async`：原生保存框会等用户（可能几十秒），同步命令钉的是窗口线程。
#[tauri::command]
pub async fn dc_export_report(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<serde_json::Value, String> {
    use tauri::Manager;

    let picked = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&scan_id).cloned()
    };
    let Some(session) = picked else {
        return Ok(serde_json::json!({ "ok": false, "error": "E_NO_SCAN：这次扫描会话已经不在了" }));
    };
    let report = {
        let st = session.state.lock().unwrap();
        let Some(tree) = st.tree.as_ref() else {
            return Ok(serde_json::json!({ "ok": false, "error": "E_NO_SCAN：这一趟还没有完整的树（没扫完就没有报告）" }));
        };
        let snap = service::snapshot_of(&session, &st);
        crate::report::build_report(
            &snap,
            tree,
            tree.top_files(),
            app.package_info().version.to_string(),
            service::now_ms(),
            crate::report::DEFAULT_MAX_DEPTH,
            crate::report::DEFAULT_TOP_PER_LEVEL,
        )
    };

    // 落点：**应用数据目录下的 reports/，文件名固定 `deepclean-report-<scanId>.json`**。
    //
    // 这里偏离了基准一处，且是刻意的：Electron 那边弹 `showSaveDialog` 让用户选位置，
    // 而本机 (Windows 11 + WebView2 + tauri-plugin-dialog 2.7.3) 上这条通道**弹不出框**：
    // 真机探针等 25 s，本进程除了主窗口没有任何额外顶层窗口（只有一个 `Tao Thread Event Target`），
    // `save_file` 的回调也从不触发 —— 命令于是永远不返回，界面连「已取消」都念不出来。
    // 一条没人能在真机上验完的交互通道，比一条位置固定但端到端验过的通道更差，所以换成后者：
    // 位置由服务端定，**并把那个位置原样念给用户**（`{ok:true, path}` → 界面那句「已导出：<路径>」）。
    // 代价：用户不能选别的位置；要改位置得先落在这里再挪。登记在验收文档 §⑤ 的"偏离"里。
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_WRITE：拿不到应用数据目录：{e}"))?
        .join("reports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("E_WRITE：建不出 reports 目录（{e}）"))?;
    let path = dir.join(format!("deepclean-report-{scan_id}.json"));
    let body = serde_json::to_string_pretty(&report).map_err(|e| format!("E_WRITE：报告序列化失败（{e}）"))?;
    if let Err(e) = std::fs::write(&path, format!("{body}
")) {
        return Ok(serde_json::json!({ "ok": false, "error": format!("E_WRITE：没能写到 {path:?}（{e}）") }));
    }
    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy() }))
}

/* ------------------------------------------------------------------ *
 * §7 视图排除（M5-E③）
 * ------------------------------------------------------------------ */

/// 只改**视图**：那个目录从地图这一层消失，计数、计价、预估一律照旧（判据在 `service::set_excluded`）。
#[tauri::command]
pub async fn dc_set_excluded(
    state: State<'_, AppState>,
    scan_id: String,
    dir_id: i64,
    excluded: bool,
) -> Result<bool, String> {
    Ok(service::set_excluded(&state, &scan_id, dir_id, excluded))
}

#[tauri::command]
pub async fn dc_clear_exclusions(state: State<'_, AppState>, scan_id: String) -> Result<bool, String> {
    Ok(service::clear_exclusions(&state, &scan_id))
}

/* ------------------------------------------------------------------ *
 * §28 白名单：在资源管理器里显示 / 用关联程序打开（M5-E②）
 * ------------------------------------------------------------------ */

/// 两条命令**共用同一个判据**：这个路径是不是某一轮已扫会话真见过的东西。
/// 不是 → `E_UNTRUSTED_PATH`，且什么都不做。没有这道闸，这两条就是
/// 「让渲染端以用户权限启动任意路径」—— 那是把 §18 那条「清单由服务端自己取」
/// 的纪律从执行面借了回来。
///
/// `async`：`ShellExecuteW` 会等关联程序接活（慢的处理器能到几百毫秒），同步命令钉的是窗口线程。
#[tauri::command]
pub async fn dc_reveal_path(
    state: State<'_, AppState>,
    abs_path: String,
) -> Result<(), String> {
    crate::paths::guard(&state, &abs_path)?;
    crate::paths::reveal_in_explorer(&abs_path);
    Ok(())
}

#[tauri::command]
pub async fn dc_open_item(
    state: State<'_, AppState>,
    abs_path: String,
) -> Result<(), String> {
    crate::paths::guard(&state, &abs_path)?;
    crate::paths::open_with_default_app(&abs_path);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * §3.6 开发环境页（M5-D2）
 * ------------------------------------------------------------------ */

/// 那一页的只读视图。**是 `async` 而不是普通 `fn`**：一次调用要起 11 趟 `where` 加一趟
/// `docker system df`（那条给到 8 s），而同步命令跑在窗口线程上 —— 那 8 秒里整个界面是钉住的，
/// 用户看到的是"点了没反应"。异步命令走 Tauri 的线程池，窗口照常 repaint。
///
/// 这一条通道**没有任何删除能力**：它把既有结论（探测 + 已算好的预估）换个形状交出去，
/// 产生的不是确认资格，是一份只读清单。
#[tauri::command]
pub async fn dc_dev_env_view(
    state: State<'_, AppState>,
    scan_id: Option<String>,
) -> Result<deepclean_devenv::DevEnvView, String> {
    let install = service::detector_status(&state);
    let docker = service::detect_docker_usage();
    Ok(service::assemble_dev_env_view(&state, scan_id.as_deref(), install, Some(docker)))
}

/* ------------------------------------------------------------------ *
 * §18 执行 / §19 验证 / §1.7 记录（M3-C）
 * ------------------------------------------------------------------ */

/// **唯一会动文件系统的入口**。只认确认回执的指纹 —— 渲染端报上来的路径清单一律不作数，
/// 清单是确认那一刻由主进程从已扫好的树里另取的那一份（`service::executable_paths`）。
#[tauri::command]
pub async fn dc_execute(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    confirmation_digest: String,
) -> Result<deepclean_cleaner::CleanTask, String> {
    service::run_cleanup(&app, &state, &confirmation_digest)
}

/// 一键清理（2026-10-24 改口径）：**只清界面上勾选的内容**。
///
/// 三件事变了，都有理由写在 `service::run_auto_clean` 那段：
/// 1. 不再有设置开关（`autoCleanEnabled` 已删）；
/// 2. 名单由渲染端报（`selection` + `tilePaths`）—— 但仍只是「勾了哪几条规则」，
///    路径清单依旧由服务端从报告里取，渲染端插不进来；
/// 3. 授权根改成按规则地盘分批（扫盘根时不再整批被 `root-is-drive-root` 拒）。
///
/// 仍然是**真删**（`permanent=true`，不进回收站）—— 那是人类伙伴当天选的。
/// 逐条进度走 `dc://clean-progress` 事件，回执形状与 `dc_execute` 同一份。
#[tauri::command]
pub async fn dc_auto_clean(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scan_id: String,
    selection: serde_json::Value,
    tile_paths: Option<Vec<serde_json::Value>>,
) -> Result<deepclean_cleaner::CleanTask, String> {
    service::run_auto_clean(
        &app,
        &state,
        &scan_id,
        selection,
        tile_paths.unwrap_or_default(),
    )
}

#[tauri::command]
pub fn dc_cancel_cleanup(state: State<'_, AppState>, task_id: String) -> bool {
    service::cancel_cleanup(&state, &task_id)
}

#[tauri::command]
pub fn dc_clean_task(state: State<'_, AppState>, task_id: String) -> Option<deepclean_cleaner::CleanTask> {
    state.tasks.lock().unwrap().get(&task_id).cloned()
}

#[tauri::command]
pub fn dc_list_clean_tasks(state: State<'_, AppState>) -> Vec<deepclean_cleaner::CleanTask> {
    let order = state.task_order.lock().unwrap();
    let tasks = state.tasks.lock().unwrap();
    // 新的在前：记录页第一屏要看到的是"刚才那次"。
    order.iter().rev().filter_map(|id| tasks.get(id).cloned()).collect()
}

/// 清理日志列表（2026-10-25 重做）：**一次清理一条**，倒序，30 天窗口外的不回。
///
/// 删掉了旧的 `dc_clean_journal(filter) -> JournalPage`（三维筛选 + 逐文件分页）：
/// 那一版的数据源是内存里「一个文件一行」的账本，已经整套换掉了。
#[tauri::command]
pub fn dc_journal_runs(state: State<'_, AppState>) -> Vec<deepclean_cleaner::CleanRun> {
    service::journal_runs(&state)
}

/// 某一次清理的**第一层**目录汇总。详情页打开时只拉这一个（懒加载第一段）。
#[tauri::command]
pub fn dc_journal_dir_tree(
    state: State<'_, AppState>,
    run_id: String,
) -> Vec<deepclean_cleaner::DirSummary> {
    service::journal_dir_summary(&state, &run_id)
}

/// 某个目录的下一层（懒加载：点开一层拉一层）。
#[tauri::command]
pub fn dc_journal_dir_children(
    state: State<'_, AppState>,
    run_id: String,
    dir: String,
) -> Vec<deepclean_cleaner::DirEntry> {
    service::journal_dir_children(&state, &run_id, &dir)
}

/* ------------------------------------------------------------------ *
 * M4 离线授权（只转发 crate 的两个语义入口）
 * ------------------------------------------------------------------ */
/// 激活。**唯一会写授权文件的命令**：`device.key`（DPAPI 保护）+ `license.dat`。
/// 判定（码在不在表里、签名对不对、绑没绑本机）全在 `deepclean-license` 里。
#[tauri::command]
pub fn dc_license_activate(app: tauri::AppHandle, code: String) -> Result<serde_json::Value, String> {
    service::license_activate_at(&app, &code)
}

/// 查授权状态。**只读**（不建目录、不生成设备密钥）。
#[tauri::command]
pub fn dc_license_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    service::license_status_at(&app)
}

/// 「关于」那一格的版本号。**从构建期嵌进二进制的包元数据取，不写字面量** ——
/// `Settings.tsx:72` 把这条规矩写在了界面上：拿一个写死的 `0.1.0` 顶上去，
/// 就会和 `package.json` 分叉成两句真话（下面那条闸钉的就是这个）。
#[tauri::command]
pub fn dc_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 这台机器的并行能力（2026-10-29，设置页「删除速率」那格滑块的真读者）。
///
/// ## 为什么要给渲染端
///
/// 那一格的保险机制是「拉到阈值之外 → 弹窗 → 自动拉回阈值」，而**阈值就是
/// 这台设备的逻辑核数**。渲染端自己算不出来（浏览器 API `navigator.hardwareConcurrency`
/// 给的是 WebView2 那个进程看到的数，与 Rust `available_parallelism` 不是同一个来源，
/// 在那台开了 CPU 组的机器上会给出两个不同的答案 —— 而两个答案就是两套真相）。
///
/// ## 为什么只报核数，不报"推荐档位"
///
/// 推荐档位 = 核数，两者今天同值。**不把两者合并成一个字段**：将来若把推荐档改成
/// "核数的一半"（那是产品决定，不是硬件事实），这个命令不用跟着变。
/// 一个字段只装一件事。
///
/// ## 内核与这里的区别（别把两处混成一处）
///
/// 这里报的是**硬件事实**；内核 `clamp_workers` 用的是同一个 `available_parallelism`
/// 但夹的是 `1..=核数×2`。界面这一侧拿核数当阈值是**交互决定**（再往上只是排队），
/// 内核那一侧拿 ×2 是**安全兜底**（手改 settings.json 的入口）。
#[tauri::command]
pub fn dc_hardware() -> serde_json::Value {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1);
    serde_json::json!({ "logicalCores": cores })
}


#[cfg(test)]
mod registration_tests {
    /// `generate_handler![ ... ]` 里逐条注册的命令名。
    ///
    /// 只取那个方括号片段，不拿整份 `main.rs` 全文找 —— `main.rs` 里 `deepclean_license::name()`
    /// 那一行也含 "license"，全文扫会得到一条**看着对但其实量错了**的计数。
    fn registered() -> Vec<String> {
        let src = include_str!("main.rs");
        let tail = src.split("generate_handler![").nth(1).expect("main.rs 里没有 generate_handler!");
        let block = tail.split(']').next().expect("generate_handler! 的列表没有收尾");
        block
            .split(',')
            .map(|s| s.trim().trim_start_matches("commands::").to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// 本文件**定义**了的命令名，全名带 `dc_` 前缀 —— 与 `registered()` 同一形状。
    /// （两侧形状不一致时这条闸会把「十五条全都没注册」报成缺漏，而真正缺的只有两条：
    /// 判据必须先证明它量的是名字，不是前缀差异。）
    ///
    /// 找的是 `fn dc_` 而**不是** `pub fn dc_`：`dc_dupes_run` 是 `pub async fn`，
    /// 按后者写就会让一条异步命令从这条闸的眼皮底下漏掉（写它的时候才撞上）。
    ///
    /// 只扫 `#[cfg(test)]` 之前的生产片段：判据咬到自己写的说明文字，
    /// 是这条闸唯一有意义的假红来源。
    fn defined() -> Vec<String> {
        let src = include_str!("commands.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or("");
        production
            .lines()
            .filter_map(|line| {
                let at = line.find("fn dc_")?;
                let rest = &line[at + "fn ".len()..];
                Some(rest.split('(').next()?.to_string())
            })
            .collect()
    }

    /// **每条定义都必须真被注册**。这就是 M4 那个缺漏的形状：命令写好了、crate 里测试全绿，
    /// 而 `main.rs` 没登记它 —— 于是前端调用得到一个「命令不存在」，而没有任何一道闸红过。
    #[test]
    fn every_command_defined_here_is_registered_in_the_shell() {
        let reg = registered();
        let missing: Vec<String> = defined().into_iter().filter(|name| !reg.contains(name)).collect();
        assert!(missing.is_empty(), "这些命令定义了却没注册（渲染进程调不到）：{missing:?}");
    }

    /// **注册了的命令必须真有人调**（上面那条闸的反方向）。
    ///
    /// 它钉的是另一类腐坏：命令活着、注册表里有、桥里没人调 —— 于是"界面已接通"那句话
    /// 会悄悄变成假话，而**没有任何一道闸红过**。这一条就是被现场逼出来的：本文件头部
    /// 一直写着「M2 只接九个命令，其余 11 个该报错」，而实际 29 条早已全接完（M5-E 收尾时
    /// 删掉了桥里最后一个桩）。没人删那句，因为那个方向没人量。
    ///
    /// 注册表条数先设一道下限：`registered()` 解析落空时会返回空表，
    /// 空表让"没有孤儿"这句话恒真 —— 判据必须先证明它在数东西。
    #[test]
    fn every_registered_command_is_actually_called_from_the_bridge() {
        let reg = registered();
        assert!(reg.len() >= 25, "注册表只解析出 {} 条 = 解析落空，这条判据会恒真", reg.len());
        let bridge = include_str!("../../src/renderer/tauri-bridge.ts");
        let called: Vec<String> = bridge_calls(bridge).into_iter().map(|(n, _)| n).collect();
        assert!(called.len() >= 25, "桥里只解析出 {} 个调用点 = 解析落空", called.len());
        let orphan: Vec<String> = reg.into_iter().filter(|n| !called.contains(n)).collect();
        assert!(
            orphan.is_empty(),
            "这些命令注册了但桥里没人调（要么接上界面，要么摘掉注册并在验收里说明为什么留着）：{orphan:?}"
        );
    }

    /// **桥 ↔ 命令的参数名对账**。
    ///
    /// 漂了会长这样：JS 送 `dupGroupIds` 而 Rust 形参改叫 `dup_ids` ⇒ Tauri 把它当"没给"，
    /// `Option` 静默成 `None` ⇒ **重复项整个从预估里消失**，而 vitest 与 `cargo test` 各自全绿
    /// （一边测"桥发出了键"，一边测"函数收到了参数"，中间那段线没人量）。
    /// 上面那条注册闸钉的是"命令写好了没登记"，这一条钉"登记了但参数名对不上"——
    /// 同一个洞的另一种漏法。跨语言没有更硬的办法，只能两侧都取名字再比。
    #[test]
    fn every_argument_the_bridge_sends_is_a_declared_parameter() {
        let bridge = include_str!("../../src/renderer/tauri-bridge.ts");
        let calls = bridge_calls(bridge);
        assert!(calls.len() >= 12, "桥里只解析出 {} 个调用点 = 解析器落空了，这条判据就是恒真", calls.len());

        let mut checked = 0usize;
        let mut bad: Vec<String> = Vec::new();
        for (cmd, keys) in &calls {
            if keys.is_empty() {
                continue; // `invoke('dc_drives')` 那种无参调用
            }
            let params = rust_params(cmd);
            assert!(!params.is_empty(), "`{cmd}` 在 commands.rs 里找不到形参 = 解析器落空");
            for k in keys {
                if !params.contains(k) {
                    bad.push(format!("{cmd} 送了 {k}，而它没有这个形参（真有的形参：{params:?}）"));
                }
            }
            checked += 1;
        }
        assert!(checked >= 10, "一个都没比上（{bad:?}）—— 解析器落空就等于这条闸不存在");
        assert!(bad.is_empty(), "桥与命令的参数名对不上：\n{}", bad.join("\n"));

        // 反空跑：解析器必须真能抓出"多送一个不认识的键"这个形状，否则上面那句"没有违例"毫无意义。
        let probe = bridge_calls("invoke('dc_demo', { ok: 1, nope: 2 });");
        assert_eq!(probe.len(), 1, "探针没解析出调用点");
        let declared = rust_params("dc_preview");
        assert!(
            probe[0].1.iter().any(|k| !declared.contains(k)),
            "探针自己都没落在'未声明'那一侧，说明比对那一段是空的"
        );
        // dc_preview 那一路必须真的在表里（这一棒新加的键就是它要守的东西）
        let preview = calls.iter().find(|(c, _)| c == "dc_preview").expect("桥里没有 dc_preview");
        // ~~`dupGroupIds` / `dupExclusions`~~：重复文件检测（§20）下线后这两个键从请求体里撤了，
        // 换成钉 `tilePaths`（§12 那一条现在是 dc_preview 唯一的具体路径通道）。
        assert!(preview.1.contains(&"tilePaths".to_string()), "dc_preview 没送 tilePaths：{:?}", preview.1);
        assert!(preview.1.contains(&"acknowledgedRisk".to_string()), "dc_preview 没送 acknowledgedRisk：{:?}", preview.1);
    }

    /// **桥刻意不送的形参豁免表**（键 = `命令:形参`）。
    ///
    /// 唯一合法进入这张表的理由是「服务端自己有个更权威的默认值，渲染端不送才是对的」，
    /// **不是**「现在没人用所以先跳过」。每一条都要写清楚默认值在哪、不送的方向是什么，
    /// 因为"漏送"与"刻意不送"在键缺失这一刻长得完全一样，只有这里的登记能区分它们 ——
    /// 而区分这件事本身有安全含义：漏送走兜底可能让功能静默死掉，刻意不送是设计。
    ///
    /// - `dc_children:cap`：`commands.rs:86` 是 `cap.unwrap_or(DEFAULT_LEVEL_CAP)` ——
    ///   层级上限由服务端按树的规模定，渲染端送一个自己猜的 cap 反而会让它拿到
    ///   一个**小于**服务端认为合适的值。方向是少画，不是多删，但没有产品需求要它。
    ///   真要让界面能控制时，它必须同时进 `PreviewRequest` 那一侧同批改。
    fn bridge_omitted_on_purpose() -> Vec<&'static str> {
        vec!["dc_children:cap"]
    }

    /// **反过来：每个声明的形参，桥都得真送过一遍**（上面那条闸漏掉的那半边）。
    ///
    /// 上面那条只查「桥送的键服务端有没有」，所以**少送**它一句都不响。而少送的代价正是
    /// 本仓已经付过两次的学费，而且两次都是静默的：
    ///
    /// - `acknowledgedRisk`（2026-10-14，M5-P1 推翻）：`tauri-bridge.ts:272` 只送
    ///   `confirm.acknowledged` ⇒ 服务端 `service.rs:663` 按 `unwrap_or(Caution)` 兜底
    ///   ⇒ **任何含 🟠 的预估在界面上永远确认不动**。646 条闸全绿抓不到它。
    /// - `dupExclusions`（`tauri-bridge.ts:266-268` 那段注释记着）：内联字面量漏了它，
    ///   TS 的方法双变让它编得过、跑得通，用户点的「这份别删」被静默丢掉 ——
    ///   界面按摘过算价钱、服务端按没摘算工作单，方向是**多删**。
    ///
    /// 共同形状：`Option<T>` 形参在键缺失时塌成兜底值，不报错、不报警，只是功能死掉。
    /// 所以判据必须是「形参表 ⊆ 桥送的键集合」，两个方向都咬住才算把这根线量完了。
    ///
    /// **为什么不用「全部形参」而当排除法**：三条是壳层注入的，不由渲染端送 ——
    /// `app: AppHandle`（命令自己带）、`state: State<AppState>`、以及每个命令都有的
    /// `scan_id` 那一类其实**要**送，所以只剔注入型。另外 `dc_license_*` 只暴露两条命令，
    /// 那一族形参本来就该齐；真正要防的是 `dc_preview` / `dc_execute` 这种**形参多、
    /// 且多数是 `Option`** 的命令。
    #[test]
    fn every_declared_parameter_is_actually_sent_by_the_bridge() {
        let bridge = include_str!("../../src/renderer/tauri-bridge.ts");
        let calls = bridge_calls(bridge);
        assert!(calls.len() >= 12, "桥里只解析出 {} 个调用点 = 解析器落空", calls.len());

        let mut checked = 0usize;
        let mut bad: Vec<String> = Vec::new();
        for (cmd, keys) in &calls {
            // **先证函数声明真被找到了，再谈零参**。`rust_params` 在「命令不存在」与
            // 「命令确实一个渲染端形参都没有」这两种情况下**都返回空表**，而第二种是合法的
            // （`dc_drives` / `dc_app_version` 这类本来就没有参数），第一种是解析器落空。
            // 直接把空表当"跳过"，就会把解析器坏掉伪装成"这条命令不用送东西" ——
            // 正是上面那条注册闸注释里点名的恒真形态。所以顺序固定为：
            // 声明在不在 → 形参空不空 → 逐条比。
            let src = include_str!("commands.rs");
            assert!(
                src.contains(&format!("fn {cmd}(")),
                "`{cmd}` 在 commands.rs 里找不到函数声明 = 桥叫了一个这里没定义的命令，或解析器落空"
            );
            let params = rust_params(cmd);
            if params.is_empty() {
                continue; // 声明在、形参表为空 ⇒ 壳层只注入型参数（app / state），没有要送的东西
            }
            for p in &params {
                if keys.contains(p) {
                    continue;
                }
                // 豁免表是显式登记、带理由的（见 `bridge_omitted_on_purpose`）；
                // 不在表里的一条都算漏送，直接点名为缺陷。
                let tag = format!("{cmd}:{p}");
                if bridge_omitted_on_purpose().contains(&tag.as_str()) {
                    continue;
                }
                bad.push(format!("`{cmd}` 声明了形参 {p}，而桥里从来没送过它（送了的键：{keys:?}）"));
            }
            checked += 1;
        }
        assert!(checked >= 10, "一个都没比上（{bad:?}）—— 解析器落空就等于这条闸不存在");
        assert!(
            bad.is_empty(),
            "桥漏送的形参（键缺失时服务端会按兜底值走，功能静默死掉）：\n{}",
            bad.join("\n")
        );

        // 反空跑：这条闸必须真能抓到「声明了但没送」这个形状。
        // 拿 `acknowledgedRisk` 当活靶 —— 它就是 2026-10-14 那次事故漏掉的那个键。
        // ~~另两个活靶是 `dupGroupIds` / `dupExclusions`~~：那两个形参随 §20 下线一起撤了，
        // 现在探针漏的是 `acknowledgedRisk` + `tilePaths` 两条。
        let probe = bridge_calls("invoke('dc_preview', { scanId, selection, confirm });");
        assert_eq!(probe.len(), 1, "探针没解析出调用点");
        let declared = rust_params("dc_preview");
        let missing: Vec<&String> = declared.iter().filter(|p| !probe[0].1.contains(p)).collect();
        assert!(
            missing.len() >= 2,
            "探针该漏掉 acknowledgedRisk/tilePaths 两条，实际只抓到 {missing:?} —— 比对那一段是空的"
        );
        assert!(
            missing.iter().any(|p| p.as_str() == "acknowledgedRisk"),
            "探针没抓到 acknowledgedRisk：{missing:?}"
        );
        // 剥注释那一下也必须证明自己干了活：`acknowledged_risk` 上面那段五行中文
        // 不该再出现在形参表里，而它自己必须在 —— 少任何一句，上面那条关于
        // "假形参顶掉真形参"的失效面就还开着。
        assert!(
            declared.iter().any(|p| p == "acknowledgedRisk"),
            "形参表里没有 acknowledgedRisk（注释没剥干净时它会被假形参顶掉）：{declared:?}"
        );
        for p in &declared {
            assert!(
                !p.contains("//") && !p.contains('：'),
                "形参名里混进了注释原文（{p:?}）—— 剥注释那一层坏了，真形参会从表里消失"
            );
        }
        // 豁免表不能变成永久旁路：它必须真的只登记了 `dc_children:cap` 这一条，
        // 且那条得是真存在于形参表里的 —— 否则将来有人往里塞一条不存在的项，
        // 就能把任何漏送悄悄洗掉。
        let omitted = bridge_omitted_on_purpose();
        assert_eq!(omitted, vec!["dc_children:cap"], "豁免表变了就重新审理由");
        assert!(
            rust_params("dc_children").iter().any(|p| p == "cap"),
            "豁免的那一项 `dc_children:cap` 得真是个形参，否则这条豁免是在给一个不存在的东西开后门"
        );

        // 剥注释那一下的自证（活靶就是 `dc_preview` 本身 —— 它中间那段五行注释
        // 既含全角引号、又含半角冒号，正是这条解析器最容易漏键的形状）。
        // ~~`dupGroupIds` / `dupExclusions`~~：随 §20 下线从请求体撤了，活靶换成
        // `tilePaths`（现在是 `dc_preview` 唯一的具体路径通道）。
        let real = calls.iter().find(|(c, _)| c == "dc_preview").expect("桥里没有 dc_preview");
        for k in ["acknowledgedRisk", "tilePaths"] {
            assert!(
                real.1.contains(&k.to_string()),
                "bridcomment 剥注释坏了：{k} 从 `dc_preview` 的键集合里消失了（实际 {:?}）",
                real.1
            );
        }
    }

    /// 反空跑专用：把「注释紧跟一个键」这个形状单独拿出来判一次。
    ///
    /// 活靶用**半角双引号**（`"给了 null"`）—— 桥里 `dc_preview` 那段注释确实就是半角 ASCII 引号
    /// （`tauri-bridge.ts:275` 实测：该片段里 ASCII `"` 正好 2 个、全角引号 0 个）。
    /// 只认全角引号的探针测不到真缺陷：状态机按字符匹配引号，半角那两个才真把它带偏。
    /// 第一版探针写的就是全角，于是它在**修好的解析器**上也照样绿 —— 探针与真缺陷不同形，
    /// 等于这条自证没证明任何东西。
    #[test]
    fn a_key_right_after_a_comment_is_not_swallowed_by_quote_tracking() {
        // 与 tauri-bridge.ts:273-276 同形：注释含半角引号与冒号，紧跟一个真键。
        let probe = bridge_calls(
            "invoke('dc_preview', {\n        confirm: req?.confirm?.acknowledged ?? null,\n        // 缺键与\"给了 null\"在服务端是两种状态: A 与 B\n        acknowledgedRisk: req?.confirm?.acknowledgedRisk ?? null,\n        tilePaths: req?.tilePaths ?? []\n      })",
        );
        assert_eq!(probe.len(), 1, "探针没解析出调用点");
        assert!(
            probe[0].1.contains(&"acknowledgedRisk".to_string()),
            "注释紧跟的键被吞了（{:?}）—— 注释里的半角引号把字符串状态机带偏了",
            probe[0].1
        );
        assert!(
            probe[0].1.contains(&"tilePaths".to_string()),
            "注释后面的键也一起被吞了（{:?}）",
            probe[0].1
        );
        // 反向半边：`in_comment` 必须在引号判定**之前**生效，否则注释里的引号会开一个
        // 幻字符串。这条断言钉的就是那个顺序本身。
        let keys = strip_line_comments("// 注释里有\"引号\": 冒号\nrealKey: 1");
        assert!(
            !keys.contains("//"),
            "剥注释没把 `//` 那一段抹掉：{keys:?}"
        );
        let only = top_level_keys("// x\"y: z\nrealKey: 1");
        assert_eq!(
            only,
            vec!["realKey".to_string()],
            "注释行应当整段消失、只留真键，实际 {only:?}"
        );
    }

    /// 取桥里每个 `invoke(...)` 的命令名 + 它对象字面量里的**顶层键**。
    /// 认的形状是 `invoke('dc_x', { … })` / `invoke<T>('dc_x', { a })`（简写键也算）/ `invoke('dc_x')`（无参）。
    ///
    /// **为什么必须按形状认，不能"看到 invoke 就往后找一个引号"**：本文件注释里有
    /// `能 invoke 成功、跑起来才发现形状不对"没人拦` 这种句子 —— 往后找到的那个 `"` 会造出一个
    /// 幽灵命令名，于是那条"找不到形参表就 panic"的断言当场假红（第一版就这么红过）。
    /// 现在要求 `invoke` 后面紧跟可选泛型 + `(` + 引号，且命令名必须以 `dc_` 起头。
    fn bridge_calls(src: &str) -> Vec<(String, Vec<String>)> {
        let mut out = Vec::new();
        let bytes: Vec<char> = src.chars().collect();
        let mut i = 0;
        while i + 6 <= bytes.len() {
            let is_call: bool = bytes[i..i + 6].iter().copied().eq("invoke".chars());
            if !is_call {
                i += 1;
                continue;
            }
            let mut j = i + 6;
            // 可选泛型实参 `invoke<CleanTask>(...)`
            if j < bytes.len() && bytes[j] == '<' {
                let mut gd = 1usize;
                while j < bytes.len() && gd > 0 {
                    j += 1;
                    match bytes.get(j) {
                        Some('<') => gd += 1,
                        Some('>') => gd -= 1,
                        _ => {}
                    }
                }
                j += 1;
            }
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if j >= bytes.len() || bytes[j] != '(' {
                i += 6;
                continue; // 不是调用点（注释、`const invoke = ...` 的定义、`.invoke(cmd, args)` 那类转发）
            }
            j += 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if j >= bytes.len() || (bytes[j] != '\'' && bytes[j] != '"') {
                i += 6;
                continue; // 命令名是变量（`invoke(cmd, args)`），不是字面量
            }
            let quote = bytes[j];
            let start = j + 1;
            // 从引号**之后**找配对的那个（从引号自己起步会立刻退出，切出反向区间而 panic）
            let mut c = start;
            while c < bytes.len() && bytes[c] != quote {
                c += 1;
            }
            if c >= bytes.len() {
                break;
            }
            let cmd: String = bytes[start..c].iter().collect();
            if !cmd.starts_with("dc_") {
                i = c.max(i + 6);
                continue;
            }
            // 找参数对象的左花括号（必须在同一次调用的右括号之前）
            let mut k = c + 1;
            let mut depth_paren = 1usize;
            let mut obj_start = None;
            while k < bytes.len() {
                match bytes[k] {
                    '(' => depth_paren += 1,
                    ')' => {
                        depth_paren -= 1;
                        if depth_paren == 0 {
                            break;
                        }
                    }
                    '{' if obj_start.is_none() => obj_start = Some(k + 1),
                    _ => {}
                }
                k += 1;
            }
            let Some(os) = obj_start else {
                out.push((cmd, Vec::new()));
                i = k.max(i + 6);
                continue;
            };
            // 跟着花括号深度取到与之配对的那个 `}`
            let mut d = 1usize;
            let mut m = os;
            while m < bytes.len() {
                match bytes[m] {
                    '{' => d += 1,
                    '}' => {
                        d -= 1;
                        if d == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                m += 1;
            }
            let body: String = bytes[os..m.min(bytes.len())].iter().collect();
            out.push((cmd, top_level_keys(&body)));
            i = m.max(i + 6);
        }
        out
    }

    /// 把对象字面量体里的 `//` 行注释整段抹掉（**引号内不算**）。
    ///
    /// 为什么必须先剥它：`top_level_keys` 按 `find(':')` 取键名，而注释里冒号比键里的多得多
    /// （`service::build_preview` 就有两个）。于是「注释行 + 紧跟一个键」这个形状会把
    /// **键自己吞掉** —— 键不再进集合，于是：
    /// - 对向的那条闸（桥送的键是不是都声明过）看不见这个键 ⇒ 少送它照样全绿；
    /// - 本闸（声明的形参是不是都送过）会把这个键报成"从没送过" ⇒ 拿一条**假缺陷**报警。
    ///
    /// 这不是假想：`dc_preview` 的 `acknowledgedRisk` 上面正压着一段五行中文说明，
    /// 剥掉之前解析出来的六个键里就是没有它，而 `tauri-bridge.ts:276` 明明送了。
    /// 顺带修掉同一族的另一半 —— 注释里的 `[` / `{` / `)` 会把 `depth` 计数带偏，
    /// 让后面的顶层键被误判成嵌套键。
    ///
    /// 引号要一路跟着走：`invoke('dc_x', { p: 'D://srv' })` 这种值里的 `//` 不是注释。
    /// 反引号与单双引号都认，中转义只当字面量处理（本文件的桥里没有跨行模板串，
    /// 真要有时先在此登记，别让"看着能跑"的假设代替量）。
    fn strip_line_comments(body: &str) -> String {
        let mut out = String::with_capacity(body.len());
        let mut quote: Option<char> = None;
        let mut escaped = false;
        let mut prev_was_slash = false;
        let mut in_comment = false;
        for c in body.chars() {
            // **`in_comment` 必须排在 `quote` 之前**：注释里的 ASCII 双引号（桥里
            // `dc_preview` 那段就有两个半角 `"`）会把状态机骗进"字符串里"，
            // 于是整段注释连同紧随其后的真键一起被当成字符串内容吃掉 ——
            // `acknowledgedRisk` 就是这么从键集合里消失的，而两条闸都看不见它。
            // 顺序反了等于这条闸整个失效，所以 `a_key_right_after_a_comment_…`
            // 专门用一个半角引号的活靶钉这个先后。
            if in_comment {
                if c == '\n' {
                    in_comment = false;
                    out.push(c); // 换行要留着：它是顶层切分的天然边界
                }
                continue;
            }
            if c == '/' && prev_was_slash {
                in_comment = true;
                out.pop(); // 把刚推进去的那个 `/` 收回来
                prev_was_slash = false;
                continue;
            }
            if let Some(q) = quote {
                out.push(c);
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            match c {
                '\'' | '"' | '`' => {
                    quote = Some(c);
                    out.push(c);
                }
                '/' => {
                    if prev_was_slash {
                        in_comment = true;
                        out.pop(); // 把刚推进去的那个 `/` 收回来
                        prev_was_slash = false;
                    } else {
                        out.push(c);
                        prev_was_slash = true;
                    }
                    continue;
                }
                _ => {
                    prev_was_slash = false;
                    out.push(c);
                }
            }
        }
        out
    }

    /// 对象字面量体的顶层键（`a: 1` 与简写 `a` 都算；嵌套对象里的键不算）。
    fn top_level_keys(body: &str) -> Vec<String> {
        // 注释先剥：否则注释里的冒号会把紧跟其后的真键名顶掉（见 `strip_line_comments`）。
        let body = strip_line_comments(body);
        let mut keys = Vec::new();
        let mut depth = 0i32;
        let mut item = String::new();
        let push = |item: &str, keys: &mut Vec<String>| {
            let t = item.trim();
            if t.is_empty() {
                return;
            }
            let head = match (t.find(':'), t.find(',')) {
                (Some(c), _) if c < t.len() => t[..c].trim(),
                _ => t,
            };
            let head = head.trim_end_matches([':', ',', ' ', '?']);
            if !head.is_empty()
                && head.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !head.chars().next().unwrap().is_ascii_digit()
            {
                keys.push(head.to_string());
            }
        };
        for ch in body.chars() {
            match ch {
                '{' | '[' | '(' => depth += 1,
                '}' | ']' | ')' => depth -= 1,
                ',' if depth == 0 => {
                    push(&item, &mut keys);
                    item.clear();
                    continue;
                }
                _ => {}
            }
            if depth == 0 {
                item.push(ch);
            }
        }
        push(&item, &mut keys);
        keys
    }

    /// `commands.rs` 里那条命令**声明**的形参名，snake → camel（Tauri 就按这个映射收键）。
    /// 注入型形参（`AppHandle` / `State<...>`）不由渲染端送，先剔掉。
    ///
    /// 全程按 **char** 走：本文件满是中文注释，拿字节下标去切 `&str` 会踩在非 UTF-8 边界上 panic
    /// —— 而 panic 与"这条闸没抓到东西"在测试输出里长得不太一样，但一样没用。
    ///
    /// **形参区间内的行注释必须先剥掉**：`dc_preview` 的 `acknowledged_risk` 上面压着一段
    /// 五行中文说明，不剥的话切出来的"形参"是 `// M5-P1 T4：…` 那一整坨，
    /// 于是真形参 `acknowledged_risk` 反而从表里消失 —— 判据会拿一个假形参去比键，
    /// 而真正的漏送它一条都看不见（第一版就是这么漏的）。
    fn rust_params(cmd: &str) -> Vec<String> {
        let src = include_str!("commands.rs");
        let Some(at) = src.find(&format!("fn {cmd}(")) else {
            return Vec::new();
        };
        let chars: Vec<char> = src[at..].chars().collect();
        let Some(open) = chars.iter().position(|c| *c == '(') else {
            return Vec::new();
        };
        let mut depth = 0i32;
        let mut end = open;
        while end < chars.len() {
            match chars[end] {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            end += 1;
        }
        if end >= chars.len() {
            return Vec::new();
        }
        // 按顶层逗号切（`State<'_, AppState>` 里的逗号在尖括号里，不算分隔）
        let mut parts: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut angle = 0i32;
        let mut paren = 0i32;
        // 形参区间内的 `//` 行注释：切顶层逗号之前先丢掉，否则注释里的中文与
        // 缩进会被当成一个形参名的一部分（见本函数文档）。
        let mut in_comment = false;
        for &c in &chars[open + 1..end] {
            if in_comment {
                if c == '\n' {
                    in_comment = false;
                }
                continue;
            }
            if c == '/' && angle <= 0 && cur.trim_end().is_empty() {
                in_comment = true;
                continue;
            }
            match c {
                '<' => angle += 1,
                '>' => angle -= 1,
                '(' => paren += 1,
                ')' => paren -= 1,
                _ => {}
            }
            if angle == 0 && paren == 0 && c == ',' {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            cur.push(c);
        }
        parts.push(cur);

        let mut out = Vec::new();
        for part in parts {
            let mut bits = part.splitn(2, ':');
            let name = bits.next().unwrap_or("").trim();
            let ty = bits.next().unwrap_or("").trim();
            if name.is_empty() || name.starts_with("mut ") {
                continue;
            }
            if ty.contains("AppHandle") || ty.contains("State<") {
                continue;
            }
            let mut camel = String::new();
            let mut up = false;
            for c in name.chars() {
                if c == '_' {
                    up = true;
                    continue;
                }
                camel.push(if up { c.to_ascii_uppercase() } else { c });
                up = false;
            }
            out.push(camel);
        }
        out
    }

    /// **授权只暴露两条命令**（`dc_license_activate` / `dc_license_status`）。
    ///
    /// 这条线来自 M4 验收：本 crate 的 `device::DeviceKey::seed()`、`CodeTable` 原文、
    /// `LicenseFile` 正文都是**能拿到但不该拿**的东西 —— 多开一条命令，私钥种子就可能顺着
    /// IPC 到渲染进程。数量闸比「逐一禁止字段」宽：它不看内容，只看门开了几扇。
    #[test]
    fn exactly_two_license_commands_are_exposed() {
        let mut got: Vec<String> = registered().into_iter().filter(|n| n.contains("license")).collect();
        got.sort();
        assert_eq!(
            got,
            vec!["dc_license_activate".to_string(), "dc_license_status".to_string()],
            "授权门开了几扇，就必须是这两扇"
        );
    }

    /// 「关于」那一格念的版本号来自 `tauri.conf.json`（构建期嵌进二进制），
    /// 而用户与发行看的是 `package.json`。两份分叉时界面不会报错，只会念出另一份 ——
    /// 所以这里逐字比那两个串，而不是"取一个版本号断言它非空"（那种断言恒真）。
    #[test]
    fn the_two_manifests_agree_on_the_version_the_about_row_shows() {
        let grab = |src: &str| -> String {
            let at = src.find("\"version\"").expect("清单里没有 version 键");
            let tail = &src[at..];
            let colon = tail.find(':').expect("version 键后面没有冒号") + 1;
            let q1 = colon + tail[colon..].find('"').expect("version 不是字符串") + 1;
            let q2 = q1 + tail[q1..].find('"').expect("version 的字符串没有收尾");
            tail[q1..q2].to_string()
        };
        let conf = grab(include_str!("../tauri.conf.json"));
        let pkg = grab(include_str!("../../package.json"));
        assert!(
            !conf.is_empty() && conf.chars().next().map_or(false, |c| c.is_ascii_digit()),
            "版本号形状不对：{conf:?}"
        );
        assert_eq!(conf, pkg, "Tauri 与 npm 两份清单的版本分叉了：{conf} vs {pkg}");

        // 反空跑：解析器必须真读出东西，否则上面那句相等是"两个空串相等"
        assert!(conf.len() >= 3, "解析出的版本号短得不像话：{conf:?}");
    }
}
