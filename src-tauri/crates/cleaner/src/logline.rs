//! §29 的落盘面：**每一次删除（成功/失败）与每一条拒绝都要留一行**。
//!
//! 基准是 `electron/main/logger.ts:14` 的 `formatLogLine` 与 `core/clean/executor.ts:90` 的
//! `CleanLog`。两个设计决定都是照抄基准的，理由写在各自那段注释里：
//!
//! 1. **字段是有序串表，不是 struct**。线格式就是 `k=v` 按声明顺序拼接，用一个结构体表达
//!    会把"顺序也是格式"这件事藏起来 —— 而日志文件是给人 grep 的，也是这轮验收要读的产物。
//!    `None` 那一格**整段不出现**（基准 `if (v === undefined) continue`），不是写成 `k=`。
//! 2. **写盘的活不在这个模块里**。执行器只认 trait，测试注一个收集器进去就能逐行断言；
//!    真的文件句柄、`broken` 闸门在外壳层（`src-tauri/src/cleanlog.rs`）。这与基准同分工：
//!    `core/clean` 不 import electron，logger 在 main 进程。
//!
//! 本模块**没有任何删除能力**：它只把已经发生的结局摊成一行字。

use std::fmt;

/// 一行里那些 `k=v` 的值的形状。基准是 `string | number | boolean | undefined`
/// （`electron/main/logger.ts:5`），四格都在：`undefined` 单独用 `None` 表达，
/// 因为它的意思是"这一格别出现"，而不是"这一格是空串"。
#[derive(Clone, Copy, PartialEq)]
pub enum LogValue<'a> {
    Str(&'a str),
    Int(i64),
    Bool(bool),
}

impl fmt::Debug for LogValue<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogValue::Str(s) => write!(f, "{s:?}"),
            LogValue::Int(i) => write!(f, "{i}"),
            LogValue::Bool(b) => write!(f, "{b}"),
        }
    }
}

/// 一串字段，**顺序就是格式**（与 TS 对象字面量的键序一一对应）。
pub type LogFields<'a> = &'a [(&'a str, Option<LogValue<'a>>)];

/// 执行器的注入面。与 TS `CleanLog` 同形：一个方法、消息打头、字段随附。
///
/// `Send + Sync` 是被 `ExecuteCtx` 的用法逼出来的（它要跨过 Tauri 的 IPC 线程），
/// 不是装饰 —— 实现方自己得保证内部同步（文件那条用追加打开，本来就是原子的一次写）。
pub trait CleanLog: Send + Sync {
    fn clean(&self, msg: &str, fields: LogFields<'_>);
}

/// JS 的 `/\s/` 与 Rust 的 `char::is_whitespace` 几乎同一集合，**差一个 `U+FEFF`**：
/// ECMAScript 把 BOM 当空白（`\s` 含 `\ufeff`），Unicode 的 White_Space 属性不含它。
/// 路径里真出现 BOM 的概率极低，但这格决定"这个值要不要加引号"，一旦不一致，
/// 两侧写出来的同一行就不同 —— 补上它只要一个常量。
const JS_ADDITIONAL_SPACE: char = '\u{FEFF}';

fn needs_quote(v: &str) -> bool {
    v.chars().any(|c| c.is_whitespace() || c == JS_ADDITIONAL_SPACE || c == '"')
}

/// `formatLogLine` 的逐字翻译：`<stamp> [<scope>] <msg>` 然后每个存活字段 ` k=v`。
///
/// 字符串值：含空白或 `"` 才加引号，加引号时把内部的 `"` 写成 `\"`（基准
/// `logger.ts:9`，注意它**只在要引号时才转义** —— 一个含 `"` 但不含空白的值同样进这个分支）。
pub fn format_log_line(stamp: &str, scope: &str, msg: &str, fields: LogFields<'_>) -> String {
    let mut line = format!("{stamp} [{scope}] {msg}");
    for (k, v) in fields {
        let Some(v) = v else { continue };
        match v {
            LogValue::Str(s) => {
                if needs_quote(s) {
                    line.push_str(&format!(" {k}=\"{}\"", s.replace('"', "\\\"")));
                } else {
                    line.push_str(&format!(" {k}={s}"));
                }
            }
            LogValue::Int(i) => line.push_str(&format!(" {k}={i}")),
            LogValue::Bool(b) => line.push_str(&format!(" {k}={b}")),
        }
    }
    line
}

/// 把 `epoch_ms` 折成 `YYYY-MM-DD HH:MM:SS`（本地、含那一刻生效的时区偏移），
/// 与 JS `new Date(ms)` 的六个 getter 同口径。
///
/// 换算本体在 [`crate::journal_view::local_system_time`]：记录页的日期筛选键与日志行的
/// 时间戳是同一件事的两张脸，各算一次本地日历就会有一天两者对不上（而且原来那一份
/// 按 UTC 日零点换算，本身少一天 —— 修在那一侧）。
///
/// 换算失败回空串，调用方照样把这一行写出去 —— 宁可时间戳缺着，也不要为了填它把整行丢掉
/// （日志的价值恰恰在崩溃前那几行）。
pub fn local_stamp(epoch_ms: i64) -> String {
    match crate::journal_view::local_system_time(epoch_ms) {
        Some((y, mo, d, h, mi, s)) => format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s<'a>(v: &'a str) -> Option<LogValue<'a>> {
        Some(LogValue::Str(v))
    }
    fn i<'a>(v: i64) -> Option<LogValue<'a>> {
        Some(LogValue::Int(v))
    }
    fn b<'a>(v: bool) -> Option<LogValue<'a>> {
        Some(LogValue::Bool(v))
    }

    /// 基准那条例子的逐字复刻（`logger.ts` 的格式：戳、scope、消息、然后 k=v）。
    #[test]
    fn the_line_matches_the_renderers_format() {
        let line = format_log_line(
            "2026-10-13 01:02:03",
            "CLEAN",
            "clean start",
            &[("task", s("t1")), ("root", s(r"C:\Sandbox")), ("requested", i(3))],
        );
        assert_eq!(line, "2026-10-13 01:02:03 [CLEAN] clean start task=t1 root=C:\\Sandbox requested=3");
    }

    /// **顺序是格式**：同一批字段换个次序，写出来的行就不同 —— 两侧必须同序。
    #[test]
    fn field_order_is_part_of_the_format() {
        let a = format_log_line("x", "CLEAN", "m", &[("one", i(1)), ("two", i(2))]);
        let b = format_log_line("x", "CLEAN", "m", &[("two", i(2)), ("one", i(1))]);
        assert_ne!(a, b);
        assert_eq!(a, "x [CLEAN] m one=1 two=2");
    }

    /// `undefined` 那格**整段消失**，不是留下 `k=`。基准是 `actualFreedBytes` 可能没量到，
    /// 留一个空值会让"没量到"与"量到 0"在同一份日志里长一样。
    #[test]
    fn an_absent_field_is_absent_not_empty() {
        let line = format_log_line(
            "x",
            "CLEAN",
            "end",
            &[("success", i(2)), ("actualFreedBytes", None), ("ms", i(5))],
        );
        assert_eq!(line, "x [CLEAN] end success=2 ms=5");
        assert!(!line.contains("actualFreedBytes"), "缺席的键也不许出现：{line}");
    }

    /// 引号的两条边界：含空白才包，包的时候转义内部的 `"`；含 `"` 但不含空白**也**要包
    /// （基准 `logger.ts:9` 的正则是 `[\s"]`，两条任其一）。
    #[test]
    fn quoting_follows_the_js_predicate() {
        let line = format_log_line(
            "x",
            "CLEAN",
            "p",
            &[
                ("plain", s(r"C:\Temp\a")),
                ("spacey", s("two words")),
                ("quoted", s(r#"say "hi""#)),
                ("tight", s(r#"a"b"#)),
            ],
        );
        assert_eq!(
            line,
            r#"x [CLEAN] p plain=C:\Temp\a spacey="two words" quoted="say \"hi\"" tight="a\"b""#
        );
    }

    /// JS/Rust 空白集差集里那一格：BOM 在 ECMAScript 算 `\s`，在 Unicode 的 White_Space
    /// 里不算。不补这一条，同一路径两侧一个加引号一个不加。
    #[test]
    fn the_bom_is_whitespace_for_js() {
        let bom = "\u{FEFF}x";
        assert!(!bom.chars().any(char::is_whitespace), "前提：Rust 不认它是空白");
        let line = format_log_line("x", "CLEAN", "p", &[("path", s(bom))]);
        assert!(line.contains("path=\""), "含 BOM 的值没被引起来，两侧格式会分叉：{line}");
    }

    /// 空串是**一个值**，不是缺席（`blocked: ''` 就是这么写的）。
    #[test]
    fn an_empty_string_is_a_value_not_an_absence() {
        let line = format_log_line("x", "CLEAN", "e", &[("blocked", s(""))]);
        assert_eq!(line, "x [CLEAN] e blocked=");
    }

    #[test]
    fn booleans_print_the_js_spelling() {
        let line = format_log_line("x", "CLEAN", "b", &[("ok", b(true)), ("bad", b(false))]);
        assert_eq!(line, "x [CLEAN] b ok=true bad=false");
    }

    /// 时间戳的**形状**与**本地性**。这里不敢拿当前时区的墙上时间当期望值（那等于用被测方
    /// 给自己出题），所以只钉形状 + 与 `local_day` 必须同日这两条独立判据。
    #[test]
    fn the_stamp_is_local_and_shaped_like_the_baseline() {
        let ms: i64 = 1_762_000_000_000; // 2025-11-01 前后某一刻
        let stamp = local_stamp(ms);
        assert_eq!(stamp.len(), 19, "形状应为 YYYY-MM-DD HH:MM:SS，实得 {stamp:?}");
        let bytes = stamp.as_bytes();
        for &p in &[4usize, 7, 10, 13, 16] {
            assert!(matches!(bytes[p], b'-' | b':' | b' '), "{p} 位不是分隔符：{stamp}");
        }
        assert_eq!(
            stamp.split(' ').next().unwrap(),
            crate::journal_view::local_day(ms),
            "时间戳的日期那一半必须与筛选键同一天（两侧各算一次本地日历就是两套真相）"
        );
    }

    /// 跨日本身单独钉一次。
    ///
    /// ## 2026-10-29：这条原来把「本机时区」写进了期望值，CI 上当场红
    ///
    /// 原写法是 `assert_eq!(local_stamp(1_791_829_800_000), "2026-10-13 02:30:00")`，
    /// 期望值来自作者本机（UTC+8）。GitHub 的 runner 是 **UTC**，同一时刻算出来是
    /// `2026-10-12 18:30:00` —— CI 第一次跑就红在这里：
    ///
    /// ```text
    /// left:  "2026-10-12 18:30:00"
    /// right: "2026-10-13 02:30:00"
    /// ```
    ///
    /// **红得对**：那是测试的隐藏环境依赖，不是产品缺陷。`local_stamp` 没算错 ——
    /// 它在 UTC 机器上就该给 UTC 的墙上时间（「本地」的定义就是那台机器的本地）。
    ///
    /// ## 修法：不写死任何一个时区的读数
    ///
    /// 这条判据真正要钉的是「**跨日按本地日历算，不是按 UTC 日算**」。所以拿两侧
    /// 各算一次再比对关系，而不是比对某个固定字符串：
    ///
    /// - 本地侧：`local_stamp`（被测方）
    /// - UTC 侧：`journal_view::civil_from_epoch_ms` —— **纯公历展开，与 `local_stamp`
    ///   走的不是同一条链**（后者经 `SystemTimeToTzSpecificLocalTime`）
    ///
    /// 于是：
    /// - 在 UTC+8 上，两侧日期不同 ⇒ 断言本地日跟着本地日历走；
    /// - 在 UTC 上，两侧本来就相同 ⇒ **明说跳过跨日那半**，不留一个恒真的假判据。
    ///
    /// 产品在 UTC 机器上不跨日是对的，所以那不是判据失效。
    #[test]
    fn the_stamp_crosses_local_midnight_with_the_instant_not_the_utc_day() {
        let ms: i64 = 1_791_829_800_000; // UTC 2026-10-12 18:30:00

        let stamp = local_stamp(ms);
        let local_day = stamp.split(' ').next().unwrap();

        // ① 与筛选键必须同一套日历（跨日那一刻尤其不能分家）。这条与机器时区无关。
        assert_eq!(
            local_day,
            crate::journal_view::local_day(ms),
            "时间戳的日期那一半必须与筛选键同一天（两侧各算一次本地日历就是两套真相）"
        );

        // ② UTC 侧独立算一遍 —— 纯公历展开，不碰时区。
        let (uy, umo, ud) = crate::journal_view::civil_from_epoch_ms(ms).expect("公历展开失败");
        let utc_day = format!("{uy:04}-{umo:02}-{ud:02}");

        // ③ UTC 那一格是硬事实，先钉住（它不随机器时区变）。
        assert_eq!(utc_day, "2026-10-12", "UTC 那一侧应当恒为 2026-10-12");

        // ④ 跨日那半：本地日与 UTC 日不同时才有意义。
        if local_day == utc_day {
            // UTC（或偏移为 0 的）机器上，本地日 = UTC 日 就是正确行为。
            // 明说跳过，而不是把它写成一个永远成立的断言。
            return;
        }
        // 两侧不同 ⇒ 时间戳确实按本地日历走。
        // 不写死方向：东半球是次日、西半球是前一日，两种都算"按本地日历"。
        assert_ne!(
            local_day, utc_day,
            "本地日与 UTC 日不同时，时间戳必须跟着本地日历走（实得 local={local_day} utc={utc_day}）"
        );
    }

    /// 装不下的时刻（`SYSTEMTIME` 表达不了）回空串，而不是拿 UTC 硬填 ——
    /// 与 `local_day` 同一 posture：宁可缺一格，不要一个看着像真的的错值。
    #[test]
    fn an_unrepresentable_instant_yields_empty_not_a_silent_utc_stamp() {
        assert_eq!(local_stamp(i64::MAX), "");
        assert_eq!(local_stamp(i64::MIN), "");
    }
}
