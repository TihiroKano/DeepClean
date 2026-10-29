//! `channel` —— **一条通道**的取证结果形状，六条通道共用（计划 §1.3 的 C1–C6）。
//!
//! 为什么这一层要独立成文件：P2-T1 时它住在 `fs_probe.rs`，因为那时只有三条**文件系统**
//! 通道；P2-T2 把注册表（C1/C2）与进程快照（C5）接进来之后，三条通道的形状与三条 Win32
//! 通道的形状必须是**同一个**三态容器 —— 否则「看过了、确实没有」与「没看成」在两条实现里
//! 会长成两副样子，而这两句话的差别正是这条判据的全部内容。
//!
//! ## 三态在这里怎么来（与 `fs_probe` 的模块文档同一条纪律）
//!
//! - **命中** → [`Probe::Hit`]（C1/C3/C4/C5 是本体证据 → `Present`；C2/C6 只是痕迹）；
//! - **枚举成功且没有命中** → [`Probe::CheckedNoHit`]：「无本体」那一半**需要**的那种没有，
//!   它必须建立在「真的去看过了」上面；根不存在（`NotFound` / 键不存在）也算看过；
//! - **取不到证据** → [`Probe::Unavailable`]（根没配上 / 权限拒 / IO 失败 / 没实现）。
//!
//! [`ChannelScan::probe`] 的顺序**就是判据**，不可调：
//! 命中 > 有失败 > **对这个候选有盲区** > 一个根都没配 > 证完了没有。
//! 第三档（[`ChannelScan::gaps`]）是 P2-T2 加的：见它的字段文档。

use crate::Probe;

/// 一条通道扫出来的东西 + 「哪儿没取到」。三态的第三态就住在这里。
#[derive(Debug, Clone, Default)]
pub struct ChannelScan {
    /// 证据串（目录名 / 快捷方式名 / 注册表值 / 进程镜像名，原样大小写，已排序 ——
    /// `Hit` 的细节要能逐字复现）。
    pub entries: Vec<String>,
    /// **取不到**证据的根，每个带原话（IO 错误、`RegEnumKeyExW` 的错误码、快照失败）。
    /// 非空 → 这条通道对所有候选都只能报 [`Probe::Unavailable`]。
    pub failures: Vec<String>,
    /// 看过但确实是空的根（`NotFound` / `ERROR_FILE_NOT_FOUND`：那个位置不存在，
    /// 本身是一条**看过**的结论）。留给报告与 P2-T4 对账，不改变结论。
    pub empty_notes: Vec<String>,
    /// **盲区**：通道整体跑成功了，但有一些条目「拿到了名字却定位不了它指哪儿」。
    ///
    /// 目前只有一处会产生它（计划 §4.4）：卸载表的 `InstallLocation` 展不出绝对路径时，
    /// 「这个应用的本体在不在磁盘上」对**那一串路径所指的应用**就成了未知，token 取的是
    /// 那一串的**最后一段**（理由见 `registry::unresolvable_install_locations` 的文档）。
    /// 它只对**名字匹配得上那一段**的候选生效 —— 把全局 C4 打成 `Unavailable`
    /// 会让整台机器一条都提不议（过头），把它当「没有这条」则是在替没看过的地方
    /// 作证「这里没有本体」（不够，那正是多删的一侧）。
    pub gaps: Vec<String>,
    /// 配了几个根（0 → 这条通道的覆盖面是空的，也报 `Unavailable`）。
    pub roots_configured: usize,
    /// 取证成功的根数（枚举出来 + 确实不存在）。
    pub roots_verified: usize,
    /// C3 专用：比较时额外拿包族名比一次（见 [`package_family`]）。
    pub family_aware: bool,
    /// **本体通道 = `true`，痕迹通道 = `false`**（P2-T2 的裁定，见 [`name_matches_loose`] 的文档）。
    ///
    /// 本体放宽（多算 Present = 少删）与痕迹收窄（少发 `Absent` 的入场券 = 少删）——
    /// 两个方向都朝「少删」，靠的就是这一格布尔，而不是两套通道共用一份口径。
    pub loose_match: bool,
}

impl ChannelScan {
    /// 这条通道对一个候选给什么结论。顺序是判据：命中 > 取不到 > 盲区 > 没配根 > 证完了没有。
    pub fn probe(&self, key: &str) -> Probe {
        if let Some(hit) = self.hit(key) {
            return Probe::Hit(hit);
        }
        if !self.failures.is_empty() {
            return Probe::Unavailable(format!(
                "{} 个根里 {}/{} 没取到证据：{}",
                self.roots_configured,
                self.failures.len(),
                self.roots_configured,
                self.failures.join("；")
            ));
        }
        // 盲区只在「这个候选确实对上了那条定位不了的条目」时才生效（见字段文档）。
        let blind: Vec<&String> = self.gaps.iter().filter(|g| self.matches(key, g)).collect();
        if !blind.is_empty() {
            return Probe::Unavailable(format!(
                "通道整体跑成功了，但{}/{} 条条目定位不出安装根（{install_hint}）：{list} —— \
                 对本候选而言「没看见本体」可能是「根本没看到那个位置」，按弃权处理",
                blind.len(),
                self.gaps.len(),
                install_hint = "InstallLocation 是空的、还是相对路径、还是环境变量展不开",
                list = blind.iter().map(|g| g.as_str()).collect::<Vec<&str>>().join("；")
            ));
        }
        if self.roots_configured == 0 {
            return Probe::Unavailable(
                "这条通道一个根都没配上 —— 覆盖面是空的，「没看见」推不出「没有」".to_string(),
            );
        }
        Probe::CheckedNoHit
    }

    /// 这条通道用哪一口径比：本体放宽（[`name_matches_loose`]）、痕迹收窄（[`name_matches`]）。
    ///
    /// 本体侧多一道**角色词**闸（[`GENERIC_ROLE_NAMES`]）：整条条目名就是个角色词时，
    /// 只有候选名与它**整串相等**才算本体证据。方向是把本体收窄（少 Present ⇒ 多弃权/多提议），
    /// 与 P2-T2 那条「本体侧要放宽」的裁定相反 —— 因为这条不是「歧义怎么写」而是
    /// 「这句话根本没有断言力」：`Program Files\update` 存在，推不出任何一个具体应用在场。
    pub fn matches(&self, key: &str, token: &str) -> bool {
        if !self.loose_match {
            return name_matches(key, token);
        }
        if is_generic_role_name(token) && !same_identity(key, token) {
            return false;
        }
        name_matches_loose(key, token)
    }

    /// 命中的证据串（带包族名口径），没命中返回 `None`。
    pub fn hit(&self, key: &str) -> Option<String> {
        self.entries.iter().find_map(|e| {
            if self.matches(key, e) {
                Some(if self.family_aware {
                    format!("条目「{e}」（包族名「{}」）", package_family(e))
                } else {
                    format!("条目「{e}」")
                })
            } else if self.family_aware && self.matches(key, package_family(e)) {
                Some(format!("包族名「{}」（原条目「{e}」）", package_family(e)))
            } else {
                None
            }
        })
    }
}

// ---------------------------------------------------------------- 匹配口径

/// 计划 §1.3 的匹配口径：**双向包含**，两侧都先小写归一。
///
/// 空串一律不匹配（`"".contains(…)` 恒真那条陷阱）。候选名的长度闸在
/// [`crate::is_matchable_key`]，不在这里 —— 这里只保证不吞空。
///
/// ⚠️ **不做空格↔连字符归一**（P2-T2 裁定，登记在计划 §5）：`Acme Tool.lnk` 匹配不上
/// 候选 `acme-tool`。放宽**痕迹**那一半等于降低 `Absent` 的门槛，而 `Absent` 后面接删除；
/// 窄口径漏掉的痕迹只会多弃权（少删），与计划 §0.1 同向。
pub fn name_matches(key: &str, token: &str) -> bool {
    let t = token.to_lowercase();
    let k = key.to_lowercase();
    // 条目侧也要够长才谈身份 —— 候选侧那一格在 [`crate::is_matchable_key`]，这一格由真机补上：
    // 卷根一级目录里有个名叫 `D` 的目录，双向包含之下它替**每一个**含 `d` 的候选证成了在场
    // （审计确认已卸载的 10 条 `*-updater`/数据目录全部被判 Present，就是这一格）。
    // 两侧同尺，同一个 `MIN_MATCHABLE_KEY_CHARS`，不许各写一把。
    if k.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS || t.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS {
        return false;
    }
    t.contains(&k) || k.contains(&t)
}

/// **本体通道那一半**的口径：字面双向包含 **或** 去掉分隔符（空格 / `-` / `_` / `.`）之后再比一次。
///
/// 这是 P2-T2 对手上那面接缝的裁定，与「痕迹那一半不归一」是同一件事的两面 —— 判据不是
/// 「哪一侧看起来更像正规化」，而是**哪一侧放宽之后落在少删的方向**：
///
/// ```text
///   本体（C1/C3/C4/C5）漏一条 ⇒ 少了 Present ⇒ 多判 Absent ⇒ 多删      → 这一侧要放宽
///   痕迹（C2/C6）多发一张     ⇒ 多了 Absent 的入场券 ⇒ 多删            → 这一侧要收窄
/// ```
///
/// 于是同一个歧义（`Acme Notepad` 对 `acme-tool` 那类连字符写法）在本体侧要认，
/// 在痕迹侧不认。归一化只**去掉**分隔符，不做任何大小写以外的变形（不裁后缀、不做词干、
/// 不折叠重复字母），因为那些都会让痕迹侧一起变宽 —— 而痕迹侧一行都不许动。
/// [`ChannelScan::loose_match`] 就是这条裁定的落点。
pub fn name_matches_loose(key: &str, token: &str) -> bool {
    if name_matches(key, token) {
        return true;
    }
    let k = strip_separators(&key.to_lowercase());
    let t = strip_separators(&token.to_lowercase());
    // 归一之后再过一次同一把尺：`D B` 去掉分隔符就成了 `db`，两格都够短就不许比。
    if k.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS || t.chars().count() < crate::MIN_MATCHABLE_KEY_CHARS {
        return false;
    }
    t.contains(&k) || k.contains(&t)
}

/// **角色词**：描述「这个目录是干什么的」而不是「这是谁」的名字。
///
/// 真机实测的成因：`<LOCALAPPDATA>\adrive-desktop-updater` 这类候选被安装根一级目录里
/// 一个名叫 `update` 的条目**证成了 Present**（双向包含：候选名含条目名），于是审计已确认
/// 卸载的 5 条 `*-updater`（1,063.9 MiB）一条都提不出来。角色词没有断言力 —— 任何一家
/// 厂商都会建一个 `update` 目录，无论它的应用在不在。
///
/// 只用在**本体**通道（`loose_match`），痕迹通道一行不动（那边宽一寸就多删一寸）。
///
/// ⚠️ 这张表**不许**收进能证明「某个厂商在场」的名字：`microsoft` / `windows` / `google`
/// 这类一旦进来，`%LOCALAPPDATA%\Microsoft` 就再也拿不到本体证据，而它有厂商键当痕迹
/// ⇒ 会被判成残留推上前台。[`role_list_never_contains_a_vendor_or_os_name`] 钉住这件事。
pub const GENERIC_ROLE_NAMES: [&str; 24] = [
    "update", "updates", "upgrade", "install", "installer", "installers", "setup", "uninstall",
    "temp", "tmp", "cache", "caches", "log", "logs", "data", "common", "files", "backup",
    "backups", "current", "runtime", "runtimes", "tools", "core",
];

/// 整条条目名是不是就是个角色词（多词的 `Common Files` 不算 —— 保守，只掐单名的吞并）。
fn is_generic_role_name(token: &str) -> bool {
    let t = token.to_lowercase();
    GENERIC_ROLE_NAMES.iter().any(|g| *g == t.as_str())
}

/// 「整串相等」：大小写与分隔符归一后逐字相等。这一格留给**真叫** `update` 的应用，
/// 它和「某个更长的名字里含 update」是两件事。
fn same_identity(key: &str, token: &str) -> bool {
    let k = strip_separators(&key.to_lowercase());
    let t = strip_separators(&token.to_lowercase());
    !k.is_empty() && k == t
}

fn strip_separators(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, ' ' | '-' | '_' | '.'))
        .collect()
}

/// MSIX 目录名 `<包族名>_<包哈希>` 里的前半段。
///
/// 包哈希后缀是**定长 13 位的 `[a-z0-9]`**（包族名 CanonicalPackageName 的那套），本机两个真形状：
/// `Claude_pzs8sxrjxfjjc` → `Claude`、`com.flutter.kazumi_wbnnev551gwxy` → `com.flutter.kazumi`。
/// 尾巴不像包哈希的原样返回 —— `no_underscore` 切成 `no`、`Teamo_Router`（大写字母）都不动。
/// 这条长度判据不是洁癖：切错了会让 `Packages` 里一个普通目录被当成包族名去比，
/// 而 [`ChannelScan::hit`] 是**拿包族名再比一次**（宽松方向 → 多算 Present → 少删），
/// 所以宁可少切。
pub fn package_family(entry: &str) -> &str {
    match entry.rfind('_') {
        Some(i) if looks_like_package_hash(&entry[i + 1..]) => &entry[..i],
        _ => entry,
    }
}

fn looks_like_package_hash(s: &str) -> bool {
    s.len() == 13 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// 从一串**已经拿到名字**的条目造一个通道结果（`roots_configured = 1`、`roots_verified = 1`）。
/// 三个 P2-T2 的采集器都用它收尾，顺序与 `fs_probe` 一致（排序 + 去重由调用方保证语义）。
pub fn scan_of_names(entries: Vec<String>) -> ChannelScan {
    let mut cs = ChannelScan {
        entries,
        roots_configured: 1,
        roots_verified: 1,
        ..ChannelScan::default()
    };
    cs.entries.sort();
    cs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(entries: &[&str]) -> ChannelScan {
        ChannelScan {
            entries: entries.iter().map(|s| s.to_string()).collect(),
            roots_configured: 1,
            roots_verified: 1,
            loose_match: true,
            ..ChannelScan::default()
        }
    }

    fn trace(entries: &[&str]) -> ChannelScan {
        ChannelScan { loose_match: false, ..body(entries) }
    }

    /// 真机那一格的形状：安装根一级目录里有个 `update`，它**不许**替任何具体应用作证。
    #[test]
    fn a_role_word_cannot_prove_a_longer_candidate_is_installed() {
        for entry in ["update", "Temp", "installer", "backups"] {
            let cs = body(&[entry]);
            for key in ["adrive-desktop-updater", "clash_win-updater", "webcast_mate-updater"] {
                assert!(
                    matches!(cs.probe(key), Probe::CheckedNoHit),
                    "条目「{entry}」把候选「{key}」证成了在场：{:?}",
                    cs.probe(key)
                );
            }
        }
    }

    /// 反向半边：真叫这个名字的应用还在这一格里 —— 整串相等算命中，别把它做成一律拒绝。
    #[test]
    fn a_role_word_still_proves_a_candidate_with_the_same_name() {
        let cs = body(&["update"]);
        assert!(matches!(cs.probe("update"), Probe::Hit(_)), "整串相等被角色词闸一起掐掉了");
        assert!(matches!(cs.probe("Update"), Probe::Hit(_)), "大小写归一后也要算相等");
    }

    /// 具体名字不受影响：闸只能掐「条目本身就是个角色词」这一种，别顺手收窄整条通道。
    #[test]
    fn a_specific_install_dir_is_still_body_evidence() {
        let cs = body(&["Adrive", "Common Files", "Doubao"]);
        assert!(matches!(cs.probe("adrive-desktop-updater"), Probe::Hit(_)), "具体目录名应当作证");
        assert!(matches!(cs.probe("doubao-updater"), Probe::Hit(_)));
        // 多词条目不在角色词表里（`Common Files` 不是 `common`）
        assert!(matches!(cs.probe("common"), Probe::Hit(_)));
    }

    /// 痕迹通道一行不动：那边放宽一寸就多删一寸（P2-T2 的裁定）。
    #[test]
    fn trace_channels_keep_the_narrow_caliber() {
        let cs = trace(&["update"]);
        // 窄口径本来就是双向包含 —— 角色词闸只加在本体侧，痕迹侧这里不生效，
        // 但痕迹侧也不许因为这次改动变宽：命中的形状逐字与 name_matches 一致。
        assert!(matches!(cs.probe("adrive-desktop-updater"), Probe::Hit(_)));
        assert!(!name_matches("acme tool", "acme-tool"), "痕迹侧依旧不做空格↔连字符归一");
        assert!(name_matches_loose("acme tool", "acme-tool"), "本体侧做归一（这条是 P2-T2 的裁定）");
    }

    /// 真机那一格：卷根一级目录里有个名叫 `D` 的目录，它含在**任何**带 d 的候选名里。
    /// 条目侧的长度闸与候选侧同一把尺（`MIN_MATCHABLE_KEY_CHARS`），两侧都用。
    #[test]
    fn an_entry_too_short_to_carry_identity_matches_nothing() {
        for entry in ["D", "d", "ab", ""] {
            let cs = body(&[entry]);
            for key in ["adrive-desktop-updater", "starward", "tidalab", "leigod"] {
                assert!(
                    matches!(cs.probe(key), Probe::CheckedNoHit),
                    "条目「{entry}」吞掉了候选「{key}」：{:?}",
                    cs.probe(key)
                );
            }
            // 痕迹侧同一把尺：短条目发不出 `Absent` 的入场券（那边宽一寸就多删一寸）。
            assert!(matches!(trace(&[entry]).probe("adrive-desktop-updater"), Probe::CheckedNoHit));
        }
        // 够长就照旧算，别把闸做成一律拒绝。
        assert!(matches!(body(&["adr"]).probe("adrive-desktop-updater"), Probe::Hit(_)));
    }

    /// 这张表的**覆盖面**判据：能证明「某厂商/系统在场」的名字一旦进来，    /// `%LOCALAPPDATA%\Microsoft` 就拿不到本体证据、而它有厂商键当痕迹 ⇒ 被判残留。
    #[test]
    fn role_list_never_contains_a_vendor_or_os_name() {
        for forbidden in ["microsoft", "windows", "google", "nvidia", "tencent", "claude", "packages", "programs"] {
            assert!(
                !GENERIC_ROLE_NAMES.contains(&forbidden),
                "「{forbidden}」进了角色词表 —— 它能证明某个厂商/系统在场，掐掉它就是多删的方向"
            );
        }
        assert!(GENERIC_ROLE_NAMES.contains(&"update"), "表里必须有 update：真机就是栽在它上面");
    }
}
