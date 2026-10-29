//! `fs_probe` —— 三条**文件系统只读**通道：C3（MSIX 包目录）、C4（安装根一级目录）、
//! C6（开始菜单快捷方式）。计划 §1.3 那张表里这三条的实现列都写着 `std::fs::read_dir`。
//!
//! ## 这一层只有「看」，没有「动」
//!
//! 本文件与 `lib.rs` 的生产片段里，一个写/删/建的 API 都不许出现，也不起进程 ——
//! 由 `tests/readonly.rs` 那道静态闸钉着（形状照 `crates/devenv/tests/readonly.rs`）。
//! 这条纪律不是形式主义：这一层是**唯一**允许摸真机的探针层之一（另外两条是
//! `registry.rs` 的注册表只读枚举与 `procs.rs` 的进程快照），而它的结论后面接的是删除。
//! 探针自己动了盘，「这台机器上现在装着什么」就变成「探针走后剩下什么」了。
//!
//! ## 三态在哪里定义
//!
//! 每条通道对每个候选给一个 [`Probe`]（`crates/appfacts::Probe`）；承载「这一路看到了什么、
//! 哪里没看到」的容器是 [`ChannelScan`]，P2-T2 起它住在 [`crate::channel`] 并由六条通道共用
//! （顺序判据：命中 > 有失败 > 对本候选有盲区 > 一个根都没配 > 证完了没有）。
//! 本文件只负责把三条 FS 通道填进那个容器：
//!
//! - **命中** → [`Probe::Hit`]（C3/C4 是本体证据 → `Present`；C6 只是痕迹）；
//! - **枚举成功且没有命中** → [`Probe::CheckedNoHit`]：这是「无本体」这一半**需要**的那种没有 ——
//!   它必须建立在「真的去看过了」上面；根不存在（`NotFound`）也算看过（那个位置确实是空的）；
//! - **取不到证据** → [`Probe::Unavailable`]（根没配上 / 权限拒 / IO 失败）。
//!   ⚠️ 没跑过的通道**绝不许**报 `CheckedNoHit`：那等于替一条没跑过的通道作证「这里没有本体」，
//!   正是多删的那一半。这条由 [`crate::FactScan::probe_for`] 的兜底分支写死。
//!
//! ## 匹配口径（计划 §1.3）
//!
//! 候选目录 basename 小写后与证据串做**双向包含**（`条目含候选` 或 `候选含条目`），
//! 与 M5-P1 审计里那轮手工取证同法。C3 另外拿 MSIX 的**包族名**（`_<哈希>` 之前那一段）比一次。
//!
//! ⚠️ 这套口径**只用来给 Present/痕迹 找证据**，绝不反过来当 Absent 的判据 ——
//! 子串匹配造出的假「查无」正是规格 §4.2 那三次误杀的成因。所以太短的候选名
//! （[`crate::MIN_MATCHABLE_KEY_CHARS`]）连匹配都不参与，直接全通道弃权。

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::{InstallRoot, ProbeRoots, CH_INSTALL_ROOTS, CH_PACKAGES, CH_START_MENU};

// 一条通道的结果形状与匹配口径住在 `crate::channel`（P2-T2 起六条通道共用一份）。
// 这里按原名再导出：`fs_probe::ChannelScan` / `fs_probe::name_matches` /
// `fs_probe::package_family` 在 P2-T1 就已经是公开面。
pub use crate::channel::{name_matches, package_family, ChannelScan};

/// 三条文件系统通道的取证结果，一次 [`scan`] 跑完（同一次调用里每条通道只枚举一遍 ——
/// 计划 §2.7「一次扫描只采一次」在这层的投影）。
#[derive(Debug, Clone, Default)]
pub struct FsScan {
    /// key = 通道名（[`CH_PACKAGES`] / [`CH_INSTALL_ROOTS`] / [`CH_START_MENU`]）。
    pub channels: BTreeMap<&'static str, ChannelScan>,
}

/// **C3 / C4 / C6 的采集面**：跑真盘（由调用方给的根决定是哪棵树），零写、零删、零建。
pub fn scan(roots: &ProbeRoots) -> FsScan {
    let mut channels: BTreeMap<&'static str, ChannelScan> = BTreeMap::new();
    channels.insert(CH_PACKAGES, scan_packages(roots.packages.as_deref()));
    channels.insert(CH_INSTALL_ROOTS, scan_install_roots(&roots.install_roots));
    channels.insert(CH_START_MENU, scan_start_menu(&roots.start_menu_roots));
    FsScan { channels }
}

impl FsScan {
    /// 这一路对候选 `key` 的结论；`channels` 里没有这一路时返回 `None`
    /// （交 [`crate::FactScan::probe_for`] 兜底成 `Unavailable` —— 兜底方向必须是弃权）。
    pub fn probe(&self, channel: &'static str, key: &str) -> Option<crate::Probe> {
        self.channels.get(channel).map(|cs| cs.probe(key))
    }
}

// ---------------------------------------------------------------- 各通道的枚举

/// C3：`<LOCALAPPDATA>\Packages` 的一级目录名。方向 = **Present，且单向**（计划 §1.2）。
///
/// MSIX 装完必然在这里留一个 `<包族名>_<包哈希>` 目录；卸载后**可能留壳**。
/// 所以这一路的结论只允许往 `Present` 用：见到就弃权（`Present`），见不到不推定任何东西。
fn scan_packages(dir: Option<&Path>) -> ChannelScan {
    let mut cs = ChannelScan {
        family_aware: true,
        // 本体通道 ⇒ 放宽（P2-T2 裁定，见 `channel::name_matches_loose`）。
        loose_match: true,
        ..ChannelScan::default()
    };
    let Some(dir) = dir else {
        cs.failures
            .push("C3 的容器根推导不出来：注入的 env 表里没有 LOCALAPPDATA（本 crate 不读真实环境）".to_string());
        return cs;
    };
    cs.roots_configured = 1;
    match list_child_dirs(dir) {
        Ok(names) => {
            cs.roots_verified = 1;
            cs.entries = names;
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // 这个账号下确实没有任何 MSIX 包：是「看过了，空的」，不是「没看到」。
            cs.roots_verified = 1;
            cs.empty_notes
                .push(format!("包目录容器「{}」不存在", dir.display()));
        }
        Err(e) => cs
            .failures
            .push(format!("包目录容器「{}」：{e}", dir.display())),
    }
    cs
}

/// C4：安装根的一级目录名。方向 = Present。
///
/// 默认三根（`Program Files` ×2 + `<LOCALAPPDATA>\Programs`）**不够**：计划 §4.4 点名
/// 参考机 85 条卸载项里一大半 `InstallLocation` 在 D 盘，只扫默认三根就会把
/// 装在自定义根上的活应用看成「无本体」。所以 `extra` 根（由 `InstallLocation` 反推、
/// 或配置追加的那些）除一级目录外，**根自己的 basename 也算本体证据**。
fn scan_install_roots(roots: &[InstallRoot]) -> ChannelScan {
    let mut cs = ChannelScan {
        // 本体通道 ⇒ 放宽（P2-T2 裁定，见 `channel::name_matches_loose`）。
        loose_match: true,
        ..ChannelScan::default()
    };
    cs.roots_configured = roots.len();
    for r in roots {
        match list_child_dirs(&r.path) {
            Ok(names) => {
                cs.roots_verified += 1;
                if r.extra {
                    // 调用方指名「这就是某个应用的安装位置」，那么这个位置在 = 本体在。
                    if let Some(base) = r.path.file_name() {
                        cs.entries.push(base.to_string_lossy().into_owned());
                    }
                }
                cs.entries.extend(names);
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                // 根不存在：装在这里的应用确实没装着（陈旧 InstallLocation 正是要被抓出来的那种）。
                cs.roots_verified += 1;
                cs.empty_notes.push(format!("安装根「{}」不存在", r.path.display()));
            }
            Err(e) => cs
                .failures
                .push(format!("安装根「{}」：{e}", r.path.display())),
        }
    }
    cs.entries.sort();
    cs
}

/// C6：开始菜单 `.lnk` 的文件名（去掉扩展名）。方向 = **只当痕迹**。
///
/// 递归深度 ≤ 2（根 + 根的直接子目录），**只看文件名**，不读快捷方式内容，
/// 也不跟着更深的层级走 —— 公共开始菜单里 `Tools\xyz\…\a.lnk` 这种三层以上的东西
/// 归属本来就不明，多收进来只会造出假痕迹。
fn scan_start_menu(root_list: &[PathBuf]) -> ChannelScan {
    // 痕迹通道：`loose_match` **留在默认 false** 那一侧。放宽痕迹 = 多发 `Absent` 的入场券，
    // 而 `Absent` 后面接的是删除（P2-T2 裁定，理由见 `channel::name_matches_loose` 的文档块，
    // 钉在 `trace_matching_stays_literal_by_p2_t2_adjudication`）。
    let mut cs = ChannelScan::default();
    cs.roots_configured = root_list.len();
    for root in root_list {
        match list_entries(root) {
            Ok(top) => {
                cs.roots_verified += 1;
                for (name, is_dir) in &top {
                    if *is_dir {
                        // 深度 2：子目录里的 .lnk。子目录算在父根这一次取证里，不另计一根。
                        match list_entries(&root.join(name)) {
                            Ok(sub) => {
                                for (n2, is_dir2) in sub {
                                    if !is_dir2 {
                                        if let Some(stem) = lnk_stem(&n2) {
                                            cs.entries.push(stem);
                                        }
                                    }
                                }
                            }
                            Err(e) => cs.failures.push(format!(
                                "开始菜单子目录「{}\\{name}」：{e}",
                                root.display()
                            )),
                        }
                    } else if let Some(stem) = lnk_stem(name) {
                        cs.entries.push(stem);
                    }
                }
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                cs.roots_verified += 1;
                cs.empty_notes
                    .push(format!("开始菜单根「{}」不存在", root.display()));
            }
            Err(e) => cs
                .failures
                .push(format!("开始菜单根「{}」：{e}", root.display())),
        }
    }
    cs.entries.sort();
    cs
}

// ---------------------------------------------------------------- 小工具（全是读的）

/// 一级条目：`(名字, 是不是目录)`。`file_type` 拿不到时按「不是目录」处理 ——
/// 少收一条证据只会往 `Present` 的方向少，不会造出假「无本体」。
fn list_entries(dir: &Path) -> std::io::Result<Vec<(String, bool)>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push((entry.file_name().to_string_lossy().into_owned(), is_dir));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// 一级**目录**名（C3/C4 用：装着的证据得是个目录）。
fn list_child_dirs(dir: &Path) -> std::io::Result<Vec<String>> {
    Ok(list_entries(dir)?
        .into_iter()
        .filter(|(_, is_dir)| *is_dir)
        .map(|(n, _)| n)
        .collect())
}

/// `.lnk` 文件名去扩展名（大小写不敏感地认扩展名）。
fn lnk_stem(name: &str) -> Option<String> {
    let (stem, ext) = name.rsplit_once('.')?;
    if ext.eq_ignore_ascii_case("lnk") && !stem.is_empty() {
        Some(stem.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FactScan, Probe};

    #[test]
    fn package_family_strips_only_a_real_hash_suffix() {
        assert_eq!(package_family("Claude_pzs8sxrjxfjjc"), "Claude");
        assert_eq!(package_family("com.flutter.kazumi_wbnnev551gwxy"), "com.flutter.kazumi");
        // 尾巴不像包哈希的不动它：`_Router` 大写字母、`_ab` 太短。
        assert_eq!(package_family("Teamo_Router"), "Teamo_Router");
        assert_eq!(package_family("foo_ab"), "foo_ab");
        assert_eq!(package_family("no_underscore"), "no_underscore");
    }

    #[test]
    fn matching_is_bidirectional_but_never_swallows_empty() {
        assert!(name_matches("claude", "Claude"));
        assert!(name_matches("claude", "claude_code_host"));
        assert!(name_matches("com.flutter.kazumi", "kazumi"));
        // 空 token 恒真是这里最贵的那种错。
        assert!(!name_matches("claude", ""));
        assert!(!name_matches("", "claude"));
        // 大小写不敏感（key 侧已经是小写）。
        assert!(name_matches("kazumi", "KAZUMI_wbnnev551gwxy"));
    }

    /// P2-T2 裁定的那条（计划 §1.3 的 ⚠️ 那一格）：**痕迹**那一半的字面口径不放宽。
    /// 空格↔连字符归一会让 `Acme Tool.lnk` 变成候选 `acme-tool` 的痕迹，而痕迹是
    /// `Absent` 的入场券 —— 降低门槛的方向就是多删。这条测试钉住「不归一」这件事本身。
    #[test]
    fn trace_matching_stays_literal_by_p2_t2_adjudication() {
        assert!(
            !name_matches("acme-tool", "Acme Tool"),
            "痕迹口径被放宽了：那等于降低 Absent 的门槛（删除方向）"
        );
        assert!(name_matches("acme-tool", "acme-tool"), "字面同名的痕迹仍然要算");
    }

    #[test]
    fn an_unregistered_channel_never_reports_checked_no_hit() {
        // 兜底分支：没跑过的通道 = 弃权。这条是「替没跑过的通道作证这里没有本体」的防线。
        let empty = FactScan::default();
        let p = empty.probe_for("C7 某个还没影的通道", "claude");
        assert!(matches!(p, Probe::Unavailable(_)), "实际 {p:?}");
        // 三条 FS 通道在没 scan 过的 FactScan 上同样只能弃权。
        for ch in [CH_PACKAGES, CH_INSTALL_ROOTS, CH_START_MENU] {
            assert!(
                matches!(empty.probe_for(ch, "claude"), Probe::Unavailable(_)),
                "{ch} 在空表上不许报「证完了」"
            );
        }
    }

    #[test]
    fn a_root_that_could_not_be_read_degrades_the_probe_not_the_conclusion() {
        // 一个必然读不出来的根（不存在的路径 + 一条 IO 失败）：
        // NotFound 走「看过且为空」，其它错误走 Unavailable —— 后者绝不能被折叠成 CheckedNoHit。
        let mut cs = ChannelScan::default();
        cs.roots_configured = 1;
        cs.failures.push("安装根「X」：Access is denied".to_string());
        assert!(matches!(cs.probe("claude"), Probe::Unavailable(_)));
        let mut cs2 = ChannelScan::default();
        cs2.roots_configured = 1;
        cs2.roots_verified = 1;
        cs2.empty_notes.push("安装根「X」不存在".to_string());
        assert!(matches!(cs2.probe("claude"), Probe::CheckedNoHit));
        // 一个根都没配 → 覆盖面是空的，不许报「证完了」。
        assert!(matches!(ChannelScan::default().probe("claude"), Probe::Unavailable(_)));
    }

    #[test]
    fn a_gap_blinds_only_the_candidate_it_names() {
        // 盲区（§4.4：InstallLocation 展不出绝对路径）只对**名字对得上**的候选生效：
        // 全局打成 Unavailable 会让整台机器一条都提不议，不当回事又是在替没看的地点作证。
        let mut cs = ChannelScan {
            roots_configured: 1,
            roots_verified: 1,
            gaps: vec!["Bcfm".to_string()],
            ..ChannelScan::default()
        };
        assert!(
            matches!(cs.probe("bcfm"), Probe::Unavailable(_)),
            "匹配到盲区条目却报了「证完了」"
        );
        assert!(
            matches!(cs.probe("ghost"), Probe::CheckedNoHit),
            "无关候选被盲区连带打成弃权了：覆盖面塌成一团"
        );
        // 命中优先于盲区（见到本体就是本体在）。
        cs.entries.push("Bcfm.exe".to_string());
        assert!(matches!(cs.probe("bcfm"), Probe::Hit(_)));
    }
}
