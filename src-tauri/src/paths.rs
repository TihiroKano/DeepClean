//! 「打开」与「在资源管理器里显示」—— §28 那道白名单的 Tauri 侧（M5-E②）。
//!
//! 基准：`electron/main/ipc-register.ts:108-115` + `core/scan/scanner.ts:555-566`（`knowsPath`）
//! + `electron/services/scan-service.ts:629-633`（`knownPath` 遍历所有 job）。
//!
//! ## 为什么这两条要有闸
//!
//! 渲染进程拿到的是一个**任意字符串**（右键菜单、地址栏、将来某个还没写出来的调用方）。
//! 没有这道闸，`dc_open_path` 就是「让渲染端在用户机器上以用户权限启动任意路径」——
//! 那是把 §18 那条「清单由服务端自己取」的纪律从执行面借了回来。所以两条命令**共用同一个判据**：
//! **这个路径是不是这轮扫描真见过的东西**。不是 → `E_UNTRUSTED_PATH`，且**不做任何事**。
//!
//! ## 判据的三格（逐字照抄基准，包括那两格看着反直觉的）
//!
//! 1. `parent_of` 给不出父目录（空串、裸 `C:`、单层名字）→ `false`。空串就死在这一格。
//! 2. 父目录不在这棵被扫的树上 → `false`。
//! 3. 父目录的子项（目录或文件）里有同名项（大小写折叠）→ `true`；
//!    **但如果这轮扫描被 `maxFiles` 截断过**，文件清单已经被丢掉了，无从核对 ——
//!    基准在这里退化成「父目录在树上即放行」，理由写在它自己的注释里：
//!    *这是只读工具，打开不等于删除*。这一格**照抄**，不收紧：收紧会让截断那台机器上的
//!    每一个右键都变成「不信任」，而那是要用户去理解的症状。
//!
//! 归一化只有一把：[`deepclean_rules::engine::normalize_key`]（与引擎的认领表、`TreeSource`
//! 同一份）。这里再造一把就是两套真相。

use crate::service::AppState;
use deepclean_rules::engine::normalize_key;
use deepclean_scanner::tree_index::TreeIndex;

/// 去掉尾部分隔符后取最后一个 `\` 之前那一段；给不出父目录时 `None`。
/// 基准 `pathutil.ts:28-35`，包括那句**看着多余**的补回：去掉分隔符会把盘符根变成裸 `C:`，
/// 与树里那个 `c:\` 的键对不上，于是根目录下的项全被判成「不在树上」。
pub fn parent_of(p: &str) -> Option<String> {
    let s = p.trim_end_matches('\\');
    let i = s.rfind('\\')?;
    if i == 0 {
        return None;
    }
    let head = &s[..i];
    let is_drive_head =
        head.len() == 2 && head.as_bytes()[0].is_ascii_alphabetic() && head.as_bytes()[1] == b':';
    Some(if is_drive_head { format!(r"{head}\") } else { head.to_string() })
}

/// 最后一个 `\` 之后的那一段（`pathutil.baseName` 在这一条链上的用法：输入是绝对路径）。
pub fn base_name_of(p: &str) -> String {
    let s = p.trim_end_matches('\\');
    match s.rfind('\\') {
        Some(i) => s[i + 1..].to_string(),
        None => s.to_string(),
    }
}

/// 这一棵树上认不认这个路径。**注意 `truncated` 是从会话里取的 global 口径**
/// （TS 那边是 `store.truncated`，不是"这一层被截断"），所以它由调用方传进来，
/// 省得这里再长出一份"什么算截断"的第二定义。
pub fn knows_path_in_tree(idx: &TreeIndex, truncated: bool, abs: &str) -> bool {
    let Some(parent) = parent_of(abs) else { return false };
    let parent_key = normalize_key(&parent);
    // 线性找父目录：一次点击只问一遍，为它建一张 30 万条的索引不划算（`TreeSource` 那张是给
    // 引擎逐条评估用的，那是另一个访问形状）。
    let Some(dir) = idx.iter_dirs().find(|d| normalize_key(&d.path) == parent_key) else {
        return false;
    };
    let name = base_name_of(abs).to_lowercase();
    if dir.child_dirs.iter().filter_map(|c| idx.dir(*c)).any(|c| c.name.to_lowercase() == name) {
        return true;
    }
    if truncated {
        return true;
    }
    dir.files.iter().any(|f| f.name.to_lowercase() == name)
}

/// 渲染端报来的这个路径，是不是**某一轮已扫会话**真见过的东西（基准：`knownPath` 遍历所有 job）。
pub fn known_path(state: &AppState, abs: &str) -> bool {
    if abs.is_empty() {
        return false;
    }
    let sessions: Vec<_> = state.sessions.lock().unwrap().values().cloned().collect();
    for s in sessions {
        let st = s.state.lock().unwrap();
        if let Some(idx) = st.tree.as_ref() {
            if knows_path_in_tree(idx, st.truncated(), abs) {
                return true;
            }
        }
    }
    false
}

/// 两条命令共用的那道闸：**过不了就什么都不做**。
/// 做成一个返回 `Result` 的函数而不是在命令里写 `if !known_path { ... }`，是为了让
/// 「拒绝」这一格能被单测反复验 —— 界面上走不到它（渲染端只能从已扫的树里拿路径），
/// 所以真机给不出这个证据，只能在这里给。
pub fn guard(state: &AppState, abs: &str) -> Result<(), String> {
    if known_path(state, abs) {
        Ok(())
    } else {
        Err("E_UNTRUSTED_PATH: 这个路径不在任何一轮已扫的树上，不替它开".to_string())
    }
}

/// 在资源管理器里显示。**不关心退出码**：`explorer.exe` 成功时也常给非 0，
/// 而基准那侧（`shell.showItemInFolder`）是返回 void 的 —— 报"打开失败"会是假话，
/// 报"打开成功"同样是假话，所以两条都不报：闸门过了就交出去。
pub fn reveal_in_explorer(abs: &str) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer.exe")
        .arg(format!("/select,{abs}"))
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn();
}

/// 用系统关联的程序打开。走 `ShellExecuteW`（Electron 的 `shell.openPath` 底下就是它），
/// 而不是 `cmd /c start` —— 后者要多起一个进程、要处理"第一个带引号的参数是窗口标题"那套
/// 语义，而这两条都不是我们要验的东西。
///
/// 返回值照基准丢掉：`openPath` 交回来的是一句人话错误串，契约（`Promise<void>`）装不下它，
/// 而这一侧也一样 —— 判据放行之后打不开是什么东西（关联程序没了、UAC 拦了），
/// 不是这条链能负责说清的。
pub fn open_with_default_app(abs: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOW;
    use windows_sys::Win32::Foundation::HWND;

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    };
    let item = wide(abs);
    // `NULL` 窗口句柄：这条链上没有归属窗口（命令跑在工作线程上），系统对话框会自己找主人
    let hwnd = std::ptr::null_mut() as HWND;
    let op = wide("open");
    unsafe {
        // 第 4/5 参（工作目录、额外参数）在这份绑定里都是 `*const u16`，给 null 就是"用默认"
        ShellExecuteW(hwnd, op.as_ptr(), item.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOW);
    }
}

/* ================================================================== *
 * 单测
 *
 * 白名单的判据必须在**没有真 explorer**的前提下也能反复验，所以 `knows_path_in_tree` 吃一棵
 * 合成树。真机那两条（reveal / open）由 `scripts/m5e-paths-e2e.ps1` 点一次真的。
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
    use deepclean_scanner::tree_index::TreeIndex;
    use deepclean_scanner::volume::VolumeInfo;

    fn tree() -> TreeIndex {
        let mut leaf = ScanNode::dir("leaf".into(), r"D:\range\sub\leaf".to_string());
        leaf.files.push(ScanFile {
            name: "big.bin".into(),
            size: 10,
            alloc: 10,
            counted: 10,
            file_id: 3,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        leaf.file_count = 1;
        leaf.size_counted = 10;
        let mut sub = ScanNode::dir("sub".into(), r"D:\range\sub".to_string());
        sub.children.push(leaf);
        sub.dir_count = 1;
        let mut root = ScanNode::dir("range".into(), r"D:\range".to_string());
        root.files.push(ScanFile {
            name: "Top.TXT".into(),
            size: 5,
            alloc: 5,
            counted: 5,
            file_id: 1,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        root.children.push(sub);
        root.file_count = 1;
        root.dir_count = 1;
        root.size_counted = 15;
        TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo {
                serial: 1,
                label: "t".into(),
                total_bytes: 1u64 << 62,
                free_bytes: 0,
            },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        })
    }

    #[test]
    fn parent_of_keeps_the_drive_root_whole() {
        assert_eq!(parent_of(r"D:\range\sub").as_deref(), Some(r"D:\range"));
        assert_eq!(parent_of(r"C:\Users").as_deref(), Some(r"C:\"), "裸 'C:' 与树里的 'c:\' 对不上");
        // 尾分隔符先削掉再找父：`D:\range\sub\` 的父是 `D:\range`（不是 `D:\range\sub`）
        assert_eq!(parent_of(r"D:\range\sub\").as_deref(), Some(r"D:\range"));
        // 而 `D:\range\` 的父是**盘符根**，不是 `D:\range` —— 别把"去掉尾斜杠"读成"取这一层"
        assert_eq!(parent_of(r"D:\range\").as_deref(), Some(r"D:\"));
        assert_eq!(parent_of(""), None);
        assert_eq!(parent_of("just-a-name"), None);
        // `D:\x` 的父是盘符根 `D:\`（基准在 `i <= 0` 那一格回 null 的是**没有反斜杠**的输入）
        assert_eq!(parent_of(r"D:\x").as_deref(), Some(r"D:\"));
        assert_eq!(parent_of(r"C:").as_deref(), None, "裸盘符：没有分隔符");
    }

    #[test]
    fn the_whitelist_accepts_only_what_the_scan_really_saw() {
        let idx = tree();
        // 文件、子目录、深层项都认
        assert!(knows_path_in_tree(&idx, false, r"D:\range\Top.TXT"));
        assert!(knows_path_in_tree(&idx, false, r"D:\range\sub"));
        assert!(knows_path_in_tree(&idx, false, r"D:\range\sub\leaf\big.bin"));
        // 大小写折叠：这是 Windows 的口径，不是宽容
        assert!(knows_path_in_tree(&idx, false, r"d:\RANGE\top.txt"));
        // 正斜杠写法**不放行**：基准的 `parentOf` 只找反斜杠（`pathutil.ts:30`），
        // 所以 `D:/range/sub` 在第一格就 `null`。两侧同形，且这是**fail-closed** 的方向 ——
        // 记在这里是因为 `normalize_key` 会折斜杠，看着像这一格也该折。
        assert!(!knows_path_in_tree(&idx, false, r"D:/range/sub"));

        // 树上没有的东西：一律不放行
        assert!(!knows_path_in_tree(&idx, false, r"D:\range\evil.exe"));
        assert!(!knows_path_in_tree(&idx, false, r"D:\Windows\System32\cmd.exe"));
        assert!(!knows_path_in_tree(&idx, false, r"C:\Users\Kano\Desktop\thing.bat"));
        assert!(!knows_path_in_tree(&idx, false, ""));
        assert!(!knows_path_in_tree(&idx, false, r"D:\range\sub\leaf\deeper\x"));
        // 目录本身在树上，但**它不是任何父目录的子项**时也要放行（它就是那个父目录）——
        // 基准的形状：`dirIdByPath(parent)` 命中且名字在子项里。`D:\range` 的父是 `D:\`，
        // 不在这棵树里，所以根目录自己点「打开」是**不放行**的。这一格基准同样如此，照抄。
        assert!(!knows_path_in_tree(&idx, false, r"D:\range"));
    }

    #[test]
    fn a_truncated_scan_falls_back_to_the_parent_being_on_the_tree() {
        // 第三格：截断后文件清单已被丢掉，无从核对 —— 基准退化成「父目录在树上即放行」。
        // 这一条正反都要钉：`false` 时不放行（上面那条已钉），`true` 时放行（这一条）。
        let idx = tree();
        assert!(knows_path_in_tree(&idx, true, r"D:\range\not-in-the-list.exe"));
        // 但**父目录不在树上**时截断也救不了它 —— 退化只退一层，不是变成不设防
        assert!(!knows_path_in_tree(&idx, true, r"D:\elsewhere\x.exe"));
        assert!(!knows_path_in_tree(&idx, true, r"C:\Windows\System32\cmd.exe"));
    }

    #[test]
    fn the_command_gate_opens_for_tree_paths_and_refuses_everything_else() {
        // 这一格真机给不出证据（界面上走不到拒绝那条），所以在这里钉：
        // 同一个 `AppState`，树上有的放行、树上没有的一律 `E_UNTRUSTED_PATH`。
        use crate::service::{AppState, Session, SessionState, Status};
        use deepclean_scanner::scan::ScanControl;
        use std::sync::{Arc, Mutex};
        let idx = tree();
        let mut counters = Counters::default();
        counters.files = 3;
        let session = Arc::new(Session {
            id: "s1".into(),
            root: r"D:\range".into(),
            control: ScanControl::new(),
            report_cache: Mutex::new(None),
            deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters,
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(idx)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        });
        let state = AppState::default();
        state.sessions.lock().unwrap().insert("s1".into(), session);

        assert!(guard(&state, r"D:\range\Top.TXT").is_ok(), "树上真见过的文件必须放行");
        assert!(guard(&state, r"D:\range\sub\leaf").is_ok(), "树上真见过的目录也必须放行");
        for bad in [
            r"C:\Windows\System32\cmd.exe",
            r"D:\range\evil.exe",
            r"D:\range\sub\leaf\not-there.log",
            "",
            "not-a-path",
        ] {
            let err = guard(&state, bad).unwrap_err();
            assert!(err.starts_with("E_UNTRUSTED_PATH"), "{bad:?} 该被拒，实际：{err}");
        }
    }

    #[test]
    fn base_name_matches_the_shape_the_gate_needs() {
        assert_eq!(base_name_of(r"D:\range\sub\leaf\big.bin"), "big.bin");
        assert_eq!(base_name_of(r"D:\range\"), "range", "尾分隔符先削掉再取名");
        assert_eq!(base_name_of("plain"), "plain");
    }
}
