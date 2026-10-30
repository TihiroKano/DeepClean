# 2026-10-20 · 清理逻辑按 cleanup-rules.md 优化 + 扫描引擎换 SpaceSniffer

## 做了什么

### 1. 大文件 / 重复文件下线（彻底删除）

删掉的不只是两个页面：

| 层 | 删除物 |
|---|---|
| 前端 | `pages/LargeFiles.tsx`、`pages/Duplicates.tsx`、`components/FileTable.tsx`、导航项、`dupGroupIds`/`dupExclusions` 两条状态链、`App.tsx` 里对应的四处 state 与事件订阅 |
| 桥 | `runDuplicateScan` / `cancelDuplicateScan` / `getTopFiles` / `onDupEvent`，`dc_preview` 的 `dupGroupIds` / `dupExclusions` 两个形参 |
| Rust | `crates/dupes` 整个 crate（11 个源文件 + 4 个测试 + 4 份夹具）、`src/dupes.rs`、`src/top_files.rs`、`dc_dupes_run` / `dc_dupes_cancel` / `dc_top_files` 三条命令 |
| 核心 | `core/dup/`（detect + findings）、`core/analyze/top-files.ts`、`shared/dup-narrow.ts` |
| 测试 | `dup-detect` / `dup-hardlink` / `dup-narrow` / `dup-render` / `largefiles-live` / `top-files` 六个文件 |
| 服务层 | `build_preview` / `run_auto_clean` / `assemble_dev_env_view` 三个函数的 `DupState` 形参，以及 §20 → §17 的并账段 |

同时把因此变成死代码的东西一起收了：`service::rule_report`（唯一的便捷入口，会自己采机器事实从而在持锁路径上制造未响应）、`perf.rs` 里的 `synthetic_report`、`clean-journal` 里的旧形状断言。

### 2. 扫描引擎换成 SpaceSniffer（内嵌，边扫边画）

新增 `src-tauri/src/scanner_host.rs`（约 940 行）与 `src/renderer/hooks/useSpaceSniffer.ts`：

- `SpaceSniffer.exe scan "<root>"` 起子进程（实测无模态弹窗，直接进 `full scan...`）
- 等 `TfrmMain` 出现（50ms × 15s 轮询，**有界**超时）
- 把 `WS_POPUP` 改成 `WS_CHILD` 后 `SetParent` 挂进 DeepClean 主窗口
- 坐标换算**全在 Rust 一侧**：前端只送 `getBoundingClientRect()` 原值（屏幕坐标 + CSS 像素），
  `ClientToScreen(客户区 0,0)` 求原点、`scale_factor()` 乘回物理像素 —— 两处各算一半会在 125%
  缩放的屏上留下 1.25px 的缝
- 六条命令全部 `async` + `spawn_blocking`：它们要与**另一个进程的窗口线程**打交道，
  同步等就会一起卡住
- 退出时杀（`RunEvent::Exit`）、`stop` 时杀、下一次 `launch` 前先杀上一个，三条路同一个 `stop`
- 引擎缺失时回结构化错误 `E_SS_MISSING`，界面显示「扫描引擎缺失」并**退回自带 treemap**，
  不崩、不静默

「开始深度扫描」现在**双路并发**：① DeepClean 自己的扫描（清理/规则判定读的树，一行没动）；
② SpaceSniffer（空间地图的绘图引擎）。两路互不等待，引擎起不来不拦自己的扫描。

### 3. 按 cleanup-rules.md 补齐判据

- **三档风险**映射到既有 `Risk`：🟡 → `safe`、🟠 → `caution`/`high` + `excludedFromDefaultSelection`、
  ⛔ → `forbidden`
- **§6 五类 deny 类别**：`FORBIDDEN_PATH_PATTERNS` 6 → 17 条、`REPORT_ONLY_ROOT_PATTERNS` 1 → 12 条
- **围栏地板**：`FENCE_MINIMUM_DENY_PATTERNS` 4 → 5 条（补 `%LOCALAPPDATA%\Programs\*`）
- **R-LOG-01 的活日志守卫**：`*.?.log` 只吃轮转件、不吃 `HiviewPlatform.log`（已有，未动）
- 两侧（Rust `crates/rules` 与 TS `core/rules`）**逐条同序**，由 `parity_with_ts` 零容差对账

## 一处必须记下来的判断：叶子型禁止根移到了「只上报」

`cleanup-rules.md` §6 的 R-DENY-AIDATA / USERDATA / MSACTIVITY 里有一族根住在
`%APPDATA%` / `%LOCALAPPDATA%` 下（`Claude`、`Tencent`、`Packages`、`Package Cache` …）。
把它们登记成**禁止根**会让这四条已上线的容器入口规则（`browser-cache` / `app-cache-data` /
`installer-artifacts` / `app-rotated-logs`）**一条 finding 都不出** —— 因为那两条根正是它们的
`allowRoots`，评估层的 `AncestorOfProtected` 会把 allow 根判成"套住了受保护路径"。

实测证据：`C:\ProgramData` 被判 `AncestorOfProtected`（它套住了 `%PROGRAMDATA%\Package Cache`），
`C:\Local` / `C:\Roam` 同理。

**处置**：这一族移到 `REPORT_ONLY_ROOT_PATTERNS`。语义与文档 §6 完全一致（⛔ 照常枚举、
照实报占用、没有任何规则能认领），差别只在枚举阶段看不看得见 —— 而看得见才能如实报出
「Tencent 1298.9 MB」那种读数。**住在家目录（`%USERPROFILE%` 下）的八条留在禁止根**，
因为 `%USERPROFILE%` 不是任何 allowRoot。

这条不是"绕过文档"，是文档没覆盖到的一个结构性冲突。两侧同步过，parity 绿。

## 验证

| 闸 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `vitest run` | **62 files / 987 tests 全绿** |
| `cargo test --workspace` | **全部 crate 0 failed**（118 + 121 + 109 + 106 + 57 + 39 + 32 + …） |
| `cargo check --workspace` | `Finished`，**零 warning** |
| `npm run build:tauri` | 构建成功，产物含 `一键清理` / `dc-clean-head` / `dc-clean-cta` |
| 真机启动 | 窗口打开、`responding=True`、侧栏只剩 5 项（大文件/重复文件已消失） |
| 真机扫描 | `DC_AUTOSCAN` 扫 `%LOCALAPPDATA%\Temp` → 自动跳空间地图，treemap 渲染出真实数据（`dsh-workspace-changes` 60.4 MB 等），右侧 Top 榜单正确 |
| SpaceSniffer 独立起 | `scan "C:\Windows"` → 标题变 `[C:\Windows\ - full scan...]`、`responding=True` |

## **没验到的部分**（如实登记，不写成"已验证"）

1. **内嵌 SpaceSniffer 窗口的视觉效果没在任何一次真机截图里出现过**。
   截图里看到的两次空间地图都是我们自己的 treemap：`DC_AUTOSCAN` 走的是纯后端入口，
   它**不调** `dc_ss_launch` —— 只有用户在首页点「开始深度扫描」才会拉起 SpaceSniffer。
   而本机的屏幕自动化**点不动这个窗口**（详见下一条），所以我无法用"点一下再截图"补齐这一格。
   `dc_ss_*` 六条命令的编译、`SetParent` 路径的可行性（早前用 PowerShell 直接对
   SpaceSniffer 窗口做过 `SetParent` + `WS_CHILD` 试验、进程保持响应）都验过，
   但**"点开始扫描 → 地图区出现 SpaceSniffer 在扫"这条端到端链路本身没跑通过一次**。
   这是本次交付最大的一个空白。

2. **屏幕自动化在这个窗口上失效**。`SetCursorPos` + `mouse_event` 对侧栏连续十几次零响应
   （悬停能出 tooltip，点击不换页）；键盘 `Tab` 也不移动焦点环；`SetForegroundWindow`
   要先按一下 `Alt` 解前台锁才返回 True。同一套手法在别的应用上正常。
   与本轮改动无关（`SetParent` 只在点「开始深度扫描」后才执行，而本路径从未触发过），
   但它使"点一下截图"这条验收路不可用。

3. **0 命中的规则只写「本机 0 命中」**：`R-DEVART-01`（开发目录构建产物）**有意不上表** ——
   它与 `builtin.rs` 里那两条既有硬判据（`node_modules` / `__pycache__` 故意不做）冲突，
   文档给的 tier 本身就是「🟠 不自动判」。`R-DRIVER-01`（DriverStore 差集）同样没做：
   DriverStore 被 `%WINDIR%\System32` 禁止根挡着（正确），而"无设备在用 ≠ 可删"那条
   文档自己要求逐包人工确认，不适合进自动判据。

4. **`R-LOG-01` 的「mtime 早于 30 天」没有实现**：本项目有断言钉着「全表没人用时间过滤」
   （规则不读时钟，否则同一棵树两次评估给出两份账）。只补了名单与活日志守卫。

5. **`R-ORPHAN-01` 的「≥20 MB 门槛」没有实现**：它属于"值不值得报"而不是"是不是残留"，
   放进判定层会撞同一条时钟/可复现性断言。深 token 展开与「打开看内容」守卫也**没有落**。

6. **`R-STAGE-01`（安装暂存随机后缀目录）没有实现**：它需要「必须存在非随机后缀兄弟目录」
   这个兄弟目录判据，现有 `RuleScanner` 字段表达不了，要么加字段要么改引擎 —— 本轮没做。

7. **§7 七路证据的 `oracles_queried / legs_available / dead_legs` 汇总没有落**：
   `appfacts` 的 `judge()` 已经是「任一路取不到 ⇒ Unknown」（§1.2 铁律 2 成立），
   但文档要求的三个计数与「缺哪路点名哪路」的输出没有加。

以上 3–7 是**没做的**，不是"做了但没验"。

## 顺手发现、没动的问题

- 仓库根有约 25 MB 的一次性截图与 `.log`（`dc_*.png` / `scan_*.png` / `golden-run*.log` 等），
  以及 `.scan-cache/`（2.7 MB）。它们都在 `.gitignore` 之外但未跟踪。本轮没删 ——
  不在授权范围内，但"保持代码整洁"如果要含工作区，这是第一笔。
- `src-tauri/dist/` 里有两份旧的 `index-*.js` 残留（`git status` 显示为 `D` 与 `??` 各一份）。
