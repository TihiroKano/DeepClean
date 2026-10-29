//! `registry` —— 两条**注册表只读**通道：C1（卸载表三根）与 C2（`SOFTWARE` 顶层厂商键）。
//! 计划 §1.3 的实现列写的是 `RegOpenKeyExW` + `RegEnumKeyExW` + `RegQueryValueExW`。
//!
//! ## 只读是结构性的，不是自觉
//!
//! 访问掩码只有 `KEY_READ`（+ 视图选择位 `KEY_WOW64_64KEY` / `KEY_WOW64_32KEY`，那两个是
//! **选哪个视图**，不是要写），写值那一族、删键那一族、建键那一族**一个都不调用**。
//! 这三族的名字在本文件里一次都不原样出现 —— 不是躲注释：`tests/readonly.rs` 那道静态闸
//! **不剥注释**，把名字拼出来就是当场自证违例（那三族现在都在禁列里，`every_needle_has_teeth`
//! 一根针配一个反例）。
//! `tests/readonly.rs` 里还有一条 `the_p2_t2_read_api_allowlist_is_not_caught` 钉住
//! 「这一页真正用到的只读名字不许被禁列误伤」—— 误伤的后果不是编译不过，是闸恒红、
//! 然后有人去把闸绕过。
//!
//! ## 为什么这一层的判据吃的是**快照**而不是注册表
//!
//! [`RegistrySnapshot`] 是纯数据：`collect_snapshot()` 是真机采集入口（只被壳层调，P2-T4），
//! [`uninstall_scan`] / [`vendor_key_scan`] / [`extra_install_locations`] 是**判据**，只吃那张数据。
//! 于是每条判据都能拿一份假快照跑完 —— 掺进一次真机读取，「全绿」就退化成
//! 「**这台**机器上恰好全绿」，而这台机器恰好装着规格 §4.2 那三个反例。
//!
//! ## 三态在这里怎么落（与 [`crate::channel`] 同一套容器）
//!
//! - 根打开成功并枚举完 → `Listed`；
//! - 根**不存在**（`ERROR_FILE_NOT_FOUND`）→ `Missing` = 「看过，那个键确实没有」，
//!   这是一条**看过**的结论（32 位视图在没有 WOW64 的机器上就不存在，不是取证失败）；
//! - 打不开 / 枚举中途出错 / 权限拒 → `Unavailable(原话)`，该路对所有候选一律弃权。
//!
//! ⚠️ 后一档绝不能折叠成前一档：「没看成」读成「看过了、这里没有卸载条目」就是多删。
//!
//! ## C2 的口径是**窄**的，这是刻意的
//!
//! 厂商键是**痕迹**，而痕迹是 `Absent` 的入场券。所以 [`vendor_key_scan`] 只把顶层键名
//! （`Microsoft`、`Intel`、…）交给匹配，**不**把 `HKLM\SOFTWARE\…` 那个路径串交出去 ——
//! 路径里那串 `Microsoft\Windows\CurrentVersion` 会让任何叫 `Windows` / `CurrentVersion` 的
//! 候选目录凭一条假痕迹进入 `Absent` 判定。放宽痕迹 = 降低删除门槛，方向与计划 §0.1 相反。
//!
//! ## §4.4：`InstallLocation` 不是装饰，它反推 C4 的额外安装根
//!
//! 见 [`extra_install_locations`] 与 [`unresolvable_install_locations`] —— 后者是那条
//! 「拿到了位置却展不出绝对路径」的盲区出口，静默丢弃等于替没看过的地方作证。

#![allow(unsafe_code)] // FFI 只在 `collect_*` 那几段，且用的全是读 API；判据层不需要 unsafe。

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::channel::ChannelScan;
use crate::lookup_env;

/// 注册表根的**取证结局**，三态（缺第三态就退化成「查无即残留」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootStatus {
    /// 打开并枚举完了。
    Listed,
    /// 键确实不存在 —— 「看过、那里是空的」，算取证成功。
    Missing,
    /// 取不到证据（打不开、权限拒、枚举中途失败）。`why` 非空是硬约束。
    Unavailable(String),
}

/// 卸载表里的一个条目（C1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallEntry {
    /// 子键名（常常是 GUID，也常常就是应用名）。
    pub key: String,
    /// `DisplayName`：报告与匹配主要看它。
    pub display_name: Option<String>,
    /// `InstallLocation`：**计划 §4.4 的输入**，反推 C4 的额外安装根。
    pub install_location: Option<String>,
}

/// 卸载表的一个根（三根之一）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallRoot {
    /// 报告里点名的路径（HKLM 的两条会标出用的是哪个视图）。
    pub path: String,
    pub status: RootStatus,
    pub entries: Vec<UninstallEntry>,
}

/// `SOFTWARE` 顶层键的一个根（C2，三根之一）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorRoot {
    pub path: String,
    pub status: RootStatus,
    /// 顶层键名（只名字，不含路径 —— 见模块文档那条「窄口径」）。
    pub keys: Vec<String>,
}

/// 一次注册表取证的完整快照。**判据层吃的是这份数据**，不是注册表。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RegistrySnapshot {
    /// C1 的三根。
    pub uninstall: Vec<UninstallRoot>,
    /// C2 的三根。
    pub vendors: Vec<VendorRoot>,
}

impl RegistrySnapshot {
    /// **一份「什么都没看成」的快照**（两条通道的根清单都是空的）。
    ///
    /// 它是默认值不是便利构造：默认值必须落在「没证据」那一侧，于是忘了采集的调用方
    /// 得到的是一整张 `Unknown` 表，而不是「卸载表是空的」这种能推出 `Absent` 的假象。
    pub fn nothing_collected() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------- 判据（纯函数）

/// C1：卸载表三根 → 一条通道的结果。方向 = Present。
///
/// 交给匹配的串是**子键名 + `DisplayName`**（各自一条）。路径串不进 `entries`：
/// C1 是本体通道，放宽只会多算 Present（少删），但把路径喂进去会让 `Hit` 的细节里
/// 混进 `…\CurrentVersion\Uninstall` 这种谁都能对上的东西，报告就点不出是哪一条目了。
pub fn uninstall_scan(snap: &RegistrySnapshot) -> ChannelScan {
    // 本体通道 ⇒ 放宽（P2-T2 裁定，见 `channel::name_matches_loose`）。
    let mut cs = ChannelScan { loose_match: true, ..ChannelScan::default() };
    for root in &snap.uninstall {
        cs.roots_configured += 1;
        match &root.status {
            RootStatus::Listed => {
                cs.roots_verified += 1;
                if root.entries.is_empty() {
                    cs.empty_notes
                        .push(format!("卸载表根「{}」枚举完了，一个条目都没有", root.path));
                }
                for e in &root.entries {
                    cs.entries.push(e.key.clone());
                    if let Some(d) = &e.display_name {
                        let d = d.trim();
                        if !d.is_empty() {
                            cs.entries.push(d.to_string());
                        }
                    }
                }
            }
            RootStatus::Missing => {
                cs.roots_verified += 1;
                cs.empty_notes
                    .push(format!("卸载表根「{}」不存在", root.path));
            }
            RootStatus::Unavailable(why) => cs
                .failures
                .push(format!("卸载表根「{}」：{why}", root.path)),
        }
    }
    cs.entries.sort();
    cs
}

/// C2：`SOFTWARE` 顶层厂商键 → 一条通道的结果。方向 = **痕迹**（不是 Present）。
pub fn vendor_key_scan(snap: &RegistrySnapshot) -> ChannelScan {
    // 痕迹通道 ⇒ `loose_match` 留在 false（理由见模块文档那一格与 `channel::name_matches_loose`）。
    let mut cs = ChannelScan::default();
    for root in &snap.vendors {
        cs.roots_configured += 1;
        match &root.status {
            RootStatus::Listed => {
                cs.roots_verified += 1;
                cs.entries.extend(root.keys.iter().cloned());
            }
            RootStatus::Missing => {
                cs.roots_verified += 1;
                cs.empty_notes
                    .push(format!("厂商键根「{}」不存在", root.path));
            }
            RootStatus::Unavailable(why) => cs
                .failures
                .push(format!("厂商键根「{}」：{why}", root.path)),
        }
    }
    cs.entries.sort();
    cs
}

/// **计划 §4.4 的正向出口**：把卸载表的 `InstallLocation` 展成能给 C4 用的绝对路径。
///
/// 只收**展得开、且是绝对路径、且 basename 长到能安全做子串匹配**的那些
/// （[`crate::MIN_MATCHABLE_KEY_CHARS`]；`D:\` 这种盘根的 basename 是 `D:`，2 个字符，
/// 收进来等于把整个盘的顶层目录都当证据 —— 那是把匹配口径吞掉）。
/// 展不开的走 [`unresolvable_install_locations`]，**不静默丢**。
pub fn extra_install_locations(
    snap: &RegistrySnapshot,
    env: &BTreeMap<String, String>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in &snap.uninstall {
        if !matches!(root.status, RootStatus::Listed) {
            continue;
        }
        for e in &root.entries {
            if let Some(p) = install_location_of(e, env) {
                if !out.iter().any(|q| q.to_string_lossy().eq_ignore_ascii_case(&p.to_string_lossy())) {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    out
}

/// **计划 §4.4 的盲区出口**：有条目给了 `InstallLocation`、但这一串展不出绝对路径。
///
/// 交出去的 token 是**那一串自己的 basename**（不是条目名）。这不是顺手的选择，是这条判据
/// 唯一测到东西的选法：真机上有 `{key: "D8A1F2B3…", DisplayName: 空, InstallLocation:
/// `%VARS%\urban-friendship-story`}` 这种形状 —— 条目名对不上候选目录名，而**路径的最后一段**
/// 正好就是候选目录名。用条目名当 token 的话，token 必然已经在 C1 的 `entries` 里，
/// 而 C1 的命中永远优先 ⇒ 这一档变成一条打不着任何东西的死代码（P2-T2 第一版就是这么写的，
/// 改过来的理由记在计划 §5）。
///
/// 空 / 缺键的 `InstallLocation` **不算盲区**：那不是「看到了但定位不了」，是「它本来就没登记
/// 位置」，把它算成盲区会让每一条无 `InstallLocation` 的卸载项把整台机器的 C4 打成弃权（过头）。
pub fn unresolvable_install_locations(
    snap: &RegistrySnapshot,
    env: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for root in &snap.uninstall {
        if !matches!(root.status, RootStatus::Listed) {
            continue;
        }
        for e in &root.entries {
            let raw = e.install_location.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                continue;
            }
            if install_location_of(e, env).is_some() {
                continue;
            }
            if let Some(token) = location_basename_token(raw) {
                if !out.contains(&token) {
                    out.push(token);
                }
            }
        }
    }
    out.sort();
    out
}

/// 一条展不开的 `InstallLocation` 里还能拿出来的**最后一段名字**（拿不出就 `None`）。
///
/// 展不开 ≠ 没有信息：`%NOT_INJECTED%\ghost-app` 的最后一段仍然是 `ghost-app`，
/// 那正是它想指向的那个目录叫什么。`D:\` 这一类只剩盘符的没有这一格。
fn location_basename_token(raw: &str) -> Option<String> {
    let s = raw.trim().trim_matches('"').replace('/', "\\");
    let last = s.rsplit('\\').find(|seg| !seg.is_empty())?;
    if last.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS || last.ends_with(':') {
        return None;
    }
    Some(last.to_string())
}

/// 一条卸载项的 `InstallLocation` → 可用的绝对路径（展不开给 `None`）。
pub fn install_location_of(
    entry: &UninstallEntry,
    env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    let raw = entry.install_location.as_deref()?;
    expand_install_location(raw, env)
}

/// 把 `InstallLocation` 原话转成一个绝对路径。
///
/// 三步都做**窄**的：去引号 → 用**注入的** env 表展 `%VAR%`（本 crate 一次都不读真实环境，
/// 展不开就是展不开，不许猜）→ 判「是不是绝对路径」+「basename 够不够长去做子串匹配」。
/// 斜杠按 Windows 口径归一（`C:/Program Files/Foo` 这种正斜杠写法在注册表里是真的存在的）。
pub fn expand_install_location(raw: &str, env: &BTreeMap<String, String>) -> Option<PathBuf> {
    let s = raw.trim().trim_matches('"').trim().replace('/', "\\");
    if s.is_empty() {
        return None;
    }
    let expanded = expand_percent_vars(&s, env)?;
    // 去掉尾巴上的分隔符（MSI 真的写 `"D:\App\"`）：留着它，两侧的去重与排序就会把
    // `D:\App` 与 `D:\App\` 当成两个根，报告里也点不清是哪一个。盘根（`D:\`）在上面那一步
    // 已经被 basename 长度闸挡掉了，这里不会把 `D:\` 削成 `D:`。
    let expanded = expanded.trim_end_matches('\\').to_string();
    if !looks_absolute(&expanded) {
        return None;
    }
    let base = expanded
        .rsplit('\\')
        .find(|seg| !seg.is_empty())
        .unwrap_or_default();
    if base.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS || base.ends_with(':') {
        return None;
    }
    Some(PathBuf::from(expanded))
}

/// `%VAR%` 就地展开；**任何一个**变量展不出来就交 `None`（半截展开的路径比不展开更坏：
/// 它会长成一个「看起来像绝对路径」的假根，然后 C4 在那儿「看到了一片空白」）。
fn expand_percent_vars(s: &str, env: &BTreeMap<String, String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = s;
    loop {
        let Some(open) = rest.find('%') else {
            out.push_str(rest);
            return Some(out);
        };
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else {
            // 落单的 `%`：不是变量形状。原样留着（路径里真有 % 的情况极少，留给 looks_absolute 去判）。
            out.push('%');
            out.push_str(after);
            rest = "";
            return if rest.is_empty() { Some(out) } else { None };
        };
        let name = &after[..close];
        if name.is_empty() {
            // `%%`：MSI 的转义写法，代表一个字面 `%`。
            out.push('%');
        } else {
            let value = lookup_env(env, name)?;
            out.push_str(&value);
        }
        rest = &after[close + 1..];
    }
}

/// 绝对路径的形状：`X:\…` / `X:` 或 UNC `\\server\share`。
fn looks_absolute(s: &str) -> bool {
    if s.starts_with("\\\\") {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

// ---------------------------------------------------------------- 真机采集（只读 FFI）

use windows_sys::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS, FILETIME,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};

/// C1 的三个根（计划 §1.1 那句「HKLM 64 位、HKLM WOW6432Node、HKCU」）。
///
/// 32 位那一根走的是 `KEY_WOW64_32KEY` **视图选择位**而不是去枚举
/// `SOFTWARE\WOW6432Node\…`：前者是微软给的正规读法，后者会把视图名混进路径里、
/// 在 32 位系统上还会凭空多一条「键不存在」。报告里点名仍然写 WOW6432Node，那才是人看得懂的话。
struct RootSpec {
    /// 报告里点名的路径（人话）。
    label: &'static str,
    hive: HKEY,
    subkey: &'static str,
    sam: u32,
}

const UNINSTALL_SPECS: [RootSpec; 3] = [
    RootSpec {
        label: r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall（64 位视图）",
        hive: HKEY_LOCAL_MACHINE,
        subkey: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        sam: KEY_READ | KEY_WOW64_64KEY,
    },
    RootSpec {
        label: r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall（32 位视图）",
        hive: HKEY_LOCAL_MACHINE,
        subkey: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        sam: KEY_READ | KEY_WOW64_32KEY,
    },
    RootSpec {
        label: r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        hive: HKEY_CURRENT_USER,
        subkey: r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        sam: KEY_READ,
    },
];

const VENDOR_SPECS: [RootSpec; 3] = [
    RootSpec {
        label: r"HKLM\SOFTWARE（64 位视图顶层键）",
        hive: HKEY_LOCAL_MACHINE,
        subkey: "SOFTWARE",
        sam: KEY_READ | KEY_WOW64_64KEY,
    },
    RootSpec {
        label: r"HKLM\SOFTWARE\WOW6432Node（32 位视图顶层键）",
        hive: HKEY_LOCAL_MACHINE,
        subkey: "SOFTWARE",
        sam: KEY_READ | KEY_WOW64_32KEY,
    },
    RootSpec {
        label: r"HKCU\SOFTWARE（顶层键）",
        hive: HKEY_CURRENT_USER,
        subkey: "SOFTWARE",
        sam: KEY_READ,
    },
];

/// 卸载表里要读的两个值名（§1.3：`DisplayName` / `InstallLocation`）。
const VALUE_DISPLAY_NAME: &str = "DisplayName";
const VALUE_INSTALL_LOCATION: &str = "InstallLocation";

/// **真机采集入口**：只读枚举三根卸载表 + 三根 `SOFTWARE` 顶层键。
///
/// 只被壳层调（P2-T4 的 `service.rs`），一次扫描调一次（计划 §2.7）。
/// 判据层的用例**一个都不调它** —— 它们传的是手搭的 [`RegistrySnapshot`]。
pub fn collect_snapshot() -> RegistrySnapshot {
    RegistrySnapshot {
        uninstall: UNINSTALL_SPECS.iter().map(collect_uninstall_root).collect(),
        vendors: VENDOR_SPECS.iter().map(collect_vendor_root).collect(),
    }
}

fn collect_uninstall_root(spec: &RootSpec) -> UninstallRoot {
    let mut root = UninstallRoot {
        path: spec.label.to_string(),
        status: RootStatus::Listed,
        entries: Vec::new(),
    };
    let opened = open_key(spec.hive, spec.subkey, spec.sam);
    match opened {
        Ok(Some(hkey)) => {
            match enum_subkeys(hkey) {
                Ok(keys) => {
                    for key in keys {
                        let mut entry = UninstallEntry {
                            key: key.clone(),
                            display_name: None,
                            install_location: None,
                        };
                        // 子键打不开：这一条读不到，但**整根**不能因此算「证完了」吗？
                        // 算。少一条卸载项只会少一条 Present 证据（少删方向），
                        // 而把整根打成 Unavailable 会让一台机器上一条都提不议（过头）。
                        if let Ok(Some(sub)) = open_key(hkey, &key, KEY_READ) {
                            entry.display_name = read_sz(sub, VALUE_DISPLAY_NAME).ok().flatten();
                            entry.install_location = read_sz(sub, VALUE_INSTALL_LOCATION).ok().flatten();
                            unsafe {
                                RegCloseKey(sub);
                            }
                        }
                        root.entries.push(entry);
                    }
                }
                Err(e) => root.status = RootStatus::Unavailable(enum_failure("RegEnumKeyExW", e)),
            }
            unsafe {
                RegCloseKey(hkey);
            }
        }
        Ok(None) => root.status = RootStatus::Missing,
        Err(e) => root.status = RootStatus::Unavailable(open_failure("RegOpenKeyExW", e)),
    }
    root
}

fn collect_vendor_root(spec: &RootSpec) -> VendorRoot {
    let mut root = VendorRoot {
        path: spec.label.to_string(),
        status: RootStatus::Listed,
        keys: Vec::new(),
    };
    match open_key(spec.hive, spec.subkey, spec.sam) {
        Ok(Some(hkey)) => {
            match enum_subkeys(hkey) {
                Ok(keys) => root.keys = keys,
                Err(e) => root.status = RootStatus::Unavailable(enum_failure("RegEnumKeyExW", e)),
            }
            unsafe {
                RegCloseKey(hkey);
            }
        }
        Ok(None) => root.status = RootStatus::Missing,
        Err(e) => root.status = RootStatus::Unavailable(open_failure("RegOpenKeyExW", e)),
    }
    root
}

/// 打开一个键。`Ok(None)` = 「这个键不存在」（看过、空的），`Err` = 取不到证据。
fn open_key(hive: HKEY, subkey: &str, sam: u32) -> Result<Option<HKEY>, u32> {
    let name = to_wide(subkey);
    let mut out: HKEY = std::ptr::null_mut();
    let rc = unsafe { RegOpenKeyExW(hive, name.as_ptr(), 0, sam, &mut out) };
    if rc == ERROR_SUCCESS {
        Ok(Some(out))
    } else if rc == ERROR_FILE_NOT_FOUND {
        Ok(None)
    } else {
        Err(rc)
    }
}

/// 枚举子键名。缓冲区不够时按 `ERROR_MORE_DATA` 回传的容量重试一次那一格（不推进 index）。
fn enum_subkeys(key: HKEY) -> Result<Vec<String>, u32> {
    let mut names: Vec<String> = Vec::new();
    let mut buf = vec![0u16; 512];
    let mut index: u32 = 0;
    let mut retries = 0usize;
    loop {
        let mut len = buf.len() as u32;
        let mut class_len: u32 = 0;
        let mut last_modified: FILETIME = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let rc = unsafe {
            RegEnumKeyExW(
                key,
                index,
                buf.as_mut_ptr(),
                &mut len,
                std::ptr::null(),
                std::ptr::null_mut(),
                &mut class_len,
                &mut last_modified,
            )
        };
        if rc == ERROR_SUCCESS {
            names.push(from_wide(&buf[..len as usize]));
            index += 1;
            retries = 0;
        } else if rc == ERROR_MORE_DATA && retries < 3 {
            let want = (len as usize).max(buf.len() * 2).min(65_536);
            buf = vec![0u16; want + 1];
            retries += 1;
        } else if rc == ERROR_NO_MORE_ITEMS {
            return Ok(names);
        } else {
            return Err(rc);
        }
    }
}

/// 读一个字符串值（`REG_SZ` / `REG_EXPAND_SZ`）。`Ok(None)` = 这个值名不存在。
///
/// `REG_EXPAND_SZ` **不**在这里展：展它是 [`expand_percent_vars`] 的活，用的是**注入的**
/// env 表，而不是真实环境（那既守住了「全靠注入」，也让用例能测 `%VAR%` 展不开那一支）。
fn read_sz(key: HKEY, value: &str) -> Result<Option<String>, u32> {
    let name = to_wide(value);
    let mut kind: u32 = 0;
    let mut size: u32 = 0;
    let rc = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if rc != ERROR_SUCCESS {
        return Err(rc);
    }
    if !matches!(kind, 1 | 2) {
        // 1 = REG_SZ、2 = REG_EXPAND_SZ。其它类型（REG_MULTI_SZ / DWORD / …）不是这一路要的
        // 「一个名字」，读成字符串会得到噪声；当作「这条值没有」处理，不污染 entries。
        return Ok(None);
    }
    let mut buf = vec![0u8; size as usize + 2];
    let mut out_size = size;
    let rc = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buf.as_mut_ptr(),
            &mut out_size,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(rc);
    }
    let units: Vec<u16> = buf
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let s = from_wide(&units);
    let s = s.trim().to_string();
    if s.is_empty() {
        Ok(None)
    } else {
        Ok(Some(s))
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn open_failure(api: &str, code: u32) -> String {
    format!("{api} 失败（错误码 {code}）—— 这一路给不出证据，按弃权处理，不当成「没有」")
}

fn enum_failure(api: &str, code: u32) -> String {
    format!("{api} 中断（错误码 {code}）—— 枚举出来的那一半不足以说「都看过了」")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> BTreeMap<String, String> {
        let mut e = BTreeMap::new();
        e.insert("LOCALAPPDATA".into(), r"C:\Users\x\AppData\Local".into());
        e.insert("USERPROFILE".into(), r"C:\Users\x".into());
        e
    }

    fn root(path: &str, status: RootStatus, entries: Vec<UninstallEntry>) -> UninstallRoot {
        UninstallRoot { path: path.into(), status, entries }
    }

    fn entry(key: &str, display: Option<&str>, location: Option<&str>) -> UninstallEntry {
        UninstallEntry {
            key: key.into(),
            display_name: display.map(str::to_string),
            install_location: location.map(str::to_string),
        }
    }

    #[test]
    fn a_snapshot_that_was_never_collected_is_never_checked_and_empty() {
        // 核心 fail-safe 在注册表这一路的形状：默认值（没采集）必须是 Unavailable。
        for cs in [
            uninstall_scan(&RegistrySnapshot::nothing_collected()),
            vendor_key_scan(&RegistrySnapshot::nothing_collected()),
        ] {
            assert!(
                matches!(cs.probe("claude"), crate::Probe::Unavailable(_)),
                "空快照被读成「卸载表是空的」了：{:?}",
                cs.probe("claude")
            );
        }
    }

    #[test]
    fn a_missing_key_root_counts_as_verified_empty_not_as_failure() {
        // 32 位视图在没有 WOW64 的机器上就是不存在 —— 那是「看过、空的」，不是取不到证据。
        let snap = RegistrySnapshot {
            uninstall: vec![root("HKCU\\…\\Uninstall", RootStatus::Missing, vec![])],
            vendors: vec![],
        };
        let cs = uninstall_scan(&snap);
        assert_eq!(cs.roots_configured, 1);
        assert_eq!(cs.roots_verified, 1);
        assert!(matches!(cs.probe("claude"), crate::Probe::CheckedNoHit));
        // 但「一条根都没配」与「根不存在」必须分得开（前者才是覆盖面塌了）。
        assert_eq!(
            uninstall_scan(&RegistrySnapshot::default()).roots_configured,
            0
        );
    }

    #[test]
    fn vendor_entries_are_key_names_only_never_paths() {
        // 痕迹喂路径 = 给「Windows / CurrentVersion」这类候选名发入场券，方向是多删。
        let snap = RegistrySnapshot {
            uninstall: vec![],
            vendors: vec![VendorRoot {
                path: r"HKLM\SOFTWARE（64 位视图顶层键）".into(),
                status: RootStatus::Listed,
                keys: vec!["Microsoft".into(), "Acme".into()],
            }],
        };
        let cs = vendor_key_scan(&snap);
        assert!(matches!(cs.probe("acme"), crate::Probe::Hit(_)));
        assert!(
            !cs.entries.iter().any(|e| e.contains('\\')),
            "厂商键的证据串里混进了路径：{:?}",
            cs.entries
        );
        assert!(!matches!(cs.probe("currentversion"), crate::Probe::Hit(_)));
    }

    #[test]
    fn install_locations_expand_into_extra_roots() {
        let snap = RegistrySnapshot {
            uninstall: vec![root(
                "HKLM\\…\\Uninstall",
                RootStatus::Listed,
                vec![
                    entry("D8A1F2B3", Some("Claude"), Some(r"D:\Software\Claude\")),
                    entry("Quark", Some("夸克"), Some(r"C:/Users/x/AppData/Local/Programs/Quark")),
                    entry("WithVar", Some("WithVar"), Some(r"%LOCALAPPDATA%\Programs\WithVar")),
                ],
            )],
            vendors: vec![],
        };
        let got = extra_install_locations(&snap, &env());
        assert_eq!(got.len(), 3, "三个都能展开拓三个：{got:?}");
        assert!(got.iter().any(|p| p.to_string_lossy() == r"D:\Software\Claude"), "{got:?}");
        assert!(
            got.iter().any(|p| p.to_string_lossy() == r"C:\Users\x\AppData\Local\Programs\WithVar"),
            "%VAR% 没用注入的表展：{got:?}"
        );
        assert!(unresolvable_install_locations(&snap, &env()).is_empty());
    }

    #[test]
    fn an_unexpandable_install_location_becomes_a_named_gap_not_a_drop() {
        let snap = RegistrySnapshot {
            uninstall: vec![root(
                "HKLM\\…\\Uninstall",
                RootStatus::Listed,
                vec![
                    entry("D8A1F2B3", None, Some(r"%NOT_INJECTED%\urban-friendship-story")),
                    entry("Rel", Some("RelativeApp"), Some(r"Apps\NotAbsolute")),
                    entry("Bare", Some("DriveRoot"), Some(r"D:\")),
                    entry("Blank", Some("NoLocation"), Some("   ")),
                    entry("None", Some("KeyMissing"), None),
                ],
            )],
            vendors: vec![],
        };
        assert!(extra_install_locations(&snap, &env()).is_empty());
        let gaps = unresolvable_install_locations(&snap, &env());
        // 盲区 token 是**那一串的最后一段**：GUID 键 + 空 DisplayName 的真形状里，
        // 只有路径自己还在说这个应用叫什么。用条目名当 token 的话这一档永远打不着候选
        // （条目名能打着候选的时候 C1 早就 Hit 了），那就是死代码。
        assert_eq!(
            gaps,
            vec!["NotAbsolute".to_string(), "urban-friendship-story".to_string()],
            "{gaps:?}"
        );
        // 只剩盘符 / 空 / 缺键的 InstallLocation 不算盲区（不是「看到了但展不开」）——
        // 否则真机 85 条卸载项会把整台机器的 C4 全打成弃权（过头）。
        assert!(!gaps.iter().any(|g| g == "NoLocation" || g == "KeyMissing" || g == "DriveRoot" || g == "D:"), "{gaps:?}");
        // 盲区只对**名字对得上**的候选生效（C4 那一侧由 ChannelScan::gaps 执行）。
        let mut cs = crate::channel::ChannelScan {
            roots_configured: 1,
            roots_verified: 1,
            gaps: gaps.clone(),
            ..Default::default()
        };
        assert!(matches!(cs.probe("urban-friendship-story"), crate::Probe::Unavailable(_)));
        cs.entries.push("SomethingElse".to_string());
        assert!(!matches!(cs.probe("urban-friendship-story"), crate::Probe::Hit(_)));
    }

    #[test]
    fn quoted_and_slashed_install_locations_still_work() {
        // MSI 真的会写 `"D:\App\"` 这种带引号的值；正斜杠写法也在野外观测过。
        assert_eq!(
            expand_install_location(r#""D:\App\""#, &env()).map(|p| p.to_string_lossy().into_owned()),
            Some(r"D:\App".to_string())
        );
        assert_eq!(
            expand_install_location(r"C:/Tools/Foo", &env()).map(|p| p.to_string_lossy().into_owned()),
            Some(r"C:\Tools\Foo".to_string())
        );
        assert_eq!(expand_install_location("", &env()), None);
        assert_eq!(expand_install_location(r"\\nas\share\App", &env()).map(|p| p.to_string_lossy().into_owned()), Some(r"\\nas\share\App".to_string()));
    }

    #[test]
    fn a_lone_percent_is_left_alone_but_an_unknown_var_is_not() {
        assert_eq!(
            expand_install_location(r"D:\50%\App", &env()).map(|p| p.to_string_lossy().into_owned()),
            Some(r"D:\50%\App".to_string())
        );
        assert_eq!(expand_install_location(r"%NOPE%\App", &env()), None);
        // `%%` 是 MSI 的字面 % 转义。
        assert_eq!(
            expand_install_location(r"D:\A%%B\App", &env()).map(|p| p.to_string_lossy().into_owned()),
            Some(r"D:\A%B\App".to_string())
        );
    }
}
