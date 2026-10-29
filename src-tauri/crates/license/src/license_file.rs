//! `license.dat` 的形状：**可读的 JSON**，只存激活码的 SHA-256 与设备绑定，**不存明文码**。
//!
//! 规格书那句「license.dat 只存 SHA-256 哈希表」按字面有两种读法（存整张 1000 行哈希表，
//! 还是只存**用掉的那个**哈希）。本实现取后者：`code_hash` 是**被激活的那个码**的 SHA-256；
//! 整张表随应用一起交付、由 `code_table.rs` 从外部载入（见那份文件顶部）。理由：license.dat
//! 是**每台设备各一份**的激活记录，把 1000 行只读表塞进它没有意义，而「只存哈希、不存明文」
//! 这条实质约束两种读法都满足。**这条读法属「规格缺口下的裁定」，已在计划实施记录里点名。**
//!
//! ## 为什么 JSON 不加密
//!
//! 设备绑定不需要加密：license.dat 里写着设备公钥并用设备私钥签名，`status` 会①用里面
//! 的公钥验签名、②比它是不是**本机**公钥。拷到别的机器，第②步红。加密（DPAPI）留给
//! **私钥**（`device.key`）—— 那才是「解不开就没有身份」的东西。明文 license.dat 还让
//! 排查变简单（运维能直接看它绑给了谁）。
//!
//! ## 签名的规范化
//!
//! 签名覆盖的是 `LicenseBody` 的**紧凑 JSON**（字段顺序固定，与文件里的排版无关）。这样
//! 文件可以给人看得很舒服（缩进），而签名校验的字节是唯一确定的 —— 不这么分，改个缩进
//! 就会让签名失效。

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 当前格式版本。**只认它**：将来改结构必须升这个数，让老二进制明确拒绝而不是猜读。
pub const CURRENT_FORMAT: u32 = 1;

/// license.dat 的读/写错误。
#[derive(Debug)]
pub enum LicenseFileError {
    Io { path: std::path::PathBuf, message: String },
    Json { message: String },
    /// 版本号不认识（比当前新或为 0）。**拒绝**，不做向后兼容的猜测读法。
    UnsupportedFormat { got: u32 },
    /// 某个字段在做边界校验时不合格（长度/十六进制/空）。
    BadField { field: &'static str, reason: &'static str },
}

impl std::fmt::Display for LicenseFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LicenseFileError::Io { path, message } => {
                write!(f, "license.dat 读不动（{}）：{message}", path.display())
            }
            LicenseFileError::Json { message } => write!(f, "license.dat 不是合法 JSON：{message}"),
            LicenseFileError::UnsupportedFormat { got } => {
                write!(f, "license.dat 版本号 {got} 不认识（当前 {CURRENT_FORMAT}）")
            }
            LicenseFileError::BadField { field, reason } => {
                write!(f, "license.dat 的字段 `{field}` 不合法：{reason}")
            }
        }
    }
}

impl std::error::Error for LicenseFileError {}

/// 参与签名的**正文**。字段顺序即签名时的 JSON 顺序 —— **不要重排**（重排会让所有已发出的
/// 授权验签失败）。用 `deny_unknown_fields`：多了没见过的字段就拒绝（防止有人塞一个被忽略的
/// 字段、而它将来在别处被赋予意义）。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseBody {
    pub format: u32,
    pub code_hash: String,
    pub device_pub: String,
    pub activated_at_ms: u64,
}

/// 落盘的 `license.dat`：正文 + 设备私钥对正文紧凑 JSON 的签名。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseFile {
    pub format: u32,
    pub code_hash: String,
    pub device_pub: String,
    pub activated_at_ms: u64,
    /// 128 位十六进制 = 64 字节 Ed25519 签名。
    pub signature: String,
}

impl LicenseFile {
    /// 由正文与签名拼出一份完整的 license.dat。
    pub fn new(body: LicenseBody, signature: String) -> Self {
        LicenseFile {
            format: body.format,
            code_hash: body.code_hash,
            device_pub: body.device_pub,
            activated_at_ms: body.activated_at_ms,
            signature,
        }
    }

    /// 取出参与签名的正文。
    pub fn body(&self) -> LicenseBody {
        LicenseBody {
            format: self.format,
            code_hash: self.code_hash.clone(),
            device_pub: self.device_pub.clone(),
            activated_at_ms: self.activated_at_ms,
        }
    }

    /// 签名/验签用的**规范化字节**：正文的紧凑 JSON。`serde_json` 按结构体字段声明顺序输出，
    /// 且 `LicenseBody` 里没有 `HashMap` 之类的无序容器 ⇒ 同一份正文每次得到同一串字节。
    pub fn body_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.body()).expect("LicenseBody 的序列化不会失败（全是标量字段）")
    }

    /// 边界校验：版本、哈希/公钥/签名的长度与十六进制。**在读入路径上逐条查**，
    /// 不把它们推迟到「用到时才发现」。
    pub fn validate(&self) -> Result<(), LicenseFileError> {
        if self.format != CURRENT_FORMAT {
            return Err(LicenseFileError::UnsupportedFormat { got: self.format });
        }
        check_hex("codeHash", &self.code_hash, 64)?;
        check_hex("devicePub", &self.device_pub, 64)?;
        check_hex("signature", &self.signature, 128)?;
        Ok(())
    }

    /// 从磁盘读一份 license.dat（读 + 解析 + 校验）。
    pub fn read(path: &Path) -> Result<LicenseFile, LicenseFileError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| LicenseFileError::Io { path: path.to_path_buf(), message: e.to_string() })?;
        let file: LicenseFile = serde_json::from_str(&text)
            .map_err(|e| LicenseFileError::Json { message: e.to_string() })?;
        file.validate()?;
        Ok(file)
    }

    /// 写一份 license.dat。**人类可读的缩进 JSON**；签名覆盖的是紧凑正文（见 `body_bytes`）。
    pub fn write(path: &Path, file: &LicenseFile) -> Result<(), LicenseFileError> {
        file.validate()?;
        let text = serde_json::to_string_pretty(file)
            .map_err(|e| LicenseFileError::Json { message: e.to_string() })?;
        std::fs::write(path, text)
            .map_err(|e| LicenseFileError::Io { path: path.to_path_buf(), message: e.to_string() })
    }
}

/// 定长十六进制校验（小写/大写都收，只看是否合法）。
fn check_hex(field: &'static str, s: &str, expect_len: usize) -> Result<(), LicenseFileError> {
    if s.is_empty() {
        return Err(LicenseFileError::BadField { field, reason: "为空" });
    }
    if s.len() != expect_len {
        return Err(LicenseFileError::BadField { field, reason: "长度不对" });
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(LicenseFileError::BadField { field, reason: "含非十六进制字符" });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample() -> LicenseFile {
        LicenseFile {
            format: CURRENT_FORMAT,
            code_hash: hex::encode([1u8; 32]),
            device_pub: hex::encode([2u8; 32]),
            activated_at_ms: 1_700_000_000_000,
            signature: hex::encode([3u8; 64]),
        }
    }

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("deepclean-license-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{tag}-{}.dat", std::process::id()))
    }

    #[test]
    fn body_bytes_is_deterministic_and_field_order_is_fixed() {
        let f = sample();
        assert_eq!(f.body_bytes(), f.body_bytes());
        // 字段顺序固定（首个键是 format）：这是签名的契约，重排会让老授权全部失效。
        let s = String::from_utf8(f.body_bytes()).unwrap();
        assert!(s.starts_with("{\"format\":1,"), "正文 JSON = {s}");
    }

    #[test]
    fn changing_any_body_field_changes_body_bytes() {
        let base = sample();
        let mut a = sample();
        a.code_hash = hex::encode([9u8; 32]);
        assert_ne!(base.body_bytes(), a.body_bytes());
        let mut b = sample();
        b.activated_at_ms += 1;
        assert_ne!(base.body_bytes(), b.body_bytes());
        // 签名本身**不**进正文。
        let mut c = sample();
        c.signature = hex::encode([8u8; 64]);
        assert_eq!(base.body_bytes(), c.body_bytes());
    }

    #[test]
    fn license_file_keys_equal_body_keys_plus_signature() {
        // 防两份字段名单漂移：LicenseFile 的键集合必须恰好 = LicenseBody 的键集合 + signature。
        let f = sample();
        let mut file_keys: Vec<String> = serde_json::to_value(&f)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let mut body_keys: Vec<String> = serde_json::to_value(f.body())
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        file_keys.sort();
        body_keys.sort();
        body_keys.push("signature".to_string());
        body_keys.sort();
        assert_eq!(file_keys, body_keys);
    }

    #[test]
    fn roundtrip_write_read() {
        let p = temp_path("roundtrip");
        let f = sample();
        LicenseFile::write(&p, &f).unwrap();
        let back = LicenseFile::read(&p).unwrap();
        assert_eq!(f, back);
    }

    #[test]
    fn validate_rejects_bad_version_and_fields() {
        let mut f = sample();
        f.format = 2;
        assert!(matches!(f.validate(), Err(LicenseFileError::UnsupportedFormat { got: 2 })));

        let mut g = sample();
        g.code_hash = "xyz".into();
        assert!(matches!(g.validate(), Err(LicenseFileError::BadField { field: "codeHash", .. })));

        let mut h = sample();
        h.signature = hex::encode([3u8; 32]); // 长度错
        assert!(matches!(h.validate(), Err(LicenseFileError::BadField { field: "signature", .. })));

        let mut i = sample();
        i.device_pub = String::new();
        assert!(matches!(i.validate(), Err(LicenseFileError::BadField { field: "devicePub", .. })));
    }

    #[test]
    fn read_rejects_unknown_field_and_bad_json() {
        let p = temp_path("unknown");
        std::fs::write(&p, r#"{"format":1,"codeHash":"","devicePub":"","activatedAtMs":0,"signature":"","extra":1}"#).unwrap();
        assert!(matches!(LicenseFile::read(&p), Err(LicenseFileError::Json { .. })));

        std::fs::write(&p, "not json").unwrap();
        assert!(matches!(LicenseFile::read(&p), Err(LicenseFileError::Json { .. })));
    }
}
