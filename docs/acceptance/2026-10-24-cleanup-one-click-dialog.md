# 2026-10-24 一键清理：按勾选清理 + 过程弹窗

**一句话结论**：人类伙伴报告「点击清理无法清理，点击没反应」。根因是**两道闸叠在一起**——
设置页的免确认开关（本机默认关）与「授权根取扫描根」（扫盘根时守卫整批拒绝）。
按当天四条裁定改完：一键清理去掉开关、只清勾选内容、永久删除、与手动档合并成一颗，
并新增逐条滚动的过程弹窗。真机 e2e 全链通过：5 个种子文件删成 0，弹窗列表逐条滚、
进度条 0%→100%、完成行报「共释放 40.0 KB」，截图落 `assets/clean-dialog-done.png`。

**同日下午第二轮**（人类伙伴真实删除测试后的四条反馈，见文末「附」）：
① 删除前加确认提示（弹窗内「确定，开始清理」）；
② 删除加速 —— 根因是**每个文件单独调一次 `SHFileOperationW`**（shell 层固定开销），
修法为**按批次并发**（每批一条线程，共享取消与进度计数）；
③ 清理后统计带数值不变 —— 根因是预览读扫描时的**不可变快照树**，修法为
`Session.deleted_paths` + `FilteredSource`（报告层摘掉已删文件）；
④ 弹窗滚动卡顿 —— 列表改截尾渲染（只画最近 60 行）+ 自动滚底。
四条全部真机探针验证，见「附」。

---

## 1. 现象

人类伙伴原话（当天三条，逐条对应下面的修法）：

1. 「点击清理无法清理，点击没反应」；
2. 「点击清理后出现弹窗显示清理的文件列表（类似扫盘时出现的文件列表一样）下方是清理进度条
   （百分比），完成后提示清理完成释放 XX 空间」；
3. 后续裁定：「一键清理去掉开关，逻辑改一下，点击后只清理勾选的内容」；
   「删除进回收站还是直接删」→ 选**永久删除，不进回收站**；
   「页面底部那套确认预估 → 开始清理还留吗」→ 选**合并成一颗**。

## 2. 根因（读代码读出来的，不是猜）

### 闸一：设置开关，且拒绝提示滚在屏幕外

旧版「一键清理」的总闸是设置里的 `autoCleanEnabled`（默认关）。本机
`%APPDATA%\com.deepclean.app` 下**没有** `settings.json`，开关按关处理。点按钮时
`Cleanup.tsx` 只 `setAutoError(...)` 后 `return` —— 那句提示渲染在列表下方的滚动区域之外，
用户看到的就是「点了没反应」。

### 闸二：授权根取扫描根，盘根整批拒绝

`ConfirmedPlan.authorized_root` 取**会话扫描根**。首页默认扫的就是盘根（`C:\`），
而 `guard_authorized_root` 对盘符根一律回 `root-is-drive-root` ⇒ **整批拒绝、零删除**
（M3-C 验收文档写着「这是刻意的，不是缺陷」）。所以即使开关开了，扫盘根时也一个文件都删不掉。

两件事叠在一起 = 「点了清理一个文件都没动」。

### 附带确认：公共祖先这条路走不通

最初按「授权根改成清单的公共祖先」设计，先算了真实数据的形状：
`%TEMP%` 在 `C:\Users\…` 下、`%PROGRAMDATA%` 在 `C:\ProgramData` 下，
**真实清单的公共祖先就是 `C:\` 本身** —— 取公共祖先等于什么都没改，照样撞 `root-is-drive-root`。
与人类伙伴确认后改成「按每条规则自己的地盘分批删」（见 §3-B）。

## 3. 改动

### A. 执行器：逐条进度注入面（`crates/cleaner/src/executor.rs`）

- 新增 `CleanProgressEvent`（path / ok / bytes / done / total / cleaned_size）与
  trait `CleanProgress`。与 `CleanLog` 同一位置、同一条纪律：**只观测、不判定**，
  没挂就整段跳过，不参与任何一道闸、不算进六个计数。
- `ExecuteCtx` 加 `progress: Option<Arc<dyn CleanProgress>>` 与 `with_progress`。
- 四条结局路径（文件成功/失败、目录成功/失败）在账本与日志写完、`cleaned_size` 加过之后
  各报一次 `report(...)` —— 报的是**已发生的事实**，不是打算。
- `ExecuteCtx` 加 `with_cancel_flag`：一次任务跑多批，取消标志由 `execute_plan` 建、逐批注入，
  「取消」对全部批次生效（旧版每批一个自己的标志，取消只停得下正在跑的那一批）。

### B. 服务端：按勾选清理 + 分批授权根（`src-tauri/src/service.rs`）

- **`run_auto_clean` 改口径**：不再读设置开关、不再用固定名单 `AUTO_CLEAN_RULE_IDS`。
  名单由渲染端报（`selection.items` 的 ruleId + `tilePaths`）。边界没松：
  渲染端报的仍只是「勾了哪几条规则」，**路径清单照旧由服务端从报告里取**
  （`executable_batches` 读 `RuleFinding.all_paths`），渲染端一个字节的清单都插不进来；
  勾选照旧过 `build_preview_model` 的全套判据（🔴 不可勾、只上报根逐条拒、越界拒）。
- **档位**：新增 `required_tier_for_selection` —— 先跑一趟不带确认的预览，
  按「已计入项里的最高档」取档（与 `confirm::required_tier` 同口径），再带这个档做内部 confirm。
  不再固定 High（固定 High 是过度授权）。
- **`ConfirmedPlan` 从「一个授权根 + 一张清单」改成 `batches: Vec<CleanBatch>`**，
  每批 = 一条授权根 + 一批路径。分组键是**规则自己的地盘**
  （`RuleFinding.matched_roots` 里最深的命中根，逐路径勾选按「包住它的最深根」归组）。
  授权根取匹配根本身，**不取父目录**：父目录（如 `%LOCALAPPDATA%`）套着只上报根
  `%LOCALAPPDATA%\Packages` 与 `%LOCALAPPDATA%\Programs`，会被
  `root-ancestor-of-forbidden` 整批拦下。取地盘本身既非盘根、又不套保护路径。
- **`execute_plan` 按批执行**：每批跑一次执行器（授权根不同，执行器契约「一次执行 = 一个授权根」
  一个字没动），最后 `merge_tasks` 并成一个任务：counts 相加、progress 按**全部计划**重算、
  status 按「任一批 cancelled ⇒ cancelled；全部 refused ⇒ refused；否则 completed」、
  blockers 按 reason+detail 去重、§19 验证按「各批前后之和」且 note 重写成多块口径。
- **取消把手全程在**：`execute_plan` 开头先把带共享标志的占位 ctx 塞进 `state.running`，
  换批只换 ctx、键不变 —— 修掉了「恰好在换批那一瞬间点取消拿到 false、后面几批照旧开跑」的窗口。
- **进度事件**：新增 `dc://clean-progress`（`CLEAN_PROGRESS_EVENT`），载荷
  `CleanProgressWire`（taskId / path / ok / bytes / done / total / cleanedSize）。
  `EventProgressSink` 做两级节流：**每 40 ms 或每 64 条里先到的那一个**，
  `done >= total` 永远放行。跨批次时 `done` 回绕 ⇒ 把上一批总数累进 base，
  报出去的 done/total 是**全任务**口径，与 `merge_tasks` 的分母同一个数。
- 旧固定名单与进程闸（`AUTO_CLEAN_RULE_IDS` / `auto_clean_selection` /
  `auto_clean_app_cache_paths` / `running_process_segments`）**保留但挂 `#[allow(dead_code)]`**：
  它们是「在跑应用的缓存不删」这条判据的唯一实现与可测入口（有单测钉着），
  迁移到勾选链上的活未做，代码里注释标了迁移点。

### C. 设置字段收口（`src-tauri/src/settings.rs` + `shared/settings.ts`）

`auto_clean_enabled` 从结构、清洗、读写、线形状测试四处一起删掉。老用户的
`settings.json` 里若还留着 `autoCleanEnabled`：读时**被忽略**（不认识的键不进结构）、
写时**被丢掉**（整份重写）。Rust 侧补了三条判据：老文件带已删字段读得动、
`save_settings` 收到旧调用方的 `{autoCleanEnabled:true}` 不报错不落盘、文件里不留残留键。

### D. 命令层（`src-tauri/src/commands.rs`）

`dc_auto_clean` 签名改为 `(scan_id, selection, tile_paths)`，转发给新的
`run_auto_clean`。`dc_execute`（手动档执行入口）保留不动 —— 服务端那条
digest → ConfirmedPlan → 执行的链原样在，只是界面上不再有单独的手动入口。

### E. 前端（`src/renderer/`）

- **`Cleanup.tsx`**：
  - 删掉手动档整块（🟠 高风险清单 / 「确认预估」/「开始清理」/「取消清理」/ 确认回执显示），
    删掉 `canExecuteReceipt` / `BLOCKER_LABEL` / `requestConfirmation` 消费。
  - 「一键清理」按钮：去开关门，`onClick` 直接 `runAuto()` ——
    选区 = `selected.map(ruleId => ({ruleId}))` + `tilePaths`，先 `setDialogOpen(true)` 再 invoke。
    禁用条件收敛为四个：扫描没完成 / 正在清理 / 保护未落地 / 零可清理，title 各有说法。
  - 新增 `CleanProgressDialog`（挂在 `Portal`）：订阅 `onCleanProgress` 滚列表、
    `onCleanEvent` 的 done 出「清理完成，共释放 XX」。任务 id 由**第一条事件认领**
    （`dc_auto_clean` 同步删完才返回，等 `task` 回来再渲染会错过全部进度）。
    订阅用 `useLayoutEffect`（早于 invoke 的 Promise 链），行缓冲在 effect 闭包外、
    `requestAnimationFrame` 逐帧灌入（React 18 批处理会丢快速批里的中间行），上限 400 行。
  - `TaskPanel` 保留在页面上（清理后的 §19 验证仍显示）。
- **`Settings.tsx`**：开关那格删掉。现在这一页**没有设置控件** —— `dupMinSizeMb` 的读者
  （重复文件检测）已随 `dupes` crate 下线，`autoCleanEnabled` 随本次删掉；
  读写通道先留着，但「没有读者的控件不画」（这一页立身规矩的原话）。
- **`tauri-bridge.ts`**：`runAutoClean(scanId, selection, tilePaths)` 换签名；
  新增 `onCleanProgress`（`dc://clean-progress`）。
- **`shared/types.ts`**：新增 `CleanProgressEvent`；`DeepCleanApi.runAutoClean` 换签名。
- **`shared/settings.ts` / `shared/constants.ts`**：删字段与对应注释，通道注释改口。
- **`usePreview.ts`**：删 `requestConfirmation`（界面不再单独走确认那一步）。
- **`App.tsx`**：dev 脚手架 `window.__dc` 加 `scanId()`（CDP 探针要拿会话 id 调桥，
  与页面同一份会话）。

### F. 测试

- 新增 `scripts/clean-dialog-e2e.ps1` + `scripts/clean-dialog-e2e.mjs`：真机 e2e
  （debug 构建 + `DC_ENV_ROOT` 靶场 + CDP 驱动，判据见 §4）。
- 新增 `scripts/_clean-dialog-probe.*`：只读预览领地探针（诊断用，命名带下划线不进语法闸）。
- 改 `tests/unit/cleanup-one-click-button.test.ts`：结构闸跟到新形状
  （手动档已删、选区来自勾选、弹窗必须渲染、不许绕 `dc_execute`）。
- 改 `tests/unit/cleanup-can-execute.test.tsx`：归档说明 + 保留「带档位回执 ≠ 模型指纹」
  这条服务端仍要钉住的判据（消费方搬到了 `run_auto_clean` 内部 confirm）。
- 改 `src-tauri/src/settings.rs` 的测试：删字段后的三条新判据（见 §3-C）。

## 4. 真机 e2e（debug 构建 + 靶场，四条独立判据）

`DC_ENV_ROOT` 把 TEMP 等五键重定向进 `Desktop\DeepClean删除测试\target\envroot`，
5 个 8 KiB 种子文件只被 `windows-temp` 认领。CDP 驱动走真实页面。

```
SCAN_STATUS   completed
CLEANUP_READY rows=22 checked=19（自动打勾） cta.disabled=false
CTA_CLICKED   弹窗出现
DIALOG_SAMPLES 17 次采样：first {rows=1, 正在清理, 0%} → last {rows=5, 清理完成, 100%}
DONE_LINE     "清理完成，共释放 40.0 KB"
after: 0 files   ← 独立口径：进程退出后数靶场文件，5 → 0
```

截图：`docs/acceptance/assets/clean-dialog-done.png`（1770×1140，弹窗 + 列表 5 行 +
进度条 100% + 完成行）。

> 期间一次误判也如实记：e2e 第一版在「rows > 0」就判清理页就绪 —— 那是自动打勾**之前的**
> 中间态（checked=0、totalBytes=0、按钮 disabled），把"时序没等"误读成"自动打勾没生效"。
> 修法是把就绪判据改成 `checked > 0`（与 `Cleanup.tsx` 的 settling 那段同一口径）。

## 5. 测试与构建

| 闸 | 结果 |
| --- | --- |
| `cargo test --workspace` | 全绿：app 120 passed（4 ignored）、cleaner 121、各 crate parity 全过 |
| `npm test`（vitest） | 1072 passed / 1 failed —— 那条是 `scripts-syntax` 全量并发下的 20 s 超时，单独跑 3 条全过（与 2026-10-22 文档 §7 同一条既有问题） |
| `tsc -p tsconfig.web.json` / `tsconfig.node.json` | 0 错误 |
| release 构建 | `target\release\deepclean-app.exe` 已重建（含最新 dist；`build.rs` 的 `rerun-if-changed=dist` 保证前端改动会触发重编） |

## 6. 代价与未做（如实登记）

1. **进程闸未迁移**：旧免确认档的「在跑应用的缓存不删」判据现在**不挂在勾选链上**。
   用户勾选 `app-cache-data` 时，正在跑的应用缓存不会再被逐条过滤。
   挡它的只剩执行器的路径闸（禁止根/只上报根），与「应用在跑」无关。
   这条迁移是下一批的活，代码里有 `#[allow(dead_code)]` 与注释点名。
2. **§19 验证口径变多块**：清理前后测量是逐批的，合并任务的 verification 是
   「各批前后字节之和」，note 重写成多块口径 —— 「授权根表观大小」那种单根读法
   在这份任务上不成立，界面文案已同步（`merge_tasks` 的 note）。
3. **旧 e2e 脚本会红**：`m3-e2e-cleanup.ps1` / `m5k-cleanlog-e2e.ps1` /
   `m5n-tile-dup-e2e.ps1` / `m5-preview-e2e.ps1` 还在找已删的「确认预估 / 开始清理」按钮。
   它们量的是手动档，本批未迁（迁移意味着重写这几棒的驱动链），需要时另开一批。
4. **手动档的服务端入口没删**：`dc_execute` 与 `run_cleanup` 原样保留 ——
   删它们等于拆掉 digest → ConfirmedPlan → 执行这条已验链，而一键清理内部走的正是它。
   界面上没有入口 ≠ 服务端没有这条链。
5. **release 真删验证没做**：`DC_ENV_ROOT` 是 debug-only 口子，release 上没有安全靶场，
   e2e 走的是 debug 构建。release 侧的服务端逻辑与 debug 同一份代码、同一组测试，
   但「release exe 上真点一次」欠着（与 M3-C 文档「真实 C: 未获批准删除」同一条边界）。

## 7. 工作树状态

本批改动**未提交**，与工作区里更早的未提交改动（dup 检测下线、大文件页删除等，非本批）
混在同一棵工作树上。本批动的文件：`shared/settings.ts`、`shared/types.ts`、
`shared/constants.ts`、`src-tauri/crates/cleaner/src/{executor.rs,lib.rs}`、
`src-tauri/src/{service.rs,commands.rs,settings.rs,paths.rs}`、
`src-tauri/crates/rules/src/{tree_source.rs,lib.rs}`、
`src/renderer/{pages/Cleanup.tsx,
pages/Settings.tsx,hooks/usePreview.ts,App.tsx,tauri-bridge.ts}`、
`src/renderer/styles/global.css`、
`tests/unit/{cleanup-one-click-button.test.ts,cleanup-can-execute.test.tsx}`、
新增 `scripts/clean-dialog-e2e.{ps1,mjs}`、`scripts/_clean-dialog-probe.{ps1,mjs}`、
`scripts/_refresh-probe.{ps1,mjs}`、
`docs/acceptance/assets/{clean-dialog-done.png,clean-dialog-confirm.png}` 与本文档。

---

# 附：同日下午第二轮（真实删除测试后的四条反馈）

人类伙伴用真机做了一轮删除测试，反馈四条，逐条定位与修法如下。
全部有真机探针读数；确认阶段与完成两态各有一张截图。

## 1. 「删除过程无法停止（加入这个提示，确定后执行清理）」

### 修法

弹窗拆成**两段**：

- **确认阶段**（点「一键清理」之后、开删之前）：标题「确认清理」，
  正文「将按当前勾选执行清理，删除的文件**不进回收站、无法恢复**」，
  摘要「预计删除 X · N 项」，两颗按钮「取消」/「确定，开始清理」。
  数字由调用方从当前模型读（`model.totalBytes` / 已计入项数），弹窗不另算第二份。
- **执行阶段**：点「确定」才调 `executeAuto`（选区在 `useCallback` 里拼好注入弹窗），
  订阅 `dc://clean-progress` 的 effect 以 `confirmed` 为门槛 —— 确认之前不订事件、
  不渲染列表。

`start` 动作由调用方注入（`CleanProgressDialog` 的新 prop），弹窗不自己拼选区 ——
选区是 `selected` / `tilePaths` 两份 state，弹窗另拼一份就是第二套真相。

### 验证

`scripts/clean-dialog-e2e.mjs` 新增 ③b/③c 两段：等「确定，开始清理」出现、
断言确认文案含「不进回收站」、断言摘要含「预计删除」，再点确定。
截图 `assets/clean-dialog-confirm.png`。e2e 全链通过（见 §4 的读数）。

## 2. 「删除的速度有点慢，有办法加速吗？」

### 根因（读出来的，不是猜）

执行器对**每个文件单独调一次 `SHFileOperationW`**（shell 层 API，每次有固定开销；
`WindowsCleanFs::delete_permanently` 每条路径发一次）。几千上万文件 = 几千上万次
shell 往返，而 shell 层单次调用是毫秒级的固定成本 —— 大清单上的时间几乎全花在这上面。

### 修法：按批次并发

`service::execute_plan` 的批次循环从**顺序**改成 `std::thread::scope` 里**每批一条线程**。
批次数 = 勾选规则的地盘数，通常几条到十几条，线程数有自然上限。

配套的执行器侧只加三个**只观测**的注入面（120 条既有测试一行没动）：

| 注入面 | 用途 |
| --- | --- |
| `with_shared_done(Arc<AtomicUsize>)` | 跨批共享的「已处理条数」：并发时事件报全局第几条 |
| `with_shared_cleaned(Arc<AtomicU64>)` | 跨批共享的「累计释放」：界面那句「已释放 X」不跳回 0 |
| `with_skip_verification(bool)` | 只有**最后一批**做 §19 前后测量（前几批的 before/after 会被并发批污染） |

`build_verification` 从 `run()` 里抽成独立方法（跳过路径不复那段代码）。

### 代价（如实登记）

1. §19 前后测量只在最后一批做，`merge_tasks` 的 verification 口径仍是「各批之和」
   （最后一批测的是自己的根，其余批是 0 贡献 —— 与"多块地盘"那句 note 自洽）。
2. 日志行序与清单序不再一致（并发写入，序由调度决定）。日志本是「一行一件事」的
   附录，记录页账本不依赖它排序。
3. 取消仍生效：共享标志在所有线程可见，任何一批看到都停；`execute_plan` 的占位
   ctx 仍全程挂在 `state.running` 上。

### 验证

`cargo test --workspace` 全绿（app 120 / cleaner 121 / 各 crate parity 全过）。
真机 e2e（并发路径）同 §4 全链通过。

## 3. 「清理完成后图二这里数值没变（刚删的临时文件）」

### 根因

预览读的是**扫描那棵不可变快照树**（`Session.state.tree` 扫描完成时 publish 一次、
之后不可变）。清理删的是磁盘文件，树没动 —— 光清缓存重算，报告还是旧数。

### 修法

1. `Session` 加 `deleted_paths: Mutex<BTreeSet<String>>`（已删文件的归一化路径键）。
2. `execute_plan` 收尾：把合并任务里 `deleted[].ok === true` 且 kind === file 的路径
   记进去（目录不算 —— 过滤层只摘文件，目录行的口径是「还剩多少字节」）。
3. `rules` crate 加 `FilteredSource`：包在真 `RuleSource` 外面的过滤层，
   `children_of` 里摘掉已删文件、`size_of` 透传（最终字节按逐路径求和，不是 `size_of`；
   `resolve_territory` 只把 `size_of` 写进 ledger 的 present 格）。
4. `report_for_preview`：**已删集合非空 ⇒ 绝不复用缓存**（缓存里是清理前那份），
   且在 `FilteredSource` 上重算报告。
5. `ConfirmedPlan` 加 `scan_id`（收尾时按它找回会话记已删集合）。

边界：只影响估价，不影响执行 —— 执行器的清单来自清理前那份报告，过滤层只服务
「清理之后这一页显示的数字」。目录不摘，文件删空后目录行显示 0 字节。

### 验证

`scripts/_refresh-probe.mjs`（真机）：

```
BEFORE findingBytes=40960 files=5
DONE  清理完成，共释放 40.0 KB
AFTER findingBytes=0 files=0 totalBytes=0
REFRESH_OK
files after: 0
```

清理后重新拉预览，`windows-temp` 从 40960 字节 / 5 文件归零。

## 4. 「向下滚的效果（刚启动但页面占满了，不会动）」

### 修法

弹窗列表从「全量渲染 400 行」改成**截尾渲染**：只画最近 `VISIBLE_LINES = 60` 行，
每帧灌入后 `scrollTop = scrollHeight` 自动滚到底。DOM 节点数恒定，删除高峰期
不再全量重渲；视觉上就是"文件一条条往上冒"。

> 「刚启动但页面占满了，不会动，后面恢复了」这句话本身是两条：① 列表没自动滚底
> （上面几行动都不动）；② 高峰期掉帧。截尾 + 自动滚底两条一起治。

### 验证

e2e 采样 `DIALOG_SAMPLES` 里 `first.rows=1 → last.rows=5`，列表在滚；
`maxRows` 判据仍过（行真的出现过）。

---

# 附二：第三轮（人类伙伴四张截图：清理后数值还是没变）

人类伙伴跑了真实删除（截图一：选择；截图二：点击清理；截图三：清理完毕；
截图四：清理之后数值没变），并说「目前就这一个问题」。

## 根因：上一轮只修了服务端半边，前端半边漏了

上一轮的服务端修法（`Session.deleted_paths` + `FilteredSource`）是**对的**——
`_refresh-probe.mjs` 直接调桥重拉预览，`windows-temp` 从 40960 字节归零。
但它没覆盖**页面不重新拉取**这条：`usePreview` 的模块级 `previewCache` 键是
`[scanId, selected, tilePaths, scanStatus]`，清理完成不改变任何一个 —— 键不变 ⇒
缓存命中 ⇒ **effect 连请求都不发**，页面上还是旧模型。

服务端「重问会给新数」与前端「重问发生」是两半，只修一半时现象原样不变。

## 修法

1. `usePreview` 加第 5 参 `refreshNonce?: number`，进缓存键。
   语义注释写死：它表达「同一份勾选，但答案可能变了」，与 `scanStatus` 分开 ——
   两者混在一起会让「扫描完成」与「清理完成」变成同一个不可分辨的触发源。
2. `Cleanup.tsx` 加 `const [refreshNonce, setRefreshNonce] = useState(0)`；
   `onCleanEvent` 的 handler 里 `kind === 'done'` 时 `setRefreshNonce(n => n + 1)`。
   任务收尾那一刻服务端已把已删文件记进 `Session.deleted_paths`
   （`execute_plan` 收尾在 emit done **之前**），所以重拉拿到的就是删完之后的那份报告。

## 验证（真机 e2e，同一条链补两段）

`scripts/clean-dialog-e2e.mjs` 加 ④b：

```
HEAD_BEFORE_CLEAN 预计释放 40.0 KB
DONE_LINE          清理完成，共释放 40.0 KB
HEAD_AFTER_CLEAN   预计释放 0 B · total 0 B
HEAD_REFRESH_OK
after: 0 files
```

截图三张落 assets：`clean-dialog-confirm.png`（确认阶段）、`clean-dialog-done.png`
（完成弹窗）、`clean-dialog-after.png`（关弹窗后页面态，数值已刷新；两张哈希不同，
证明拍的是两个状态）。

期间一次误判如实记：第一版 ④b 把「关弹窗」放在「拍完成弹窗」之前，两张截图
哈希相同 —— 是脚本顺序错，不是产品缺陷；完成弹窗截图挪到关弹窗之前后，两态各得其所。


---

# 附三：次日（10-25）—— 2167 条失败与 125 条被拒的真因，以及启动即提权

上一批（10-24 第二轮）把「按勾选清理」做通了，但人类伙伴在真机上点了一次之后，
完成弹窗报出 **2167 条失败 · 125 条被拒**。本文这一节只回答两件事：
那两个数字分别是怎么来的、以及为什么最后选择启动即提权。

## 1. 先把那趟清理的账对上（不然一切推论都是猜）

日志 `%APPDATA%\com.deepclean.app\logs\deepclean.log` 里任务 `auto-1792854191063-1`：

```
clean end … status=completed success=17143 failed=2167 refused=0 cleanedSize=787400211
```

`787400211 B = 750.9 MiB`，与截图那行「共释放 750.9 MB」逐字对上；`refused=0` 是
**合并任务那一行**的读数（被拒的 125 条记在各批的 `refusals[]` 里，不进 `failed`）。
所以截图那两个数字确实来自同一趟任务，不是两件事拼起来的。

26 个批次（`clean start` 26 条 / `clean end` 26 条），其中 **1 批整批被拒**：

```
clean start task=auto-… root=C:\ProgramData requested=125
clean end   task=auto-… status=refused blocked=root-ancestor-of-forbidden success=0 failed=0
```

## 2. 2167 条失败：99.6% 是权限，不是占用

逐条按 errno 归类（2163 条能在日志里点名）：

| errno | 条数 | 含义 |
| --- | --- | --- |
| `WIN32_120` | **2154** | `DE_ACCESSDENIEDSRC` —— shell 层「源文件拒绝访问」 |
| `WIN32_32` | 9 | `ERROR_SHARING_VIOLATION` —— 真的被别的进程占着 |

`WIN32_120` 不是猜的：写了个小程序直接调 `SHFileOperationW`（flags `0x0414`，与
`delete_permanently` 同参数），把目标目录的 ACL 复刻成 `%ProgramData%` 下那种形状
（`BUILTIN\Users:(RX)`、目录 `(CI)(WD,AD)`），返回 **120**；同一个程序删正常文件返回 **0**。
对照组成立，所以这个码就是「权限不够」，不是「文件被锁」。

失败集中在三棵树：

| 目录 | 条数 |
| --- | --- |
| `C:\ProgramData\leigod_person_7002\sslproxy\proxy` | 1168 |
| `C:\ProgramData\Comms\PCManager\HarmonyEcology` | 551 |
| `C:\ProgramData\Razer\Razer Central\WebAppCache` | 419 |

而这三棵树的 ACL 都给 `BUILTIN\Administrators:(OI)(CI)(F)`。也就是说：
**它们删不掉，只因为进程是 Medium 完整性级别。** 量化过一遍（对 2165 条仍存在的失败目标逐条量）：

| 轴 | 数量 |
| --- | --- |
| `Administrators` 有 Delete 权 | **2164 / 2165** |
| 独占打开成功（未被占用） | 2151 |
| 被在跑的进程锁住 | 14 |
| 只有 TrustedInstaller 能删 | 3 |

正在跑的 `deepclean-app.exe` 令牌实测 `Elevation=0`，manifest 里是 `asInvoker` —— 与这条推论闭合。

## 3. 125 条被拒：与权限无关，是闸拦的

`app-rotated-logs` 这类**容器入口规则**的 `matched_roots` 就是 `%PROGRAMDATA%` 本身
（`engine.ts` 的 `leafFiles` 分支：没有「命中目录」这层概念，根就是被搜过的那层入口）。
而 `%PROGRAMDATA%` 套着只上报根 `%PROGRAMDATA%\Package Cache`
⇒ `guard_authorized_root` 的 `root-ancestor-of-forbidden` 整批拒绝，**一个文件都没碰**。

这与 §2 的失败是两个完全不同的机制：一个是我们自己拒绝动手，一个是动手了但没权限。
换管理员令牌对前者一点用都没有 —— 这点在决定提权之前必须先分清，否则会以为提权能全解决。

**「改成公共祖先」这条路再次确认走不通**（与 10-24 第一轮同一个结论，这次是拿这 125 条重算的）：
`C:\ProgramData\USOShared\Logs\System` 与 `C:\ProgramData\Comms\Hiview` 的最近共同祖先
**就是** `C:\ProgramData` 本身 —— 等于没改。

## 4. 改动 A：批次授权根按父目录收窄（`src-tauri/src/service.rs`）

只在**授权根确实套住受保护路径**时收窄：把该批清单按父目录重新分组，每组一个更窄的根。
判据用报告里已解析的 `forbidden_roots ∪ report_only_roots`（不另解析模板 —— 两处解析出两种
结果就是两套真相）。

三条纪律写进代码注释：① 收窄后的每个根自己也要过同一道判据；② 有一条收不窄就整批退回原根，
让执行器如实拒绝，不在这里替它编一个能删的根；③ 盘符根永远不做授权根。
**执行器那道闸一个字没改。**

新增 `narrow_sweeping_roots` / `parent_dir` 两个函数 + 4 条测试。

## 5. 改动 B：启动即提权（`windows-app-manifest.xml` + `build.rs`）

人类伙伴裁定推翻 M5-H 那条 `asInvoker`（「把带删除按钮的界面提权是拿边界换便利」）。
推翻它的依据是 §2 那张表：2164/2165 有 Delete 权却删不掉，那不是「边界换便利」，
是「边界换来一个永远删不掉的结果」。

**落地时踩到一个必须记的坑**：manifest 改了之后 `cargo test` 直接挂 ——
测试二进制也被嵌了同一份清单，于是 `os error 740（请求的操作需要提升）`，
整包 124 条一条都跑不起来。修法是 `build.rs` 按 profile 分档：release 嵌提权档，
debug 换成 `asInvoker`。

判据只能用 `PROFILE` —— 实测 build script **拿不到**「这次是不是 `--test`」：
`CARGO_CFG_TEST` / `CARGO_BIN_NAME` / `CARGO_PRIMARY_PACKAGE` 全是 `None`。
这条是试出来的，不是读文档读出来的。

代价如实登记：**debug 档复现不出「提权后能删」**，要验那条必须跑 release 产物或装出来的包。

## 6. 改动 C：清理页加提示（人类伙伴要求）

原话是「部分清理可能需要管理员权限」。**措辞没有照抄**，因为改完之后程序启动就带管理员令牌，
再说「可能需要」会让用户去找一个不存在的按钮。落成：

> 本程序已以管理员身份运行。仍有部分文件删不掉：被其他程序占用中的、以及受系统保护的文件。
> 失败的条目会逐条列出，不计入释放空间。

依据是 §2 的 14 + 3 条（提权也救不回来），所以这句承诺的是「逐条列出」，不是「都能删掉」。

放三处：清理页空状态、清理页有数据态、确认弹窗。弹窗里那句换了个说法
（「删不掉的条目会标成失败并逐条列出」）—— 页面那条讲常驻事实，弹窗那条讲这一次按下去会怎样，
不是同一句话说两遍。

## 7. 验证

| 闸 | 结果 |
| --- | --- |
| `cargo test -p deepclean-app` | **124 passed** / 0 failed / 4 ignored |
| `cargo test -p deepclean-cleaner -p deepclean-rules` | 121 + 4 + 1 + 109 + 4 + 1，全绿 |
| `tsc -p tsconfig.web.json` | 0 错误 |
| vitest（`--no-file-parallelism`） | **1073 passed / 69 files** |
| release PE 资源 | 活着的 manifest 块**恰好 1 份**：含 `requireAdministrator` ∧ `longPathAware` ∧ `Common-Controls`，不含 `asInvoker` |
| debug PE 资源 | 反过来：`asInvoker`，不含 `requireAdministrator` |
| 提权生效旁证 | 从非提权环境启动 release 产物被 UAC 拦下（`The operation was canceled by the user`） |
| 提示真实渲染 | UIAutomation 读到页面文本 + 截图 `assets/cleanup-admin-hint.png` |

**收窄那条做了变异验证**（不然判据是自证）：把 `narrow_sweeping_roots` 那行短路掉，
`a_container_root_that_sweeps_a_report_only_root_is_narrowed_to_parent_dirs` 立刻变红
（`left: ["C:\ProgramData"]` vs `right: ["C:\ProgramData\Comms\Hiview", …]`）；恢复后转绿。

**一条红要解释**：vitest 全量并发跑时 `scripts-syntax.test.ts` 有一条红（22 s 超时），
单独跑 3 条全过、手工把 42 个脚本逐个 `node --check` 也全过、加 `--no-file-parallelism`
跑全量 1073 全绿。是并行超时，不是代码问题 —— 与 10-24 §5 记的是同一条既有问题。

## 8. 代价与未做（如实登记）

1. **安装包没重打**：`target\release\bundle\nsis\` 那份仍是 `asInvoker` 的旧产物。
   要分发前必须重打，并在**包内 exe** 上复验「`requireAdministrator` 在、`asInvoker` 不在」。
2. **边界变薄**：整个带删除按钮的界面常驻管理员令牌，§16/§17/§18 那几道闸从
   「纵深防御的一层」变成「唯一的一层」。这是这次裁定的代价，不是附带损伤。
3. **debug 档验不到提权效果**：见 §5。
4. **提权也删不掉的那 17 条**（14 被占用 + 3 TrustedInstaller）仍然删不掉。
   那 125 条被拒的里，收窄后有 11 条真有 DELETE 权限、114 条提权后才删得动。
5. **文档推翻登记**：`2026-10-12-tauri-m5-h.md` §2 的表后两行、`2026-10-13-tauri-m5-o.md` 清单行、
   `2026-10-15-m6-packaging-gate.md` 包内 exe 那格 —— 三处都按「划掉保留原句 + 订正块」处理，
   没有就地改号。

## 9. 工作树状态

本批改动**未提交**，与工作区里更早的未提交改动混在同一棵工作树上。本批动的文件：

- `src-tauri/src/service.rs`（`narrow_sweeping_roots` / `parent_dir` + 4 条测试）
- `src-tauri/windows-app-manifest.xml`（`asInvoker` → `requireAdministrator`）
- `src-tauri/build.rs`（按 profile 分档）
- `src/renderer/pages/Cleanup.tsx`（三处提示）
- `src/renderer/styles/global.css`（`.dc-clean-admin-hint`）
- `docs/acceptance/{2026-10-12-tauri-m5-h,2026-10-13-tauri-m5-o,2026-10-15-m6-packaging-gate}.md`（推翻登记）
- 新增 `docs/acceptance/assets/cleanup-admin-hint.png`、本文档

另：本轮顺带发现一处**没动**的问题 —— 清理日志有 33 行是两条记录被拼在一起的
（并发批次写同一个文件，`append` 没有行级互斥），丢了 47 条记录的换行。未修，登记在此。