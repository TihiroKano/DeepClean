//! 设备身份：一把 Ed25519 设备密钥（规格表「设备绑定」那一行）。
//!
//! ## 它是干什么的、不是干什么的（先划清楚，免得高估）
//!
//! - **是**：给「license.dat 是发给这台设备的」这件事一个可验证的凭据。license.dat 里写着
//!   设备公钥、并用对应的私钥签名；`status` 在**本机**重新载入设备私钥、比公钥、验签名。
//!   于是把 license.dat 拷到另一台机器 → 那台机器算出的设备公钥不同 → `DeviceMismatch`。
//! - **不是**：它挡不住「同一个激活码在第二台机器上再激活一次」。完全离线没有全局登记处，
//!   第二台机器拿同一个码照样能过表校验。**这是「完全离线」的边界，不是本实现的缺陷**，
//!   见 `activate.rs` 顶部那段说明。
//!
//! ## 私钥怎么落地
//!
//! 私钥本体（32 字节种子）**先经 DPAPI 保护再写盘**（`device.key`）。用户作用域 ⇒ 密文绑在
//! 「当前用户 + 当前机器」；换机器或换用户都解不开。所以即使有人把 `device.key` 也一起拷走，
//! 目标机上 `unprotect` 也会失败 —— 设备绑定因此有两道：① 公钥比对；② 私钥根本解不开。

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use std::path::{Path, PathBuf};

/// 设备公钥的十六进制长度（32 字节）。
pub const DEVICE_PUB_HEX_LEN: usize = 64;
/// Ed25519 签名长度（64 字节）。
pub const SIGNATURE_HEX_LEN: usize = 128;

/// 设备密钥的存储错误。
#[derive(Debug)]
pub enum KeyStoreError {
    Io { path: PathBuf, message: String },
    /// DPAPI 保护/解保护失败 —— 在别的机器或别的用户上解开、或文件被损坏时走这里。
    Dpapi(crate::dpapi::DpapiError),
    /// 解出来不是 32 字节。**拒绝**而不是截断/补零（那会得到一把「看着像密钥」的错密钥）。
    BadLength { got: usize },
}

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyStoreError::Io { path, message } => {
                write!(f, "设备密钥文件读不动（{}）：{message}", path.display())
            }
            KeyStoreError::Dpapi(e) => write!(f, "设备私钥的 DPAPI 处理失败：{e}"),
            KeyStoreError::BadLength { got } => {
                write!(f, "设备私钥解出来是 {got} 字节，应为 32")
            }
        }
    }
}

impl std::error::Error for KeyStoreError {}

/// 验签失败的原因。
#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    /// 公钥不是 64 位十六进制。
    BadPublicHex,
    /// 签名不是 128 位十六进制。
    BadSignatureHex,
    /// 十六进制能解、但不是一条合法的 Ed25519 签名 / 公钥。
    Malformed,
    /// 签名与公钥、消息对不上（用 `verify_strict`，连签名的可塑性变体也一并拒）。
    Mismatch,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            VerifyError::BadPublicHex => "设备公钥不是 64 位十六进制",
            VerifyError::BadSignatureHex => "签名不是 128 位十六进制",
            VerifyError::Malformed => "公钥/签名不是合法的 Ed25519 值",
            VerifyError::Mismatch => "签名校验不过",
        })
    }
}

impl std::error::Error for VerifyError {}

/// 一台设备的 Ed25519 身份。私钥在内存里就是这个结构体，落盘才经 DPAPI。
pub struct DeviceKey {
    signing: SigningKey,
}

impl DeviceKey {
    /// 生成一把全新的设备密钥。熵来自 OS（`OsRng`）—— 不用时间、pid 这类可猜源。
    pub fn generate() -> Self {
        let mut rng = rand_core::OsRng;
        DeviceKey { signing: SigningKey::generate(&mut rng) }
    }

    /// 由 32 字节种子重建（从 DPAPI 解出来的那 32 字节走这里）。
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        DeviceKey { signing: SigningKey::from_bytes(seed) }
    }

    /// 私钥种子。**只该出现在落盘那一步**（写进 DPAPI 之前）。
    pub fn seed(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// 设备公钥的十六进制（64 位小写）。
    pub fn public_hex(&self) -> String {
        hex::encode(self.signing.verifying_key().to_bytes())
    }

    /// 对消息签名，返回 64 字节。
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// 用**给定的**公钥验签。刻意不收 `DeviceKey`：`status` 要拿 license.dat 里**写着**的公钥验，
/// 而不是拿本机公钥验 —— 顺序是「先验内置公钥的签名，再比它是不是本机公钥」，两步都独立成立。
pub fn verify(public_hex: &str, msg: &[u8], signature_hex: &str) -> Result<(), VerifyError> {
    let pub_bytes: [u8; 32] = decode_hex_array(public_hex).ok_or(VerifyError::BadPublicHex)?;
    let sig_bytes: [u8; 64] = decode_hex_array(signature_hex).ok_or(VerifyError::BadSignatureHex)?;
    let vk = VerifyingKey::from_bytes(&pub_bytes).map_err(|_| VerifyError::Malformed)?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(msg, &sig).map_err(|_| VerifyError::Mismatch)
}

/// 严格的定长十六进制解码：长度与字符都必须在边界上校验过。长度不对返回 `None`。
fn decode_hex_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = hex::decode(s).ok()?;
    let mut out = [0u8; N];
    out.copy_from_slice(&v);
    Some(out)
}

// —— 存储层（Windows：DPAPI） ——

/// 载入设备密钥；文件不存在则**生成并落盘**一把新的。
///
/// 为什么不「不存在就报错让调用方决定」：激活与 status 都需要一把设备密钥才能谈绑定，
/// 让每个调用点各自处理「还没有密钥」会把同一段 `generate + save` 抄两遍（且容易抄漏 save，
/// 症状是「激活成功了但下次启动 device.key 不见了 → status 说设备不匹配」）。
pub fn load_or_create_device_key(path: &Path) -> Result<DeviceKey, KeyStoreError> {
    if path.exists() {
        load_device_key(path)
    } else {
        let key = DeviceKey::generate();
        save_device_key(path, &key)?;
        Ok(key)
    }
}

/// 从 `path` 载入设备密钥：读字节 → DPAPI 解开 → 32 字节种子。
pub fn load_device_key(path: &Path) -> Result<DeviceKey, KeyStoreError> {
    let cipher = std::fs::read(path)
        .map_err(|e| KeyStoreError::Io { path: path.to_path_buf(), message: e.to_string() })?;
    let seed = crate::dpapi::unprotect(&cipher).map_err(KeyStoreError::Dpapi)?;
    let seed: [u8; 32] = seed
        .as_slice()
        .try_into()
        .map_err(|_| KeyStoreError::BadLength { got: seed.len() })?;
    Ok(DeviceKey::from_seed(&seed))
}

/// 把设备密钥落盘：种子 → DPAPI 密文 → 写 `path`。
pub fn save_device_key(path: &Path, key: &DeviceKey) -> Result<(), KeyStoreError> {
    let cipher = crate::dpapi::protect(&key.seed()).map_err(KeyStoreError::Dpapi)?;
    std::fs::write(path, cipher)
        .map_err(|e| KeyStoreError::Io { path: path.to_path_buf(), message: e.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 「只属于本进程」的临时目录，避免并发测试互相踩；不删除（本 crate 无删除 API）。
    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deepclean-license-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir.join(format!("{tag}-{}", unique()))
    }

    fn unique() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn sign_verify_roundtrip_and_mismatch() {
        let key = DeviceKey::generate();
        let msg = b"license-body-bytes";
        let sig = key.sign(msg);
        assert_eq!(verify(&key.public_hex(), msg, &hex::encode(sig)), Ok(()));
        // 消息改一个字 → 不匹配。
        assert_eq!(verify(&key.public_hex(), b"other", &hex::encode(sig)), Err(VerifyError::Mismatch));
        // 公钥长度不对 → 明确拒绝。
        assert_eq!(verify("ab", msg, &hex::encode(sig)), Err(VerifyError::BadPublicHex));
    }

    #[test]
    fn two_devices_have_different_public_keys() {
        assert_ne!(DeviceKey::generate().public_hex(), DeviceKey::generate().public_hex());
    }

    #[cfg(windows)]
    #[test]
    fn device_key_survives_dpapi_roundtrip_via_disk() {
        let p = temp_path("device.key");
        let key = DeviceKey::generate();
        save_device_key(&p, &key).unwrap();
        let loaded = load_device_key(&p).unwrap();
        assert_eq!(loaded.public_hex(), key.public_hex());
        // 落盘的不是明文种子（DPAPI 密文更长，且不等于种子）。
        assert_ne!(std::fs::read(&p).unwrap(), key.seed().to_vec());
    }

    #[cfg(windows)]
    #[test]
    fn load_or_create_creates_then_reuses() {
        let p = temp_path("reuse.key");
        let k1 = load_or_create_device_key(&p).unwrap();
        let k2 = load_or_create_device_key(&p).unwrap();
        assert_eq!(k1.public_hex(), k2.public_hex(), "第二次必须复用同一把，而不是重新生成");
    }

    #[cfg(windows)]
    #[test]
    fn tampered_ciphertext_fails_to_unlock() {
        let p = temp_path("tamper.key");
        let key = DeviceKey::generate();
        save_device_key(&p, &key).unwrap();
        let mut raw = std::fs::read(&p).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xFF; // 翻掉最后一个字节：DPAPI 完整性校验应拒绝。
        std::fs::write(&p, raw).unwrap();
        // 刻意不 derive `Debug` on `DeviceKey`（免得哪次 `{:?}` 把私钥打进日志），
        // 所以这里只 match 错误分支、`Ok` 分支不格式化解出来的密钥。
        match load_device_key(&p) {
            Err(KeyStoreError::Dpapi(_)) => {}
            Err(other) => panic!("篡改的密文应报 Dpapi 错，实得 {other:?}"),
            Ok(_) => panic!("篡改的密文不该解开"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn plaintext_seed_is_not_accepted_as_a_key_file() {
        // 直接把明文种子当 device.key 写进去 → DPAPI 解不开 ⇒ 拒绝（不是「当密钥用」）。
        let p = temp_path("plain.key");
        std::fs::write(&p, [7u8; 32]).unwrap();
        match load_device_key(&p) {
            Err(KeyStoreError::Dpapi(_)) => {}
            Err(other) => panic!("明文种子应报 Dpapi 错，实得 {other:?}"),
            Ok(_) => panic!("明文种子不该被接受成密钥"),
        }
    }
}
