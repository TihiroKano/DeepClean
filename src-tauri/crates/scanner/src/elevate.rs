//! M1-T6「以管理员重新扫描」的 Tauri 侧薄封装 —— **只提升扫描助手，主界面不动**。
//!
//! 为什么主界面不能跟着提权：规格书那句话（`docs/spec/DeepClean_Tauri重写计划书.md` 的
//! 「提供"以管理员重新扫描"，只提升扫描助手」）要的是"多扫到那些被拒的目录"，
//! 而不是"让整个带删除按钮的窗口拿到管理员令牌"。把 UI 提权等于把 §16/§17/§18 那道
//! 逐项确认链的调用方变成高权限进程 —— 那是拿便利换安全边界，方向反了。
//!
//! 分成两半是有意的：
//!  · **判据与命令行构造是纯函数**（`should_offer_elevation` / `helper_command_line`），
//!    能被单测反复验，包括 Windows 命令行引号那两个经典坑；
//!  · **起进程那一半必然弹 UAC** —— `runas` 没有"静默通过"的路径，所以真机那一跑
//!    只能人工点确认，写在验收文档里手工打勾，不伪装成自动化过了。

use crate::model::Counters;
use std::path::Path;

/// 这一轮值不值得给用户"以管理员重新扫描"那一格：**有任何一个目录被拒**就值得。
///
/// 只有 `denied` 算数，这两格**不算**（写死在判据里，别让"看起来扫得不全"都成了提权的理由）：
///  · `skipped_reparse` —— junction 一律不进入是 §28 原则二，提权也不会变，问了反而误导；
///  · `depth_capped` / `files_truncated` —— 那是参数上限，改参数就行，与管理令牌无关。
pub fn should_offer_elevation(c: &Counters) -> bool {
    c.errors.denied > 0
}

/// Windows 命令行切分：带空格的参数整体加引号。**尾部是反斜杠时必须先去掉** ——
/// `"D:\dir\"` 里的 `\"` 会被当成转义引号，于是引号被吃掉、后面的参数粘进来
/// （这是 CreateProcess 命令行解析的公开规则，不是本项目发明的）。
fn quote_arg(s: &str) -> String {
    if !s.contains([' ', '\t']) && !s.contains('"') {
        return s.to_string();
    }
    let trimmed = s.trim_end_matches('\\');
    format!("\"{trimmed}\"")
}

/// 助手进程的**参数串**（不含可执行文件本身）。`--out` 是必需的：
/// 提权跑起来的是另一个进程，它的 stdout 回不到这个界面 —— 没有落盘路径就等于拿不到结果。
pub fn helper_command_line(root: &Path, out: &Path) -> String {
    format!(
        "{} --out={}",
        quote_arg(&root.display().to_string()),
        quote_arg(&out.display().to_string())
    )
}

/// `ShellExecuteExW` + `runas`：让系统去问 UAC。
///
/// 用户点"否"不是 bug，是**一条要如实说的结果** —— `SE_ERR_ACCESSDENIED`(5) 单独翻成
/// `E_UAC_DECLINED`，界面据此保留原来那份（不完整的）报告，而不是清空或报错成"扫描坏了"。
/// 返回 `Ok(())` 只代表"助手被批准启动了"，**不代表它跑完** —— 跑完的判据是 `out` 那个文件
/// 出现（助手只在扫完时写它）。
pub fn launch_elevated(exe: &Path, parameters: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    };
    let verb = wide("runas");
    let file = wide(&exe.display().to_string());
    let params = wide(parameters);
    if !exe.exists() {
        return Err(format!("E_HELPER_MISSING: 提权要启动的助手不在盘上：{exe:?}"));
    }
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    // SW_HIDE：助手是来干活的，不该留一个黑窗口在用户桌面上闪一下
    info.nShow = 0;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    let ok = unsafe { ShellExecuteExW(&mut info) };
    if ok != 0 {
        return Ok(());
    }
    // ShellExecuteExW 失败时错误码走 GetLastError。用户点"否"给的是
    // `ERROR_CANCELLED`(1223)；`ERROR_ACCESS_DENIED`(5) 是"策略直接不允许提权"那一类。
    // 两者对界面的意思一样（这一轮没提权，继续用刚才那份报告），但**串要分开**，
    // 否则"用户自己点了否"和"这台机器根本不给你提权"在日志里长一个样。
    let code = unsafe { windows_sys::Win32::Foundation::GetLastError() };
    Err(match code {
        1223 => "E_UAC_DECLINED: 用户在 UAC 上点了否，这一轮仍用刚才那份报告".into(),
        5 => "E_UAC_DENIED_BY_POLICY: 系统拒绝了提权（策略或以标准用户运行），这一轮仍用刚才那份报告".into(),
        other => format!("E_LAUNCH_FAILED: ShellExecuteExW(runas) 失败，win32={other}"),
    })
}

/* ================================================================== *
 * 单测：只测纯的那两半（起进程要弹 UAC，不可能进常规闸）
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Counters, ErrorTally};

    fn c(denied: u64) -> Counters {
        Counters { errors: ErrorTally { denied, ..Default::default() }, ..Default::default() }
    }

    #[test]
    fn only_denied_offers_elevation() {
        assert!(!should_offer_elevation(&c(0)), "一条都没被拒就别问 UAC —— 问了只会白打断用户");
        assert!(should_offer_elevation(&c(1)));
        // 两格"看着像扫不全"但不该提权的，逐格点名（写成 `..Default::default()` 一把带过就测不到）
        let reparse = Counters { skipped_reparse: 900, ..Default::default() };
        assert!(!should_offer_elevation(&reparse), "junction 不进入是判据，不是权限问题");
        let capped = Counters { depth_capped: 40, ..Default::default() };
        assert!(!should_offer_elevation(&capped), "撞到深度上限该改参数，不该提权");
        let both = Counters { skipped_reparse: 3, errors: ErrorTally { denied: 2, ..Default::default() }, ..Default::default() };
        assert!(should_offer_elevation(&both), "混在一起时 denied 必须说话");
    }

    #[test]
    fn the_command_line_quotes_paths_with_spaces_and_drops_the_trailing_slash() {
        let root = Path::new(r"D:\deepclean fixture\some tree");
        let out = Path::new(r"C:\Users\me\my reports\r.json");
        assert_eq!(
            helper_command_line(root, out),
            r#""D:\deepclean fixture\some tree" --out="C:\Users\me\my reports\r.json""#
        );
    }

    #[test]
    fn a_trailing_backslash_before_a_quote_is_not_an_escaped_quote() {
        // `"D:\dir\"` 会被解析成 `"D:\dir"` + 转义引号 ⇒ 后面的参数整段粘进来。
        // 所以带空格又以 `\` 结尾的路径必须先把尾反斜杠去掉。
        let q = quote_arg(r"D:\some dir\");
        assert!(!q.ends_with('\\'), "引号前留着反斜杠 = 把引号吃了：{q}");
        assert_eq!(q, r#""D:\some dir""#);
        // 不带空格就不需要引号，也就没有这个坑（原样交出去，别多改一个字符）
        assert_eq!(quote_arg(r"D:\plain"), r"D:\plain");
    }

    #[test]
    fn the_out_flag_is_always_there() {
        // 少了 --out，提权那一跑的结果永远拿不到（stdout 回不到这个进程）
        let s = helper_command_line(Path::new(r"D:\x"), Path::new(r"D:\o.json"));
        assert!(s.contains("--out="), "{s}");
        assert!(s.starts_with(r"D:\x "), "{s}");
    }

    #[test]
    fn launching_a_missing_helper_fails_before_touching_uac() {
        // 这条测的是"别拿一个不存在的路径去弹框"：用户点了同意才发现起不来，是最坏的一课
        let e = launch_elevated(Path::new(r"D:\definitely\not\here.exe"), "").unwrap_err();
        assert!(e.starts_with("E_HELPER_MISSING"), "{e}");
    }
}
