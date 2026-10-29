//! `activate` / `status` 的语义 —— 规格表最后一行「前端只能调用 activate 和 status 两个命令」。
//!
//! 本 crate 不依赖 tauri；这两个函数是**语义层**。Tauri 侧的 command 只是把参数转进来、
//! 把结果转出去（那是主会话的接线，见计划末尾「主会话必须接着做的事」）。
//!
//! ## 「完全离线」能做什么、不能做什么（把边界说在前面）
//!
//! 规格书验收行写的是三条：断网可激活；license.dat 拷到另一台电脑失效；重复激活码被拒绝。
//! 本实现逐条对应的能力与实际边界：
//!
//! - **断网可激活**：全程无网络（本 crate 无任何网络 API，见 `lib.rs` 的结构性判据）。
//! - **license.dat 拷到另一台机器失效**：**能**。文件里写着设备公钥，`status` 比对本机公钥
//!   → 不同就 `DeviceMismatch`。私钥在别的机器上也解不开（DPAPI），双保险。
//! - **重复激活码被拒绝**：**只能做到三件**——① 表内重号（`code_table` 载入即拒）；
//!   ② 表外的错码（`InvalidCode`）；③ **同一台机器**上对同一码重复激活不产生第二份
//!   （`AlreadyActive`）。**做不到**的是「同一个码在第二台机器上被再次激活」——
//!   完全离线没有全局登记处，第二台机器拿同一个码照样过表校验（见
//!   `same_code_activates_on_two_independent_devices_offline` 用例，它**故意断言这个限制**）。
//!   这是规格缺口，已在计划的「实施记录」里点名，不许含糊成「已拒绝」。
//!
//! ## 授权范围（本地状态，不是「用量」）
//!
//! 表是**固定的一份**，随应用交付。`status` 会核对 license.dat 里的 `code_hash` 是否在表里
//! —— 这不是为了统计用量，而是为了「一份凭空捏造、哈希不在表里的 license.dat」不算数。
//! 代价：**表一旦交付就不可从表里删码**（删了会让已激活的用户失效）。这条纪律写在计划里。

use crate::code_table::{hash_code, normalize_code, CodeTable, TableError};
use crate::device::{self, KeyStoreError};
use crate::license_file::{LicenseBody, LicenseFile, LicenseFileError, CURRENT_FORMAT};
use std::path::PathBuf;

/// 三份文件的落点。**由调用方注入**（生产：应用数据目录；测试：临时目录）——
/// 路径写死在 crate 里会让测试只能碰真机目录，而「在真机上试激活」是不可接受的副作用。
#[derive(Debug, Clone)]
pub struct LicensePaths {
    /// 激活码哈希清单（`codes.sha256`）。**注入的数据**，见 `code_table.rs`。
    pub table_path: PathBuf,
    /// DPAPI 保护的设备私钥（`device.key`）。
    pub device_key_path: PathBuf,
    /// 激活记录（`license.dat`）。
    pub license_path: PathBuf,
}

/// 激活成功后的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum ActivationOutcome {
    /// 这次写下了（或重写了）一份新的激活记录。
    Activated { activated_at_ms: u64, device_id: String },
    /// 同一个码已经绑在本机 —— **不重复写入**（幂等），把这句真话回给界面。
    AlreadyActive { activated_at_ms: u64, device_id: String },
}

/// 激活失败的原因。**没有「放行但记一笔」这种分支** —— 失败就是拒绝。
#[derive(Debug)]
pub enum ActivationError {
    /// 清单缺失/损坏 → 无法校验 → 拒绝激活（不是「无码可校验于是全过」）。
    Table(TableError),
    /// 码不在表里（错码、或用户少打多打了一个字符）。这是最常见的一条。
    InvalidCode,
    /// 设备密钥生成/落盘失败。
    DeviceKey(KeyStoreError),
    /// 写 license.dat 失败。
    LicenseFile(LicenseFileError),
}

impl std::fmt::Display for ActivationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ActivationError::Table(e) => write!(f, "激活码清单不可用：{e}"),
            ActivationError::InvalidCode => f.write_str("激活码无效"),
            ActivationError::DeviceKey(e) => write!(f, "设备密钥不可用：{e}"),
            ActivationError::LicenseFile(e) => write!(f, "授权文件写入失败：{e}"),
        }
    }
}

impl std::error::Error for ActivationError {}

/// 授权状态。`Invalid` 一定带一个**具名**的原因，界面才能说清「哪里不对」。
#[derive(Debug, PartialEq, Eq)]
pub enum LicenseStatus {
    /// 还没有 license.dat。
    Unlicensed,
    /// 有效，且绑在本机。
    Licensed { activated_at_ms: u64, device_id: String },
    /// 有文件，但不可信。**这是失败关闭（fail-closed）**：不把它当有效。
    Invalid { problem: StatusProblem },
}

/// `Invalid` 的具体原因。每个变体对应一条独立可测的失败路径。
#[derive(Debug, PartialEq, Eq)]
pub enum StatusProblem {
    /// 本机没有设备密钥（`device.key` 缺失或解不开）⇒ 无法确认绑定给谁。
    NoDeviceKey,
    /// license.dat 读不动 / 不是合法 JSON / 字段不合法。
    LicenseUnreadable,
    /// license.dat 绑的是**别的设备**（典型：文件被拷到了另一台机器）。
    DeviceMismatch,
    /// 签名对不上（文件被手改过，或签名与正文不配）。
    BadSignature,
    /// license.dat 里的 `code_hash` 不在本版交付的清单里 —— 不是本版认得的码。
    CodeNotInTable,
    /// 清单缺失/损坏 ⇒ 无法核对码 ⇒ 失败关闭。
    TableUnavailable,
}

/// 激活。成功即写下一份绑到本机的 `license.dat`。
///
/// `now_ms` 由调用方给（生产传 `now_unix_ms()`），这样测试能钉死时间戳、
/// 也能证明「`activated_at_ms` 只被记录、不参与判定」。
pub fn activate(
    paths: &LicensePaths,
    raw_code: &str,
    now_ms: u64,
) -> Result<ActivationOutcome, ActivationError> {
    // 1) 先要一份可用的清单。缺表 = 拒绝（fail-closed）。
    let table = CodeTable::load(&paths.table_path).map_err(ActivationError::Table)?;

    // 2) 归一化 + 校验码。空码直接拒（省得把空串拿去查表）。
    let normalized = normalize_code(raw_code);
    if normalized.is_empty() {
        return Err(ActivationError::InvalidCode);
    }
    let hash = hash_code(&normalized);
    if !table.contains_hash(&hash) {
        return Err(ActivationError::InvalidCode);
    }

    // 3) 拿本机设备密钥（没有就生成一把并落盘）。
    let key = device::load_or_create_device_key(&paths.device_key_path)
        .map_err(ActivationError::DeviceKey)?;

    // 4) 已经是「同一个码 + 本机 + 签名有效」⇒ 幂等返回，不重写。
    //    任一条件不成立（换了码 / 文件损坏 / 绑的是别的设备）都往下走，用这次激活覆盖它。
    if paths.license_path.exists() {
        if let Ok(existing) = LicenseFile::read(&paths.license_path) {
            let same_code = existing.code_hash.eq_ignore_ascii_case(&hex::encode(hash));
            let same_device = existing.device_pub.eq_ignore_ascii_case(&key.public_hex());
            let sig_ok =
                device::verify(&existing.device_pub, &existing.body_bytes(), &existing.signature)
                    .is_ok();
            if same_code && same_device && sig_ok {
                return Ok(ActivationOutcome::AlreadyActive {
                    activated_at_ms: existing.activated_at_ms,
                    device_id: existing.device_pub,
                });
            }
        }
    }

    // 5) 组装正文 → 先造出完整的 LicenseFile 再签它的规范化正文，最后补上签名。
    //    顺序不能反：`body_bytes()` 必须与将来验签时的口径逐字相同。
    let body = LicenseBody {
        format: CURRENT_FORMAT,
        code_hash: hex::encode(hash),
        device_pub: key.public_hex(),
        activated_at_ms: now_ms,
    };
    let mut file = LicenseFile::new(body, String::new());
    let signature = key.sign(&file.body_bytes());
    file.signature = hex::encode(signature);

    LicenseFile::write(&paths.license_path, &file).map_err(ActivationError::LicenseFile)?;
    Ok(ActivationOutcome::Activated { activated_at_ms: now_ms, device_id: file.device_pub })
}

/// 查询授权状态。**只读**：不生成、不修改任何文件（尤其不生成设备密钥 —— 那会让一个
/// 外来 license.dat 在本机「变成本机的」，把设备绑定绕过去）。
pub fn status(paths: &LicensePaths) -> LicenseStatus {
    if !paths.license_path.exists() {
        return LicenseStatus::Unlicensed;
    }

    // 清单必须在，且要在码这一层核对（见本文件顶部「授权范围」）。
    let table = match CodeTable::load(&paths.table_path) {
        Ok(t) => t,
        Err(_) => return LicenseStatus::Invalid { problem: StatusProblem::TableUnavailable },
    };

    // 本机设备密钥：缺失 ⇒ 无法确认绑定。
    let key = match device::load_device_key(&paths.device_key_path) {
        Ok(k) => k,
        Err(_) => return LicenseStatus::Invalid { problem: StatusProblem::NoDeviceKey },
    };

    let file = match LicenseFile::read(&paths.license_path) {
        Ok(f) => f,
        Err(_) => return LicenseStatus::Invalid { problem: StatusProblem::LicenseUnreadable },
    };

    // 设备绑定（这一条就是「拷到另一台机器失效」）。
    if !file.device_pub.eq_ignore_ascii_case(&key.public_hex()) {
        return LicenseStatus::Invalid { problem: StatusProblem::DeviceMismatch };
    }

    // 用**文件里写着的**公钥验签名（先验完整性，再确认它就是本机公钥 —— 上面那步已确认）。
    if device::verify(&file.device_pub, &file.body_bytes(), &file.signature).is_err() {
        return LicenseStatus::Invalid { problem: StatusProblem::BadSignature };
    }

    // 码必须在表里。
    match decode_hash32(&file.code_hash) {
        Some(h) if table.contains_hash(&h) => {}
        _ => return LicenseStatus::Invalid { problem: StatusProblem::CodeNotInTable },
    }

    LicenseStatus::Licensed { activated_at_ms: file.activated_at_ms, device_id: file.device_pub }
}

/// 把 64 位十六进制转成 32 字节（`file.code_hash` 已在读入时校验过格式）。
fn decode_hash32(s: &str) -> Option<[u8; 32]> {
    let v = hex::decode(s).ok()?;
    v.as_slice().try_into().ok()
}

/// Unix 毫秒时间戳（生产调用方用）。放在这里是为了让「时间从哪来」只有一个落点 ——
/// 测试则自己给 `now_ms`，于是「时间戳不参与判定」这句可以被钉住。
pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::code_table::hash_code;
    use crate::license_file::LicenseFile;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    // 每个测试用**独立**的临时根目录（进程号 + 单调计数器 + 时间），避免并发互踩。
    // 本 crate 无删除 API，所以跑完不清理 —— 文件都落在系统临时目录下。
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    const TEST_CODES: [&str; 3] = ["DC-TEST-0001", "DC-TEST-0002", "DC-TEST-0003"];

    fn fresh_root(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "deepclean-license-act-{}-{}-{}-{}",
            std::process::id(),
            tag,
            n,
            nanos
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 在 `root` 下摆好三份文件路径，并写好一份含 `codes` 的清单。
    fn paths_with_codes(root: &PathBuf, codes: &[&str]) -> LicensePaths {
        let table_path = root.join("codes.sha256");
        let manifest = codes
            .iter()
            .map(|c| hex::encode(hash_code(c)))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&table_path, manifest).expect("写清单");
        LicensePaths {
            table_path,
            device_key_path: root.join("device.key"),
            license_path: root.join("license.dat"),
        }
    }

    fn paths(root: &PathBuf) -> LicensePaths {
        paths_with_codes(root, &TEST_CODES)
    }

    // —— 问题 1：错码怎么办？ ——

    #[test]
    fn wrong_code_is_rejected_and_writes_nothing() {
        let root = fresh_root("wrong");
        let p = paths(&root);
        match activate(&p, "DC-TEST-9999", 1000) {
            Err(ActivationError::InvalidCode) => {}
            other => panic!("错码应被拒，实得 {other:?}"),
        }
        assert!(!p.license_path.exists(), "被拒的激活不许留下 license.dat");
    }

    #[test]
    fn empty_or_whitespace_code_is_rejected() {
        let root = fresh_root("empty");
        let p = paths(&root);
        assert!(matches!(activate(&p, "", 1), Err(ActivationError::InvalidCode)));
        assert!(matches!(activate(&p, "   ", 1), Err(ActivationError::InvalidCode)));
        assert!(!p.license_path.exists());
    }

    #[test]
    fn missing_table_refuses_activation_fail_closed() {
        let root = fresh_root("notable");
        let p = paths(&root);
        // 把清单挪到一个不存在的路径（不删原文件，只换路径）⇒ 应拒绝，而不是「无码可查于是全过」。
        let p2 = LicensePaths { table_path: root.join("absent.sha256"), ..p };
        assert!(matches!(activate(&p2, "DC-TEST-0001", 1), Err(ActivationError::Table(_))));
        assert!(!p2.license_path.exists());
    }

    // —— 问题 2：同一个码在第二台机器上还能不能激活？ ——

    /// **故意断言「完全离线」的限制**：两个彼此独立的设备存储（模拟两台机器），
    /// 同一个码都能激活 —— 因为表校验是无状态的，离线没有全局登记处。
    /// 这条用例存在的意义是把缺口**钉成事实**，而不是让文档含糊成「已拒绝」。
    #[test]
    fn same_code_activates_on_two_independent_devices_offline() {
        let (ra, rb) = (fresh_root("devA"), fresh_root("devB"));
        let pa = paths(&ra);
        let pb = paths(&rb);
        assert!(matches!(activate(&pa, "DC-TEST-0001", 1000), Ok(ActivationOutcome::Activated { .. })));
        assert!(matches!(activate(&pb, "DC-TEST-0001", 2000), Ok(ActivationOutcome::Activated { .. })));
        assert!(matches!(status(&pa), LicenseStatus::Licensed { .. }));
        assert!(matches!(status(&pb), LicenseStatus::Licensed { .. }));
        // 两台设备的公钥不同（绑定确实按设备分开），但**码本身拦不住跨机复用**。
        let la = LicenseFile::read(&pa.license_path).unwrap();
        let lb = LicenseFile::read(&pb.license_path).unwrap();
        assert_ne!(la.device_pub, lb.device_pub);
        assert_eq!(la.code_hash, lb.code_hash);
    }

    // —— 问题 3：license.dat 拷到另一台机器是否失效？ ——

    #[test]
    fn copied_license_is_rejected_on_another_device() {
        let (ra, rb) = (fresh_root("orig"), fresh_root("copy"));
        let pa = paths(&ra);
        activate(&pa, "DC-TEST-0001", 1000).unwrap();
        let pb = paths(&rb);
        // B 台有自己的设备密钥（否则会是 NoDeviceKey，测不到 DeviceMismatch）。
        device::load_or_create_device_key(&pb.device_key_path).unwrap();
        // 只拷 license.dat 过去（模拟「随手复制」）。
        let content = std::fs::read(&pa.license_path).unwrap();
        std::fs::write(&pb.license_path, content).unwrap();
        assert_eq!(status(&pb), LicenseStatus::Invalid { problem: StatusProblem::DeviceMismatch });
    }

    // —— 问题 4 + 状态机：DPAPI 往返已在 device.rs 钉住；这里测状态面的其余分支 ——

    #[test]
    fn valid_activation_then_status_is_licensed() {
        let root = fresh_root("ok");
        let p = paths(&root);
        match activate(&p, "  dc-test-0002  ", 4242).unwrap() {
            ActivationOutcome::Activated { activated_at_ms, device_id } => {
                assert_eq!(activated_at_ms, 4242);
                assert_eq!(device_id.len(), crate::device::DEVICE_PUB_HEX_LEN);
            }
            other => panic!("首次激活应是 Activated，实得 {other:?}"),
        }
        // 归一化生效：大小写/空白不影响。
        match status(&p) {
            LicenseStatus::Licensed { activated_at_ms, .. } => assert_eq!(activated_at_ms, 4242),
            other => panic!("应 Licensed，实得 {other:?}"),
        }
    }

    #[test]
    fn reactivating_same_code_is_idempotent_not_duplicated() {
        let root = fresh_root("again");
        let p = paths(&root);
        activate(&p, "DC-TEST-0001", 1000).unwrap();
        let first = std::fs::read_to_string(&p.license_path).unwrap();
        // 第二次用「不同写法、同一个码」+ 不同时间戳：必须识别成同一个码 ⇒ AlreadyActive，且不改文件。
        match activate(&p, " dc-test-0001 ", 9999).unwrap() {
            ActivationOutcome::AlreadyActive { activated_at_ms, .. } => assert_eq!(activated_at_ms, 1000),
            other => panic!("重复激活应 AlreadyActive，实得 {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&p.license_path).unwrap(), first, "不得重写");
    }

    #[test]
    fn activating_a_different_valid_code_rebinds() {
        let root = fresh_root("rebind");
        let p = paths(&root);
        activate(&p, "DC-TEST-0001", 1000).unwrap();
        match activate(&p, "DC-TEST-0002", 2000).unwrap() {
            ActivationOutcome::Activated { activated_at_ms, .. } => assert_eq!(activated_at_ms, 2000),
            other => panic!("换码应 Activated，实得 {other:?}"),
        }
        let f = LicenseFile::read(&p.license_path).unwrap();
        assert_eq!(f.code_hash, hex::encode(hash_code("DC-TEST-0002")));
    }

    #[test]
    fn missing_device_key_makes_status_unbound() {
        let root = fresh_root("nokey");
        let p = paths(&root);
        activate(&p, "DC-TEST-0001", 1000).unwrap();
        // 把设备密钥路径换到一个不存在的地方（不删文件）⇒ status 不许「造一把新的」。
        let p2 = LicensePaths { device_key_path: root.join("absent.key"), ..p };
        assert_eq!(status(&p2), LicenseStatus::Invalid { problem: StatusProblem::NoDeviceKey });
    }

    #[test]
    fn missing_license_is_unlicensed() {
        let root = fresh_root("none");
        let p = paths(&root);
        assert_eq!(status(&p), LicenseStatus::Unlicensed);
    }

    #[test]
    fn missing_table_makes_status_invalid_fail_closed() {
        let root = fresh_root("statustable");
        let p = paths(&root);
        activate(&p, "DC-TEST-0001", 1000).unwrap();
        let p2 = LicensePaths { table_path: root.join("absent.sha256"), ..p };
        assert_eq!(status(&p2), LicenseStatus::Invalid { problem: StatusProblem::TableUnavailable });
    }

    // —— 畸形输入 ——

    #[test]
    fn malformed_license_file_is_invalid_not_panic() {
        let root = fresh_root("malformed");
        let p = paths(&root);
        device::load_or_create_device_key(&p.device_key_path).unwrap();

        for bad in [
            "not json at all",
            r#"{"format":1}"#,                                   // 缺字段
            r#"{"format":2,"codeHash":"","devicePub":"","activatedAtMs":0,"signature":"","extra":1}"#, // 版本+未知字段
        ] {
            std::fs::write(&p.license_path, bad).unwrap();
            assert_eq!(
                status(&p),
                LicenseStatus::Invalid { problem: StatusProblem::LicenseUnreadable },
                "输入 {bad:?} 应判 LicenseUnreadable"
            );
        }
    }

    #[test]
    fn tampered_body_fails_signature() {
        let root = fresh_root("tamper");
        let p = paths(&root);
        activate(&p, "DC-TEST-0001", 1000).unwrap();
        // 手改 activatedAtMs（在签名覆盖范围内）⇒ 签名不再匹配。
        let mut f = LicenseFile::read(&p.license_path).unwrap();
        f.activated_at_ms += 1;
        std::fs::write(&p.license_path, serde_json::to_string_pretty(&f).unwrap()).unwrap();
        assert_eq!(status(&p), LicenseStatus::Invalid { problem: StatusProblem::BadSignature });
    }

    #[test]
    fn valid_signature_but_unknown_code_hash_is_rejected() {
        let root = fresh_root("boguscode");
        let p = paths(&root);
        let key = device::load_or_create_device_key(&p.device_key_path).unwrap();
        // 用**本机**设备密钥签一份 code_hash 不在表里的授权：签名/设备都对，只有码是编的。
        let body = LicenseBody {
            format: CURRENT_FORMAT,
            code_hash: hex::encode(hash_code("DC-NOT-IN-TABLE")),
            device_pub: key.public_hex(),
            activated_at_ms: 5,
        };
        let mut file = LicenseFile::new(body, String::new());
        file.signature = hex::encode(key.sign(&file.body_bytes()));
        LicenseFile::write(&p.license_path, &file).unwrap();
        assert_eq!(status(&p), LicenseStatus::Invalid { problem: StatusProblem::CodeNotInTable });
    }

    #[test]
    fn status_does_not_create_a_device_key() {
        let root = fresh_root("readonly");
        let p = paths(&root);
        // 只有 license.dat、没有 device.key、也没有先激活过。
        std::fs::write(&p.license_path, "{}").unwrap();
        let _ = status(&p);
        assert!(!p.device_key_path.exists(), "status 是只读的，不许生成设备密钥");
    }
}
