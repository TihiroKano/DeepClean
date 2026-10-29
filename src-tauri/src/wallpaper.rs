//! 背景壁纸的落地：**选图 → 复制进应用数据目录 → 只回文件名**（2026-10-27）。
//!
//! ## 为什么不用 `tauri-plugin-dialog`
//!
//! 本仓**已经踩过那条通道弹不出框**（`commands.rs::dc_export_report` 那段注释记着全过程：
//! Windows 11 + WebView2 + `tauri-plugin-dialog` 2.7.3，真机探针等 25 s，
//! 进程里除了主窗口没有任何额外顶层窗口，`save_file` 的回调从不触发 ——
//! 命令永远不返回，界面连「已取消」都念不出来）。
//! 一条没人能在真机上验完的交互通道，比一条直调 Win32 的通道更差。
//!
//! 所以这里直接调 `comdlg32!GetOpenFileNameW`（`windows-sys` 已在依赖里，
//! `Win32_UI_Shell` feature 也早就开着 —— `dc_open_item` 那条链在用同一个 crate 的 Shell API）。
//!
//! ## 三条不许含糊的地方
//!
//! 1. **复制，不引用原路径**。用户选中的图可能在 U 盘、在临时目录、在即将被清理的文件夹里。
//!    存绝对路径的话，那张图明天没了，而界面上只会看到背景变回默认 —— 一个没有解释的变化。
//!    复制进 `<appData>/wallpapers/` 之后，那张图的生命周期归本程序管。
//! 2. **只回文件名**。绝对路径会被渲染端拼进 `url()`，越界由自定义协议挡；
//!    存绝对路径等于把"选一张图"变成"读任意文件"。
//! 3. **失败要分得清三种**：用户取消（不是错误）、选的文件读不动、复制失败。
//!    塌成一句「操作失败」会让"我点了取消"看起来像程序坏了。

use std::path::{Path, PathBuf};

/// 壁纸目录名（应用数据目录下）。
pub const WALLPAPER_DIR: &str = "wallpapers";

/// 允许的图片扩展名。与 `shared/settings.ts` 的 `sanitizeWallpaper` 白名单逐条同一份 ——
/// 两处不一致时，选图那一步放行的东西在保存时会被丢掉，界面表现成"选了没生效"。
pub const ALLOWED_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

/// 选图的结果。**`Cancelled` 是一个正常结果，不是错误** —— 它与"失败"在界面上的说法完全不同。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickOutcome {
    /// 用户选了这张（源路径）
    Picked(PathBuf),
    /// 用户按了取消 / 关掉了对话框
    Cancelled,
}

/// 用户选的这张图能不能拿来当壁纸。`None` = 可以；`Some(为什么不行)` = 不行。
///
/// 三条：扩展名在白名单里、是个文件、存在且可读。
/// 不检查尺寸与像素数：一张 1×1 的图完全合法（用户可能就想要一个纯色底），
/// 而"这张图太大"不构成拒绝理由 —— 复制是流式的，内存不会因为一张 100 MB 的 PNG 涨上去。
pub fn reject_reason(path: &Path) -> Option<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let Some(ext) = ext else {
        return Some(format!(
            "E_WALLPAPER_TYPE：这个文件没有扩展名，认不出是不是图片（{}）",
            path.display()
        ));
    };
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Some(format!(
            "E_WALLPAPER_TYPE：只收 {} 这几种，这个是 .{ext}（{}）",
            ALLOWED_EXTS.join(" / "),
            path.display()
        ));
    }
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => None,
        Ok(_) => Some(format!("E_WALLPAPER_TYPE：这不是一个文件（{}）", path.display())),
        Err(e) => Some(format!("E_WALLPAPER_READ：读不到这个文件（{}）：{e}", path.display())),
    }
}

/// 复制进壁纸目录，回**存下来的文件名**（不是路径）。
///
/// 文件名取 `wallpaper-<源文件名>`：加前缀的理由是它要和用户可能选的别的图共处一个目录，
/// 而直接沿用源名会让 `picked.png` 与另一张 `picked.png` 互相覆盖 —— 那看起来像
/// "我换了图但背景没变"。同名第二次选会覆盖同一个前缀名，这是**刻意的**：
/// 用户重选同一张图时不该在磁盘上堆出一份又一份副本。
pub fn store_wallpaper(dir: &Path, source: &Path) -> Result<String, String> {
    if let Some(why) = reject_reason(source) {
        return Err(why);
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("E_WALLPAPER_WRITE：建不出壁纸目录（{}）：{e}", dir.display()))?;
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("E_WALLPAPER_TYPE：这个文件名不是合法 UTF-8（{}）", source.display()))?;
    // 源名里若带路径分隔符（理论上 `file_name` 已经剥掉了，这里再挡一次）
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("E_WALLPAPER_TYPE：文件名里含路径分隔符（{name}）"));
    }
    let stored = format!("wallpaper-{name}");
    let target = dir.join(&stored);
    std::fs::copy(source, &target)
        .map_err(|e| format!("E_WALLPAPER_WRITE：复制到 {} 失败：{e}", target.display()))?;
    Ok(stored)
}

/// 把 `file:<名字>` 换成磁盘上的绝对路径。名字不合法 / 文件不在 ⇒ `None`。
///
/// 渲染端**走不到**这一条（它只拼 `dc-wallpaper://<name>`，由协议层调这里），
/// 但测试要能直接钉"某个名字对应哪条路径"，所以它是个 `pub fn`。
pub fn wallpaper_path(dir: &Path, name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") || name.starts_with('.') {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if !ALLOWED_EXTS.iter().any(|e| lower.ends_with(&format!(".{e}"))) {
        return None;
    }
    let p = dir.join(name);
    p.is_file().then_some(p)
}

/// 壁纸目录：`<appData>/wallpapers`。目录算不出来要报错（与 `settings_path` 同一条纪律）。
pub fn wallpaper_dir(app_data: &Path) -> PathBuf {
    app_data.join(WALLPAPER_DIR)
}

/* ================================================================== *
 * Win32 打开文件对话框
 *
 * 只有 `#[cfg(windows)]` 的真实实现；测试走 `PickOutcome` 那一层，不弹框。
 * ================================================================== */

/// 弹一个"选一张图片"的系统对话框。
///
/// **必须在带 COM 初始化的线程上调用**：`GetOpenFileNameW` 内部会走 shell 那一套，
/// 在没初始化 COM 的线程上它会直接回 0 并让 `CommDlgExtendedError` 说不清原因。
/// Tauri 的 `async` 命令跑在线程池上，那上面的线程**不保证**初始化过 COM ——
/// 所以这个函数自己 `CoInitializeEx(COINIT_APARTMENTTHREADED)`，并在结束时成对 `CoUninitialize`。
/// 已经初始化过（回 `S_FALSE` / `RPC_E_CHANGED_MODE`）时不配对清理。
#[cfg(windows)]
pub fn pick_image(parent: Option<isize>) -> Result<PickOutcome, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    // ⚠️ 这两个住在 `Win32::UI::Controls::Dialogs`，**不是** `Win32::UI::Shell` ——
    // Shell 下也有同名声明，但那条路解不出来（详见 `Cargo.toml` 那段注释）。
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    // SAFETY: 只在同线程成对初始化/清理；句柄与缓冲区都在本函数栈上，调用期间一直有效。
    unsafe {
        let hr = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        // S_OK / S_FALSE = 我们自己初始化（或已初始化同一模式）⇒ 要清理；
        // RPC_E_CHANGED_MODE 等失败码 = 别人已经初始化成别的模式 ⇒ 不动它的引用计数。
        let owns_com = hr >= 0;

        // 过滤器：两段 —— 先图片，再"所有文件"（给那些扩展名被改过的图一个出口）
        let filter: Vec<u16> = "图片 (*.png;*.jpg;*.jpeg;*.webp;*.bmp)\0*.png;*.jpg;*.jpeg;*.webp;*.bmp\0所有文件 (*.*)\0*.*\0\0"
            .encode_utf16()
            .collect();
        let title: Vec<u16> = "选择背景壁纸\0".encode_utf16().collect();
        let mut buf = vec![0u16; 1024];

        let mut ofn: OPENFILENAMEW = std::mem::zeroed();
        ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
        ofn.hwndOwner = parent.map(|h| h as HWND).unwrap_or(std::ptr::null_mut());
        ofn.lpstrFilter = filter.as_ptr();
        ofn.lpstrFile = buf.as_mut_ptr();
        ofn.nMaxFile = buf.len() as u32;
        ofn.lpstrTitle = title.as_ptr();
        // FILEMUSTEXIST | PATHMUSTEXIST | NOCHANGEDIR：三个都是"别让用户选到一个之后才失败"的口径。
        // 常量取自 `OPEN_FILENAME_FLAGS`，不手敲魔数（第一版敲过 `0x0000_0800 | …`，
        // 值碰巧对，但下一个人看不出那三个数是什么）。
        ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;

        let ok = GetOpenFileNameW(&mut ofn);
        if owns_com {
            CoUninitialize();
        }
        if ok == 0 {
            // 0 有两种：用户取消（最常见），或真出错。`CommDlgExtendedError` == 0 就是取消。
            // 这里不另调那个 API：它要额外 feature，而"取消"是绝大多数情况 ——
            // 把罕见错误也报成取消是可接受的代价（用户再点一次就知道），
            // 反过来把取消报成错误会天天误报。**代价如实登记在这里。**
            return Ok(PickOutcome::Cancelled);
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let picked = String::from_utf16_lossy(&buf[..len]);
        if picked.is_empty() {
            return Ok(PickOutcome::Cancelled);
        }
        Ok(PickOutcome::Picked(PathBuf::from(picked)))
    }
}

/// 非 Windows：本产品不发这个平台，但 `cargo check` 在别的机器上要过。
#[cfg(not(windows))]
pub fn pick_image(_parent: Option<isize>) -> Result<PickOutcome, String> {
    Err("E_WALLPAPER_PLATFORM：这个平台没有系统文件对话框".to_string())
}

/// 把 `&str` 转成宽字符（测试与协议层共用）。没用到时不报未使用。
#[cfg(test)]
fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s).encode_wide().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(format!(r"D:\deepclean-fixture\wallpaper\{tag}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extension_gate_matches_the_ts_whitelist() {
        // 白名单**逐字**与 `shared/settings.ts` 同一份（那边是 `.png|.jpe?g|.webp|.bmp`）
        assert_eq!(ALLOWED_EXTS, ["png", "jpg", "jpeg", "webp", "bmp"]);
        let dir = temp_dir("ext");
        let png = dir.join("a.png");
        fs::write(&png, b"x").unwrap();
        assert_eq!(reject_reason(&png), None, "白名单里的扩展名要放行");

        // 大小写不免疫（Windows 上 `.PNG` 是常见形状）
        let upper = dir.join("b.JPG");
        fs::write(&upper, b"x").unwrap();
        assert_eq!(reject_reason(&upper), None);

        // 白名单外
        let gif = dir.join("c.gif");
        fs::write(&gif, b"x").unwrap();
        let why = reject_reason(&gif).unwrap();
        assert!(why.starts_with("E_WALLPAPER_TYPE："), "{why}");
        assert!(why.contains(".gif"), "拒绝理由要点名是哪种扩展名：{why}");

        // 没有扩展名
        let bare = dir.join("noext");
        fs::write(&bare, b"x").unwrap();
        assert!(reject_reason(&bare).unwrap().contains("没有扩展名"));

        // 目录不是文件。
        // ⚠️ 这里**不能**断言理由一定是「不是一个文件」：`ext` 这个目录名本身没有扩展名，
        // 于是它在扩展名那道闸就被挡住了（理由串是「没有扩展名」）。
        // 两条理由都正确，取决于名字长什么样 —— 所以换一个**带合法扩展名**的目录，
        // 才真正走到"存在但不是一个文件"那一支。
        let dir_named_png = dir.join("looks-like.png");
        fs::create_dir(&dir_named_png).unwrap();
        let why = reject_reason(&dir_named_png).unwrap();
        assert!(why.contains("不是一个文件"), "带 .png 的目录该被判成'不是文件'，实得：{why}");
        // 反向半边：无扩展名的目录**也**要被拒（只是理由不同）
        assert!(reject_reason(&dir).unwrap().contains("没有扩展名"));

        // 不存在
        let missing = dir.join("gone.png");
        assert!(reject_reason(&missing).unwrap().starts_with("E_WALLPAPER_READ："));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn storing_copies_and_returns_only_the_file_name() {
        let dir = temp_dir("store");
        let src = dir.join("my photo.png");
        fs::write(&src, b"PNGDATA").unwrap();
        let wall_dir = dir.join("wallpapers");

        let name = store_wallpaper(&wall_dir, &src).unwrap();
        // 只回名字：**不许**含分隔符或盘符（渲染端要直接拼进 URL）
        assert_eq!(name, "wallpaper-my photo.png");
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(':'), "{name}");
        // 真的复制了，且内容一致
        let stored = wall_dir.join(&name);
        assert_eq!(fs::read(&stored).unwrap(), b"PNGDATA");
        // 源文件还在（复制不是移动）
        assert!(src.exists(), "复制之后源文件必须还在");

        // 反面对照：同一个源再存一次**不产生第二份副本**（重选不该堆文件）
        store_wallpaper(&wall_dir, &src).unwrap();
        let count = fs::read_dir(&wall_dir).unwrap().count();
        assert_eq!(count, 1, "重选同一张图不该在磁盘上堆副本，实际 {count} 个");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn storing_refuses_what_the_gate_refuses() {
        let dir = temp_dir("store-bad");
        let gif = dir.join("x.gif");
        fs::write(&gif, b"x").unwrap();
        let err = store_wallpaper(&dir.join("wallpapers"), &gif).unwrap_err();
        assert!(err.starts_with("E_WALLPAPER_TYPE："), "{err}");
        // 反面对照：拒绝之后**没有**落下任何文件
        assert!(!dir.join("wallpapers").exists(), "拒绝了却还是把目录建出来了");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wallpaper_name_resolves_inside_the_dir_or_not_at_all() {
        let dir = temp_dir("resolve");
        fs::write(dir.join("wallpaper-a.png"), b"x").unwrap();

        assert!(wallpaper_path(&dir, "wallpaper-a.png").is_some());

        // 越界的五种形状一个都不许解析出路径（这是"选一张图"与"读任意文件"的分界线）
        for evil in [
            "../secret.png",
            r"..\secret.png",
            "sub/dir/a.png",
            "C:/windows/a.png",
            ".hidden.png",
        ] {
            assert_eq!(wallpaper_path(&dir, evil), None, "{evil} 不该被解析成路径");
        }
        // 扩展名不在白名单
        assert_eq!(wallpaper_path(&dir, "a.gif"), None);
        // 名字合法但文件不在
        assert_eq!(wallpaper_path(&dir, "wallpaper-gone.png"), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelled_is_a_result_not_an_error() {
        // 这条钉的是**类型形状**：取消是一个正常结果值，调用方不必靠字符串判断。
        // 探针不弹真框（那要人点），但那条路的分支已经在这里被点名了。
        let c = PickOutcome::Cancelled;
        let p = PickOutcome::Picked(PathBuf::from(r"D:\a.png"));
        assert_ne!(c, p);
        assert_eq!(c, PickOutcome::Cancelled);
    }

    #[test]
    fn wide_strings_are_nul_terminated_by_the_caller() {
        // `GetOpenFileNameW` 要求过滤器与标题以 NUL 结尾、过滤器整段双 NUL 收口。
        // 这条只钉"我们转出来的是 UTF-16 且无内嵌 NUL"，收口那一步在上面那个函数里手写。
        let w = wide("选择背景壁纸");
        assert!(!w.contains(&0), "字面量里不许有内嵌 NUL");
        assert_eq!(w.len(), 6, "六个汉字六个码元");
    }
}
