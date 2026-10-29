//! 激活码表 —— **注入的数据，不是编进本 crate 的常量**。
//!
//! ## 为什么是注入的
//!
//! 规格书写的是「预生成 1000 个激活码」，「只存 SHA-256 哈希表」。本 crate 仍然**不内置任何码**：
//! 运行时从外部载入一份哈希清单（`codes.sha256`，一行一个 SHA-256，64 位十六进制），
//! 生成清单用 `crates/license/tools/gen-license-codes.mjs`（不是 `scripts/`，那份路径是旧的）。
//! 表从哪来是**壳层的产品问题**，见 `src-tauri/src/license_table.rs`。
//!
//! ## 2026-10-11：那 1000 个码已经有了，投递链也接上了（本段替换掉原先点名的缺口）
//!
//! 原先这一节写的是「真表不在本仓库里，本仓库没有那份清单」，并把「把一张自己编的表当成
//! 那 1000 个码写进代码或文档」列为静默虚报。那句话现在不成立了，按事实改成：
//!
//! - **码**：2026-10-11 由 `gen-license-codes.mjs --generate 1000 --prefix DC-` 生成，
//!   形状是 `DC-` + 32 位大写十六进制（128 位熵、去重），共 1000 个。
//! - **明文清单**：在仓库外（`D:\dc-license-vault\codes-2026-10-11-1000.txt`），发放给用户用的那份。
//!   `.gitignore` 里有 `codes-*` 一条挡它进仓。
//! - **哈希清单**：`src-tauri/resources/codes.sha256`，**进仓**，由壳层 `include_str!` 嵌进二进制，
//!   首次运行时落到授权目录（回读逐字比对）。它反推不出明文码，所以进仓不构成泄密。
//! - 本 crate 测试用的仍是 `tests/data/codes.sha256`（5 条**夹具**），**不是那 1000 个真码**，
//!   也不许被当成它 —— 那条边界原样保留。
//!
//! 原句要紧的那一半仍然要紧：**「有一张表」和「那张表就是交付范围」是两件事**，所以这里必须
//! 把码的来源、生成命令、条数、明文放哪写清楚到能被复核，而不是只写「已生成」。
//!
//! ## 归一化约定（生成脚本与这里必须是同一个）
//!
//! 用户输入的码先 `trim_ascii_whitespace` 再 `to_ascii_uppercase`，然后对 **UTF-8 字节**做
//! SHA-256。**不折叠中间的连字符/空格** —— 折了会把「两个不同的码」映射成同一个哈希。
//! 这个约定必须与 `crates/license/tools/gen-license-codes.mjs` 逐字一致，否则真码会被判成错码；
//! `lib.rs` 里有一条交叉对账测试专门钉它（读夹具 + 重算哈希 + 与清单比对）。

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// SHA-256 的十六进制长度。清单里每一行必须正好这么长。
pub const CODE_HASH_HEX_LEN: usize = 64;

/// 激活码表的载入错误。**每一个变体都是「不许静默跳过」的一次拒绝** ——
/// 一份读不动的清单绝不能退化成「那就放行吧」（那等于把授权关掉），也不能退化成空表。
#[derive(Debug)]
pub enum TableError {
    /// 清单文件读不到（不存在 / 权限 / IO）。**缺表 = 拒绝**，不是「无码可校验于是全过」。
    Io { path: PathBuf, message: String },
    /// 某一行不是 64 位十六进制。带行号与原文，便于运维定位。
    Malformed { line: usize, text: String, reason: &'static str },
    /// 同一个哈希在清单里出现两次。**「重复激活码被拒绝」的第一层落实就在这里**：
    /// 表里重号说明生成环节出过问题，此时整表拒绝（而不是去重后照用）。
    Duplicate { hash: String, first_line: usize, again_line: usize },
}

impl std::fmt::Display for TableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TableError::Io { path, message } => {
                write!(f, "激活码清单读不动（{}）：{message}", path.display())
            }
            TableError::Malformed { line, text, reason } => {
                write!(f, "激活码清单第 {line} 行不合法（{reason}）：{text:?}")
            }
            TableError::Duplicate { hash, first_line, again_line } => write!(
                f,
                "激活码清单里哈希 {hash} 重复（第 {first_line} 行与第 {again_line} 行）"
            ),
        }
    }
}

impl std::error::Error for TableError {}

/// 把用户输入的一个码归一化成哈希的输入字符串。
///
/// **只动首尾 ASCII 空白与大小写**。刻意不做「去掉空格/连字符」这类「友好」处理：
/// 那会把 `AB-12` 与 `AB12` 判成同一个码，等于悄悄扩大了授权范围。
pub fn normalize_code(raw: &str) -> String {
    raw.trim_matches(|c: char| c.is_ascii_whitespace()).to_ascii_uppercase()
}

/// 归一化字符串 → SHA-256 原始 32 字节。
pub fn hash_code(raw: &str) -> [u8; 32] {
    let normalized = normalize_code(raw);
    let digest = Sha256::digest(normalized.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// 已载入的激活码表。键是 SHA-256 原始字节，值是该哈希首次出现的行号（仅为诊断保留）。
///
/// 用 `BTreeMap` 而不是 `HashSet`：判定只需 `contains_key`，但要让「同一份清单两次载入」
/// 在诊断输出里稳定可复现（顺序确定），排序容器省掉一次「为什么两次打印不一样」的排查。
#[derive(Debug, Clone)]
pub struct CodeTable {
    hashes: BTreeMap<[u8; 32], usize>,
}

impl CodeTable {
    /// 从磁盘载入清单。文件不存在等 IO 失败是 `Io`（**拒绝**），不是空表。
    pub fn load(path: &Path) -> Result<CodeTable, TableError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| TableError::Io { path: path.to_path_buf(), message: e.to_string() })?;
        CodeTable::parse(&text)
    }

    /// 解析清单文本。空行与 `#` 开头的注释行跳过（注释是**清单自己的**说明，不是数据）。
    /// 其余每一行都**必须是** 64 位十六进制 —— 不合法就整表拒绝。
    pub fn parse(text: &str) -> Result<CodeTable, TableError> {
        let mut hashes: BTreeMap<[u8; 32], usize> = BTreeMap::new();
        for (idx, raw_line) in text.lines().enumerate() {
            let lineno = idx + 1;
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let hash = parse_hash_hex(line).map_err(|reason| TableError::Malformed {
                line: lineno,
                text: line.to_string(),
                reason,
            })?;
            if let Some(first) = hashes.get(&hash).copied() {
                return Err(TableError::Duplicate {
                    hash: hex::encode(hash),
                    first_line: first,
                    again_line: lineno,
                });
            }
            hashes.insert(hash, lineno);
        }
        Ok(CodeTable { hashes })
    }

    /// 直接由明文码集合建表（供测试与运维工具用；生产走 `load`）。
    /// 返回 `Result` 是因为两个不同明文可能归一化成同一个哈希（`Duplicate`）。
    pub fn from_codes<I, S>(codes: I) -> Result<CodeTable, TableError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut hashes: BTreeMap<[u8; 32], usize> = BTreeMap::new();
        for (i, code) in codes.into_iter().enumerate() {
            let lineno = i + 1;
            let hash = hash_code(code.as_ref());
            if let Some(first) = hashes.get(&hash).copied() {
                return Err(TableError::Duplicate {
                    hash: hex::encode(hash),
                    first_line: first,
                    again_line: lineno,
                });
            }
            hashes.insert(hash, lineno);
        }
        Ok(CodeTable { hashes })
    }

    /// 表里有几个码。**这是清单条数，不是「剩下多少可用」** —— 完全离线没有用量的概念。
    pub fn len(&self) -> usize {
        self.hashes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hashes.is_empty()
    }

    /// 原始哈希是否在表里。
    pub fn contains_hash(&self, hash: &[u8; 32]) -> bool {
        self.hashes.contains_key(hash)
    }

    /// 明文码是否在表里（内部做归一化）。
    pub fn contains_code(&self, raw: &str) -> bool {
        self.contains_hash(&hash_code(raw))
    }
}

/// 只接受 `CODE_HASH_HEX_LEN` 位十六进制的字符串，转成 32 字节。
fn parse_hash_hex(s: &str) -> Result<[u8; 32], &'static str> {
    if s.len() != CODE_HASH_HEX_LEN {
        return Err("不是 64 位十六进制（长度不对）");
    }
    if !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("不是 64 位十六进制（含非十六进制字符）");
    }
    let bytes = hex::decode(s).map_err(|_| "不是 64 位十六进制")?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_only_trims_and_uppercases() {
        assert_eq!(normalize_code("  ab-cd  "), "AB-CD");
        assert_eq!(normalize_code("ab cd"), "AB CD"); // 中间空格**不**折叠
        assert_eq!(normalize_code("\tAbC\n"), "ABC");
    }

    #[test]
    fn hash_is_stable_and_normalization_sensitive() {
        // 归一化后相同 ⇒ 哈希相同。
        assert_eq!(hash_code(" dc-1 "), hash_code("DC-1"));
        // 中段不同 ⇒ 哈希不同（证明没做「去空格」这种过度归一化）。
        assert_ne!(hash_code("AB CD"), hash_code("ABCD"));
    }

    #[test]
    fn parse_accepts_comments_and_blank_lines() {
        let mut t = String::from("# 注释\n\n");
        t.push_str(&hex::encode([1u8; 32]));
        t.push('\n');
        t.push_str(&hex::encode([2u8; 32]));
        t.push_str("\n  # 尾注\n");
        let table = CodeTable::parse(&t).expect("应能解析");
        assert_eq!(table.len(), 2);
        assert!(table.contains_hash(&[1u8; 32]));
        assert!(table.contains_hash(&[2u8; 32]));
        assert!(!table.contains_hash(&[3u8; 32]));
    }

    #[test]
    fn parse_rejects_short_line_with_line_number() {
        let t = format!("# c\n{}\nzz\n", hex::encode([7u8; 32]));
        match CodeTable::parse(&t) {
            Err(TableError::Malformed { line, .. }) => assert_eq!(line, 3),
            other => panic!("应报 Malformed，实得 {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_non_hex_line() {
        let bad: String = "g".repeat(64);
        match CodeTable::parse(&bad) {
            Err(TableError::Malformed { reason, .. }) => {
                assert!(reason.contains("非十六进制"), "reason={reason}")
            }
            other => panic!("应报 Malformed，实得 {other:?}"),
        }
    }

    #[test]
    fn parse_rejects_duplicate_hash() {
        let h = hex::encode([9u8; 32]);
        let t = format!("{h}\n{h}\n");
        match CodeTable::parse(&t) {
            Err(TableError::Duplicate { first_line, again_line, .. }) => {
                assert_eq!((first_line, again_line), (1, 2))
            }
            other => panic!("应报 Duplicate，实得 {other:?}"),
        }
    }

    #[test]
    fn from_codes_rejects_two_codes_normalizing_equal() {
        // " dc-x " 与 "DC-X" 归一化后相同 ⇒ 表里重号 ⇒ 拒绝。
        match CodeTable::from_codes([" dc-x ", "DC-X"]) {
            Err(TableError::Duplicate { .. }) => {}
            other => panic!("应报 Duplicate，实得 {other:?}"),
        }
    }

    #[test]
    fn load_missing_file_is_error_not_empty_table() {
        // 刻意用一个不可能存在的路径（而不是先删再试）：本 crate **不许出现任何删除 API**，
        // 连测试里也不留，免得结构性判据要为它开豁免口子。
        let p = std::env::temp_dir()
            .join(format!("deepclean-license-no-such-manifest-{}.sha256", std::process::id()));
        match CodeTable::load(&p) {
            Err(TableError::Io { .. }) => {}
            other => panic!("缺表应报 Io，实得 {other:?}"),
        }
    }
}
