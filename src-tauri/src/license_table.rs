//! 激活码清单（`codes.sha256`）的**投递链**：从「随二进制交付」到「落在授权目录里」。
//!
//! ## 这一层为什么必须存在
//!
//! `deepclean-license` 把码表设计成**注入的数据**（`CodeTable::load(paths.table_path)`），
//! 而激活与状态查询**两边都要读它**（状态那半边核对 `license.dat` 里的 `code_hash` 是否在表里）。
//! 于是「清单从哪来」是一个**产品级空洞**而不是实现细节：此前仓库里没有任何一环把
//! `codes.sha256` 放到用户机器上，只有一份测试夹具靠验收脚本手工拷进去 ——
//! 也就是说**全新安装的用户哪怕拿着真码，也只会得到 `E_LICENSE_TABLE`**。
//!
//! ## 选定形态：内嵌进二进制 + 首启落盘，而不是打包资源 / 首次联网拉取
//!
//! 三条理由，代价写在后面：
//! 1. **判据落得了地**。`include_str!` 让「随应用交付的那份表」变成仓库里一个能被单元测试
//!    逐字读到的文件；走 `bundle.resources` 则要在**打完包之后**才能验表在不在，而那条判据
//!    要一直等到 `bundle.active = true` 才有载体（M6 起有了，但内嵌这条不用等，也仍然更短）。
//! 2. **不增加授权强度，也就不许诺它**。这份产品没有服务器（见 `netprobe.rs` 顶部那两句实话），
//!    「运行时拉取清单」会暗示一个不存在的授权服务，那是虚报。
//! 3. **离线可激活**。清单在二进制里 ⇒ 断网首启照样能激活；网络那道闸只管点「激活」那一下。
//!
//! 代价：**换一版清单要重新编译、重新发包**（码不能从表里撤销）。这与 crate 自己在
//! `activate.rs` 顶部记的那条「表一旦交付就不可从表里删码」是同一件事，不是新增的约束。
//!
//! ## 只写自己那一份，绝不覆盖
//!
//! 已存在的 `codes.sha256` 一律一字不碰（`ensure_never_touches_an_existing_table` 钉着）。
//! 理由：那个位置是**运维覆盖点**（`DC_LICENSE_DIR` 指过去放一份别的表，是本项目唯一的换表通道），
//! 覆盖它会让「谁放的、放的什么」在事后无从考证；宁可让畸形表在激活时以具名错误现形。

use std::path::Path;

/// 随二进制交付的清单原文。**只有 SHA-256，一行一个**；明文码从不进仓库、也不进构建产物。
///
/// 这条边界由 `embedded_table_holds_only_hashes_and_no_plaintext_codes` 逐行钉住：
/// 那份 1000 个明文码的清单在仓库外（`D:\dc-license-vault\`，发放给用户用），
/// 谁把它贴进来，这条判据立刻红。
pub const EMBEDDED_CODES_SHA256: &str = include_str!("../resources/codes.sha256");

/// 首启落盘的结果。**两种都算成功**，但界面/日志要分得开「这次写没写」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// 那个位置已经有清单了 —— 本次**一个字节都没动**。
    AlreadyPresent,
    /// 原先没有，目录与文件都是这次建的。
    Written,
}

/// 把内嵌清单投递到 `table_path`（授权目录里的 `codes.sha256`）。
///
/// 写完**回读逐字比对**：这条不是防御性冗余。半途失败的真实形态是「文件建出来了但内容是空的/
/// 截断的」（磁盘满、杀软拦截、OneDrive 占位文件），那种状态下 `exists()` 为真、下一次启动直接
/// 走 `AlreadyPresent` 分支，于是**一个空表会跟着这台机器一辈子**，而它的表现是「所有真码都无效」。
pub fn ensure_at(table_path: &Path) -> Result<Placement, String> {
    if table_path.exists() {
        return Ok(Placement::AlreadyPresent);
    }
    let dir = table_path.parent().ok_or_else(|| {
        format!(
            "E_LICENSE_TABLE_WRITE: 清单路径没有父目录，建不出授权目录：{}",
            table_path.display()
        )
    })?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("E_LICENSE_TABLE_WRITE: 授权目录建不出来（{}）：{e}", dir.display()))?;
    std::fs::write(table_path, EMBEDDED_CODES_SHA256).map_err(|e| {
        format!("E_LICENSE_TABLE_WRITE: 清单写不进去（{}）：{e}", table_path.display())
    })?;

    let back = std::fs::read(table_path)
        .map_err(|e| format!("E_LICENSE_TABLE_WRITE: 清单写完读不回来（{}）：{e}", table_path.display()))?;
    if back.as_slice() != EMBEDDED_CODES_SHA256.as_bytes() {
        return Err(format!(
            "E_LICENSE_TABLE_WRITE: 清单落盘内容与内嵌的那份不一致（{}，实得 {} 字节，应为 {} 字节）\
             —— 多半是磁盘满或被安全软件拦；这份表会照着错的样子一路用下去，所以这里必须拦",
            table_path.display(),
            back.len(),
            EMBEDDED_CODES_SHA256.len()
        ));
    }
    Ok(Placement::Written)
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepclean_license::CodeTable;

    /// 规格书定的码数（「预生成 1000 个激活码」）。
    ///
    /// 它是**判据的常量**而不是产品的常量：生产代码不数码（数了就是第二份真相），所以它住在这里。
    /// 写死成常量是为了少一个数就**测试期可见地红**，而不是等某个用户的码不在表里时才在真机上现形。
    const SHIPPED_CODE_COUNT: usize = 1000;

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "deepclean-table-{}-{tag}-{n}-{nanos}",
            std::process::id()
        ));
        // 刻意**不**建目录：投递链的第一件事就是目录也不存在时也要能建出来。
        dir
    }

    /// **发布侧判据（表在位、且条数就是规格书那 1000）**。
    ///
    /// 这一条是「全新安装能不能激活」的**唯一**编译期可见证据。以前这个空洞要靠用户点第一次
    /// 「激活」才现形，而现形的方式是 `E_LICENSE_TABLE` —— 一个用户完全无法自证的错误码。
    #[test]
    fn the_embedded_table_parses_with_exactly_1000_codes() {
        let table = CodeTable::parse(EMBEDDED_CODES_SHA256)
            .expect("内嵌清单必须能被 crate 的解析器接受（畸形表 = 所有码都无效）");
        assert_eq!(
            table.len(),
            SHIPPED_CODE_COUNT,
            "随应用交付的码数不是规格书定的 {SHIPPED_CODE_COUNT}（实得 {}）—— 换表要连这条一起改",
            table.len()
        );
        assert!(!table.is_empty());
    }

    /// **不泄密判据**：内嵌的那份只许是 64 位小写十六进制 + 注释行。
    ///
    /// 两个容易咬自己的地方，都留在这里说明：① 判据必须**跳过注释行**，因为清单自己的表头
    /// 写着「前缀 DC-」，而 `DC-` 正是明文码的形状；② 必须要求**小写**，因为大写十六进制是
    /// 明文码的后缀形状（`DC-` + 32 位大写十六进制），大小写混着放行就等于这条闸只拦一半。
    #[test]
    fn embedded_table_holds_only_hashes_and_no_plaintext_codes() {
        let mut rows = 0;
        for (i, line) in EMBEDDED_CODES_SHA256.lines().enumerate() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            assert_eq!(t.len(), 64, "第 {} 行长度不是 64：{t:?}", i + 1);
            assert!(
                t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "第 {} 行不是 64 位小写十六进制（看着像明文码？）：{t:?}",
                i + 1
            );
            rows += 1;
        }
        assert_eq!(rows, SHIPPED_CODE_COUNT);
        assert!(
            !EMBEDDED_CODES_SHA256.lines().any(|l| l.starts_with("DC-")),
            "内嵌清单里出现了 DC- 开头的**数据行**（表头注释里的 DC- 不算，上面已跳过）"
        );
    }

    /// **负对照**：一条形状完全正确、但不在表里的码，必须真的不在表里。
    /// 没有这条，上面两条只证明「表能解析、有 1000 行」，不证明比对是个**有效的**比对。
    #[test]
    fn a_plausible_code_outside_the_table_is_not_in_it() {
        let table = CodeTable::parse(EMBEDDED_CODES_SHA256).unwrap();
        assert!(!table.contains_code(&format!("DC-{}", "0".repeat(32))));
        assert!(!table.contains_code(&format!("DC-{}", "F".repeat(32))));
        assert!(!table.contains_code(""));
    }

    #[test]
    fn ensure_writes_the_table_into_an_absent_dir_and_reads_back_identical() {
        let dir = fresh_dir("write");
        let path = dir.join("codes.sha256");
        assert!(!dir.exists(), "夹具必须是「目录也不存在」");
        assert_eq!(ensure_at(&path).unwrap(), Placement::Written);
        let back = std::fs::read(&path).expect("写完应读得回来");
        assert_eq!(back.as_slice(), EMBEDDED_CODES_SHA256.as_bytes(), "落盘内容与内嵌那份不一致");
        // 再核一次语义：那 1000 条是从**磁盘上这份**读出来的，不是从常量读出来的。
        assert_eq!(CodeTable::load(&path).unwrap().len(), SHIPPED_CODE_COUNT);
    }

    /// **绝不覆盖**：那个位置已经是运维的覆盖点，写下去就把「谁放的表」变成不可考证。
    /// 畸形表不在这儿判 —— 它会在激活时以 `E_LICENSE_TABLE` 具名现形，那是 crate 的判定。
    #[test]
    fn ensure_never_touches_an_existing_table() {
        let dir = fresh_dir("keep");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("codes.sha256");
        let sentinel = "# 运维自己放的表，不是内嵌那份\n";
        std::fs::write(&path, sentinel).unwrap();
        assert_eq!(ensure_at(&path).unwrap(), Placement::AlreadyPresent);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            sentinel,
            "已存在的清单被覆盖了 —— 运维覆盖点就没了"
        );
    }

    /// 建不出来要说清是**哪一步**、**哪个路径**，不能退化成一个笼统的 E_LICENSE_TABLE。
    /// 「授权目录建不出来」与「清单里没有你的码」在运维上是两件完全不同的事。
    #[test]
    fn failure_names_the_step_and_the_path() {
        let dir = fresh_dir("blocked");
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("codes.sha256");
        std::fs::write(&blocker, "x").unwrap();
        // 拿一个**文件**当目录用：create_dir_all 必然失败（Windows 上是 NotADirectory/AccessDenied）。
        let nested = blocker.join("sub").join("codes.sha256");
        let err = ensure_at(&nested).expect_err("父路径是文件，建不出来，应报错");
        assert!(err.contains("E_LICENSE_TABLE_WRITE"), "错误码不对：{err}");
        assert!(err.contains("codes.sha256"), "错误串里必须带上那个路径：{err}");
    }
}
