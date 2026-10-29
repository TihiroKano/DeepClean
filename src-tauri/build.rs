use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // **前端产物变了就必须重跑本脚本**，否则 `cargo build` 不会重新把 `dist/` 嵌进二进制。
    //
    // 这是真机上付过时间代价的一条：`npm run build:tauri` 之后直接 `cargo build`，
    // cargo 认为 crate 没变（它只盯 `src/` 与 `Cargo.toml`），链接产物里仍是**旧页面**，
    // 于是改了 CSS 却怎么看都是旧的 —— 当时排查了很久才定位到这一层。
    // `tauri-build` 自己不会声明这一条（它只声明 tauri.conf.json 一类输入），所以必须写在这里。
    println!("cargo:rerun-if-changed=dist");
    // 应用 manifest 走仓库里那一份合并版（`windows-app-manifest.xml`），理由与三条语义的来历都写
    // 在那个文件的头上。这里只做一件事：让 tauri-build 嵌**我们的**而不是它默认那份 ——
    // 默认那份只有 Common-Controls v6，而 `FindResourceW(id=1)` 实测取到的正是它，
    // 于是 MinGW 那份带的 longPathAware 等于白给。
    shadow_mingw_default_manifest();
    // **dev / test 档不许要管理员令牌**（2026-10-25）。manifest 改成 `requireAdministrator`
    // 之后，`cargo test` 起的测试 exe 也带上了它，于是连跑单测都 `os error 740`
    // （请求的操作需要提升）直接失败 —— 实测过一次，整包 124 条一条都跑不起来。
    // `cargo run` 同理：开发时每跑一次弹一次 UAC，改一行看一眼的成本会变得难以接受。
    //
    // 判据只能按 profile：**build script 拿不到"这次是不是 --test"**（实测
    // `CARGO_CFG_TEST` / `CARGO_BIN_NAME` / `CARGO_PRIMARY_PACKAGE` 全是 None，
    // 而 `PROFILE` 是有的）。所以这里的分法是 release = 真交付档、debug = 开发档：
    //   · release（`cargo build --release` / `tauri build`）⇒ 嵌 `requireAdministrator`，
    //     那是用户双击的那个 exe，提权正是为它加的；
    //   · debug（`cargo build` / `cargo test` / `cargo run`）⇒ 换成 `asInvoker`，
    //     单测跑得起来、开发不弹 UAC。
    // 代价如实登记：**debug 档复现不出"提权后能删"这件事** —— 要验那条得跑 release 产物
    // 或装出来的包（那本来就是唯一有意义的验法，与 M5-H「闸跑在装进包里的那份上」同一纪律）。
    //
    // 替换的是同一份清单里的一个属性，其余语义逐字不变，所以 longPathAware / comctl v6
    // 这两条在 debug 档照样被验到。
    let elevated = env::var("PROFILE").map(|p| p == "release").unwrap_or(false);
    let manifest = if elevated {
        include_str!("windows-app-manifest.xml").to_string()
    } else {
        include_str!("windows-app-manifest.xml")
            .replace(r#"level="requireAdministrator""#, r#"level="asInvoker""#)
    };
    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(&manifest),
        ),
    )
    .unwrap();
}

/// 把 MinGW 那份自动挂上的 manifest 顶掉，让 `.rsrc` 里只剩**我们这一份**。
///
/// 症状：每次链接都有一条 `ld.exe: .rsrc merge failure: multiple non-default manifests`。
/// 真因不在 ld 也不在 tauri —— 在 gcc 的 specs 里那一句
/// （`gcc -dumpspecs` 实测）：`%{!shared:%:if-exists(default-manifest.o%s)}`
/// ⇒ 只要不是共享库，MinGW 就无条件再塞一份自带 manifest 的 `default-manifest.o`，
/// 与我们那份同为 `RT_MANIFEST` ID=1，于是两份撞车。
/// ld **没有**任何 manifest 相关开关（`--help` 里 0 命中，`--no-default-manifest` 直接 unrecognized），
/// 所以以前记的结论是"摘不掉"。
///
/// 但 `if-exists` 走的是 **gcc 驱动**的文件搜索路径，那个可以被 `-B<dir>/` 抢在前面：
/// 放一个**不含任何资源**的 `default-manifest.o` 进我们自己的目录，MinGW 那份就不再被取用。
/// 30 秒的独立复现验过三档（`gcc + 一个带 manifest 的 .rc`）：
///   `-B<shim>/` → 告警消失；`-L<shim>` → 照旧（`-L` 是给 ld 的库路径，管不到 specs 取文件）；
///   `-nostartfiles` → 也消失，但它会连 crt 的启动文件一起丢，对可执行文件不可用。
///
/// 有效语义不变：今天 `FindResourceW(id=1)` 取到的本来就是我们这份，顶掉 MinGW 那份只是去掉重复。
/// 构建后仍要复核 exe 里 longPathAware / asInvoker / comctl v6 三条都在（这条改错了的症状是
/// **应用 12 秒内消失、零 stderr**，2026-10-14 实测过，所以不能只看不报警就收工）。
///
/// 降级路径：gcc 不在 PATH（或编译失败）时**什么都不做** —— 回到今天这个"有告警但能跑"的状态，
/// 而不是把一个能用的构建改坏。
fn shadow_mingw_default_manifest() {
    let target = env::var("TARGET").unwrap_or_default();
    if !(target.contains("windows") && target.contains("gnu")) {
        return;
    }
    let out = match env::var("OUT_DIR") {
        Ok(o) => PathBuf::from(o),
        Err(_) => return,
    };
    let shim_dir = out.join("mingw-manifest-shim");
    if fs::create_dir_all(&shim_dir).is_err() {
        return;
    }
    let src = out.join("dc_empty_manifest.c");
    // 只放一个不会被引用的符号：这个 .o 的作用是**占住那个文件名**，让 specs 的 if-exists
    // 取到我们这份（空的）而不是 MinGW 那份带 manifest 的。
    if fs::write(&src, "int __dc_empty_manifest_shim(void){return 0;}\n").is_err() {
        return;
    }
    let obj = shim_dir.join("default-manifest.o");
    let ok = Command::new("gcc")
        .arg("-c")
        .arg(&src)
        .arg("-o")
        .arg(&obj)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok || !obj.exists() {
        println!("cargo:warning=没找到可用的 gcc，跳过 MinGW 默认 manifest 顶替 —— 链接仍会报 .rsrc merge failure，构建不受影响");
        return;
    }
    let mut p = shim_dir.into_os_string();
    p.push(std::path::MAIN_SEPARATOR_STR); // `-B` 要的是前缀目录，必须带尾分隔符
    println!("cargo:rustc-link-arg=-B{}", p.to_string_lossy());
}
