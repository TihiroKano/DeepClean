//! DeepClean 的离线授权（M4）：**完全离线**的激活 / 状态查询。
//!
//! 规格基准：`docs/spec/DeepClean_Tauri重写计划书.md` 的「离线 License」表 + M4 验收行。
//! 本 crate 不依赖 tauri —— 它是**语义层**，界面壳只把参数转进来、把结果转出去。
//!
//! ## 规格表四个环节 → 本实现
//!
//! | 环节 | 本实现 |
//! | --- | --- |
//! | 激活码 | `code_table`：对归一化后的码做 SHA-256，与**注入的**哈希清单比对（`sha2`） |
//! | 设备绑定 | `device`：Ed25519 设备密钥，license.dat 里写设备公钥并签名（`ed25519-dalek`） |
//! | 密钥保护 | `dpapi`：设备私钥经 Windows DPAPI 加密后落盘（`windows-sys` 的 `CryptProtectData`） |
//! | 前后端隔离 | 本 crate 只暴露 `activate` / `status` 两个语义入口；IPC 层（主会话接线）只转发这两个 |
//!
//! ## 那 1000 个激活码：2026-10-11 已生成，投递链在壳层
//!
//! 规格书写「预生成 1000 个激活码」。本节原先点名的是**缺口**（真码不在仓库、全新安装只会
//! 拿到 `E_LICENSE_TABLE`）；缺口已补，按事实改写：
//!
//! - 1000 个码由 `crates/license/tools/gen-license-codes.mjs --generate 1000 --prefix DC-` 生成，
//!   形状 `DC-` + 32 位大写十六进制；**明文清单在仓库外**（`D:\dc-license-vault\`，发用户用的那份）。
//! - 本 crate 依旧**不内置任何码**：表是注入的数据。把注入的清单放到用户机器上是壳层的事，
//!   见 `src-tauri/src/license_table.rs`（内嵌 + 首启落盘 + 回读逐字比对）。
//! - 本 crate 测试用的仍是 `tests/data/codes.sha256`（5 条**夹具**），**不是那 1000 个真码，
//!   也不许被当成它**。
//!
//! ## 完全离线能做什么、不能做什么
//!
//! 见 `activate.rs` 顶部。一句话：挡得住「随手把 license.dat 拷到别的机器」（设备公钥比对 +
//! DPAPI 解不开私钥），**挡不住**「同一个码在第二台机器上再激活一次」（完全离线没有登记处）。
//!
//! ## ⚠️ 2026-10-11 改版：产品侧的激活改成「在线激活」
//!
//! 用户裁定：点「激活」时程序先检测设备是否连网、网络是否可用，不可用则激活失败。
//! **本 crate 一行没改，也不联网** —— 那道 `no_network_api_appears_in_this_crate` 闸照旧成立。
//! 探测住在壳层（`src-tauri/src/netprobe.rs`），它是**进本 crate 之前的一道前置条件**，
//! 不是授权判定的一部分：本 crate 看到的输入仍然是「码 + 路径 + 时间」，结论仍然只由
//! 码表与设备密钥决定。
//!
//! 两条必须一起记住的实话：① 没有服务器参与，所以这道闸**不增加任何授权强度**
//! （能上网就能过），它在产品层面的作用是让激活有一道真实的门槛；② 正因为如此，
//! 它的风险方向是**误伤有网的合法用户**（防火墙/DNS/代理），不是被绕过 ——
//! 探测点因此有三个、且失败时逐条点名。
//!
//! ## 硬约束（本 crate 结构性保证，随编译打红）
//!
//! - **运行期零网络**：本 crate 无任何网络 API（`no_network_api_appears_in_this_crate`）。
//! - **没有任何删除文件的能力**：本 crate 不出现删除 API（`no_deletion_api_appears_in_this_crate`）。
//!   授权会**写** `device.key` / `license.dat`（没有写入就没有「激活」），但不删任何东西。

// 非 Windows 直接拒绝编译：设备私钥保护**就是** DPAPI，没有它整个设备绑定不成立。
// 与其在别的平台退化成「明文存私钥」（那是一条静默的安全降级），不如拒绝构建。
#[cfg(not(windows))]
compile_error!(
    "deepclean-license 依赖 Windows DPAPI（CryptProtectData/CryptUnprotectData）保护设备私钥；不支持非 Windows 目标。"
);

pub mod activate;
pub mod code_table;
pub mod device;
pub mod license_file;

#[cfg(windows)]
pub mod dpapi;

pub use activate::{
    activate, now_unix_ms, status, ActivationError, ActivationOutcome, LicensePaths, LicenseStatus,
    StatusProblem,
};
pub use code_table::{CodeTable, TableError};
pub use device::{DeviceKey, KeyStoreError, VerifyError};
pub use license_file::{LicenseBody, LicenseFile, LicenseFileError};

pub fn name() -> &'static str {
    "deepclean-license"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_stable() {
        assert_eq!(name(), "deepclean-license");
    }

    /// **结构性安全判据（零删除）**：本 crate 的源码里一个删除 API 都不许出现。
    /// 读的是 `include_str!` 进来的**本 crate 源码**（随编译打红，谁塞一行就红），
    /// 剥掉注释行与 `#[cfg(test)]` 之后逐行找字面量。
    ///
    /// 两道豁免都为「判据别咬到自己」：① 注释行里的词是**说明**不是能力；
    /// ② `#[cfg(test)]` 之后（含本测试自己）。测试进程各自用**独立临时文件**、跑完不删。
    #[test]
    fn no_deletion_api_appears_in_this_crate() {
        let sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("code_table.rs", include_str!("code_table.rs")),
            ("device.rs", include_str!("device.rs")),
            ("license_file.rs", include_str!("license_file.rs")),
            ("activate.rs", include_str!("activate.rs")),
            ("dpapi.rs", include_str!("dpapi.rs")),
        ];
        let banned = [
            "remove_file",
            "remove_dir",
            "remove_dir_all",
            "std::fs::remove",
            "SHFileOperation",
            "IFileOperation",
            "DeleteFile",
        ];
        scan_sources(&sources, &banned, "删除 API");
    }

    /// **结构性安全判据（零网络）**：完全离线是产品定义 —— 运行期不许有任何网络能力。
    #[test]
    fn no_network_api_appears_in_this_crate() {
        let sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("code_table.rs", include_str!("code_table.rs")),
            ("device.rs", include_str!("device.rs")),
            ("license_file.rs", include_str!("license_file.rs")),
            ("activate.rs", include_str!("activate.rs")),
            ("dpapi.rs", include_str!("dpapi.rs")),
        ];
        let banned = [
            "TcpStream",
            "TcpListener",
            "UdpSocket",
            "std::net",
            "reqwest",
            "hyper::",
            "ureq",
            "isahc",
        ];
        scan_sources(&sources, &banned, "网络 API");
    }

    /// 逐行扫（跳过注释行与 `#[cfg(test)]` 之后的部分）。
    fn scan_sources(sources: &[(&str, &str)], banned: &[&str], what: &str) {
        for (name, src) in sources {
            let code_only = src.split("#[cfg(test)]").next().unwrap_or("");
            for line in code_only.lines() {
                let code = line.trim_start();
                if code.starts_with("//") || code.starts_with('*') {
                    continue;
                }
                for b in banned {
                    assert!(
                        !code.contains(b),
                        "{name} 里出现了{what} `{b}`：{line}\n\
                         本 crate 是零网络、零删除的：授权只读写自己的三个文件，不碰网络、不删东西。"
                    );
                }
            }
        }
    }

    /// **生成脚本 ↔ Rust 的归一化交叉对账**。
    ///
    /// 夹具清单（`tests/data/codes.sha256`）是用 `tools/gen-license-codes.mjs` 从
    /// 夹具明文码（`tests/data/codes.fixture.txt`）生成的。这里用 **Rust 的**归一化把同一份
    /// 明文码重算一遍，必须在清单里都找得到。两侧归一化（去首尾空白 + 大写 ASCII）一旦分叉，
    /// 真码就会被判成错码 —— 而那种错**只在有真码时才在真机上现形**，所以必须在这里先钉死。
    #[test]
    fn fixture_manifest_agrees_with_rust_normalization() {
        let manifest = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/codes.sha256"));
        let codes = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/codes.fixture.txt"));
        let table = CodeTable::parse(manifest).expect("夹具清单应能解析");

        let mut n = 0;
        for line in codes.lines() {
            let c = line.trim();
            if c.is_empty() || c.starts_with('#') {
                continue;
            }
            assert!(
                table.contains_code(c),
                "夹具码 {c:?} 不在清单里 —— 生成脚本与 Rust 的归一化很可能分叉了"
            );
            n += 1;
        }
        assert_eq!(n, 5, "夹具明文码条数变了：交叉对账的覆盖范围跟着变");
        assert_eq!(table.len(), 5);
        // 一个近失码必须不在表里（证明比对不是「恒真」）。
        assert!(!table.contains_code("DC-FIX-0001-X"));
        assert!(!table.contains_code(""));
    }
}
