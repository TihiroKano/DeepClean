//! Windows DPAPI 薄封装：把字节串「保护」成只有当前用户能解开的密文，再解回来。
//!
//! **只用来保护设备私钥**（规格表「密钥保护 safeStorage → DPAPI」那一行）。license.dat
//! 本身不加密 —— 它是可读的 JSON，设备绑定靠 Ed25519 公钥比对（见 `device.rs`）。
//!
//! ## 为什么用**用户作用域**（不传 `CRYPTPROTECT_LOCAL_MACHINE`）
//!
//! 需求是「license.dat 复制到另一台电脑失效」。用户作用域天然满足：密文绑在
//! 「当前用户 + 当前机器」的密钥上，换机器**或换用户**都解开不了。机器作用域只能挡住
//! 换机器，同一台机器的另一个账户仍能解开 —— 那与「随手复制就失效」的目标不符。
//! 代价：用户重装系统/换账户会丢激活，需要重新激活。这是可接受的（重装本就是重新激活的场景）。
//!
//! ## 签名照抄 Win32 原文（不用 `windows` crate 的包装层）
//!
//! `windows-sys` 的 `CryptProtectData` 就是 Win32 的签名：入参是裸 `*const CRYPT_INTEGER_BLOB`、
//! 返回值是 `BOOL`（`i32`）。**不能假设它一定成功** —— 失败时返回 0，要立刻 `LocalFree`
//! 释放上一轮/本轮的输出缓冲并转成错误。这里没有「吞掉错误当空数据」的分支：一个解不开的
//! 私钥必须显式失败，否则上层会拿着一串空字节去当密钥用，症状是「激活了但 status 说无效」。

#![cfg(windows)]

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

/// DPAPI 的失败一律是这一族错误。**不细分成上百个 Win32 码** —— 对上层来说，
/// 「这串密文在当前用户+机器上解不开」是一件事，细分只会让调用方去 match 一串没人读的常量。
#[derive(Debug, PartialEq, Eq)]
pub enum DpapiError {
    /// `CryptProtectData` / `CryptUnprotectData` 返回 0。带 `GetLastError` 的值便于排查。
    CallFailed(u32),
    /// 输出缓冲的 `cbData == 0` 或 `pbData` 为空。技术上 BOOL 成功了，但结果是空 ——
    /// 对「解出一把 32 字节私钥」的调用方来说，空结果与失败没有区别，都必须当成错误。
    EmptyResult,
}

impl std::fmt::Display for DpapiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DpapiError::CallFailed(code) => {
                write!(f, "DPAPI 调用失败（GetLastError={code}）")
            }
            DpapiError::EmptyResult => write!(f, "DPAPI 调用返回空结果"),
        }
    }
}

impl std::error::Error for DpapiError {}

/// 把 `plaintext` 用 DPAPI 保护。用户作用域（无 `CRYPTPROTECT_LOCAL_MACHINE`）。
///
/// 熵（`pOptionalEntropy`）传 `None`：熵是**可选的加固**，一旦用了它就要在解开处**逐字匹配**，
/// 而它本身并不保护任何东西（它写在能读到密文的人也能读到的地方）。多一个参数就多一处
/// 「保护时给了熵、解开时忘了给」的静默失败。所以**不用**。
pub fn protect(plaintext: &[u8]) -> Result<Vec<u8>, DpapiError> {
    crypt(plaintext, true)
}

/// 解开 `protect` 出来的密文。
pub fn unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, DpapiError> {
    crypt(ciphertext, false)
}

/// `CryptProtectData`（`to_cipher = true`）与 `CryptUnprotectData`（`false`）的公共骨架。
/// 两者的参数表除了「多一个 `ppszDataDescr` 输出」之外完全一致，所以走同一段代码，
/// 免得两份拷贝将来各自漂移。
fn crypt(input: &[u8], to_cipher: bool) -> Result<Vec<u8>, DpapiError> {
    // 入参 BLOB 借用 `input` 的缓冲；`pbData` 在 `CryptProtectData` 里是 `*mut u8`，
    // 但那次调用只读不写，借一个 `as *mut` 出去是安全的（Win32 文档亦如此约定）。
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    // SAFETY：两个 BLOB 都是本函数栈上的有效对象；`pvReserved`/`pPromptStruct` 传 null
    // 是 Win32 允许的（无保留、不弹 UI）；输出缓冲由 DPAPI 用 LocalAlloc 分配，失败时
    // 为 null（下面按 BOOL 判定，不读它）。
    let ok: i32 = unsafe {
        if to_cipher {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out_blob,
            )
        } else {
            // `CryptUnprotectData` 的第 2 个参数是 `ppszDataDescr`（输出，可空指针 = 不要描述）。
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut out_blob,
            )
        }
    };

    if ok == 0 {
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
        // 失败路径上 DPAPI 不应分配输出，但防御性释放：`LocalFree(null)` 是 no-op。
        if !out_blob.pbData.is_null() {
            unsafe { LocalFree(out_blob.pbData as _) };
        }
        return Err(DpapiError::CallFailed(code));
    }

    if out_blob.cbData == 0 || out_blob.pbData.is_null() {
        if !out_blob.pbData.is_null() {
            unsafe { LocalFree(out_blob.pbData as _) };
        }
        return Err(DpapiError::EmptyResult);
    }

    // 把 DPAPI 分配的缓冲拷进 Rust 的 `Vec`，随后立刻 `LocalFree` —— 绝不能把这根指针
    // 交出去（那会变成跨分配的悬垂/泄漏）。
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe { LocalFree(out_blob.pbData as _) };
    Ok(out)
}
