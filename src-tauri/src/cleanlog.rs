//! §29 的落盘面（外壳层）：每一次删除、每一条拒绝都往一个文件里追加一行 `[CLEAN]`。
//!
//! 基准是 `electron/main/logger.ts`（同步 `appendFileSync`、写坏了就 `broken = true` 从此不再写）
//! 与 `electron/services/clean-service.ts:135`（记录页那格 `logPath: log.path`）。
//! 判定与格式那一半在 `deepclean_cleaner::logline` 里（那里能对 node 逐字对账），
//! 这一层只管**文件在哪、目录建不建得出来、写失败了怎么办**。
//!
//! ## 为什么日志坏了不拦删除
//!
//! 一条看起来更"安全"的做法是：日志写不下去就不许删（怕的是"删了却没留下证据"）。
//! 基准没这么做，本轮也不改：那条通道一旦成立，"磁盘满了 / 杀软占着日志文件"就会变成
//! "清理点不动"，而用户看到的症状与闸被绕过时一模一样，只是反过来。真正兜住"删了什么"的
//! 是那份**回执 + 指纹**（§17→§18 那条链），日志是给人读的第二份，不是授权凭证。
//! 这条决定有代价，登记在验收文档里：日志可能缺，而缺的时候记录页那格会说"没能确定日志文件路径"。

use deepclean_cleaner::{format_log_line, local_stamp, CleanLog, LogFields};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 基准那个文件名（`%APPDATA%\deepclean\logs\deepclean.log`）。
const LOG_FILE: &str = "deepclean.log";

pub struct FileCleanLog {
    file: PathBuf,
    /// 写失败一次就立起来，之后**不再尝试**（基准 `logger.ts:44` 的 `broken`）。
    /// 不重试不是因为懒：磁盘满 / 文件被占用这类失败会每条都复现，
    /// 每条都再撞一次 open+write 等于把删除的热路径绑在一个坏掉的通道上。
    broken: AtomicBool,
}

impl FileCleanLog {
    /// 定位置 + 建目录。失败回 `Err(原因串)`，由调用方决定"这一格干脆不挂"，
    /// 而不是带着一个永远写不进去的路继续跑。
    pub fn create(data_dir: &Path) -> Result<Self, String> {
        let dir = data_dir.join("logs");
        std::fs::create_dir_all(&dir).map_err(|e| format!("建不出日志目录 {dir:?}：{e}"))?;
        Ok(Self { file: dir.join(LOG_FILE), broken: AtomicBool::new(false) })
    }

    /// 只给测试用：产品那半边要的是 `path_string()`（`service.rs:866` 把它塞进 `log_path`），
    /// 这里留 `&Path` 形态是为了断言里好比对。
    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.file
    }

    ///
    /// ⚠️ 2026-10-25 起**没有调用方**：旧记录页有一格 `logPath` 靠它，那一整块随
    /// 清理日志重做下线了。保留是因为它是这一层的公开面（"这个日志写到哪了"是正当问题），
    /// 而且真机排查时 `path()` 那格还得能用。要收掉请连 `FileCleanLog` 的对外形状一起改。
    #[allow(dead_code)]
    pub fn path_string(&self) -> String {
        self.file.to_string_lossy().into_owned()
    }

    /// 这一路是不是已经不再写了。
    ///
    /// ⚠️ **目前只有测试读它，产品那半边没接**：清理记录页报的是 `log_path`（路径），
    /// 而 `service.rs:865` 自己就写着「这里报的是**路径**，与那个文件现在还在不在写是两件事」
    /// —— 基准（`electron/main/logger.ts`）同样把这两格分开，所以"日志静默停写、界面照旧给路径"
    /// 是继承来的行为，不是漏了一行。要把这一格上界面，得单开一批（它要动 `journal_of` 的线上形状）。
    #[cfg(test)]
    pub fn is_broken(&self) -> bool {
        self.broken.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn at(file: PathBuf) -> Self {
        Self { file, broken: AtomicBool::new(false) }
    }
}

impl CleanLog for FileCleanLog {
    fn clean(&self, msg: &str, fields: LogFields<'_>) {
        if self.broken.load(Ordering::Relaxed) {
            return;
        }
        // 时间戳取**写入那一刻**（基准同样是 `new Date()` 在 write 里现取），
        // 不是任务的 startedAtMs：一趟清理里那 20 万条各有自己的时刻，
        // 全盖成同一个数就把日志变成了"这次清理的统计"，而它答的是"什么时候发生的"。
        let stamp = local_stamp(crate::service::now_ms());
        let line = format_log_line(&stamp, "CLEAN", msg, fields);
        match self.append(&line) {
            Ok(()) => {}
            Err(e) => {
                self.broken.store(true, Ordering::Relaxed);
                // 只喊这一次（立了 `broken` 之后不会再进来）。往 stderr 喊是因为
                // 这里没有第三条通道可写 —— 日志自己坏了不能连报错的地方也一起坏掉。
                eprintln!("[dc] 清理日志写不下去，之后不再尝试写：{line:?} → {e}");
            }
        }
    }
}

impl FileCleanLog {
    fn append(&self, line: &str) -> std::io::Result<()> {
        // `append(true)` 而不是 `write(true)` + seek：每次 open 就定位到末尾，
        // 同进程内多条之间不需要保存偏移，也不给"覆盖已有内容"留任何形状。
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&self.file)?;
        f.write_all(line.as_bytes())?;
        f.write_all(b"\n")?;
        f.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepclean_cleaner::LogValue;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("deepclean-cleanlog-{name}"))
    }

    /// 端到端（真文件）：两行进去、文件里就是两行，且每行都是 `<本地时间> [CLEAN] …`。
    #[test]
    fn written_lines_land_in_the_file_one_per_event() {
        let dir = tmp("write");
        let _ = std::fs::remove_dir_all(&dir);
        let log = FileCleanLog::create(&dir).expect("临时目录建得出日志目录");
        assert!(log.path().ends_with(Path::new("logs").join("deepclean.log")), "{:?}", log.path());

        log.clean("clean start", &[("task", Some(LogValue::Str("t1"))), ("requested", Some(LogValue::Int(2)))]);
        log.clean(r"C:\Sandbox\a.txt", &[("status", Some(LogValue::Str("success"))), ("size", Some(LogValue::Int(100)))]);

        let body = std::fs::read_to_string(log.path()).expect("文件该在");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2, "一条事件一行：{lines:?}");
        // 时间戳那一格**不能只断言"像个日期"**（原来写的是 `starts_with("2")`，
        // 于是把 `local_stamp` 换成常量 `"2026-01-01 00:00:00"` 也照样绿 —— 那是我自己
        // 给这条判据留的空子）。这里拿**今天**的本地日期当期望值：写日志用的就是本地那一刻，
        // 而跨日那一半由 `logline` 那 22 点的 node 表钉死。
        // 代价：这条在 UTC 日与本地日不同的那 8 个小时里（本机 00:00–08:00）期望值会不同 ——
        // 而它要的恰恰就是"用本地那一天"，所以这是判据在做事，不是抖动。
        let today = deepclean_cleaner::local_day(crate::service::now_ms());
        assert!(!today.is_empty(), "前提：本机算得出今天的本地日期");
        for l in &lines {
            assert!(
                l.starts_with(&format!("{today} ")) && l.get(19..20) == Some(" "),
                "行首该是「{today} HH:MM:SS」：{l}"
            );
        }
        assert!(lines[0].contains(" [CLEAN] clean start task=t1 requested=2"), "{}", lines[0]);
        assert!(lines[1].contains(r#" [CLEAN] C:\Sandbox\a.txt status=success size=100"#), "{}", lines[1]);
        assert!(!log.is_broken());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 第二次调用是**追加**不是覆盖（这条看着琐碎，但"逐条删除日志"最坏的写法就是每条重写整个文件）。
    #[test]
    fn a_second_event_appends_instead_of_replacing() {
        let dir = tmp("append");
        let _ = std::fs::remove_dir_all(&dir);
        let log = FileCleanLog::create(&dir).unwrap();
        for i in 0..5 {
            log.clean("clean end", &[("task", Some(LogValue::Str("t"))), ("ms", Some(LogValue::Int(i)))]);
        }
        let body = std::fs::read_to_string(log.path()).unwrap();
        assert_eq!(body.lines().count(), 5, "五条事件该有五行：{body:?}");
        for i in 0..5 {
            assert!(body.contains(&format!("ms={i}")), "少了 ms={i}：{body}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 **写坏了就停，但不炸、也不拦删除**：把日志文件指到一个**父目录不存在**的位置，
    /// `open` 一定失败（ENOENT/ERROR_PATH_NOT_FOUND），第一条把 `broken` 立起来，
    /// 之后的调用一条都不再尝试。
    ///
    /// 原先这里写的是"指到一个目录上"，跑出来是**绿的**：那句前提就是假的 ——
    /// 测试只建了 `dir`，`dir/logs` 并不存在，于是 `create(true).append(true)` 高高兴兴
    /// 地**新建了一个叫 `logs` 的文件**，写成功、`broken` 永远是 false。
    /// 用一个不存在的父目录当失败原因是稳的，也不依赖这台机器的权限设置。
    #[test]
    fn a_broken_sink_latches_off_and_never_panics() {
        let dir = tmp("broken");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dead = dir.join("没有这一层目录").join("deepclean.log");
        assert!(!dead.parent().unwrap().exists(), "前提：父目录确实不存在");
        let log = FileCleanLog::at(dead.clone());
        assert!(!log.is_broken());
        for _ in 0..3 {
            log.clean("clean start", &[("task", Some(LogValue::Str("t")))]);
        }
        assert!(log.is_broken(), "写失败一次就该立起 broken");
        // broken 之后**不再尝试**：那个位置现在可以写了，也不该有文件冒出来
        std::fs::create_dir_all(dead.parent().unwrap()).unwrap();
        log.clean("clean end", &[("task", Some(LogValue::Str("t")))]);
        assert!(!dead.exists(), "立起 broken 之后一条都不再尝试写：{:?}", dead);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 建不出目录时回 `Err`，让调用方**不挂这一格**（记录页那格于是给 null，
    /// 页脚那句照实说"没能确定日志文件路径"）—— 而不是揣着一个写不进去的路。
    /// 用一个"已经存在但是个文件"的位置当数据目录，失败原因就是稳的。
    #[test]
    fn an_unbuildable_log_directory_reports_err_instead_of_handing_back_a_dead_path() {
        let dir = tmp("unbuildable");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        let r = FileCleanLog::create(&blocker);
        assert!(r.is_err(), "拿一个文件当数据目录，create 必须失败而不是回一个假好的 sink");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
