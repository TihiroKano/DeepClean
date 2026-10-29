//! 在线激活的网络判据（M4 改版：激活从「纯离线」改成「必须先连上公网」）。
//!
//! ## 为什么这一层住在壳里，而不是住进 `deepclean-license`
//!
//! 那个 crate 有一道**结构性闸** `no_network_api_appears_in_this_crate`（随编译打红），
//! 它的注释写着「完全离线是产品定义」。把探测塞进去只有两种收场：删掉那道闸（连带删掉一条
//! 已被变异证明过的边界），或者让注释变成假话。两者都比这次改动贵。
//!
//! 所以分工是：**crate 仍然一个网络字节都不发**（闸照旧成立、照旧红）；
//! 「这台设备能不能上公网」是**壳层的前置条件**，判定不过就根本不进 crate。
//!
//! ## 两条检测是两件事（用户点名的那两句）
//!
//! - **设备是否连接网络** → 本机有没有一条能用的路由（`UdpSocket::connect` 只做本地路由查询，
//!   **不发一个包**）。失败 = 网线没插 / 没连 WiFi / 没地址。
//! - **网络是否可用** → 能不能真把一条 TCP 连到公网上的探测点。失败 = 连上了局域网但出不去
//!   （网关挂了、DNS 挂了、被防火墙拦了、门户认证没过）。
//!
//! 两者的错误文案必须分开：把「没连 WiFi」报成「网络被墙」，用户会去查防火墙。

use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// 一个探测点。`label` 是给人看的那一份（进错误文案、进日志），`host`/`port` 是真去连的那一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub label: &'static str,
    pub host: &'static str,
    pub port: u16,
}

/// 探测点。**三个都要，任何一个应答即算在线**。
///
/// 为什么是这三个：这道闸真正的风险不是被绕过（它本来就绕不过"有网就行"这件事），
/// 而是**误伤有网的合法用户** —— 公司防火墙掐掉某个域名、DNS 挂了、代理只放行白名单。
/// 所以：两个常用国内域名 + 一个**纯 IP**（223.5.5.5 = AliDNS），纯 IP 那条保证
/// 「DNS 死了但路由还通」这种最常见的误伤场景仍然过得去。
/// （GitHub 在这台机器上不可达，所以不拿它当探测点 —— 那会把探测变成测墙。）
pub const PROBE_ENDPOINTS: [Endpoint; 3] = [
    Endpoint { label: "www.baidu.com:443", host: "www.baidu.com", port: 443 },
    Endpoint { label: "www.qq.com:443", host: "www.qq.com", port: 443 },
    Endpoint { label: "223.5.5.5:443", host: "223.5.5.5", port: 443 },
];

/// 单条探测的上限。三条全灭时用户最多等 `3 × 2 s`（外加 DNS），点一下按钮的合理量级。
const TIMEOUT: Duration = Duration::from_millis(2000);

/// 一次探测的结果。`host` 存的是 label，为的是错误文案里点名的那一份就是配置里那一份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    Ok { host: &'static str, elapsed_ms: u64 },
    Failed { host: &'static str, reason: String },
}

/// 网络这一关的结论。**三态而不是布尔**：「没连网」与「连了出不去」的处置动作完全不同，
/// 压成一个 `false` 就等于把用户支出去查一个没坏的东西。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Online { via: &'static str, elapsed_ms: u64 },
    NoLink,
    ConnectedButBlocked { attempts: Vec<Attempt> },
}

/// 纯判据（不碰网络，所以能被穷举测试）。三条规矩：
/// ① 没链路优先给 `NoLink`；② 第一条应答的探测点就是结论，并记下它是哪一条、用了多久；
/// ③ **一条都没探（空列表）不算在线** —— 「没有证据」不等于「证据说可以」。
pub fn judge(link_ok: bool, attempts: &[Attempt]) -> Verdict {
    if !link_ok {
        return Verdict::NoLink;
    }
    for a in attempts {
        if let Attempt::Ok { host, elapsed_ms } = a {
            return Verdict::Online { via: host, elapsed_ms: *elapsed_ms };
        }
    }
    Verdict::ConnectedButBlocked { attempts: attempts.to_vec() }
}

/// 结论 → 界面上那句话（`None` = 放行）。稳定码 + 一句能自查的话。
pub fn verdict_error(v: &Verdict) -> Option<String> {
    match v {
        Verdict::Online { .. } => None,
        Verdict::NoLink => Some(
            "E_LICENSE_NO_NETWORK: 这台设备没有连上任何网络 —— 激活需要先能连上公网".to_string(),
        ),
        Verdict::ConnectedButBlocked { attempts } => {
            let listed = if attempts.is_empty() {
                "一个探测点都没跑到（本机网络栈异常）".to_string()
            } else {
                attempts
                    .iter()
                    .map(|a| match a {
                        Attempt::Failed { host, reason } => format!("{host} {reason}"),
                        Attempt::Ok { host, elapsed_ms } => format!("{host} 通了({elapsed_ms}ms)"),
                    })
                    .collect::<Vec<_>>()
                    .join("；")
            };
            Some(format!(
                "E_LICENSE_NET_BLOCKED: 本机有网络连接，但出不去公网（{listed}）—— 换一个网络再试（例如手机热点）"
            ))
        }
    }
}

/// 本机有没有一条能用的路由。
///
/// `UdpSocket::connect` **不发一个包** —— UDP 是无连接的，这一步只做本地路由查询，
/// 失败意味着内核找不到去任何地方的路（没插网线 / 没连 WiFi / 没有地址）。
/// 所以它量的是「连没连上网络」，不是「对方在不在」—— 后者是探测点的活。
/// 路由查询本身。参数化只为让**负分支**能被确定地走到（见 `the_no_route_branch_is_reachable`）：
/// 真拔网线要动别人的机器，不做。
fn route_ok(host: &str, port: u16) -> bool {
    match UdpSocket::bind("0.0.0.0:0") {
        Ok(sock) => sock.connect((host, port)).is_ok(),
        Err(_) => false,
    }
}

fn has_route() -> bool {
    route_ok("223.5.5.5", 53)
}

/// 一条探测：解析 → 逐个地址试 TCP 握手。**只建连接，不发任何请求、不写一个字节**，
/// 所以这句话可以如实告诉用户：探测不上传任何东西，激活码也不上传。
fn attempt(ep: &Endpoint) -> Attempt {
    let started = Instant::now();
    let addrs: Vec<SocketAddr> = match (ep.host, ep.port).to_socket_addrs() {
        Ok(iter) => iter.collect(),
        Err(e) => return Attempt::Failed { host: ep.label, reason: format!("域名解析失败：{e}") },
    };
    if addrs.is_empty() {
        return Attempt::Failed { host: ep.label, reason: "解析结果为空".into() };
    }
    let mut last = String::from("无应答");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, TIMEOUT) {
            Ok(_) => return Attempt::Ok { host: ep.label, elapsed_ms: started.elapsed().as_millis() as u64 },
            Err(e) => last = format!("{}（{} 毫秒内）", e, TIMEOUT.as_millis()),
        }
    }
    Attempt::Failed { host: ep.label, reason: last }
}

/// dev-only：把网络这一关**人为判失败**，用来在真机上截「激活失败」那一相。
///
/// 它只能让判定更严，**不能放行** —— 没有 `online` 这个取值。一条能强制"在线"的后门
/// 会把这道闸连同它的判据一起变成摆设，而界面上那句话也就成了假话。
#[cfg(debug_assertions)]
fn forced() -> Option<Verdict> {
    match std::env::var("DC_LICENSE_NET_FORCE").ok().as_deref().map(str::trim) {
        Some("down") => Some(Verdict::NoLink),
        Some("blocked") => Some(Verdict::ConnectedButBlocked {
            attempts: PROBE_ENDPOINTS
                .iter()
                .map(|e| Attempt::Failed { host: e.label, reason: "被 DC_LICENSE_NET_FORCE 强制判失败".into() })
                .collect(),
        }),
        _ => None,
    }
}

#[cfg(not(debug_assertions))]
fn forced() -> Option<Verdict> {
    None
}

/// 真探一次。顺序：先看有没有链路（一次本地调用），有链路才去摸探测点。
pub fn probe() -> Verdict {
    if let Some(v) = forced() {
        return v;
    }
    if !has_route() {
        return Verdict::NoLink;
    }
    judge(true, &PROBE_ENDPOINTS.iter().map(attempt).collect::<Vec<_>>())
}

/// **激活的唯一入口**（壳层这一侧）：先过网络这一关，过了才把活儿交给 crate。
///
/// 顺序是判据：网络不过 ⇒ **一次文件系统都不碰**。反过来（先调 crate 再判网络）会在
/// 一台没网的机器上留下 `device.key`（crate 的写点在码校验之后），那正是要避免的形状 ——
/// 一台从没激活成功的机器上凭空多一把私钥。
pub fn activate_guarded(
    paths: &deepclean_license::LicensePaths,
    code: &str,
    verdict: &Verdict,
) -> Result<serde_json::Value, String> {
    if let Some(err) = verdict_error(verdict) {
        return Err(err);
    }
    crate::service::run_license_activate_at(paths, code)
}

#[cfg(test)]
mod tests {
    use super::{activate_guarded, judge, route_ok, verdict_error, Attempt, Verdict};

    /// **没连网就是没连网**：探测点全灭也不许把结论说成「网络不可用」。
    /// 两句对应的处置动作完全不同（查 WiFi / 查防火墙），混一句就等于没说。
    #[test]
    fn no_link_wins_over_probe_failures_and_is_its_own_message() {
        let v = judge(
            false,
            &[Attempt::Failed { host: "www.baidu.com:443", reason: "unreachable".into() }],
        );
        assert_eq!(v, Verdict::NoLink);
        let msg = verdict_error(&v).expect("没连网必须给一条失败原因");
        assert!(msg.starts_with("E_LICENSE_NO_NETWORK"), "{msg}");
        assert!(msg.contains("没有连上任何网络"), "{msg}");
        assert!(!msg.contains("激活码"), "{msg} —— 网络这条失败不许把话题拐到码上");
    }

    /// **连了网但出不去**：每个探测点都要点名（哪个、为什么），否则「网络不可用」
    /// 是一句用户无法自查、运维也无法复现的话。
    #[test]
    fn connected_but_blocked_names_every_attempt() {
        let v = judge(
            true,
            &[
                Attempt::Failed { host: "www.baidu.com:443", reason: "timed out".into() },
                Attempt::Failed { host: "www.qq.com:443", reason: "refused".into() },
            ],
        );
        assert!(matches!(v, Verdict::ConnectedButBlocked { .. }), "{v:?}");
        let msg = verdict_error(&v).expect("出不去必须给一条失败原因");
        assert!(msg.starts_with("E_LICENSE_NET_BLOCKED"), "{msg}");
        for host in ["www.baidu.com:443", "www.qq.com:443"] {
            assert!(msg.contains(host), "漏了探测点 {host}：{msg}");
        }
        assert!(msg.contains("timed out") && msg.contains("refused"), "每条的理由都要在：{msg}");
    }

    /// 两个码必须是两个码：`E_LICENSE_NO_NETWORK` 与 `E_LICENSE_NET_BLOCKED`
    /// 与 crate 那边的 `E_LICENSE_TABLE` / `E_LICENSE_INVALID_CODE` 互不重叠
    /// （「清单没交付」和「没连 WiFi」是两件完全不同的事故）。
    #[test]
    fn the_two_network_codes_are_distinct() {
        let a = verdict_error(&Verdict::NoLink).unwrap();
        let b = verdict_error(&Verdict::ConnectedButBlocked {
            attempts: vec![Attempt::Failed { host: "h:1", reason: "r".into() }],
        })
        .unwrap();
        let code = |s: &str| s.split(':').next().unwrap().to_string();
        assert_ne!(code(&a), code(&b), "两条网络失败共用了同一个码");
        assert_ne!(code(&a), "E_LICENSE_INVALID_CODE");
        assert_ne!(code(&b), "E_LICENSE_TABLE");
    }

    /// **一条探测点通了就算在线**，并且要留下「走的是哪一条、用了多久」——
    /// 界面与日志都要能说出这次是从哪儿出去的。
    #[test]
    fn first_successful_probe_is_the_verdict_and_records_which_one() {
        let v = judge(
            true,
            &[
                Attempt::Failed { host: "www.baidu.com:443", reason: "timed out".into() },
                Attempt::Ok { host: "223.5.5.5:443", elapsed_ms: 41 },
                Attempt::Ok { host: "www.qq.com:443", elapsed_ms: 7 },
            ],
        );
        assert_eq!(v, Verdict::Online { via: "223.5.5.5:443", elapsed_ms: 41 });
        assert_eq!(verdict_error(&v), None, "在线不许有失败原因");
    }

    /// **负分支是可达的**：一个 IPv4 socket 连 IPv6 目的地，任何 Windows 上都会以
    /// `Err` 告终（地址族不匹配）—— 于是 `judge(false, ..)` 那条 `NoLink` 路径不再只是
    /// "代码写了但没跑过"。
    ///
    /// 这条**不**等于"真拔了网线"：它证的是"探测拿不到路由时确实回 `Err`、确实被读成 `NoLink`"，
    /// 而不是"没插网线的机器上就是这个错"。后者仍挂在未验那一栏（见验收 §8.7）。
    #[test]
    fn the_no_route_branch_is_reachable() {
        assert!(!route_ok("[::1]", 53), "IPv4 socket 连 IPv6 目的地居然拿到了路由 —— 那这条判据量错了东西");
        assert!(matches!(judge(false, &[]), Verdict::NoLink));
    }

    /// 全绿但一条探测都没跑（收集器出 bug 给了空列表）⇒ **不许判成在线**。
    /// 这是"没有证据"和"证据说可以"的区别，方向上必须偏保守：宁可说出不通也不许静默放行。
    #[test]
    fn an_empty_attempt_list_is_not_online() {
        assert!(matches!(judge(true, &[]), Verdict::ConnectedButBlocked { .. }));
    }

    /// **闸门走在碰文件系统之前**。故意用一份「没有清单」的目录：闸门要是漏了，
    /// crate 会先报 `E_LICENSE_TABLE` —— 报出网络码才证明根本没走到 crate。
    /// 反向的一半也钉住：一台没网的机器上不许留下 `device.key`
    /// （crate 的写点在码校验之后，先调后判就会凭空多一把私钥）。
    #[test]
    fn the_network_gate_runs_before_anything_is_written() {
        let (dir, paths) = scratch("gate");
        let blocked = [
            Verdict::NoLink,
            Verdict::ConnectedButBlocked {
                attempts: vec![Attempt::Failed { host: "www.baidu.com:443", reason: "timed out".into() }],
            },
        ];
        for v in blocked {
            let err = activate_guarded(&paths, "DC-FIX-0001", &v).unwrap_err();
            assert!(
                err.starts_with("E_LICENSE_NO_NETWORK") || err.starts_with("E_LICENSE_NET_BLOCKED"),
                "{v:?} 没被闸门拦住，报的是：{err}"
            );
            assert!(!err.contains("E_LICENSE_TABLE"), "走到 crate 了（闸门漏）：{err}");
        }
        assert!(!paths.device_key_path.exists(), "没网也不许留下设备私钥");
        assert!(!paths.license_path.exists(), "没网也不许留下激活记录");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反向半边：**在线必须放行**，让 crate 自己的判据说话。
    /// 少了这条，"永远返回网络错误"的实现能骗过上面那条测试（两边都红成"被拦住了"）。
    #[test]
    fn an_online_verdict_lets_the_request_through_to_the_crate() {
        let (dir, paths) = scratch("through");
        let err = activate_guarded(
            &paths,
            "DC-FIX-0001",
            &Verdict::Online { via: "www.baidu.com:443", elapsed_ms: 12 },
        )
        .unwrap_err();
        assert!(err.starts_with("E_LICENSE_TABLE"), "在线却没走到 crate：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// 一个**不存在**的临时目录（不建它 —— 这几条判据要的就是"什么都没写过"这个前提）。
    fn scratch(tag: &str) -> (std::path::PathBuf, deepclean_license::LicensePaths) {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("deepclean-net-{tag}-{}-{n}", std::process::id()));
        (dir.clone(), crate::service::license_paths_in(&dir))
    }
}
