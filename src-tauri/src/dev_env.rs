//! 开发环境识别的**真机层**（M5-D2）。行为基准：`electron/services/detect-env.ts`（187 行，全文）。
//!
//! 分工是刻意的：判据长在 `crates/devenv`（纯函数、零 `std::fs`、零进程、零环境变量 —— 那边
//! 有一道 `tests/readonly.rs` 静态闸守着，掺一次真 `stat` 就会把「全绿」变成「这台机器上全绿」），
//! 这一层只负责把「问机器」那三个能力面接上真实 Windows：
//!
//! - [`DetectorProbe::command_available`] → `where <命令>` 的退出码（V0.7 裁定 2：只用进程查询 +
//!   目录存在性，**不碰注册表**）
//! - [`DetectorProbe::path_exists`] → `%VAR%` 模板在本机解析后判存在
//! - [`DetectorProbe::query_docker_disk_usage`]（V0.7 裁定 1）→ 一次**只读**
//!   `docker system df --format json` 的 stdout。字节怎么算是纯层的事，这一层只交原文。
//!   本层起进程的名字只有两类：`where` 与 `docker`；`reg` / `powershell` 一律没有，
//!   argv 里也不许出现 `prune` / `rm` / `-f` / `-a` / `--all`（那几个词只作为**给用户看的文案**
//!   存在于页面那一行，清理动作交给 Docker 自己）。
//!
//! 两条边界（照抄基准的那两句，因为它们决定「全绿」这个词的意思）：
//! 1. **只读**。这一层没有任何删除能力，也不把结论喂进执行链。
//! 2. 探测失败一律按**未知**回答：`where` 查不到 / 起不来 / 超时都答 `false`；变量解析不出答
//!    `None` 而不是猜一个路径。引擎对「表里缺这个 id」的兜底是当已装，所以这里**不许**为了少几条
//!    噪声而写乐观的 `true` —— 那个方向的错会静默藏掉容量。

use deepclean_devenv::detectors::{DetectorProbe, DockerCliOutcome};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `CREATE_NO_WINDOW` —— 等价于 node 的 `windowsHide: true`。少了它，一趟探测要闪十几个控制台窗口
/// （这台机器上「控制台闪窗」是一条单独记过账的事故形状）。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `where` 用 5 s：一次 PATH 查询本该是毫秒级，给到 5 s 是挡「网络盘符挂了」那一类。
pub const WHERE_TIMEOUT: Duration = Duration::from_millis(5000);

/// df 给到 8 s：daemon 冷启动（Docker Desktop 刚开）比一次 PATH 查询慢得多。
/// 再长就按「量不到」交出去，而不是把调用方钉在同步等待里。
pub const DOCKER_TIMEOUT: Duration = Duration::from_millis(8000);

/// df 的 JSON 也就几十 KB；4 MB 是把「输出被谁改了」这种情况挡在内存爆掉之前。
/// 超限按 `cli-failed` 收（node 的 `maxBuffer` 超限抛的也是非 ENOENT、非超时的错）。
pub const DOCKER_MAX_OUTPUT: usize = 4 * 1024 * 1024;

/// 裁定 1 —— 这一层唯一允许起 `docker` 的地方，argv 写死在这一条常量上，**不接受任何外部入参**。
/// 所以「顺手加一个参数」至少会在这里留下一次可见的改动。
pub const DOCKER_DF_ARGV: [&str; 4] = ["system", "df", "--format", "json"];

/// 一次起进程结构化信号的归并（四格，与 [`ProcessFace::capture`] 一一对应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessOutcome {
    /// 退出码 0。`stdout` 是原文。
    Success { stdout: String },
    /// **连进程都没起来**（node 的 `code === 'ENOENT'`，Rust 的 `ErrorKind::NotFound`）。
    /// 这是唯一可能支持「未安装」的一格。
    NotFound,
    /// 有限超时到了、进程被杀。
    TimedOut,
    /// 起来了但非 0 退出（daemon 没起、权限不够、这个版本不认识这个参数、输出超限，全在这一格）。
    Failed { stderr: String, stdout: String, message: String },
}

/// 起进程这一格做成注入面：**分类判据不许靠真起一次 docker 才能验**。
/// 这条分工抄自 TS 的 `dockerUsageProvider` / `detectorStatusProvider`（"只有注入点办得到"）。
pub trait ProcessFace {
    /// 只问「退出码是不是 0」（`where` 那一格用）。起不来 = `false`。
    fn exit_ok(&self, program: &str, args: &[&str], timeout: Duration) -> bool;
    /// 要 stdout 的那一格（docker df）。
    fn capture(&self, program: &str, args: &[&str], timeout: Duration, max_output: usize) -> ProcessOutcome;
}

/// 真实现：`std::process`，不带 `windowsHide` 的那份 Windows 快捷键。
pub struct OsProcess;

impl ProcessFace for OsProcess {
    fn exit_ok(&self, program: &str, args: &[&str], timeout: Duration) -> bool {
        match spawn_and_wait(program, args, false, timeout, 0) {
            ProcessOutcome::Success { .. } => true,
            _ => false,
        }
    }

    fn capture(&self, program: &str, args: &[&str], timeout: Duration, max_output: usize) -> ProcessOutcome {
        spawn_and_wait(program, args, true, timeout, max_output)
    }
}

/// 起一个隐藏窗口的子进程，**有界**等它，然后按机器给的结构化信号归并成四格之一。
///
/// 为什么不 `output()` 一把阻塞：那条没有超时位，而这里两条超时（5 s / 8 s）都是判据的一部分
/// —— 「超时」与「非 0 退出」是两句不同的话（前者只可能是量不到，后者还要拿 `where` 反证一次才
/// 敢说不装）。轮询 `try_wait` 的 25 ms 是拿「最坏多等 25 ms」换掉一条依赖（`wait-timeout`）。
///
/// **管道必须一边等一边读**：Windows 的匿名管道缓冲只有几十 KB，而 `docker system df` 的 JSON
/// 可以到几十 KB 以上。先等退出再读，输出一满就两边互相等死，到点报 `timed-out` —— 把「量到了」
/// 报成「量不到」。所以两条读线程先起身，`try_wait` 只负责到点杀。
fn spawn_and_wait(
    program: &str,
    args: &[&str],
    pipe: bool,
    timeout: Duration,
    max_output: usize,
) -> ProcessOutcome {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null());
    if pipe {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    } else {
        cmd.stdout(Stdio::null()).stderr(Stdio::null());
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        // 起不来就是 ENOENT 那一格，别的都不许猜
        Err(_) => return ProcessOutcome::NotFound,
    };
    let mut out_thread = child
        .stdout
        .take()
        .map(|out| std::thread::spawn(move || drain(out, max_output)));
    let mut err_thread = child
        .stderr
        .take()
        .map(|err| std::thread::spawn(move || drain(err, max_output.saturating_mul(2))));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // 杀掉之后管道必然 EOF，两条读线程随之收工 —— 不 join 就是留线程在外面
                    let _ = out_thread.take().map(|h| h.join());
                    let _ = err_thread.take().map(|h| h.join());
                    return ProcessOutcome::TimedOut;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = out_thread.take().map(|h| h.join());
                let _ = err_thread.take().map(|h| h.join());
                // 等不到状态：按「非 0 且没有信息」收，不外溢（这一层坏了不许把预览带崩）
                return ProcessOutcome::Failed {
                    stderr: String::new(),
                    stdout: String::new(),
                    message: "等待子进程状态失败".to_string(),
                };
            }
        }
    };

    let (out_buf, out_over) = out_thread.take().and_then(|h| h.join().ok()).unwrap_or_default();
    let (err_buf, err_over) = err_thread.take().and_then(|h| h.join().ok()).unwrap_or_default();
    let stdout = String::from_utf8_lossy(&out_buf).into_owned();
    let stderr = String::from_utf8_lossy(&err_buf).into_owned();
    if out_over || err_over {
        // node 的 `maxBuffer` 超限抛的是非 ENOENT、非超时的错 → 同一格 `cli-failed`
        return ProcessOutcome::Failed {
            stderr,
            stdout,
            message: format!("输出超过 {max_output} 字节上限（df 的 JSON 不该这么大）"),
        };
    }
    if status.success() {
        return ProcessOutcome::Success { stdout };
    }
    ProcessOutcome::Failed {
        stderr,
        stdout,
        message: format!("退出码 {:?}", status.code()),
    }
}

/// 读到 EOF 为止，返回（读到的字节, **是否触过上限**）。
///
/// 触顶之后**继续读到 EOF**、只是不再存：中途撂下管子不读，子进程下一次写就会阻塞在满管子上，
/// 于是永远等不到它退出 —— 那一格会被报成 `timed-out`，把「输出太大」这件已判的事说成「超时」。
fn drain(mut reader: impl std::io::Read, cap: usize) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut over = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => return (buf, over),
            Ok(n) => {
                if over {
                    continue;
                }
                if buf.len() + n > cap {
                    buf.extend_from_slice(&chunk[..cap.saturating_sub(buf.len())]);
                    over = true;
                } else {
                    buf.extend_from_slice(&chunk[..n]);
                }
            }
            // 读错就收：这一层的纪律是「不外溢」，内容缺了由调用方按未知处理
            Err(_) => return (buf, over),
        }
    }
}

/// 把 `ProcessOutcome` 收成 `DockerCliOutcome` 的四格。**只看机器给的结构化信号，不看文案**：
/// 「daemon 没起」不在这里单拆一格 —— 那要匹配英文报错文案，换一套界面语言就换一个结论，
/// 而它要的结论和「其它非 0」完全一样（量不到）。唯一能推出「未安装」的只有 `NotFound`，
/// 且纯层还要拿 `command_available("docker")` 反证一次才敢真写 `false`。
pub fn docker_outcome(face: &dyn ProcessFace) -> DockerCliOutcome {
    match face.capture("docker", &DOCKER_DF_ARGV, DOCKER_TIMEOUT, DOCKER_MAX_OUTPUT) {
        ProcessOutcome::Success { stdout } => DockerCliOutcome::Ok { stdout },
        ProcessOutcome::NotFound => DockerCliOutcome::CliMissing,
        ProcessOutcome::TimedOut => DockerCliOutcome::TimedOut,
        ProcessOutcome::Failed { stderr, stdout, message } => DockerCliOutcome::CliFailed {
            message: error_hint(&stderr, &stdout, &message),
        },
    }
}

/// 把进程抛回来的各种形状收成一句人能读的话（本层只做运输，不做判据）。
///
/// 与 TS `errorHint` 同法：stderr、stdout、message 依序拼，非空才要，空白折叠成一个空格，
/// 截 240。**一处有意的分叉**：TS 的 `slice(0, 240)` 数的是 UTF-16 单元，这里数 `char`，
/// 非 BMP 字符（emoji）上两侧差一两个字符 —— 这一格只进 `detail` 文案，不进任何判据。
fn error_hint(stderr: &str, stdout: &str, message: &str) -> String {
    let joined = [stderr, stdout, message]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let folded = joined
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    folded.chars().take(240).collect()
}

/// `%VAR%` 或 `%VAR%\子\路径` → 绝对路径；变量缺失时 `None`（不猜、不回落默认值）。
///
/// 照抄 `detect-env.ts:47-60` 的三步，包括那条**看着多余**的判据：空串算「没有这个变量」。
/// Windows 上 `set FOO=` 与从没设过 FOO 在界面上必须是同一句话 —— 拿空串拼出来的路径会退化成
/// `\子\路径`，而那是一个能存在的目录（盘符根的 `\` 下），于是「不知道」被答成「在」。
///
/// `vars` 的键必须**已经大写**且**不含空值**（[`collect_env_vars`] 负责这一件事），
/// 这样这一层就与「这台机器上的变量叫什么写法」无关了。
pub fn resolve_env_template(template: &str, vars: &BTreeMap<String, String>) -> Option<String> {
    let rest = template.strip_prefix('%')?;
    let close = rest.find('%')?;
    let name = &rest[..close];
    // 尾巴从闭合的那个 `%` **之后**开始 —— `split_at(close)` 会把 `%` 留在后半段，
    // 于是 `%LOCALAPPDATA%\npm-cache` 拼出 `...\AppData\Local\%\npm-cache`（本次实测红出来的形状）
    let tail = &rest[close + 1..];
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        // TS 的那条正则不匹配（名字里有非法字符）→ 落进 `/^[A-Za-z]:\\/` 那一支，
        // 而这一支对以 `%` 开头的串恒为 false → null。
        return None;
    }
    let value = vars.get(&name.to_uppercase())?;
    // 空串在这一格等于「没有」：判据写在**做决定的这个函数**里，而不是只写在
    // [`collect_env_vars`] 的过滤器里 —— 注入一张手工造的表（测试、靶场）也走同一条。
    if value.is_empty() {
        return None;
    }
    if tail.is_empty() {
        return Some(value.clone());
    }
    Some(format!(
        "{}\\{}",
        value.trim_end_matches('\\'),
        tail.trim_start_matches('\\')
    ))
}

/// 不带 `%` 前缀时那一支：只认「盘符 + 反斜杠」开头，其它一律 `None`。
/// UNC（`\\srv\share`）与正斜杠（`C:/x`）都不算 —— 基准就是这么窄的，放宽它等于让模板里
/// 任何写法都能被当成绝对路径，而模板住的是规则表。
pub fn looks_like_absolute_drive(template: &str) -> bool {
    let b = template.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

/// 模板 → 绝对路径（把上面两支接起来，与 TS 的 `resolveEnvTemplate` 一个函数一档事）。
pub fn resolve_template(template: &str, vars: &BTreeMap<String, String>) -> Option<String> {
    if template.starts_with('%') {
        resolve_env_template(template, vars)
    } else if looks_like_absolute_drive(template) {
        Some(template.to_string())
    } else {
        None
    }
}

/// 把本机环境变量收成「键大写、值非空」的表。空值在这里就被丢掉，`resolve_env_template`
/// 才只需要问一次 `get`。
pub fn collect_env_vars() -> BTreeMap<String, String> {
    std::env::vars()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.to_uppercase(), v))
        .collect()
}

/// 真机探针。**同一次探测里对同一个命令 / 同一个模板只问一次**：探测器是「求或」的，
/// `pip` 那一条会同时问 `pip` 与 `pip3`，不缓存的话调用方每评估一次就多起一轮进程
/// （TS 那边实测：一个测试文件建 10 次 service ⇒ 从 2 秒变 11 秒，就是这个 cache 不在的代价）。
pub struct SystemProbe<'a> {
    face: &'a dyn ProcessFace,
    vars: BTreeMap<String, String>,
    commands: RefCell<HashMap<String, bool>>,
    dirs: RefCell<HashMap<String, bool>>,
    /// `exists` 这一格也做成注入点，否则「模板解析对了」与「目录真在不在」两条判据
    /// 只能靠真盘上摆目录来验（那是另一棒的事，见 `dev_env_exists`）。
    exists: &'a dyn Fn(&str) -> bool,
}

impl<'a> SystemProbe<'a> {
    pub fn new(face: &'a dyn ProcessFace, exists: &'a dyn Fn(&str) -> bool) -> Self {
        SystemProbe {
            face,
            vars: collect_env_vars(),
            commands: RefCell::new(HashMap::new()),
            dirs: RefCell::new(HashMap::new()),
            exists,
        }
    }

    /// 注入变量表（测试与靶场用；生产走 [`collect_env_vars`]）。
    #[cfg(test)]
    pub fn with_vars(mut self, vars: BTreeMap<String, String>) -> Self {
        self.vars = vars;
        self
    }

}

impl DetectorProbe for SystemProbe<'_> {
    fn command_available(&self, command: &str) -> bool {
        if let Some(hit) = self.commands.borrow().get(command) {
            return *hit;
        }
        let ok = self.face.exit_ok("where", &[command], WHERE_TIMEOUT);
        self.commands.borrow_mut().insert(command.to_string(), ok);
        ok
    }

    fn path_exists(&self, path_template: &str) -> bool {
        if let Some(hit) = self.dirs.borrow().get(path_template) {
            return *hit;
        }
        let ok = match resolve_template(path_template, &self.vars) {
            Some(abs) => (self.exists)(&abs),
            // 解析不出 = 「不知道在不在」，而这一层的三态住在**键的缺席**里，不住在这一格 ——
            // 探测器问的是「有没有这个 footprint」，答 false 与答「查不到」在这一格是同一句话：
            // 少一条命中证据。宁可少报地盘，不猜一个路径去报。
            None => false,
        };
        self.dirs.borrow_mut().insert(path_template.to_string(), ok);
        ok
    }

    fn query_docker_disk_usage(&self) -> Option<DockerCliOutcome> {
        // 这条路径上**没有** exists：Docker 的字节只来自 stdout，不来自摸目录（裁定 1）。
        Some(docker_outcome(self.face))
    }
}

/// 真机上那个 `exists`：与 node 的 `existsSync` 同语义（跟随链接、任何错误都算不在）。
pub fn dev_env_exists(path: &str) -> bool {
    Path::new(path).exists()
}

/* ================================================================== *
 * 单测
 *
 * 脚本化的起进程面**只记账不碰真机**（同 `crates/devenv` 那条纪律：分类判据不许靠真起一次
 * docker 才能验）。最后那条 `a_real_where_call_answers_both_ways` 是唯一走真机的 —— 它验的是
 * 「接线本身通不通」，一次 `where` 是毫秒级，而两条答案都必须拿得到（恒真是这条判据失去
 * 分辨力的样子）。
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Scripted {
        /// `where` 那一条：命令名 → 退出码是不是 0
        exits: HashMap<String, bool>,
        docker: Option<ProcessOutcome>,
        /// 全序列（`program\0arg1\0arg2…`），用来反证 argv 没被改写、没多问
        calls: RefCell<Vec<String>>,
    }

    impl Scripted {
        fn new() -> Self {
            Scripted { exits: HashMap::new(), docker: None, calls: RefCell::new(Vec::new()) }
        }
        fn with_exits(mut self, pairs: &[(&str, bool)]) -> Self {
            self.exits = pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect();
            self
        }
        fn with_docker(mut self, o: ProcessOutcome) -> Self {
            self.docker = Some(o);
            self
        }
        fn call_log(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl ProcessFace for Scripted {
        fn exit_ok(&self, program: &str, args: &[&str], _timeout: Duration) -> bool {
            self.calls.borrow_mut().push(format!("{program}\0{}", args.join("\0")));
            self.exits.get(args.first().copied().unwrap_or("")).copied().unwrap_or(false)
        }
        fn capture(&self, program: &str, args: &[&str], _timeout: Duration, _cap: usize) -> ProcessOutcome {
            self.calls.borrow_mut().push(format!("{program}\0{}", args.join("\0")));
            self.docker.clone().unwrap_or(ProcessOutcome::Failed {
                stderr: String::new(),
                stdout: String::new(),
                message: "夹具没给 docker 那一格".to_string(),
            })
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_uppercase(), v.to_string())).collect()
    }

    #[test]
    fn the_where_argv_is_exactly_the_bare_command_name() {
        // argv 只许是「裸命令名」：带路径、带 .exe、带参数都会让 `where` 换一个答案，
        // 而那一格答的是「这台机器的 PATH 上有没有它」
        let face = Scripted::new().with_exits(&[("npm", true)]);
        let exists = |_p: &str| false;
        let probe = SystemProbe::new(&face, &exists);
        assert!(probe.command_available("npm"));
        assert_eq!(face.call_log(), vec!["where\0npm".to_string()]);
    }

    #[test]
    fn the_docker_argv_is_the_frozen_read_only_one() {
        let face = Scripted::new().with_docker(ProcessOutcome::Success { stdout: "[]".into() });
        let exists = |_p: &str| false;
        let probe = SystemProbe::new(&face, &exists);
        let _ = probe.query_docker_disk_usage();
        assert_eq!(face.call_log(), vec!["docker\0system\0df\0--format\0json".to_string()]);
        // 反面点名：argv 的**每一个元素**都不许是一个能删东西的词。比整元素而不是比子串 ——
        // `--format` 里含 `rm`，那是这条判据的假阳性形状（子串比对会把「format」当成「rm」判红）。
        const FORBIDDEN: [&str; 6] = ["prune", "rm", "rmi", "-f", "-a", "--all"];
        for arg in DOCKER_DF_ARGV.iter() {
            assert!(!FORBIDDEN.contains(arg), "argv 里出现了删东西的词 {arg}");
        }
        // 而且这一格**不起** `where`：df 的字节只来自 stdout，不来自摸目录（裁定 1）
        assert_eq!(face.call_log().len(), 1);
    }

    #[test]
    fn timeout_and_failure_are_neither_absent_nor_a_process_that_was_not_found() {
        // 四格各答一件不同的事，谁也不许顶替谁
        let cases = [
            (ProcessOutcome::NotFound, DockerCliOutcome::CliMissing),
            (ProcessOutcome::TimedOut, DockerCliOutcome::TimedOut),
            (
                ProcessOutcome::Failed {
                    stderr: "no daemon".into(),
                    stdout: String::new(),
                    message: "退出码 1".into(),
                },
                DockerCliOutcome::CliFailed { message: "no daemon 退出码 1".into() },
            ),
            (ProcessOutcome::Success { stdout: "{}".into() }, DockerCliOutcome::Ok { stdout: "{}".into() }),
        ];
        for (raw, want) in cases {
            let face = Scripted::new().with_docker(raw);
            assert_eq!(docker_outcome(&face), want);
        }
    }

    #[test]
    fn error_hint_folds_whitespace_and_is_bounded() {
        let got = error_hint("Cannot connect   to\nthe Docker daemon", "", "exit status 1");
        assert_eq!(got, "Cannot connect to the Docker daemon exit status 1");
        // 三段全空 → 空串（纯层那一格因此不会留一对空括号）
        assert_eq!(error_hint("", "", ""), "");
        let long = "x".repeat(400);
        assert_eq!(error_hint(&long, "", "").chars().count(), 240, "要截，但不许截出半个字符");
    }

    #[test]
    fn an_unparsable_template_never_touches_the_filesystem() {
        // 「变量解析不出」不许退化成猜一个路径去 stat —— 猜出来的那个目录可能真存在，
        // 于是「不知道」被答成「在」，而这一格的分寸就是这一页的全部价值
        let face = Scripted::new();
        let asked = RefCell::new(Vec::new());
        let exists = |p: &str| {
            asked.borrow_mut().push(p.to_string());
            false
        };
        let probe = SystemProbe::new(&face, &exists).with_vars(BTreeMap::new());
        assert!(!probe.path_exists(r"%NO_SUCH_VAR_AT_ALL%\cache"));
        assert!(!probe.path_exists("%"));
        assert!(!probe.path_exists(r"%A-B%\x"));
        assert!(!probe.path_exists("C:/Users/x"));
        assert!(!probe.path_exists(r"\\srv\share\cache"));
        assert!(asked.borrow().is_empty(), "解析不出时不该来问 exists：{:?}", *asked.borrow());
    }

    #[test]
    fn template_resolution_is_the_port_of_the_ts_regex_down_to_the_empty_value() {
        let v = vars(&[
            ("LocalAppData", r"C:\Users\Kano\AppData\Local"),
            ("USERPROFILE", r"C:\Users\Kano"),
        ]);
        assert_eq!(
            resolve_template(r"%LocalAppData%\npm-cache", &v).as_deref(),
            Some(r"C:\Users\Kano\AppData\Local\npm-cache")
        );
        // 变量名大小写无关（表已经大写归一）
        assert_eq!(
            resolve_template(r"%localappdata%\pnpm-store", &v).as_deref(),
            Some(r"C:\Users\Kano\AppData\Local\pnpm-store")
        );
        // 只有变量名、没有尾巴 → 就是变量值本身
        assert_eq!(resolve_template("%USERPROFILE%", &v).as_deref(), Some(r"C:\Users\Kano"));
        // 值带尾反斜杠 + 尾巴带头反斜杠 → 各去一侧，不许出现 `\\`
        let w = vars(&[("P", "D:\\x\\")]);
        assert_eq!(resolve_template(r"%P%\\y", &w).as_deref(), Some(r"D:\x\y"));
        // **空串算「没有这个变量」**：拿它拼会退化成 `\子\路径`，那是盘符根下一个能存在的目录
        let e = vars(&[("FOO", "")]);
        assert_eq!(resolve_template(r"%FOO%\cache", &e), None);
        // 不带 `%` 的那一支只认「盘符 + 反斜杠」
        assert_eq!(
            resolve_template(r"C:\Users\Kano\.m2", &v).as_deref(),
            Some(r"C:\Users\Kano\.m2")
        );
        assert_eq!(resolve_template("not-a-path", &v), None);
    }

    #[test]
    fn a_command_and_a_template_are_each_asked_once_per_probe() {
        // 探测器是求或的：`pip` 一条会问 `pip` 与 `pip3`，而 `is_installed` 与页面读数在同一次
        // 预览里各问一遍 —— 没有这层 cache，调用方每评估一次就多起一轮进程
        let face = Scripted::new().with_exits(&[("pip", false), ("pip3", true)]);
        let stat_count = RefCell::new(0usize);
        let exists = |_p: &str| {
            *stat_count.borrow_mut() += 1;
            true
        };
        let probe = SystemProbe::new(&face, &exists).with_vars(vars(&[("USERPROFILE", "D:\\x")]));
        assert!(!probe.command_available("pip"));
        assert!(!probe.command_available("pip"), "第二遍该走 cache，答案必须同一个");
        assert!(probe.command_available("pip3"));
        assert_eq!(face.call_log(), vec!["where\0pip".to_string(), "where\0pip3".to_string()]);

        assert!(probe.path_exists(r"%USERPROFILE%\.m2\repository"));
        assert!(probe.path_exists(r"%USERPROFILE%\.m2\repository"));
        assert_eq!(*stat_count.borrow(), 1, "同一个模板不该问第二遍");
    }

    #[test]
    fn a_big_stdout_does_not_deadlock_the_wait() {
        // 「一边等一边读」那一段的唯一定价方式：Windows 的匿名管道缓冲只有几十 KB，
        // 先等退出再读的话，df 的 JSON 一大就两边互相等死 → 到点报 `timed-out`，
        // 把「量到了」说成「量不到」。夹具打 200 KB 到 stdout（**只在测试里**起 `cmd`，
        // 生产路径上本层只起 `where` 与 `docker` 两类，那条判据在上面两条 argv 用例里钉着）。
        let dir = PathBuf::from(r"D:\deepclean-fixture\m5d-pipe");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.txt");
        std::fs::write(&file, vec![b'x'; 200_000]).unwrap();
        let arg = file.to_string_lossy().into_owned();
        let p = OsProcess;
        match p.capture("cmd", &["/c", "type", &arg], DOCKER_TIMEOUT, DOCKER_MAX_OUTPUT) {
            ProcessOutcome::Success { stdout } => {
                assert_eq!(stdout.len(), 200_000, "内容要完整（少一截就是读早停了）")
            }
            other => panic!("大输出该走 Success，实际 {other:?}"),
        }
        // 同一份内容把上限压到 1 KB → 触顶那一格必须是 Failed（既不是 Success 也不是 TimedOut）
        assert!(
            matches!(
                p.capture("cmd", &["/c", "type", &arg], DOCKER_TIMEOUT, 1024),
                ProcessOutcome::Failed { .. }
            ),
            "超限按 cli-failed 收，且不许因为撂下管子而变成 timed-out"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两份 `ext_of` 必须同口径（`deepclean-scanner` 里计数用的那一份，与 `deepclean-devenv`
    /// 从 `core/fs/pathutil.extOf` 翻译过来的那一份）。分叉的症状不是报错而是**静默漏计**：
    /// 一个不认 `.gguf` 的口径在界面上长得和「这台机器上没有」一模一样。
    ///
    /// 这条闸住在壳层：本仓没有 `src-tauri/tests/`（这是个 bin crate，集成测试进不了模块），
    /// 而壳层是唯一同时依赖两个 crate 的那一层。
    #[test]
    fn the_two_ext_of_implementations_agree() {
        // 无分隔符的语料：两份实现必须逐字相等
        let names = [
            "model.gguf",
            "MODEL.GGUF",
            "archive.tar.gz",
            "README",
            ".gitignore",
            ".bashrc",
            "model.",
            ".",
            "..",
            "a.",
            "note.txt.bak",
            "权重.safetensors",
            "",
            "x",
            "a..b",
        ];
        for n in names {
            assert_eq!(
                deepclean_scanner::model::ext_of(n),
                deepclean_devenv::model_files::ext_of(n),
                "文件名 {n:?} 上两份 ext_of 分叉了"
            );
        }
        // 含分隔符的路径：devenv 那份先取父名，scanner 那份只吃文件名 —— 补上那一步必须同果
        let paths: [&str; 4] = [
            "C:\\Users\\Kano\\.m2\\repository\\a.jar",
            "D:\\w\\model.GGUF",
            "C:\\.gitignore",
            "C:\\Users\\x\\.cache\\huggingface\\hub\\weights--x--y\\model.safetensors",
        ];
        for p in paths {
            let leaf = p.rsplit(['\\', '/']).next().unwrap_or(p);
            assert_eq!(
                deepclean_scanner::model::ext_of(leaf),
                deepclean_devenv::model_files::ext_of(p),
                "路径 {p:?} 上「文件名那一份」与「父名 ∘ 那一份」分叉了"
            );
        }
        // 反空跑：语料里必须有一批非空结果，否则整条闸退化成「两个空串相等」
        let nonempty = names
            .iter()
            .filter(|n| !deepclean_scanner::model::ext_of(n).is_empty())
            .count();
        assert!(nonempty >= 6, "非空扩展名只有 {nonempty} 条，这条闸没有分辨力");
    }

    #[test]
    fn a_real_where_call_answers_both_ways() {
        // 真机那一条：只验「接线通不通」，两条答案都必须拿得到
        let p = OsProcess;
        assert!(p.exit_ok("where", &["cmd"], WHERE_TIMEOUT), "cmd 一定在 PATH 上");
        assert!(!p.exit_ok("where", &["definitely-not-a-tool-xyz-20261012"], WHERE_TIMEOUT));
        assert!(
            !p.exit_ok("definitely-not-a-program-xyz-20261012", &["x"], WHERE_TIMEOUT),
            "连进程都起不来 = NotFound = false"
        );
    }
}
