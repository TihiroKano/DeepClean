# 2026-10-20 · 扫描口径对齐 SpaceSniffer（表观 / 占用双口径）+ 移除内嵌引擎

## 背景与目标

用户裁定两件事：

1. **扫描数值要与 SpaceSniffer 一致**（允许细微偏差）；
2. **空间地图用 DeepClean 自己的**，不再内嵌 SpaceSniffer 窗口。

对账时发现的关键事实：**SpaceSniffer 显示的是「表观大小」（logical）** —— 硬链接按名重复计、
不含 NTFS 压缩收益。三个判别项把它钉死：

| 目录 | SpaceSniffer 读数 | 我们 counted（去重） | 我们 alloc（未去重） | **我们 logical** |
|---|---|---|---|---|
| Windows | **23.2** | 11.47 | 15.78 | **23.27** ✓ |
| Program Files | **7.5** | 6.32 | 6.40 | **7.44** ✓ |
| Program Files (x86) | **3.7** | 1.05 | 2.39 | **3.79** ✓ |
| ProgramData | **4.2** | 4.08 | 4.08 | **4.18** ✓ |

`Program Files (x86)` 是最硬的判别项：只有 logical（3.79）能解释它的 3.7，而 alloc / counted
都在 1–2.4 之间。**不是我们少算，是两者量的不是同一个东西。**

所以：**扫描算法一行没改**，改的是「拿哪个数给界面」。

## 做了什么

### 1. 内核层：两套数同时送，切换不重扫（`crates/scanner/src/tree_index.rs`）

- 新增 `SizeBasis { Apparent, Allocated }`，缺省 `Apparent`（与 SpaceSniffer、资源管理器同口径）；
- `ChildView` / `ChildrenPayload` 各增 `sizeApparent` / `sizeAllocated`（Rust 侧必填）；
- `children_of_with` / `level_of_with`：**排序、`size`、`folded_bytes`、`excluded_bytes`
  全用同一个 `basis`** —— 混用会让折叠等式当场不成立；
- `payload(.., basis)` 按口径挑一个当 `size`，并回 `size_basis` 供界面读标签。

**红线**：`children_of` / `sum_children_of`（清理预估与容量对账的输入）**永远**是分配且去重口径，
不受视图开关影响 —— 有测试钉着（`accounting_api_stays_allocated_regardless_of_view_basis`）。

### 2. 命令层与前端

- `dc_children` 增 `size_basis: Option<String>`，`SizeBasis::parse` 认不出的一律回表观（不让拼错的口径名把地图打不开）；
- `useTreeNav(scanId, status, sizeBasis)`：口径进 `pull` 的依赖，切换时重取当前层（不重扫）；
- `Breadcrumb` 增「表观大小 / 占用空间」下拉，**标签与读数同字**（`basisWord`）。

### 3. 移除内嵌 SpaceSniffer

| 层 | 删除物 |
|---|---|
| Rust | `src-tauri/src/scanner_host.rs`（约 940 行）、`dc_ss_launch/attach/detach/stop/status/focus` 六条命令、`main.rs` 的 `mod`/`manage`/`generate_handler!` 六项/`RunEvent::Exit` 钩子 |
| 桥 | `tauri-bridge.ts` 六个 `ss*` 方法、`useScan.ts` 的 `ssLaunch` 并发分支 |
| 前端 | `hooks/useSpaceSniffer.ts`、`SpaceMap.tsx` 的宿主层与引擎状态提示 |
| 类型 | `shared/types.ts` 的 `SsState` / `SsStatus` / `SsRect` 与六个 `ss*` 接口 |

理由：那一轮验收文档自己登记过「端到端链路一次都没跑通」，而它带来的是
「地图一份账、判定另一份账」—— 两个进程的窗口挂载还无法用单测钉住。

### 4. 顺手修掉的真 bug

`examples/scan_one.rs` 的 `fail_exit` 用 `format!("{{\"error\":\"{e}\"}}")` 裸拼 JSON：
错误信息里带 Windows 路径（`C:\Documents and Settings`），`\D` 不是合法转义 ⇒ **产出非法 JSON**。
受影响的正是 `--out` 那条路 —— 提权重扫只能落盘拿，而"根目录打不开"恰是它最常遇到的失败。
改为 `serde_json::json!` 转义。

## 验证

| 闸 | 结果 |
|---|---|
| `cargo test --workspace` | **全绿**（113/121/110/109/57/39/32/13/7/5/4/3/2/1，0 failed） |
| `npm run typecheck` | exit 0 |
| `vitest run` | **62 files / 987 tests 全绿** |
| 变异验证 A（`size_of` 的 Apparent 写死 counted） | `size_basis_switches_the_number_and_keeps_both` **红** |
| 变异验证 B（`folded_bytes` 写死 Allocated） | `conservation_holds_in_both_bases` **红** |
| 变异验证 C（排序写死 `size()`） | `ordering_follows_the_chosen_basis` **红** |

### 真机对账（`scan_one` 扫 `C:\`，2026-10-20 15:23）

| 口径 | 字节 | GiB | 对 SpaceSniffer 的 73.5GB 偏差 |
|---|---|---|---|
| logical（表观，新缺省） | 78,077,819,457 | **72.72** | **−1.07%** |
| alloc（未去重） | 67,592,068,912 | 62.95 | −14.35% |
| counted（占用） | 61,277,978,656 | 57.07 | −22.35% |
| 卷已用 | 79,604,965,376 | 74.14 | — |

逐目录（表观 / 占用）：`Windows` 23.27 / 11.47、`Program Files` 7.44 / 6.32、
`Program Files (x86)` 3.79 / 1.05、`Users` 27.62 / 27.81。

**结论**：表观口径与 SpaceSniffer 全集偏差 −1.07%，逐目录在 −2.1% ~ +2.4% 之间，
落在"细微偏差"范围内；`C:\` 与 SpaceSniffer 的 −1.07% 主因是它的 4 个根级 ACL 目录
（`System Volume Information` / `Recovery` / `PerfLogs` / `Documents and Settings`）同样进不去。

## 没验到的部分（如实登记）

1. **界面切换控件没有真机截图**。`Breadcrumb` 那个下拉的编译与 `typecheck` 过了，
   数据通路（`dc_children` 的 `size_basis` → `SizeBasis::parse` → `payload`）在 Rust 侧有测试，
   但「在下拉里点一下、读数真的变」这条 UI 链路**没有一次真机截图**。本机的屏幕自动化
   在这个窗口上不可用（见前一份验收文档第 2 条），所以这一格仍是空白。
2. **`unaccounted` 那 17 GiB 仍未在界面上变成节点**。`report.rs` 里只有
   `unaccounted_bytes` 一个数，`ScanNode` 没有 `kind` 字段，「未知空间」还画不出来。
   本轮没做（用户本轮的要求是对齐数值）。
3. **`logical - alloc` 那 10 GiB 的口径解释只有旁证**。`compact.exe /compactos:query`
   报 `The system is in the Compact state.`，但**没有逐文件验证** WOF 压缩收益
   （拿几个已知压缩文件比 `GetFileSizeEx` 与 `GetCompressedFileSizeW`）。这不是缺陷，
   但口径文档缺一句实测支撑。
4. **`C:\Users` 下有一个内核级畸名目录**（原始 UTF-16 为 `fdff fdff fdff fdff ef02 fdff fdff fdff fdff`，
   9 个码位、其中 8 个是 U+FFFD），实测 26 个文件 / 6.07 MB，与正常账户目录
   （`楠楠想睡觉了`，277904 文件 / 29.12 GiB）是**两个不同的目录**（file id 不同）。
   本轮未处理，也**未查清它的来源**。

## 修掉的存量缺陷（不是我引入的，但挡住了编译）

`model.rs` 已未提交地加了 `ScanTree.mode` / `ScanTree.mft` 两个字段，而
`tree_index.rs` 的 4 处测试夹具还停在旧形状。**stash 掉本轮改动后 HEAD 版本同样编译失败**
（已实测确认），所以这是接手前的状态，不是本轮引入。已补齐 4 处夹具。

## 备注：关于「单位标错」的自我更正

我在本轮中途一度判定界面把 GiB 标成 GB 是 bug。**该判断已撤回**：
用户提供的 Explorer 属性截图显示 `已用空间 79,483,949,056 字节 = 74.0 GB`，
即 `79,483,949,056 / 2^30 = 74.03` —— **Windows 自己也是这么标的**。
`formatBytes` 用 1024 进制但标签写 GB，与系统惯例一致，不构成缺陷。
