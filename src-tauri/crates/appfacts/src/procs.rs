//! `procs` —— C5：**进程镜像路径**，方向 = Present。计划 §1.3 的实现列写的是
//! `CreateToolhelp32Snapshot` + `QueryFullProcessImageNameW`。
//!
//! ## 「不 spawn 任何进程」与「看进程表」是两件事
//!
//! 计划 §Global Constraints 禁的是**起进程**（不走 PowerShell、不通过 `std` 那个起子进程的
//! 类型、也不走 Win32 的进程创建那一族）。这一页做的是另一件事：拿一张**已经存在的进程清单**
//! 的快照。用到的一切都只读：
//!
//! - `CreateToolhelp32Snapshot` —— 内核往调用方交一份快照，谁都没被惊动；
//! - `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, …)` —— **一个查询用的句柄**，
//!   访问掩码只有那一格，拿不到 `PROCESS_VM_READ` / `PROCESS_TERMINATE` 那一类能力；
//! - `QueryFullProcessImageNameW` —— 读名字；
//! - `CloseHandle` —— 关掉自己刚开的那一个。
//!
//! 这条界线由 `tests/readonly.rs` 钉住：`the_p2_t2_read_api_allowlist_is_not_caught`
//! 当场验「这一页用到的名字一根针都抓不住，而同一段里只要混进进程创建那一族就立刻转红」。
//!
//! ## 三态在这里怎么落（与 [`crate::channel`] 同一套容器）
//!
//! - 快照建起来、列表跑到 `ERROR_NO_MORE_FILES`（**18**）→ `Listed`；
//! - 快照建不起来、或列表**中途**出错 → `Unavailable(原话)`：这一半进程根本没进表，
//!   「没在进程里看到它」就不能被读成「它没在跑」；
//! - 单体的 `QueryFullProcessImageNameW` 失败（保护进程、别人的会话）**不**降级整条通道：
//!   名字本来就来自 `PROCESSENTRY32W.szExeFile`，那一格不需要任何权限。
//!   完整路径只是把归属钉得更准的加分项，拿不到就少一条加分 —— 这不是「没看成」。
//!   计数走 `empty_notes`，报告里点名（P2-T4 的对账要看这个数）。
//!
//! ⚠️ `Listed` 但**一个进程都没有**在真机上不可能出现，所以 [`process_scan`] 把它折回
//! `Unavailable`：一张空表最可能的解释是快照没建起来，而不是这台机器没在跑东西。

#![allow(unsafe_code)] // 只有 `collect_process_snapshot` 那一段是 FFI，全是读 API；判据层不需要 unsafe。

use crate::channel::ChannelScan;

/// 一个进程的记录（C5 的最小证据单元）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRecord {
    /// `PROCESSENTRY32W.szExeFile`：**枚举本身**就给得出，不需要打开进程句柄。
    pub exe: String,
    /// `QueryFullProcessImageNameW` 的完整路径；`None` = 这一格加分项没拿到。
    pub image: Option<String>,
}

/// 进程表快照的**取证结局**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotStatus {
    /// 跑完了。`unnamed` = 打不开镜像路径的进程数（**不**阻塞结论，见模块文档）。
    Listed { unnamed: usize },
    /// 给不出证据：快照没建起来、或枚举中途断了。
    Unavailable(String),
}

/// 一次进程取证的快照。**判据层吃的是这份数据**，不是进程表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub records: Vec<ProcessRecord>,
    pub status: SnapshotStatus,
}

impl Default for ProcessSnapshot {
    /// 默认值 = **没采集**（不是「进程表是空的」）。忘了接线的调用方得到的是一整张
    /// `Unknown` 表，而不是一条能把活应用判成残留的假「证完了」。
    fn default() -> Self {
        Self {
            records: Vec::new(),
            status: SnapshotStatus::Unavailable(
                "进程快照压根没采集（默认值）—— 「没在进程表里看到它」不是「它没在跑」".to_string(),
            ),
        }
    }
}

impl ProcessSnapshot {
    /// 一份**跑成功的**快照（用例搭假机器时用这一格；空清单在这里就会被折回弃权）。
    pub fn listed(records: Vec<ProcessRecord>) -> Self {
        let unnamed = records.iter().filter(|r| r.image.is_none()).count();
        Self { records, status: SnapshotStatus::Listed { unnamed } }
    }

    /// 一份**取不到证据**的快照，带原话。
    pub fn unavailable(why: impl Into<String>) -> Self {
        Self { records: Vec::new(), status: SnapshotStatus::Unavailable(why.into()) }
    }
}

/// C5：进程表 → 一条通道的结果。方向 = Present。
///
/// 交给匹配的串是**可执行文件名**，外加拿得到时的**完整镜像路径**。
/// 名字这一格是双向包含口径里最宽的那一类（`app.exe` 这种谁都有），但 C5 是**本体**通道，
/// 放宽只会多算 Present（少删）—— 与痕迹那一侧（C2/C6）的放宽方向正好相反，
/// 所以这一路的口径可以宽，那两路不行（模块文档与 `trace_matching_stays_literal_by_p2_t2_adjudication`）。
pub fn process_scan(snap: &ProcessSnapshot) -> ChannelScan {
    // 本体通道 ⇒ 放宽（P2-T2 裁定，见 `channel::name_matches_loose`）。
    let mut cs = ChannelScan { loose_match: true, ..ChannelScan::default() };
    cs.roots_configured = 1;
    match &snap.status {
        SnapshotStatus::Unavailable(why) => {
            cs.failures.push(format!("进程快照：{why}"));
        }
        SnapshotStatus::Listed { unnamed } => {
            if snap.records.is_empty() {
                cs.failures.push(
                    "进程快照跑完了，但表里一个进程都没有 —— 这台机器不可能一个进程都没在跑，\
                     按「快照没建起来」处理，不按「什么都没装着」处理"
                        .to_string(),
                );
                return cs;
            }
            cs.roots_verified = 1;
            for r in &snap.records {
                cs.entries.push(r.exe.clone());
                // 完整镜像路径**整条不进证据**：只有它的**上一级目录名**进。
                // 理由（P2-T2 实跑抓出来的）：整条路径里 `C:\Users\<用户名>\…`、
                // `AppData\Local\Temp\…` 这些段是**每台机器自己的**噪声 —— 用户名里带「claude」
                // 之类的词就会凭空造出一条本体证据。上一级目录名是这条路径里唯一真的在说
                // 「这个应用装在叫什么名字的地点」的那一段（`D:\Software\Claude\Claude.exe` → `Claude`）。
                if let Some(base) = image_parent_name(r.image.as_deref()) {
                    cs.entries.push(base);
                }
            }
            cs.entries.sort();
            if *unnamed > 0 {
                cs.empty_notes.push(format!(
                    "{unnamed}/{} 个进程的完整镜像路径拿不到（保护进程 / 别人的会话）—— \
                     名字这一格照样来自枚举本身，所以这一路仍然是「跑完了」",
                    snap.records.len()
                ));
            }
        }
    }
    cs
}

// ---------------------------------------------------------------- 真机采集（只读 FFI）

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, INVALID_HANDLE_VALUE, ERROR_NO_MORE_FILES,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Toolhelp32 枚举的**正常收尾**码 —— 这一格踩过一次坑，别再看错。
///
/// 是 `ERROR_NO_MORE_FILES`（18），**不是** `ERROR_NO_MORE_ITEMS`（259）。本仓 M1 写
/// `crates/scanner/src/enumerate.rs` 时就为这件事立过判据（那里自己定义了 `18` 这个常量），
/// P2-T2 另起一段 FFI 时又踩了一遍：拿 259 当收尾 ⇒ 真机每次枚举到最后一个进程都被读成
/// 「中途断了」⇒ C5 整条通道弃权 ⇒ **每一个**候选都被降级成 Unknown ⇒ 第 22 条一次都没
/// 提议过。这一格由 [`the_real_snapshot_runs_to_the_end`] 在真机上钉住，不靠这段注释。
fn is_end_of_enumeration(code: u32) -> bool {
    code == ERROR_NO_MORE_FILES
}

/// **真机采集入口**：一次 Toolhelp32 快照 + 每个进程一次查询用的句柄。
///
/// 只被壳层调（P2-T4 的 `service.rs`），一次扫描调一次（计划 §2.7：进程表是瞬时状态，
/// 两份报告不能拿两份事实）。判据层的用例**一个都不调它**。
pub fn collect_process_snapshot() -> ProcessSnapshot {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return ProcessSnapshot::unavailable(format!(
            "CreateToolhelp32Snapshot 没交回快照（句柄 {snapshot:?}，错误码 {}）—— 这一路一条证据都没拿到",
            unsafe { GetLastError() }
        ));
    }

    // 枚举与「读每个进程的镜像路径」分开写：UnsafeBlock 里只剩 Toolhelp32 那两次调用本身，
    // 后面的 `image_path` 各自带自己那一小段。这一层是给人 review 的，块越大越没人看得出越界。
    let mut found: Vec<(u32, String)> = Vec::new();
    let mut broken: Option<String> = None;
    unsafe {
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snapshot, &mut entry) == 0 {
            let code = GetLastError();
            if !is_end_of_enumeration(code) {
                broken = Some(format!("Process32FirstW 就失败了（错误码 {code}）—— 一个进程都没进表"));
            }
        } else {
            loop {
                found.push((entry.th32ProcessID, from_wide(&entry.szExeFile)));
                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry) == 0 {
                    let code = GetLastError();
                    if !is_end_of_enumeration(code) {
                        broken = Some(format!(
                            "Process32NextW 在第 {} 个进程处中断（错误码 {code}）—— 后面的进程没进表",
                            found.len()
                        ));
                    }
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }

    if let Some(why) = broken {
        return ProcessSnapshot::unavailable(why);
    }
    let records: Vec<ProcessRecord> = found
        .into_iter()
        .map(|(pid, exe)| ProcessRecord { exe, image: image_path(pid) })
        .collect();
    ProcessSnapshot::listed(records)
}

/// 一个进程的完整镜像路径。拿不到就交 `None`（这一格是加分项，不是覆盖面 —— 见模块文档）。
fn image_path(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buf = vec![0u16; 4096];
    let mut len = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return None;
    }
    let s = from_wide(&buf[..len as usize]);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 镜像路径的**上一级目录名**（`D:\Software\Claude\Claude.exe` → `Claude`）。
///
/// 拿不到路径就给 `None`（这一格是加分项）；路径只有盘符或段长不到匹配下限的也给 `None`
/// （[`crate::MIN_MATCHABLE_KEY_CHARS`]，同一把尺子，别让 `C:` 这种段去跟候选名比）。
fn image_parent_name(image: Option<&str>) -> Option<String> {
    let raw = image?.replace('/', "\\");
    let trimmed = raw.trim_end_matches('\\');
    let mut segs = trimmed.split('\\').rev();
    let _file = segs.next()?;
    let parent = segs.next()?;
    if parent.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS || parent.ends_with(':') {
        return None;
    }
    Some(parent.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Probe;

    fn rec(exe: &str, image: Option<&str>) -> ProcessRecord {
        ProcessRecord { exe: exe.into(), image: image.map(str::to_string) }
    }

    /// 收尾码的**这一格**是纯函数，正反例都得在这儿各跑一次 —— 只验反例的话，
    /// 「把 18 也当成中断」这种改法照样全绿（而真机上那 96 条 Unknown 就是这么来的）。
    #[test]
    fn the_end_of_a_toolhelp_enumeration_is_18_and_not_259() {
        assert!(is_end_of_enumeration(ERROR_NO_MORE_FILES), "18 = 跑到尾，必须放行");
        assert!(
            !is_end_of_enumeration(259),
            "259（ERROR_NO_MORE_ITEMS）是当初写错的那一个，不许又被当成收尾"
        );
        assert!(!is_end_of_enumeration(5), "访问被拒是真断，必须弃权");
    }

    /// 真机自证：**不构造任何数据**，直接跑一次真采集，判它到底有没有跑到尾。
    ///
    /// 上面那些用例吃的全是手工造的 `ProcessSnapshot`，一条都摸不到 FFI 那一段 ——
    /// 这正是「拿 259 当收尾」能活过整条闸的原因。这一条只读、不起进程。
    #[test]
    fn the_real_snapshot_runs_to_the_end() {
        let snap = collect_process_snapshot();
        if let SnapshotStatus::Unavailable(why) = &snap.status {
            panic!(
                "真机进程快照被判成中途断了（错误码收尾判据又写错了？）：{why}\n\
                 进程表由 OS 维护，跑到尾就返回 18；这里读到断，就是 is_end_of_enumeration 坏了。"
            );
        }
        assert!(
            snap.records.len() >= 32,
            "跑到尾了但只有 {} 个进程 —— 少到不像话，更像快照没建起来",
            snap.records.len()
        );
    }

    #[test]
    fn a_running_process_is_body_evidence() {
        let snap = ProcessSnapshot::listed(vec![
            rec("svchost.exe", Some(r"C:\Windows\System32\svchost.exe")),
            rec("Claude.exe", Some(r"D:\Software\Claude\Claude.exe")),
        ]);
        let cs = process_scan(&snap);
        assert!(matches!(cs.probe("claude"), Probe::Hit(_)));
        assert!(matches!(cs.probe("ghost"), Probe::CheckedNoHit));
    }

    #[test]
    fn an_uncollected_or_broken_snapshot_is_never_checked_and_empty() {
        // 核心 fail-safe 在进程这一路的形状：默认值（没采集）与「中途断了」都必须是弃权。
        for snap in [
            ProcessSnapshot::default(),
            ProcessSnapshot::unavailable("Process32NextW 在第 12 个进程处中断（错误码 5）"),
            ProcessSnapshot::listed(vec![]),
        ] {
            assert!(
                matches!(process_scan(&snap).probe("claude"), Probe::Unavailable(_)),
                "取不到证据的进程快照被读成「它没在跑」了：{:?}",
                process_scan(&snap).probe("claude")
            );
        }
    }

    #[test]
    fn a_single_unreadable_image_does_not_blind_the_channel() {
        // 保护进程拿不到完整路径 ≠ 这一路没跑完：名字来自枚举本身。
        let snap = ProcessSnapshot::listed(vec![
            rec("SecureGuard.exe", None),
            rec("Claude.exe", Some(r"D:\Software\Claude\Claude.exe")),
        ]);
        let cs = process_scan(&snap);
        assert!(matches!(cs.probe("claude"), Probe::Hit(_)));
        assert!(matches!(cs.probe("ghost"), Probe::CheckedNoHit));
        assert_eq!(cs.empty_notes.len(), 1, "拿不到路径的数要在报告里点出来：{:?}", cs.empty_notes);
        // 而**全部**拿不到路径也不降级：仍然有名字。
        let all_unnamed = ProcessSnapshot::listed(vec![rec("a-proc.exe", None)]);
        assert!(matches!(process_scan(&all_unnamed).probe("ghost"), Probe::CheckedNoHit));
    }
}
