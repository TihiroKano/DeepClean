# M6 出包前置 —— 量具坏了两次（第二种坏法更危险），被验方三轴零残差，以及一条「用时」在扫描停下之后还在走

> **2026-10-17 历史抹除**：本文 3 处提到的验收截图已不在版本库里 —— 它们是 DWM 真实帧修正之前抓的整屏，把别的应用的像素一起提交进了仓库，随 66 张同类图一并从全部历史抹除。图本身在本地归档 `D:\dc-scrub-archive`（逐张 sha256 与被抹 blob 校验一致）。过程、判据与代价见 [2026-10-17-tauri-history-scrub.md](2026-10-17-tauri-history-scrub.md)。本文那些读数一字未改。

日期 2026-10-15 ｜ 分支 `v0.7-dev-env` ｜ 上游：用户 2026-10-14 立的两道闸（`打包前先本机扫描三轴对账`、`修完关键 bug 必须出 exe 交用户自启验证`）

闸（本轮结束时逐条当场跑，不是引用旧数）：

| 闸 | 数 |
|---|---|
| `cargo test --workspace`（cwd `src-tauri/`，TEMP 指 `D:\dc-tmp`） | **648 passed / 0 failed**，`PROG_EXIT=0` |
| `npm test` | **64 files / 1092 passed**，`NPM_EXIT=0` |
| `typecheck:node` + `typecheck:web` | 0 条 `error TS`，`TSC_EXIT=0` |
| 第 2 道闸（release 真机三轴对账） | **三轴全等，零残差**，`GATE_EXIT=0`，见 §2；在 00:37 与 00:45 两份包内产物上各跑一遍 |
| 安装包 | `bundle/nsis/DeepClean_0.1.0_x64-setup.exe` 4,849,697 B / NotSigned，见 §7 |
| 产物 | 包内 `deepclean-app.exe` 25,001,927 B，2026-10-15 00:45（`custom-protocol` 那一版） |

---

## 〇、先更正上一轮交接里我自己写错的三句话

1. **「盘上那份 release exe 仍是 10-13 20:08 的旧物」不成立。** 它已经在 10-14 23:39 出好了
   （`cargo`/`rustc` 在 23:43 之后全部退出，`deepclean-app.d` 与 exe 同刻）。我按交接去找"还在编"的东西，
   实际只找到一条已完成的构建 —— 交接叙述与仓库状态分叉，`ls -l` 一句就能看出来。
2. **「是脚本自己的 .NET 调用挂了」这句把根因说糊了。** 不是 .NET 挂了、也不是权限：
   `[System.IO.Directory]` 上**根本没有 `GetAttributes` 这个方法**（它在 `System.IO.File`）。
   详见 §1。
3. **「一个跑不出绿数的口径没有归因资格」这句是对的**，而且比当时以为的更对 —— 见 §1.2，
   仓里另一条在用的口径同样跑不出绿数，只是它连"没有绿数"这件事都不报。

---

## 一、量具的两种坏法

### 1.1 手写遍历（`scripts/_m6-file-oracle.ps1` → 已转正为 `scripts/m6-file-oracle.ps1`）

复现：`files=0 dirs=1 denied=15`，而根目录正好 15 个条目（13 目录 + 2 文件）。
把异常原样打出来才看见它是什么：

```
System.Management.Automation.RuntimeException ::
Method invocation failed because [System.IO.Directory] does not contain a method named 'GetAttributes'.
```

**危险的不是那个拼写错误，是 `catch { $denied++ }`。** 一条语言绑定错误被记进了「访问被拒」桶，
于是坏掉的量具吐出一串**看起来有台账**的数字：`denied=15` 完全可以被下一个会话当成
「15 条读不到，属已解释差异」接受掉。残缺口径最坏的形态不是给不出数，是给得出数。

修三处：①`[IO.File]::GetAttributes`（改用 `DirectoryInfo.EnumerateFileSystemInfos()`，
每条少一次 syscall，且与被验方/`Get-ChildItem` 都是不同的 walk）；②**工具故障与读不到分桶** ——
非 IO 异常一律 `exit 2` 并把异常类型原样打出来，不再往下吐数；③`PathTooLongException`
**排在 `IOException` 之前**（它派生自 `IOException`，顺序错了就会被当成「读不到」收走，
而注释还写着"算工具故障" —— 结论对、证据假）。

### 1.2 前缀这一格：不带 `\\?\` 的 PowerShell 口径会**反咬**

本机 `LongPathsEnabled = 0`。同一棵 `f100k\longpath` 子树：

| 口径 | 递归条目数 |
|---|---|
| `Get-ChildItem -LiteralPath <原路径> -Recurse -Force` | **10** |
| `Get-ChildItem -LiteralPath '\\?\<原路径>' -Recurse -Force` | **2044** |

闸的原文点名要用「PowerShell `Get-ChildItem -Recurse | Measure-Object`」当第三方口径 ——
**照字面跑就是这条**：少计 2034 条而不出声，于是被验方的正确数字会被判成「双计缺陷」。

顺带把仓里在用的 `scripts/oracle-alloc.ps1` 也量了一遍，它坏得更隐蔽：
对同一棵子树报 `files=0 dirs=10 bytes_counted=0 **unreadable=0**` 且**退出码 0**
（`-ErrorAction SilentlyContinue` 把枚举失败吞成「这个目录是空的」，而 `unreadable` 只统计
`CreateFileW` 失败）。已补 `\\?\` 前缀 + `Stop` 分桶，修后报 `files=2032 dirs=12 logical=248933`，
与 1.1 逐位相同。

### 1.3 这套检查会红（变异证明，改的是 `D:\dc-tmp` 上的副本，正版未动）

| 变异 | 结果 |
|---|---|
| A：属性读取退回 `[IO.Directory]::GetAttributes` | `exit=2` `VERDICT=TOOL_BROKEN`，异常原样打出 —— 上一版那个伪装成 `denied=15` 的失败模式现在走不到吐数那一步 |
| B：摘掉 `\\?\` 前缀 | `exit=3` `INCOMPLETE` `files=0 dirs=11 denied=1 deepestPathLen=275` —— 撞死在 260 墙上，**出不了绿** |
| 真拒读对照 `C:\System Volume Information` | `exit=3` `denied=1` |

诚实登记：B 实际落在 `DirectoryNotFoundException` 分支（.NET 把超 260 报成「找不到路径的一部分」），
所以 1.1③ 那条 `PathTooLongException` 判据**没被这次变异打到**，不能算它已证。

---

## 二、第 2 道闸：三轴零残差

静止性：`m6-file-oracle.ps1` 对 `f100k` 连跑两遍，整行输出**逐字节相同**
（`files=100006 dirs=63 bytes=1033725042 reparseSkipped=0 denied=0 deepestPathLen=344 secs=2`）。

被验方 = **打包用的那份 release exe**，真点界面（`指定位置` → 填路径 → `开始深度扫描` →
`导出 JSON 报告`），走产品自己的 `dc_export_report` 落点。脚本 `scripts/m6-scan-gate-e2e.ps1`。

| 轴 | 独立口径预测 | release 报告 | |
|---|---|---|---|
| `files` | 100,006 − 10,205(SVI 子树) = **89,801** | **89,801** | ✓ |
| `dirs` | 62 − 1(SVI 本身) − 4(SVI 子孙) = **57** | **57** | ✓ |
| `totalBytes` | 1,034,053,928 − 1,319,088 = **1,032,734,840** | **1,032,734,840** | ✓ |

`denied / missing / busy / otherErrors` 全 0，`truncated=False`，`depth_capped=0`，
`deduped_hardlinks=0`（夹具无硬链接 ⇒ `bytes_counted == bytes_alloc`，字节轴才可比）。**零残差。**

三条不是"差不多"的口径约定，全部从代码读出，没有一条是试到绿为止：

- **±1 根**：`scan.rs:275` 只对**子目录** `counters.dirs += 1`，根自己从不计入 ⇒ 量具按「含根」跑就要减 1。
  `oracle.mjs` 文件头那句「扫描器的 dirs 计数器含根」写的是**已删除的 TS 实现**，对 Rust 侧不成立。
- **SVI 子账**：`accounting.rs:14` `SKIP_ALWAYS = [system volume information, dumpstack.log.tmp]`，
  命中即 `continue`（既不计数也不进入）⇒ 把量具再指到该子树跑一次，拿到的就是被排除掉的量
  （`files=10205 dirs=5 bytes_logical=1285990 bytes_alloc=1319088`）。
- **字节轴选哪一根**：导出的 `scan.counters.totalBytes` 是 `c.bytes_counted`（`service.rs:171`，
  分配大小 + 硬链接去重），**不是表观大小**；`tree.size` 同源（`report.rs:169`）。
  所以这一格只能与 `oracle-alloc` 的 `bytes_counted` 比。拿 `FileInfo.Length` 之和去比它，
  会凭空造出一条不存在的"漏算 314 KB"缺陷（1,033,725,042 − 1,034,053,928 那个方向）。

旁证（**不是我产出的，来源未认领**）：`src-tauri/dc-tmpscan100k.json`（10-14 23:42 落盘，tracked 文件里无人引用）
是内部 `ScanReport` 原文，`skipped_always=1`（正是 SVI 那一条）、`bytes_logical=1,032,439,052`
= 100,006 那棵减去 SVI 的表观和、`files=89801 dirs=57` 与本报告逐字相同。
本轮只把它当旁证，闸的依据仍是「两条独立 walk + release 报告」。

---

## 三、修掉一条真缺陷：`elapsed_ms` 是「你什么时候来取快照」的函数

`service.rs:182` 原写作 `elapsed_ms = now_ms() − started_at_ms`，**完成时不夹住**。后果分两层：

- 界面：`Home.tsx:307` 那句「扫描完成，用时 Xs」在扫描**停下之后还在往上走**；
- 报告：`report.rs:234-236` 的 `speed.{filesPerSec,bytesPerSec,dirsPerSec}` 全部由它派生
  ⇒ 同一趟扫描、先后两次导出，给三个不同的性能数。而 `report.rs:204` 那段注释声称的设计意图
  恰恰是「同一份输入两次导出逐字节相同」。

实证（修前，release）：真扫描 534 ms（内部 `ScanTree.elapsed_ms`），界面上截图那一刻读作「1s」，
**10 秒后点导出，报告里是 `elapsedMs=10348`**。于是那一格的三个性能数被**灌水 11 倍的分母**压掉：

| | `elapsedMs` | `filesPerSec` | `bytesPerSec` | `dirsPerSec` |
|---|---|---|---|---|
| 修前（完成后 10 s 才导出） | 10,348 | 8,678.1 | 99,800,429 | 5.51 |
| 修后（同一棵、同样隔 10 s 导出） | 938 | **95,736.67** | 1,100,996,631 | 60.77 |

判据 `service::preview_tests::elapsed_ms_freezes_when_done_but_ticks_while_running`：
两个时间戳**都必须钉在过去**（`started = base-10_000`、`finished = base-9_000`）——
第一版我写成 `started = now − 1000`，旧代码算出来也是 1000，**红不起来**；改钉过去之后
修前 `left: 10000 / right: 1000` 如预期红。反向半边同一条测试里钉着：`finished` 缺席时
必须仍随墙钟走（HUD 要活数）。

修后实证（同一棵 `f100k`，release）：`elapsedMs=938`。另一棵小夹具上隔 12 秒连导两次：

```
EXPORT1 t=+5s  elapsedMs=28 fps=107.14 bps=21650286 dps=71.43 files=3 dirs=2 bytes=606208
EXPORT2 t=+17s elapsedMs=28 fps=107.14 bps=21650286 dps=71.43 files=3 dirs=2 bytes=606208
```

逐位不变 ⇒ 报告重新变成"一趟扫描的函数"而不是"导出时刻的函数"。

---

## 四、界面上看见的两格不一致（第 1 格已修并复验，第 2 格登记未修）

1. **`扫描范围` 那格回显与实际扫的树不符。** 第 2 张截图里 `指定位置` 选中、框内是
   `D:\deepclean-fixture\f100k`；扫完应用自动跳空间地图，点回 `首页` 之后同一格变成
   `本地磁盘 Windows` 选中、输入框消失，而同一屏下方写着「扫描 89,801 个文件」。
   成因：`scope` / `custom` 是 `Home` 组件的局部 `useState`，跨视图切换即重建即丢。
   数字半边不受影响（报告与概览都按真扫的那棵树算），代价是用户会以为刚才扫的是 C 盘。
   > **同日已修（`useScan` 提层）。** 三格（选盘 / `drive`↔`custom` / 那行路径）连同算出来的
   > `startTarget` 一起搬到 `useScan` —— 它是 App 级单例（文件头那句"全应用只调一次"），
   > 本来就比页面活得久；`Home` 只做别名解构，JSX 一行没改。口径抽成纯函数
   > `resolveScanTarget(scope, customPath, driveRoot)`，判据
   > `tests/unit/scan-scope-ownership.test.tsx`（5 条）：三格不许住回 Home 那条是**读源码的结构闸**
   > （与 `commands.rs` 注册面判据、`analysis-engine.test.ts:374` 同先例），拿改前的 `Home.tsx`
   > 跑四条判据**全部命中**、改后全部不命中 ⇒ 会红。诚实边界：本仓**没有 React 挂载设施**，
   > 所以这半挡得住"字面量搬回去"，挡不住"在别的组件里另起一份 state"。
   > 复验在**重打包后的产物**上（`m6-fix-*.png`）：回首页后 `指定位置` 仍是选中态、
   > 框里仍是那行路径（`STEP scope_still_custom=OK value=D:\deepclean-fixture\f100k`），
   > 三轴 `89,801 / 57 / 1,032,734,840` 逐字复现。
   > 顺带撞出两个 harness 缺陷并修掉：① 截图前"顶窗"其实顶不起来 —— Windows 的**前台锁**拒绝
   > 后台进程 `SetForegroundWindow`，第一次拍（那之前没有任何真鼠标点击）拍到的是别人家的窗口，
   > 而后几张因为前面的点击合法拿到了前台，所以一直没暴露；改用 `SwitchToThisWindow` + 五轮
   > 现读前台句柄，并把"不在最前就拒收这张图"变成硬闸（第一版就是这条闸把问题抓出来的，
   > 放宽判据是错的方向）。② 闸脚本自己的截图名也没带前缀，会把 §4.1 的"修前"证据盖掉，
   > 已补 `-Prefix`（同一个毛病本轮第三次犯，见 §九）。
2. **导出报告的 `errors.skipped` 不含名字跳过。** `service.rs:176` 那个 `skipped` 是
   `denied+missing+busy+otherErrors` 之和（=0），而 SVI 确实被跳掉了 10,205 个文件 ——
   `skipped_always` / `skipped_reparse` / `depth_capped` 只在内部 `ScanReport` 里有，
   线上那份没有。审计者若按「skipped=0 ⇒ 什么都没跳」读，会对着 10,205 的差去找一个不存在的漏扫。
   没修的理由：这个形状是与已删除的 TS 侧 `buildErrors` 逐字对齐的那一份（`parity-gate.mjs` 钉着），
   动它是破线上契约，不是修判据。要动就单独走一批，连 `parity` 一起重对。

---

3. **「用时 0s」—— 由 §三 那条修复暴露出来的显示层毛病（登记，未修）。**
   修前 `elapsedMs` 被灌水成 10,348，界面那句读作「用时 1s」，看着正常；修后拿到真值 333 ms，
   `shared/format.ts:39` 的 `formatElapsed` 只做 `Math.round(ms/1000)` ⇒ 亚秒一律说「0s」。
   数字是真的，话说得像坏了。没顺手改的理由：`shared/format.ts` 是 TS↔Rust 两侧的**共享基准层**
   （`ScanHud` 那格同源），动它的输出形状要连基准那侧一起重对，不是改一行文案。
   建议的形态是亚秒给「0.3s」，归下一批与 §4.1 一起做。

---

## 五、截图泄密面：本轮把两个脚本的裁图改回 DWM 真实帧，并重拍了全部证据图

**这条是我自己今天制造的问题。** `Shot()` 那套按 UIA `BoundingRectangle` 裁的写法，
含 DWM 的透明投影边（实测每边约 9 px：1792×1153 → 1774×1144），于是**左边一条别的窗口的字、
下面一截 IDE 状态条**会被一起拍进验收图 —— 而截图是要进版本库的。
`m5k-cleanlog-e2e.ps1:119` 早就把这条写明并修过（"截图是泄露面 —— 桌面内容不许跟着进版本库"），
我却在文末「没做 / 代价」那条里把同一个现象当"新结案"报了一遍，还在两个脚本里重新引入了它：
本轮提交的 `m6-gate-1..4.png` 与 `m5b-rel-01..03.png` 第一版都带着聊天面板与状态条的像素。

处置：`lib-dc-release.ps1` 里加共享的 `Save-DcShot`（按 `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`
裁，拿不到就 `Write-Warning` 说明这张可能带进别人的窗口；沿用 m5k 那套已在别的窗口上验过的 P/Invoke，
类型名错开成 `DcFrameRect`/`DcWinFrame` 以免与 m5k 的无条件 `Add-Type` 撞名），
`m6-scan-gate-e2e.ps1` 与 `m5-preview-e2e.ps1` 都改成调它，**全部证据图重拍**
（重拍后 `m6-gate-3-done.png` 里左缘与底缘已无外来内容）。
闸与链同样复跑通过：三轴 `89,801 / 57 / 1,032,734,840` 逐字复现、`REL_EXIT=0`、盘上 4×5,242,880 一字未动。

**没处理的一半**：带泄露的第一版仍在 git 历史里（`95db246`、`ea217d6`）。本分支**从未推送**，
所以重写历史的代价只在本地；要不要抹（`filter-branch`/`replace` 属破坏性操作）等用户点头，不擅自动。

顺带修掉 helper 自己的两个缺陷（都是这轮真撞出来的）：
① 在返回前 `throw` 会把**它自己起的**进程漏在盘上（调用方的 `finally` 还没拿到句柄，
本轮就漏了一个 pid 8640）⇒ 加 `trap` 自杀再抛；
② 点完「指定位置」只睡 700 ms 就判"有没有输入框"，机器忙时假报切换没生效 ⇒ 改成 12 秒条件等待，
期间顶窗重点一次。

---

## 六、顺手抓到一条**真掉了**的规则：CSS 注释里的 glob 把 `.dc-brand` 吃了

`src/renderer/styles/global.css:238` 那段说明里写着 `out/**/*` —— 而 `**/` 里就含 `*/`，
**CSS 注释在 238 行中途闭合**，后面整段中文散文被 esbuild 当选择器读。构建只留一行
`[WARNING] Unexpected "`" [css-syntax-error]`，`npm test` 1092 条与 `tsc` 0 条**零红**。

代价不是"一条噪声警告"。把两份构建的产物按规则切开逐条 diff（275 条里只这一条不同）：

```
BEFORE: *` 与 * `package.json`，`build .dc-brand{display:flex;align-items:center;padding:…;flex:none}
AFTER:  .dc-brand{display:flex;align-items:center;padding:…;flex:none}
```

浏览器按 CSS 错误恢复把整条判无效 ⇒ **00:37 那个包里 `.dc-brand` 的四条声明一条都没生效**。

**先更正我中途说重的一句**：当时我推断"这解释了截图左上角那颗图标为什么看不见"—— 错了。
`App.tsx:115-119` 记着 2026-10-09 你点名把品牌图标删掉、只留字标，**那一行本来就没有图标**。
按截图量的实际代价是：字标从贴角回到 `padding: 8px 6px 16px` 的位置、侧栏导航整体下移约 17 px
（= 那 16 px 下内边距）。是**侧栏顶部节奏差 16 px**，不是"界面坏了"。

处置：措辞改成「`out/` 整棵」绕开 `*/`（全仓 CSS 已 grep，含 `**/` 的只此一处）→ 重打 →
`css-syntax-error` 归零 → 在**新包内那份 exe** 上复跑闸（§2 三轴逐字复现，`elapsedMs=677`、
界面同读「扫描 89,801 个文件 · 共 984.9 MB」）。

一条流程账：闸脚本按固定文件名写截图，重跑把"修前"那张覆盖了 —— 前态这轮只能从对话回看。
下次做前后对比要先给图改名（`-Shot` 参数化），别指望文件名能同时存在两态。

---

## 七、闸怎么复跑（三步，可重放）

```bash
cd src-tauri && source ../scripts/rust-env.sh
export TMPDIR=/d/dc-tmp TMP=/d/dc-tmp TEMP=/d/dc-tmp   # C: 只剩 3.7 G，dlltool 会在那儿假报代码错
cargo build --release

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/m6-file-oracle.ps1 -Root 'D:\deepclean-fixture\f100k'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/m6-file-oracle.ps1 -Root 'D:\deepclean-fixture\f100k\System Volume Information'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/oracle-alloc.ps1  -Root 'D:\deepclean-fixture\f100k'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/oracle-alloc.ps1  -Root 'D:\deepclean-fixture\f100k\System Volume Information'
# 两条量具都必须 exit 0（INCOMPLETE / TOOL_BROKEN 一律没有归因资格）

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/m6-scan-gate-e2e.ps1   # 前置会拒绝残留实例
```

---

## 八、包本体的静态核对（不装机就能验的那几格）

装机要 UAC，所以先把**不装机就能定下来的**都定掉。依据是留在盘上的生成脚本
`src-tauri/target/release/nsis/x64/installer.nsi`（937 行，`makensis` 的输入，比读二进制权威）。

| 格 | 读数 | 判 |
|---|---|---|
| `!define` 落位 | `MANUFACTURER="TihiroKano"`、`INSTALLMODE="perMachine"`、`BUNDLEID="com.deepclean.app"`、`VERSION="0.1.0"`、`MAINBINARYNAME="deepclean-app"` | 昨天那三条拍板全部进了脚本 ✓ |
| 执行级别 | `RequestExecutionLevel admin`（perMachine 那支） | 装必然弹 UAC，不是静默改系统 |
| 注册表面 | 只写 `HKLM\...\Uninstall\DeepClean` 与 `HKLM\Software\TihiroKano\DeepClean`；卸载分支里 `DeleteRegKey` 同两把 + 清一条 HKCU `Run`（**只删不加**，产品没开自启） | 足迹可撤销 |
| 包内文件集 | 把 `File` 那两行的产物（`deepclean-app.exe` + `WebView2Loader.dll`）单独拷到 `D:\dc-tmp\pkgroot` 起进程 ⇒ **窗口正常出现** | 产物不依赖构建树 ✓ |
| 图标 | 包内 exe 的图标 SHA 前缀 `a9a230cd` **等于** `src-tauri/icons/icon.ico`；安装包自己是 `62b78d23` = NSIS 默认那枚（`INSTALLERICON ""`） | 见下 |
| WebView2 | `INSTALLWEBVIEW2MODE "downloadBootstrapper"` + `WEBVIEW2INSTALLERARGS "/silent"` | **目标机没有 WebView2 运行时时，安装过程要联网找微软下**；本机有运行时所以这一步会被跳过。（10-16 已按裁定改成 `offlineInstaller`，见 §十） |
| 空着的三格 | `LICENSE ""`、`COPYRIGHT ""`、`HOMEPAGE ""` ⇒ ARP 里没有发布者网址与版权，安装向导没有许可页 | 内容只能由作者给，**不代填** |

**没做的一条隔离实验（结论有用）**：想验「全新安装的用户第一次打开」，试过把进程的
`%APPDATA%` 指到空目录再启动 release —— **不生效**。Tauri 的 `app_data_dir()` 走
`SHGetKnownFolderPath`，不读环境变量（同一发实验里 `LOCALAPPDATA` 那半边倒是被 WebView2 读了，
所以覆盖"看起来成功"而数据仍落在真目录 —— 这类半生效比全不生效更容易骗过判据）。
`DC_LICENSE_DIR` / `DC_SETTINGS_DIR` 两个覆盖点都按 `#[cfg(debug_assertions)]` 编译，
打包版拿不到（这是 M4 定的规矩，不是漏配）。⇒ 这一格要么改真目录（把
`%APPDATA%\com.deepclean.app` 临时挪走，动的是开发状态，没批准不做），
要么给 release 留一个受控的 `--app-data-dir` 之类的入口。**登记为未验，不写成通过。**
调试态那条链本身已在 2026-10-11 用 `DC_LICENSE_DIR` 跑过「首启 → 投递清单 → 真码激活」的次序。

---

## 九、S4b：执行链在真机上又跑通了一次（debug 态 + 唯一授权靶场）

补 §六 里那句"修完之后真机上一次删除都没跑过"的账。跑的是 `scripts/m5k-cleanlog-e2e.ps1`：
它自己造种子（3 × 4096 B 落在 `%USERPROFILE%\Desktop\DeepClean删除测试\target\envroot\TEMP`）、
走完整 UI 链（指定位置 → 扫描 → 全选可清理项 → 我了解 → 确认预估 → **开始清理** → 清理记录）、
事后按三条独立坐标对账。用的是今天 22:43 重出的 debug 产物（含 `47fe9c5` 的回执修复）。

`M5K_EXIT=0`，10 条判据全 PASS：

- **A 磁盘**：3 个种子都没了；回收站条目数 **+3**（走 Shell COM，不读 `task.deleted[].ok`）。
- **B 日志**：本轮新增 5 行，有且只有一对 `start`/`end`，每个被删路径各一条 `status=success`，
  结尾 `success=3 failed=0 refused=0 cleanedSize=12288 actualFreedBytes=12288`，时间戳是今天本地时间。
- **C 界面**：记录页页脚给的是真路径（含 `deepclean.log`），那句「没能确定日志文件路径」不再出现，
  且记录页点名了同一批 3 条。

**边界必须说清**：这一跑只能在 debug 态做 —— 把规则领地指向靶场靠的是 `DC_ENV_ROOT`，
它按 `#[cfg(debug_assertions)]` 编译（`service.rs:421` 明写"打包版拿不到它"；且
`SYSTEMDRIVE`/`WINDIR` 刻意**不**重定向，免得把 §16 那道结构闸搬进沙箱里自证通过）。
⇒ **「release 上真删过一次」这句话今天仍然没有证据，而且按设计就不会有** —— 除非拿用户真缓存
去点删除，那没获批准、也不该做。目前能给的 strongest 表述是两句拼起来：
*交付物上的确认链与灰灯修复已在 release 上验通（§六 那张「开始清理」是蓝的），
而"点下去真删、删了有账"在 debug 态的授权沙箱里验通。*

证据图 `assets/m5k-1015-executed.png` / `m5k-1015-journal.png`（按 DWM 帧裁，无外来像素）。
10-13 那两张 `m5k-01/02.png` 本轮被覆盖过 —— 已还原，并给脚本加了 `-Prefix`，
让"复跑不许顶掉旧证据"变成参数而不是记性。

---

## 十、10-16 落地的四条决定（离线可装 / 不签名 / 版本号 / 发布者字段）

用户裁定四条，逐条落到位并现验：

| 决定 | 落地 | 现验到的东西 |
|---|---|---|
| **「在线激活是幌子，但联网检测要真生效」** | 产品语义**不动**（不做离线激活）；改为去证明那道闸不是装饰 | `m4-license-e2e.ps1` 五相 `M4_EXIT=0`：D 相 `DC_LICENSE_NET_FORCE=down` ⇒ 界面给出 `E_LICENSE_NO_NETWORK`；E 相 `blocked` ⇒ `E_LICENSE_NET_BLOCKED`（三个探测端点逐个点名）。且 `netprobe.rs:146-148` 写明这个口子**只能把判定变严、没有 `online` 取值** ⇒ 没有"强制放行"的后门 |
| **版本号保留现状** | 三处仍是 `0.1.0` | 与 spec `DeepClean_Tauri重写计划书.md:39` 写的「V1.0」**不一致，是有意的**：M6 那一格按 0.1.0 发，V1.0 留给以后 |
| **「setup 断网也要能装」** | `bundle.windows.webviewInstallMode = { type: "offlineInstaller", silent: true }` | 重新生成的 `installer.nsi` 里 `INSTALLWEBVIEW2MODE "offlineInstaller"`、`WEBVIEW2INSTALLERPATH` 指向已下载的 `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` ⇒ 运行时**在包里**，不再依赖目标机联网。**代价：安装包 4,851,016 B → 221,878,005 B（4.6 MiB → 212 MB）** |
| **「要填就写 TihiroKano」** | `bundle.copyright = "© 2026 TihiroKano"`、`nsis.installerIcon = "icons/icon.ico"` | 安装包版本资源 `LegalCopyright=© 2026 TihiroKano`；安装包图标 SHA 从 NSIS 默认那枚变成与 `icons/icon.ico`、包内 exe **三处一致**（`a9a230cd`）。ARP 里的 Publisher 一直是 `TihiroKano`（`!define MANUFACTURER`）。**`license` 与 `homepage` 留空**：前者 schema 要的是许可证标识符（选哪个许可证是法律问题），后者要一个真实 URL —— 两样都不能替你编 |

签名按裁定**不做**，`Get-AuthenticodeSignature` = `NotSigned`。

顺带结掉一笔自己欠的债：闸脚本里那份**内联**的「起应用→填路径→开扫→等跳图→回首页」与
`lib-dc-release.ps1` 是同一件事的两套实现，上一轮只修了 helper 那份（radio 之后改条件等待），
结果闸脚本自己因为还睡 600 ms 红了一次。这次删掉内联那份（−3238 字符）改调 helper，
并给 helper 加截图钩子保住中途那两张图。合并过程又撞出两个真问题，都修了：
① 钩子在 helper 内触发时调用方的 `$script:Hwnd` 还没赋值 ⇒ 句柄为 0 ⇒ 裁图失败，
而 `Save-DcShot` 的兜底竟是**退回整屏**（正好是本轮要消灭的泄露形态）⇒ 改成"拿不到 DWM 帧就拒绝出图"，
并把句柄/窗口对象随钩子传出去；② 第一次拍照前窗口从未获得前台（min/restore +
AttachThreadInput 仍会输给 IDE），最后一档改成**把一次真实点击落在标题栏**上
（那是应用的拖拽区，单击无副作用），前台锁即放行 —— 四张图现在全部 `foreground=True`。

合并后在**离线包内那份 exe** 上复跑第 2 道闸：`GATE_EXIT=0`，三轴 `89,801 / 57 / 1,032,734,840`
逐字复现，`scope_still_custom=OK`，四个错误桶全 0。

---

## 十一、没做 / 代价

- **安装包已打**（两道闸都过之后才动手，并随每次产品改动重打）：
  **当前这份（10-16 17:52，离线可装）**：`src-tauri/target/release/bundle/nsis/DeepClean_0.1.0_x64-setup.exe`
  **221,878,005 B（212 MB）**，SHA-256 `fe9e4970b494468935fe12b1ce71dbdadce20bb7776046d50f2c533e588b561a`；
  包内 `deepclean-app.exe` 25,002,421 B，SHA-256 `10e99f0114bf590956316869c4cf66be0fb88b46e9aeca091e643e5a928da83d`。
  上一份（10-15 23:22，4,851,016 B / `23dfce64…`）的包内 exe 是 `11a1367e…`。
  `Get-AuthenticodeSignature` = **NotSigned**（按"不买证书即不签"那条拍板）；包内 exe 资源里
  `longPathAware` 2 处、~~`level="asInvoker"`~~、comctl v6 各在 ⇒ 3b1f93e 那一格没被打包过程弄丢。
  > ⚠️ **2026-10-25：`asInvoker` 那格已过期。** 应用清单改成 `requireAdministrator`（启动即提权，
  > 裁定与代价见 `2026-10-12-tauri-m5-h.md` §2 的订正）。**上面这份 221,878,005 B 的 setup.exe
  > 仍是改之前的旧产物，包里那份 exe 还是 `asInvoker`** —— 要分发必须重打并在这份包内 exe 上
  > 复验「`requireAdministrator` 在、`asInvoker` 不在」。`longPathAware` 与 comctl v6 两条不受影响。
  五份的先后：`00:37`（带 §六 那条 CSS 缺陷，`.dc-brand` 整条没生效）→ `00:45`（§四.1 修前）
  → `23:22`（两条都修完）→ `17:47`/`17:52`（§十 那四条决定落地）。
  **每份都在它自己的包内 exe 上复跑过第 2 道闸**，三轴逐字相同。
  **安装本身没做** —— `installMode=perMachine` 要 UAC，那一步单独等点头。
- 闸跑在**装进包里的那份**上，不是先前那次 `cargo build --release` 的产物：`tauri build` 会带
  `custom-protocol` 重编（exe 25,004,494 → 25,002,169 → 25,001,927 → 25,002,421 四个尺寸），
  所以 §2 那张表在 00:37 与 00:45 两份产物上各复现了一遍。
- 版本三处一致（`package.json` / `tauri.conf.json` / 8 个 crate 全 `0.1.0`），分支名 `v0.7` 是计划批次号不是产品版本 —— 按 0.1.0 发。
- `.rsrc merge failure: multiple non-default manifests` 告警仍在（归「零告警」那一格，长路径那一格已由 3b1f93e 结清）。
  本轮另有一条**先前就有**的告警：`cleanlog.rs:41` `path` / `is_broken` 两个方法 dead_code。
- §4 那两格只登记未修；`oracle.mjs` 文件头那句「扫描器的 dirs 计数器含根」也仍然对 Rust 侧失真，
  本轮只在 §2 里点名，没去改那条注释（改它要连它自己的历史结论一起核）。
- ~~面板排版的肉眼债只还了首页两态；🟠 清理面板那一格仍未看过，而且这轮把它为什么还不上查清了……~~
  **这句今天写下去当天就被推翻**：`2026-10-14-tauri-m5-p3.md:138` 明写
  「🟠 面板的排版**第一次被眼睛看过**：徽章 / 三列数字 / 长 `description` 都不叠字不溢出」。
  我没读那份文档就照记忆写"仍未看过" —— 那条记忆是 10-14 上午的半截，当天下午债就还了。
  真实的边界换成这一句：那份肉眼证据是在 **debug 产物**上取的，而
  `scripts/m5-preview-e2e.ps1` 靠 dev-only 的 `DC_AUTOSCAN`（`main.rs:99` 的 `#[cfg(debug_assertions)]`）
  起扫描 ⇒ release 态**结构上跑不了**，所以「打包版上 🟠 面板画得对」确实没有证据，
  但原因是**缺一条 release 驱动通道**，不是"从来没人看过"。
  14 个 e2e 脚本里 **13 个**都吃这个变量 ⇒ M6 之后整面真机验收脚本悄悄变成 debug-only，是个系统性问题。
  **本轮已把出路做出来**：`scripts/lib-dc-release.ps1` 提供 `Start-DcReleaseApp -App -ScanRoot [-BackHome]`
  （驱动界面：指定位置 → 真点 → 等扫完），debug / release 同一条路，且**不给 release 开任何新口子**
  （`DC_ENV_ROOT` 那些按 debug 门控是故意的，把它们放进 shipped 二进制是安全面）。
  第一个迁过去的是 `scripts/m5-preview-e2e.ps1`，**在打包版上跑通**（`REL_EXIT=0`）：
  dup 夹具 → 勾那一组 → 去清理页 → 确认预估 → 回执，全程零删除，跑完逐名点名盘上四个文件
  字节数原封不动（5,242,880 × 4）。证据图 `assets/m5b-rel-01-preview.png` / `-02-confirmed.png` /
  `-03-receipt.png`，三件值得点名的：① **「开始清理」那颗在 release 上是蓝色可点的** ——
  P3 那轮它是永久灰，这是执行链修好在**交付物**上的第一张视觉证据；② 回执指纹
  `cd20f1409359a156` 与 P3 文档记的那枚（debug 态、同一棵夹具）**逐字相同**；
  ③ 🟠 面板（徽章 / 三列数字 / 四色分账 chip / 「确认前请逐条看完」那块）在 release 上排版正常。
  脚本另加 `-Prefix`：默认 `m5b-` 那几张是 P3 正在引用的证据图，换构建跑必须改前缀 ——
  本轮真的发生过一次覆盖（release 跑把 `m5b-FAIL.png` 盖了，而 `2026-10-14-tauri-m5-p3.md:137`
  正拿它当"回执在画面下方"的证据），已从 HEAD 还原，并把"同一条命令不许覆盖别人的证据"做成参数。
- **P3 那条未定性观测已结案，且结论与我和 P3 的猜测都相反的方向被排除了。**
  `2026-10-14-tauri-m5-p3.md:140` 记着「两张图窗口左缘有一列被裁掉一半的汉字，没查是横向溢出还是越界」，
  本轮 4 张图同样有、字形还每次不同。这次用**几何**判掉：把窗口从 `BoundingRectangle=(195,150)`
  挪到 `(620,120)`，各裁一条「以窗口左沿为中心 100×420」的横带
  （`D:\dc-tmp\edge-a-at-default.png` / `edge-b-at-moved.png`）。结果：
  两处裁到的**字完全不同**，挪位后那张能直接读出「m5b」「把文档里那」「工具 4 次」——
  那是当时开在后面的**这个对话的聊天面板**，且它压在白底上、应用侧栏是深蓝。
  ⇒ **应用侧没有左缘溢出，也不是绝对定位越界**；真正的问题是
  **UIA `BoundingRectangle` 的左沿不等于窗口可见左沿**（差约 40-55 px），
  所以 `Shot()` 那套 `CopyFromScreen` + 按 UIA 矩形裁的写法，**每张图都裁进了一条别窗口的像素**。
  这条对验收的后果比"有没有溢出"更重：凡是拿这些图判过"叠字/溢出/压按钮"的结论，
  边缘那一条都不算证据（本轮 §4.1 与 §六 的判读都避开了那一条，属侥幸）。
  具体是 DWM 扩展帧、还是透明投影边距，**没继续定位**；要收口得把裁图改成按
  `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` 或按实测内缩量，
  登记为 harness 的待办（不是产品的）。
- **10-16 已定三条**（见 §十）：安装包图标换成我们那枚、`copyright` 写 TihiroKano、
  WebView2 改 `offlineInstaller`（代价 4.6 MiB → 212 MB）。
  **仍只等作者两格**：`license`（要的是许可证标识符，选哪个许可证是法律问题）与
  `homepage`（要一个真 URL）—— 这两样不能替你编。
- **10-17：§五 那格泄露从"改了脚本"升级成"有一条闸"** —— `scripts/shot-leak-gate.mjs`
  扫 `docs/acceptance/**/*.png` 的 IHDR，宽度 >1900 且不在 `ALLOW_LIST` 里的图一律 `exit 1`；
  判据挂在 `tests/unit/shot-leak-gate.test.ts`（进 `npm test`，不是只挂在人记得跑的手动命令上）。
  仓内 79 张 tracked PNG 全扫一遍，>1900 的**恰好只有** §五 记的那三张历史整屏图
  （`m3b-preview-20261011-113557/113930`、`m4-electron-no-license-card`，都是 2160×1440），
  它们进白名单是因为撤图等于撤 M3-B / M4 的证据，那是单独一格决定（计划 §待决 5）。
  **反证两趟**：① 阈值压到 100 ⇒ 点名 73 张且退出码 1（证明扫描不是恒空、失败路径真的红）；
  ② 把一张 2160 宽的图**换个新名字**放进 assets ⇒ `LEAK …/tmp-leak-probe.png 2160x1440 count=1`
  ⇒ 证明白名单是按文件名的、不是一条"凡是 2160 都放过"的形状规则，新增整屏图照样拦得住（探针图当场删掉）。
  顺带一条**推翻计划前提**的实测：计划假设"1900 分得开窗口与桌面"（窗口 1774 / 桌面 2160），
  但 `GetForegroundWindow` + DWM 扩展帧当场量到 **1987 px 宽的合法窗口** —— 所以 1900 会误报。
  处置是**只把它留在提交闸这一侧**（误报方向安全：重拍窄一点或明写理由进白名单），
  而按计划原本的想法把它放进 `Save-DcShot` 写入口那一版**试了、撤了** —— 写入口一 throw 就把
  e2e 整棒打断，误报的代价在那一侧是不可接受的。
