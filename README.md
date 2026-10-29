# DeepClean

Windows 磁盘空间分析与安全清理工具。扫描一棵目录树，告诉你空间去哪了，再把可以删的东西
逐项列出来 —— **每一步都要你勾选、确认，才动手**。

当前版本 **1.0.0**，Tauri 2 + Rust + React 18。

---

## 它能做什么

| 页面 | 做什么 |
| --- | --- |
| **首页** | 选一个目录开始扫描，看进度与总量 |
| **空间地图** | 树图（treemap）按占用面积铺格子，可钻取、右键选中、返回上一级 |
| **垃圾清理** | 按规则逐项列出可清理项，勾选 → 看预估 → 确认 → 执行；失败的条目逐条列出 |
| **开发环境** | 识别这台机器装过哪些开发工具与缓存（只读探测，勾选仍走清理链） |
| **清理日志** | 每次清理一条记录，落盘保留 30 天，点详情看删了哪些文件 |
| **设置** | 背景壁纸、毛玻璃四格（模糊/饱和/亮度/透明度）、授权、版本 |

**它不做的事**：不联网上报、不自动清理、不碰你不勾的东西。

---

## 怎么跑起来

### 需要什么

- Windows 10/11 x64
- Node.js ≥ 20.12
- Rust（`x86_64-pc-windows-gnu` 工具链 + MinGW-W64 gcc）
- WebView2（Win11 自带；Win10 多数已装，缺了安装器会补）

### 开发

```powershell
npm install
npm run build:tauri     # 前端产物进 src-tauri/dist（Tauri 编译期嵌入它）
npx tauri dev           # 需要 Rust 工具链在 PATH
```

> **改了前端必须先 `build:tauri` 再 `cargo build`**。`cargo` 只盯 `src/` 与 `Cargo.toml`，
> 它不会因为 `dist/` 变了就重新嵌入 —— 不重打的话你跑的还是**旧页面**，而这个症状看起来
> 像「我改了 CSS 但没生效」。`build.rs` 里 `cargo:rerun-if-changed=dist` 就是为这条。

### 测试

```powershell
npm test                # vitest，全量 1095 条
cargo test --workspace  # 28 组，在 src-tauri/ 下跑
npm run typecheck       # tsc 两个项目
```

### 出包

```powershell
npx tauri build --bundles nsis
```

产物：

```
src-tauri\target\release\deepclean-app.exe
src-tauri\target\release\bundle\nsis\DeepClean_1.0.0_x64-setup.exe
```

安装包**不含 WebView2 离线运行时**（约 4.6 MiB）。目标机缺运行时时，安装器会联网拉
bootstrapper；`downloadBootstrapper` 那一条写在 `src-tauri/tauri.conf.json`。

---

## 仓库结构

```
core/              纯 TS 判定层（扫描、规则、分析、清理、报告），不依赖 Electron/Tauri
shared/            主进程与渲染端共用的类型与常量（只许 import 自己）
src/               React 渲染端（页面 / 组件 / 样式）
src-tauri/
  src/             Tauri 壳：命令、会话服务、设置、壁纸、协议注册
  crates/          六个不依赖 tauri 的纯 Rust crate，可单独 cargo test
    scanner/       MFT 与目录枚举
    rules/         规则引擎与判定
    cleaner/       删除执行
    license/       离线授权（Ed25519 + DPAPI）
    devenv/        开发环境识别
    appfacts/      机器事实探针
tests/             vitest 用例
scripts/           探针、对账、截图生成（`_` 前缀的是不入库的一次性探针）
```

**为什么 `core/` 与 `crates/` 都是纯的**：判定逻辑必须能在没有界面、没有窗口的情况下
被单测直接喂输入。`src-tauri` 那层只做 command / event 转发。

---

## 几条踩过的坑（写在这里省下一个人一天）

- **`Win32::UI::Controls::Dialogs` 不是 `Win32::UI::Shell`**：`GetOpenFileNameW` 在
  `Shell` 下也有同名声明，照着名字导会报 E0432 解不出来。
- **调 `GetOpenFileNameW` 前必须 `CoInitializeEx`**：Tauri 的 async 命令跑在线程池上，
  那上面的线程不保证初始化过 COM，不初始化时它回 0 且原因说不清。
- **`tauri build` 与 `cargo build` 不是一回事**：`#[cfg(debug_assertions)]` 门控的 import
  只在 release 档暴露。改完跑一次 `cargo check --release`，别拿十几分钟的打包当编译检查。
- **壁纸只存文件名不存绝对路径**：存路径等于把「选一张图」变成「读任意文件」。
  服务端复制进应用数据目录后只回文件名，越界由自定义协议的作用域挡。
- **缓存键要放「已删集合的快照」而不是「非空」**：后者会让清理过一次之后缓存永久失效，
  此后每次勾选都重跑全量。

---

## 授权

离线授权：激活码是 `DC-` + 32 位大写十六进制（共 35 个字符）。应用内嵌的是 **SHA-256
哈希清单**（`src-tauri/resources/codes.sha256`），从不解码回明文。设备绑定用 Ed25519，
私钥由 DPAPI 保护后落盘。

---

## 许可

**PolyForm Noncommercial License 1.0.0** —— 见 [LICENSE](LICENSE)。

一句话说清它允许什么、不允许什么：

| 你能 | 你不能 |
| --- | --- |
| 读源码 | **商用**（任何有商业预期的用途） |
| 自己用、研究、学习、实验 | 拿它做一个产品卖 |
| 改，改完自己用 | 改了之后分发出去卖 |
| 在非营利组织 / 学校 / 政府机构里用 | 把它并进商业产品 |

**它不是一个 OSI 认可的开源协议。** 这是刻意的：这个项目靠激活码分发，源码公开是为了让人
能看见它做什么、怎么做的，不是为了让人复制一份去卖。

字体（DM Sans / DM Serif / Poppins / JetBrains Mono）**是另一套许可**，各自的原许可仍然
有效，见 `docs/fonts-LICENSE.txt`。上面那张表不覆盖字体。
