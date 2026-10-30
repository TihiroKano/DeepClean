# DeepClean 扫描引擎基准与对账结果

日期：2026-09-26 · 平台：Windows 11 x64 / NVMe SSD / Node 24.19 · libuv 线程池：默认(4)
被测：`core/scan`（有界并发异步遍历，`concurrency=16`，`maxDepth=64`，`maxFiles=3,000,000`）

**口径**：表观大小（`fs.stat().size`），非 NTFS 磁盘占用大小。见计划「已知偏差 1」。

## 1. 与独立事实源的对账（§35.2）

事实源 = `scripts/oracle.mjs`，走 PowerShell `Get-ChildItem -Recurse -Force | Measure-Object`，
**不 import 本项目任何代码**。夹具里刻意放了 `System Volume Information` 分支，扫描器按名单跳过，
所以把它单独再测一次子账后作差 —— 差值必须精确闭合，不接受"差不多"。

| 规模 | 轴 | oracle 全量 | SVI 子账 | 期望值 | 扫描器 | 判定 |
|---|---|---|---|---|---|---|
| 100k | files | 100,006 | 10,205 | 89,801 | **89,801** | 精确相等 |
| 100k | dirs | 62 | 4 | 58 | **58** | 精确相等 |
| 100k | bytes | 1,033,725,042 | 1,285,990 | 1,032,439,052 | **1,032,439,052** | 精确相等 |
| 500k | files | 500,006 | 51,025 | 448,981 | **448,981** | 精确相等 |
| 500k | dirs | 62 | 4 | 58 | **58** | 精确相等 |
| 500k | bytes | 1,084,126,049 | 6,428,446 | 1,077,697,603 | **1,077,697,603** | 精确相等 |

两次运行计数逐位一致；`denied/missing/busy/otherErrors = 0`，`truncated = false`。

> **dirs 必须单独看**：只看 bytes 会洗白树形错误。计划 Task 6 记录里的 bug②
> （`ensureChain` 从盘符拼路径，凭空造父链节点）就是 bytes 对得上、dirs 6 vs 2 才暴露的。

## 2. 规模与耗时（§27）

| 规模 | 文件数 | 目录数 | 总字节 | 耗时 | 文件/秒 | peak RSS | peak heap |
|---|---|---|---|---|---|---|---|
| 100k | 89,801 | 58 | 1.03 GB | 24.0 s | ~3,740 | — | — |
| 500k | 448,981 | 58 | 1.08 GB | 87.4 s / 110.4 s（两轮） | 5,134 / 4,067 | 517 / 645 MB | 350 / 461 MB |
| 真实 C: | 378,424 | 73,120 | 64.3 GB | 434 s | ~872 | 574 MB | — |
| **真实 C:（2026-09-27，v0.1）** | **377,141** | **75,457** | **69.38 GB** | **164.9 s（净=墙钟）** | **2,287** | **742 MB** | — |

**离散度警告**：500k 同一份数据两轮差 26%（87.4 vs 110.4s）。本机任何单次读数都不可信，
上表凡有重复一律列出。真实 C: 的 872 文件/秒远低于夹具的 5,134，因为夹具是 D 盘顺序元数据、
而 C 盘要穿透 `WinSxS`/GAC 这类超深目录并吃满系统并发 I/O —— 这是环境差异，不是回归。

### 2.1 v0.1 真盘那一跑（2026-09-27）：上面那句解释被削弱了

同一台机器、同一块 C 盘，当前实现跑出 **2,287 files/s**（旧行 872 的 2.6 倍）。
「C 盘天生慢」这个归因**解释不了 2.6 倍**：如果瓶颈是环境，环境没变的话速度不该变。
候选原因包括旧行之后落地的目录不 stat / `SKIP_ALWAYS` 名单 / 播种阶段改动，但**本轮没做背靠背 A/B
（checkout 旧提交重跑），所以只登记为「旧行的速度读数不可复现」，不宣布已归因**。

同一跑的其余事实（详见计划 Task 26）：

- `denied 106 → skipped 106`，`missing/busy/otherErrors` 全 0，`status=completed`。
- 顶层目录轴闭合：PowerShell 列到 **17** 个目录 = 扫描器计入 **15** + `SKIP_ALWAYS` 的
  `System Volume Information` + 按设计不跟随的重解析点 `Documents and Settings`。
- 两条独立代码路径互校：逐文件累加的 `counters.totalBytes` == 后序归并的 `tree.size`
  == **69,379,209,066 B**；导出树里 36 个「无直属文件」节点全部满足
  `Σchildren + foldedBytes == size`（0 处违反）。
- 每文件内存 **2,062 B**（742 MB ÷ 377,141），比计划里 1.0–1.3 KB 的估算重约一倍，
  但绝对值仍远低于「超 ~2 GB 才启动 §22 落盘存储」那条线 → 落盘方案继续不动。
- 「文件消失容错」在真盘上没被触发（`missing=0`），另用一次性探针在自建 32,000 文件夹具上
  制造真竞态，实测 `missing=50` 且 `status=completed`、`bytes == files` 严格相等。


### 2.2 地图层规模（§16 / V0.2 验收第 11 条 · Task 10 · 2026-09-27）

夹具：`scripts/make-fixture.mjs --files=N --fat-dir=0.3N`（**新增的 `--fat-dir` 模式**：
N×0.3 个文件塞进**同一个目录的直属层**，尺寸 `1 + (i % 997)` 以走 top-K tie-break。
现有生成器把文件摊到 ~44 个目录，压根测不到单层瓶颈 —— `C:\Windows\System32` 实测 ~10 万直属文件）。
被测：`scripts/bench-map.mjs`（主进程侧数据/布局链）+ `--shot` 里的渲染端 `performance.now()`。
原始数据：`docs/benchmarks/map-scale-2026-09-27.json`（= `tmp-shots/bench-map.jsonl` 逐行 + RSS 曲线摘要）。

| 规模 | 扫描 files / dirs / bytes | 扫描净耗时 | peak RSS | 肥层直属项 | 页内项 | `levelOf` 肥层 | payload | `toTiles`(1200) | 根↔肥层来回均值 | 进层（含渲染） |
|---|---|---|---|---|---|---|---|---|---|---|
| 10k | 11,981 / 59 / 1.02 GB | 1.1 s | 115 MB | 3,000 | 1,200 | 4.3 ms | 246 KB | 21.2 ms | 3.6 ms | 未测 |
| 50k | 59,901 / 59 / 1.03 GB | 3.6 s | 226 MB | 15,000 | 1,200 | 16.5 ms | 246 KB | 12.1 ms | 15.7 ms | 未测 |
| 100k | 119,801 / 59 / 1.05 GB | 7.6 s | 283 MB | 30,000 | 1,200 | 34.3 ms | 247 KB | 10.7 ms | 51.5 ms | 未测 |
| 500k | 598,981 / 59 / 1.16 GB | 60.0 s | 1,045 MB | 150,000 | 1,200 | **158.5 ms** | 247 KB | 9.0 ms | **172.4 ms** | 未测 |
| **1M**（10b 之前） | **1,197,961 / 59 / 1.28 GB** | **175.2 s** | **1,458 MB** | **300,000** | **1,200** | **325.7 ms** | **248 KB** | **10.7 ms** | **345.7 ms** | **416 / 465 / 539 ms** |
| **1M**（10b 之后，同一夹具同一阈值） | 1,197,961 / 59 / 1,283,926,137 B（三跑逐字相同） | 207.3 / 216.9 / 218.4 s | 963 / 1,317 / 1,316 MB | 300,000 | 1,200 | **15.9 ms**（三跑 15.9 / 17.3 / 33.5，见 §2.2bis） | 248 KB（**254,014 B，与上那行逐字节同长**） | 12.5 ms | **13.7 ms** | **未复测**（要开 Electron，见 §2.2bis 第 5 条） |

「进层（含渲染）」只在 **1M 档**取到有效读数（其余四档未测：渲染端一次读数要等整轮扫描结束，
本机跑一轮 1M 的 Electron 已经要把 turn 预算用尽）。取数过程与两次作废的读数见 §2.3。

口径与三条必须一起读的事实：

1. **`files` 轴比生成器自报少约 1/12**：夹具里 `System Volume Information` 分支也摊了文件，
   扫描器按 `SKIP_ALWAYS` 整枝不扫 —— 与本文 §1 的 100k 对账表同一口径（100,006 → 89,801），不是漏扫。
2. **`levelOf` / 来回均值是 5 次暖跑的中位数**，`toTiles` 同；冷跑（含 JIT）也一并落进 JSON
   （`toTilesColdMs` / `fatPageColdMs`）。小档冷暖差到 81%，**只有 100k 以上的数能当结论**。
3. **`childrenOf`（整层 ChildView + 排序）占 `levelOf` 的 77% → 97%**，30 万直属项那一档
   是 315.8 / 325.7 ms。`levelOf ≈ 1.1 µs × 本层直属项数`，且**页内项恒为 1,200 也不影响这条线** ——
   封顶只封住了"画多少"，没封住"为挑出这 1,200 项付多少钱"。

**阈值判定（阈值在跑之前写死在 `docs/acceptance/2026-09-27-v0.2-treemap.md`，未因结果改动）**

| 判据 | 阈值 | 1M 实测 | 判定 |
|---|---|---|---|
| IPC payload | ≤ 5 MB | **248 KB**（五档全在 246–248 KB） | **通过** |
| `toTiles(1200)` | ≤ 60 ms | **10.7 ms**（暖）/ 14.4 ms（冷） | **通过** |
| `levelOf` 肥层 | ≤ 30 ms | **325.7 ms** | **未达成（10.9 倍）** |
| 根↔肥层来回 10 次均值 | ≤ 60 ms | **345.7 ms** | **未达成（5.8 倍）** |
| 进层（含 React 渲染 + canvas 绘制） | ≤ 250 ms | **416 / 465 / 539 ms**（三轮，本层直属 300,000 项） | **未达成（1.66–2.16 倍）** |
| 扫描层 RSS | 计划 §22 的 ~2 GB 线 | **1,458 MB**（两道闸 2,200 MB / 900 s 均未触发） | **通过**（仅对本夹具形状） |

**结论一句话**：**地图层的载荷是有界的**（五档 payload 全等 246–248 KB、`toTiles` 恒定 9–11 ms、
渲染端画出的格数恒为 1,200，1M 文件的存储也没越 §22 那条 2 GB 线），
**但"挑出这 1,200 项"的那一步没有有界** ——
`levelOf` 从本层 3 万项起就超阈值，1M 档超 10.9 倍，而**用户点一下双击要等 416–539 ms**
（渲染端 P1 阈值 250 ms，超 1.66–2.16 倍；其中约 326 ms 是主进程那一次全层排序）。
计划里那句「1M 文件的实时性靠 400ms 轮询 + 1200 tile 上限保证」只对了一半：
**上限保证了画得便宜，400ms 轮询反而保证了每 400ms 付一次 326 ms 的全层排序。**
Task 10b（原始记录上先用阈值挑前 K、只为胜出者造 `ChildView`）的触发条件
（`fatPageMs > 30`）已由本表在 100k 档满足，且**它同时是 P1 的主要可回收预算**。

### 2.2bis Task 10b：把「挑这 1,200 项」变成有界成本之后（2026-09-27，同一夹具）

改动只有一处：`TreeStore.levelOf` 不再先 `childrenOf` 整层再切前缀，而是在原始记录上
用「3 路快速选择求第 cap 大的 size → 一次线性划分 → 只在边界同分档里比名字」选出前 cap 项的
**位置**，然后只为这 cap 项造 `ChildView`。`childrenOf` 一个字未改（三条计价路径的完整口径），
`levelOf` 的入参出参形状也没动。夹具 `D:/deepclean-fixture/fat-1000000` 复用 Task 10 那一份（重建要 13 分钟）。

**三跑实测**（`scripts/bench-map.mjs`，阈值是 Task 10 跑前写死的那两个，未因结果改动；
原始 JSON 见 `map-scale-2026-09-27.json` 的 `task10b` 节）：

| 跑次 | `levelOf` 肥层（暖 5 次中位） | 冷跑 | `childrenOf` 同层（**未改动的控制项**） | 根↔肥层来回 | peak RSS | `levelOf` ≤ 30 ms |
|---|---|---|---|---|---|---|
| A | 33.5 ms | 53.1 ms | **914.1 ms** | 23.6 ms | 1,316 MB | 未达（超 12%） |
| B | 17.3 ms | 33.2 ms | **468.4 ms** | 24.6 ms | 1,317 MB | **达标** |
| C | **15.9 ms** | 31.8 ms | **340.7 ms** | 13.7 ms | 963 MB | **达标** |
| Task 10（改动前） | 325.7 ms | 350 ms | 315.8 ms | 345.7 ms | 1,458 MB | 未达（10.9 倍） |

1. **取哪一行当结论**：控制项 `childrenOf` 是同一段没动过的代码，A 跑里它读到 914 ms、
   Task 10 那跑 315.8 ms —— 同一台机器同一份码差 **2.9 倍**，说明这台机器的内存压力足以解释
   A 跑那 33.5 ms。**C 跑的控制项 340.7 ms 与 Task 10 的 315.8 ms 只差 8%**，两跑条件可比，
   所以可比条件下的读数是 **325.7 ms → 15.9 ms（20.5 倍）**，`≤ 30 ms` **达标**。
   三跑全部记录在案，不挑一次好看的：A 跑那一遍确实没进阈值。
2. **不受机器噪声影响的归一化读数**：`levelOf / childrenOf` 同层比值 =
   0.037（A）/ 0.037（B）/ 0.047（C），改动前是 **1.03**（325.7 / 315.8，即 `levelOf` 的全部时间
   就是那一次全层排序）。三跑归一化值互相差 < 27%，而绝对值差到 2.1 倍 —— 这条比值才是稳的。
3. **同解判据（真实规模，不是合成形状）**：三跑 `pageSameAsSlowPath` 全为 `true`，
   快路径回的页与「`childrenOf` 整层 + 切前缀」参照页 **JSON 逐字节相同**（SHA-256 前缀
   `8caf3b2159af5311` 两边相等，三跑同一），`foldedBytes` 两边都是 **148,461,750**，
   `payloadBytes` = **254,014 B** 与 Task 10 那行同长。判据已内建进 `scripts/bench-map.mjs`，
   不再只靠单测的合成形状。
4. **重测真的抓到一个假优化**：第一版主元取 `lo/mid/hi` 三点中位数，在夹具这种
   `size = 1 + (i % 997)` 的循环分布上被系统性打败 —— trace 出来每轮 `piv` 恰好 +1、
   只削掉一个 300 项的档，997 档要 997 轮，于是每次都撞穿 64 轮预算掉进兜底，
   **实测 `levelOf` 939 ms，比改动前的 325.7 ms 还慢 2.9 倍**。
   改成定种子 xorshift 的**随机三采样**主元（答案与主元无关，故不影响同解；轮数仍可复现）后
   才是上面那三行；兜底也换成"只排 size 的原生数值排序"（`Float64Array#sort` 无比较器），
   最坏一次 ~20 ms 而不是 ~900 ms。**这条如果只看单测永远发现不了** —— 主元怎么换都不改答案，
   1,200 项与四份账全对，只有墙钟会说话。
5. **渲染端那一列本轮未复测**：`enterMs` 只能由 `electron/main/index.ts` 的 `--shot` 脚手架产出，
   而本轮 (a) 明令不启动 Electron，(b) §2.3 记下的两条脚手架缺陷（`__dc.status()` 恒回 `idle`、
   `validateRoot` 只认反斜杠）由控制器单独在修，修好之前那三行 416/465/539 ms 也无从复现。
   能说的只有主进程侧那一段的账：**它从 325.7 ms 降到 15.9–33.5 ms**，
   于是 `≤ 250 ms` 的可回收预算（Task 10 结论里那句"约 326 ms 在主进程"）已经还回来；
   **但 `≤ 250 ms` 这条判据本身要等能开窗口的人重测，本轮不外推一个数冒充实测。**

### 2.3 渲染端那一列是怎么量出来的（Task 10 顺带发现的两条脚手架缺陷）

`enterMs` 的 416/465/539 ms 是**前三跑全部作废之后**才拿到的，作废原因本身就是两条缺陷：

1. `--shot` 的"等扫描结束"依赖渲染端 `window.__dc.status()`，而这一跑里它**从第一轮就回 `idle`**
   （渲染侧 `scan.snapshot` 从未落地，主进程同一时刻的日志是 `status=running`）⇒ 等待环第一次就退出，
   后面所有截图与计时都拍在**扫到一半的树**上。小夹具（几千文件、1 秒扫完）撞不出这条，所以从没被人发现。
   同一根因还会让 §2「扫完自动进图」的断言在 `--shot` 路径下必然报 FAIL。
2. `validateRoot`（`electron/services/scan-service.ts:44`）要求 `^[A-Za-z]:\\`，**只认反斜杠**：
   `--shot=D:/deepclean-fixture/fat-1000000` 会被 `E_BAD_ROOT` 静默拒掉（只在日志里留一行），
   然后整个 harness 拿空树继续跑 30 步。必须写 `--shot='D:\deepclean-fixture\fat-1000000'`。

Task 10 在 `runShot` 里改用自己盯肥层 `totalChildren`（连续 4 次同值才算扫满）来绕开第 1 条，
读数与失败过程记在 `.superpowers/sdd/2026-09-27-deepclean-v0.2-treemap/task-10-report.md` 第 5 节；
**这两条本身的修复不在本 Task 范围**（属 §7 实时性 / 脚手架），已交给控制器定夺。

## 3. 并发上限扫描（100k 夹具，2 轮）

| concurrency | 耗时 (ms) | 说明 |
|---|---|---|
| 2 | 33,701 / 41,578 | 明显慢 |
| 8 | 27,137 / 28,858 | |
| 16 | 24,026 / 24,743 | **默认值** |
| 32 | 23,883 / 25,066 | 与 16 持平，无收益 |

16 之后曲线走平 ⇒ 保持 `SCAN_CONCURRENCY=16`。§6 要求"不能为了速度把磁盘 I/O 拉满"，
32 换不来吞吐，只换来更多争用，没有理由上调。

## 4. `UV_THREADPOOL_SIZE` 实测（推翻原假设）

用 shell 前缀（唯一有效时机）对比：默认池(4) 最快 **19.6 s**，池=32 **24.0 s**。
**提上去反而更慢**。且进程内 `process.env.UV_THREADPOOL_SIZE = ...` 在 Electron 里是空操作
（libuv 只在线程池首次创建时读一次，Electron 引导早于主模块就碰过 fs）→ 该行已删除。
并发度全部由 `Scanner` 的信号量负责。

## 5. CPU 占用 / 磁盘读取（人工读数）

§27 的五项里这两项**未自动采集**（Windows 家庭版无 perf 计数器，且不想为读数引入 ETW 依赖）。
真实 C: 扫描期间任务管理器读数：DeepClean 主进程 CPU 约 5–15%、磁盘活动持续但未满速，
系统前台可正常操作。此为人工目测，精度仅作"没有把机器拖死"的量级参考。

## 6. §7 实时性：一个只有真实盘才能暴露的缺陷

修复前，真实 C: 扫描的 HUD 主计数（已扫描文件 / 已发现空间）**连续 142 次进度输出纹丝不动**
（≈ 4.7 分钟 / 全程 7.2 分钟）—— 因为计数只在 seed 子树扫完合并时才累加，而
`C:\Windows\WinSxS` 这种单个 seed 要跑几分钟。100k / 500k 夹具的 seed 都是毫秒级完成，
两档对账全绿也照不出这个问题。

改为每发现一个文件即计数（`TreeStore.noteSeenFile`）后：**最长冻结连续次数 = 1**，
每次进度输出都是新值（实测 100s 内 47 → 83,375 文件单调爬升）。
总计不变（156 单测含"合并不得把计数再加一遍"的回归哨兵）。

## 7. §35.2 在真实 C 盘上的对账（结论：部分通过，一处未闭合）

`node scripts/oracle.mjs` 逐个测三大目录，与应用内 Treemap 显示值对比：

| 目录 | oracle bytes | oracle GB | 应用显示 | 差 | oracle enumErrors |
|---|---|---|---|---|---|
| `C:\Windows` | 24,983,725,673 | 23.27 GB | 23.3 GB | ≈0 | 92 |
| `C:\Program Files` | 7,988,993,018 | 7.44 GB | 7.4 GB | ≈0 | 2 |
| `C:\Users` | 28,282,943,678 | 26.34 GB | 25.1 GB | **−1.24 GB (−4.7%)** | 4 |

**这一条不算通过**，两点如实记下：

1. 三个目录的 `enumErrors` 全部非零。按 `oracle.mjs` 自己的契约（"残缺的事实源没资格当事实源"，
   见其 `enumErrors>0 → exit 1` 闸），这三行数字本身都不可信，只能当量级参考。
2. `C:\Users` 差 1.24 GB 且方向是 **oracle 偏大**。最可能的原因是 PS 5.1 的
   `Get-ChildItem -Recurse` 会跟随 junction/软链接（`C:\Users\Default User` → `Default`、
   `All Users` → `ProgramData` 这类），从而重复计入；而扫描器把 reparse point 归为
   `kind==='other'` 主动跳过、不跟随（Task 5 的既定设计）。若如此，这个差异是**扫描器更正确**，
   不是漏扫。**但这一点尚未被证明** —— 要证伪需要逐个列出 oracle 多算的文件路径再比对，
   本轮未做。因此 §35.2 在真实盘上记为"两目录吻合、一目录差异未定性"。

**为什么仍然相信扫描器的计数正确性**：证据主心骨是第 1 节 —— 100k 与 500k 两份静止夹具上，
三轴与 oracle **逐项精确相等且 `enumErrors=0`**。真实 C 盘是活的、有权限墙、有 junction 的
环境，不适合做精确对账，只适合做量级核对。

### §35.2 补充：`C:\Users` 那 1.20 GB 差异已归因闭合（不是漏扫）

先记录一次**被证伪的假设**：最初推测差异来自顶层 `C:\Users\Default User → Default` 这个 junction
被 PowerShell 重复计入。实测 `C:\Users\Default` 只有 **2,718,922 B（2.7 MB）**，撑不起 1.20 GB ——
假设被自己的测量推翻，没有拿它当结论。

随后把 Scanner 与 oracle **背靠背**跑同一目录（消除"活目录随时间漂移"这个混淆因子；
第一次比对隔了几分钟，期间 `C:\Users` 自身就少了 1.32 GB / 13,319 个文件，那才是最初数字对不上的主因）：

| | files | dirs | bytes |
|---|---|---|---|
| Scanner | 160,653 | 31,706 | 25,668,674,302 |
| oracle | 161,661 | 32,293 | 26,955,060,958 |
| **差** | **+1,008** | **+587** | **+1,286,386,656 (1.20 GB)** |

再用一次独立的元数据遍历数 `C:\Users` 下的重解析点：**604 个**
（`All Users`、`Default User`，以及每个用户目录里的 `Application Data`、`Local Settings`、
`My Documents`、`Cookies`、`Recent`、`OneDrive` 等历史兼容 junction）。

**604 个重解析点 vs oracle 多出的 587 个目录** —— 数量级吻合，差异闭合：

- Scanner 按 Task 5 的既定设计把 reparse point 归为 `kind === 'other'`，**不计为目录、不跟随**；
- PowerShell 把它们当目录计入，并对部分目标做了遍历，于是既多了目录数、又把已通过规范路径
  计过一次的内容重复计入，多出 1.20 GB。

**结论：这是口径差异，且扫描器的口径才是对的。** 跟随 `Application Data → AppData` 这类
junction 会重复计数甚至自循环，SpaceSniffer 同样不跟随。§35.2 判为**通过**。

诚实边界：dirs 轴有 604↔587 的量化支撑；bytes 轴的 1.20 GB 只论证到"与跟随重解析点一致"，
未逐文件点名是哪些 junction 贡献了多少。

## 8. §4.1 文件属性：一次 stat 到底能读出什么（Task 15，假设被测量推翻）

§4.1 要求扫描内容含「属性 / 隐藏文件 / 系统文件」。计划 Task 15 假设
「Node 在 Windows 把 `FILE_ATTRIBUTE_READONLY/HIDDEN/SYSTEM/ARCHIVE` 映射进 `stats.mode` 的
bit 1/2/4/32」，并据此认为属性可以零额外 syscall 拿到。**这个假设是错的**，
在本机（Windows 11 x64 / Node 24.19.0 / Electron 44.2.0 内 node 24.20.0 / libuv 1.52.1）实测：

| PowerShell 认定的 Attributes（权威） | `fs.statSync().mode` |
|---|---|
| `Normal`（一个属性都没有） | 33206 = `0o100666` |
| `Archive` | 33206 |
| `Hidden, Archive` | 33206 |
| `System, Archive` | 33206 |
| `Hidden, System, Archive` | 33206 |
| `ReadOnly, Archive` | 33060 = `0o100444` |
| `ReadOnly, Hidden, System, Archive` | 33060 |

（靶子是 `%TEMP%` 里自己建的 7 个文件，逐个用 `Set-ItemProperty … .Attributes` 设好后测 mode。）

真实盘上同样成立：`C:\Users\Public\Desktop\desktop.ini` 与
`C:\ProgramData\Microsoft\Windows\Start Menu\desktop.ini` 的 PowerShell 属性分别是
`Hidden, System` 与 `Hidden, System, Archive`，两者的 `mode` 都是 33206。

**根因**：libuv 只把 READONLY 编进 `st_mode`，编法是「抹掉写权限位」
（可写 → `0o666`，只读 → `0o444`）。于是 33206 的 bit 2/4/32 是 **POSIX 权限位**，
与 FILE_ATTRIBUTE 的 HIDDEN/SYSTEM/ARCHIVE 撞位却毫无关系；bit 1 永远是 0。

**照抄假设的代价（量出来的，不是推理）**：按 `mode & 2 / & 4 / & 32` 判属性，扫 100k 夹具得到

| 轴 | PowerShell（权威） | 按 `mode` 位读出来 | 判定 |
|---|---|---|---|
| files | 100,006 | 100,006 | — |
| hidden | **0** | 100,006 | 100% 假阳性 |
| system | **0** | 100,006 | 100% 假阳性 |
| archive | 100,006 | 100,006 | 巧合（权限位里恒置） |
| readonly（bit 1） | 0 | 0 | 恒为 0，永远判不出真只读 |

所以那一版实现会把「每一个可写文件」都标成隐藏+系统文件，而 §28 原则二要求的
「系统文件默认保护」会因此变成「所有文件都保护」—— 看起来更安全，实际是彻底失去区分能力。

**这一轮真正交付的**：属性通道打通且零额外 syscall，能证明的属性只有 READONLY。
`core/fs/fslike.ts` 把 `st_mode` 就地解码成「已证明属性位」（`attrsFromStatMode`），
`FileEntry` / `ChildView` 带它，`shared/classify.ts` 提供三态判据
（`set` / `clear` / `unknown`，`unknown` 是显式状态，绝不塌成 `clear`），
详情面板四行如实显示：只读 = 是/否，隐藏/系统/存档 = 「未知（stat 读不到）」，
目录 = 「未采集」（目录本轮不 stat，见下面的成本红线）。

### 与 PowerShell 的属性交叉对账

口径：PowerShell `Get-ChildItem -LiteralPath '\?\…' -Recurse -Force -File` +
`$_.Attributes -band [IO.FileAttributes]::…`（`\?\` 前缀与枚举错误闸沿用 `oracle.mjs` 的纪律）。
`enumErrors=0` 才有资格当权威。

| 目标目录 | PS files / enumErrors | scanner files | PS bytes | scanner bytes | 只读 PS↔scanner | 隐藏 PS↔scanner | 系统 PS↔scanner |
|---|---|---|---|---|---|---|---|
| `C:\Users\Public` | 63 / **0** | **63** | 539,856 | **539,856** | 0 ↔ **0** ✅ | 20 ↔ 0（63 行全 unknown） | 20 ↔ 0 |
| `C:\ProgramData\Microsoft\Windows\Start Menu` | 83 / **0** | **83** | 96,825 | **96,825** | 0 ↔ **0** ✅ | 10 ↔ 0（83 unknown） | 10 ↔ 0 |
| `C:\tmp`（含属性探针文件） | 15 / **0** | **15** | 1,023,788 | **1,023,788** | 2 ↔ **2** ✅ | 3 ↔ 0（15 unknown） | 3 ↔ 0 |
| `C:\Users`（背靠背，同一分钟内两侧各跑一次） | 162,513 / **4**（少计，不可当权威） | 161,503 | 27,633,807,882 | 26,348,817,060 | 204 ↔ 203（口径修正后 **203 ↔ 203**） | 587 ↔ 0（161,503 行全 unknown） | 1,553 ↔ 0 |

**`C:\Users` 那一行的差额逐个点名闭合**（不接受"差不多"）：

- files：`162,513 − 1,008（PS 认定的重解析点文件，扫描器按 Task 5 口径主动跳过）= 161,505`，
  扫描器 161,503，余 2 —— 两侧都不完整（扫描器 `denied=2` 个不可读目录，PS 自己 `enumErrors=4`），
  且这个目录是活的：PS 侧连跑三次给出 162,201 / 162,495 / 162,513，20 分钟漂了 312 个文件，
  比这 2 个的残差大两个数量级。
- readonly：**精确闭合**。再问 PowerShell 一次「ReadOnly 且不是 ReparsePoint」= **203**，
  与扫描器的 203 逐位相等。（204 里多出的那 1 个是挂在重解析点上的只读条目，扫描器不跟随重解析点。）
- bytes：PS 比扫描器多 1.28 GB —— 与本文第 7 节已归因闭合的同一件事（PS 把 junction 目标重复计入），
  不是本轮新差异。

三个 `enumErrors=0` 的静止目录（`C:\Users\Public` / `Start Menu` / `C:\tmp`）才是这轮的权威对照：
files、bytes、readonly 三轴 **逐位相等**，隐藏/系统轴则如实差在"标注"上（见下）。

三点如实结论：

1. **枚举没有漏**：三个 `enumErrors=0` 的目录上，scanner 的 files 与 bytes 与 PowerShell **逐位相等**
   —— §4.1 的「扫描隐藏文件」这一半（把隐藏/系统文件**扫进来、计容量**）是成立的，
   隐藏文件确实进了树、进了容量。
2. **只读轴逐位相等**（含 `C:\tmp` 上 PS=2 ↔ scanner=2 的正例）—— 说明属性管道在真实盘上是通的，
   不是只在 fake fs 里通。
3. **隐藏/系统轴差的是"标注"不是"漏扫"**：PS 认定的 20/10/3 个隐藏文件，scanner 一个都标不出来
   （全报 `unknown`）。这是运行时能力边界，不是实现 bug，也没有用假数据抹平：
   判 `set` 是假阳性、判 `clear` 是假阴性（等于宣布"这个文件不是系统文件、可以清理"），
   所以 UI 与类型系统都强制显示第三态。补齐它需要下面任一代价，本轮明确不付：
   - N-API 原生模块，在 `FindNextFileW` 的枚举里顺手取 `dwFileAttributes`（真·零额外 syscall，
     但推翻「零原生依赖」锁定决策）；
   - 每文件多一次 `GetFileAttributesEx`（stat 数量翻倍，违反 Task 15 的成本红线）；
   - 每目录一次 `Get-ChildItem`（进程内拿不到，得为每个子树 spawn PowerShell）。

### 成本红线复核（属性确实零额外 syscall）

- `core/` 里 `.stat(` 调用点仍然是 **2 个**（`walk.ts` 每个文件一次、`scanner.collectShallowFiles`
  每个浅层文件一次），`lstat` **0 个**：与 Task 15 之前逐字相同。
- 回归哨兵在 `tests/unit/walk.test.ts` / `scanner.test.ts`：假 fs 记录每次 stat 的路径，
  断言「5 个文件 / 6 个目录的树恰好 5 次 stat，且没有一次落在目录路径上」。
- 目录属性**不采**：为目录补一次 lstat ≈ 真实 C 盘多 7.3 万次 I/O（实测 C 盘 dirs=73,120）。
- 属性不参与聚合：§35.2 的 100k 对账（files 89,801 / dirs 58 / bytes 1,032,439,052）
  本轮重跑**逐位不变**。

## 9. winenum M1（2026-10-09）：Win32 目录枚举层真机账

口径：表观大小（与 §2 同）；M1 **不碰**"磁盘占用"口径（本机 Compact OS 开着，
System32 逻辑 2.46 GB vs 占用 504 MB —— 占用是 M2 之后的事）。

| 项 | nodeFs+finddata | winFs | 判定 |
|---|---|---|---|
| C:\ 根 三轴（收尾轮，`--dump` 现场） | 459,942 / 90,143 / 82,683,736,048 | 459,942 / 90,143 / 82,683,796,567 | files/dirs 全等；bytes Δ=**+60,519** 被 9 条逐名点名（下详），零残差 |
| findDataRecovery | C:\ 轮 = `4 / 8,560,336,896 B`（pagefile 系动态大小，两轮间自身在变） | **恒 `{files:0,bytes:0}`** | 主路不再触发兜底 ✅ |
| IsAdmin | False（脚本自证） | 同 | 不提权成立 ✅ |
| 微基准（`C:\Windows\System32`，x5） | readdir+stat = 1152.2 / 1039.5 / 954.2 / 934.9 / 893.0 ms | readdir = 132.8 / 105.2 / 107.2 / 107.1 / 100.1 ms | ≈7–12×（5 读全列，不挑） |
| 全盘 A/B（3 跑，全列） | 见下节 | 见下节 | 机器噪声纪律见 §2（活盘不主张逐字节相等） |
| **peak RSS（2026-10-10 RSS 复跑轮；每 2s 采样 + 扫描起/止各一次）** | **980.8 MB** | **1340.1 MB** | **≈1.4×，不高于基线一个量级 ✅**（两轮同进程顺序跑 → winenum 峰值为保守口径，含 nodefs 轮残留） |

peak RSS 复跑轮现场补记（`--dump` 同路径，判据 5 改判的证据面）：winenum 轮 462,429 files / 90,387 dirs /
83,835,597,701 B / 99,319 ms（nodefs 轮 462,424 / 90,387 / 82,525,453,449 B / 173,590 ms）；files 净 +5
= onlyWin 8 − onlyNode 3，Δbytes=+1,310,144,252 被逐名点名且**逐字节零残差**（sizeDiff 17 条 Σ=1,310,432,427，
其中 pagefile.sys 自身 +1,310,116,864；onlyNode Σ=288,240；onlyWin Σ=65）—— 差额全部为页面文件动态大小
与运行中日志/Qoder 临时文件，与「活盘不主张逐字节相等」的裁定一致（EXIT=1 同属有意旗标）。

### 9.1 静止目标：f100k 夹具三轴 + oracle 零容差闭合

`npx vite-node scripts/reconcile-winenum.mjs --dir='D:\deepclean-fixture\f100k'`：
nodefs 与 winenum 三轴 **89,801 / 58 / 1,032,439,052 逐字节相等**（nodefs 5,079 ms vs winenum 1,243 ms），
两轮 skipped 全 0、recovery 全 0，EXIT=0。

与第三方口径（`scripts/oracle.mjs`，两次 enumErrors=0）精确闭合，**零容差**：

| 轴 | 算式 | 结果 = winenum 读数 |
|---|---|---|
| files | 100,006 − 10,205（SVI 子树） | 89,801 |
| dirs | 62 − 4（§1 表形式；根约定逐位记账见 Task 8 报告） | 58 |
| bytes | 1,033,725,042 − 1,285,990 | 1,032,439,052 |

T10 收尾复跑（dump 完备性自断言落地后）：数字如前，EXIT=0；两份 dump 各 89,801 行、
Σ=1,032,439,052 与三轴逐字节相等。

### 9.2 System32（静止）：三轴全等 + 微基准 5 读全列

三轴 **18,601 / 1,607 / 9,917,055,187 两侧逐字节相等**（winenum 873 ms vs nodefs 4,009 ms），
两轮 skipped 均 18（全 denied，[winenum] 原始行全部 `win32:5`），recovery 全 0，EXIT=0。
微基准 5 读：winenum readdir = 132.8 / 105.2 / 107.2 / 107.1 / 100.1 ms；
node readdir+stat = 1152.2 / 1039.5 / 954.2 / 934.9 / 893.0 ms。

### 9.3 C:\ 全盘 A/B（3 跑全列）+ 活盘差额逐名点名

| 跑 | 轮 | files | dirs | bytes | ms | recovery（files/B） | skipped.denied | EXIT |
|---|---|---|---|---|---|---|---|---|
| 1 | nodefs | 459,998 | 90,143 | 82,491,700,890 | 163,239 | 4 / 8,346,750,976 | 102 | — |
| 1 | winenum | 459,998 | 90,143 | 82,490,993,901 | 80,007 | 0 / 0 | 102 | 1 |
| 2 | nodefs | 460,005 | 90,143 | 82,493,199,978 | 150,782 | 4 / 8,346,750,976 | 102 | — |
| 2 | winenum | 460,003 | 90,143 | 82,493,237,850 | 73,189 | 0 / 0 | 102 | 1 |
| 3（收尾，`--dump`） | nodefs | **459,942** | 90,143 | 82,683,736,048 | 136,611 | 4 / 8,560,336,896 | 102 | — |
| 3（收尾，`--dump`） | winenum | **459,942** | 90,143 | 82,683,796,567 | **91,096** | 0 / 0 | 102 | 1 |

前两跑差值方向不稳（跑 1 Δbytes=−706,989；跑 2 Δfiles=−2、Δbytes=+37,872）、两跑之间
盘上计数自身在动 → 触发 2026-10-09 裁定：**活盘不做"逐字节相等"断言**，判据改为
"差值必须被 `--dump` 逐名点名并判性质（≤MB、方向不稳、临时/日志类）或为零"。

收尾轮 `onlyNode=0 onlyWin=0 sizeDiff=9`（第 3 跑 Δbytes=+60,519 = 9 条之和，逐字节零残差）：

| # | 条目 | node→win（Δ） | 性质（跑后现场复核） |
|---|---|---|---|
| 1 | Edge `webstorage\quotaManager-journal` | 8,720→0（−8,720） | 漂移：journal 被截断/重置（现场 stat = 0 字节） |
| 2 | Qoder `logs\…\main.log` | 3,304,821→3,312,075（+7,254） | 漂移：追加型日志（跑后现场又 +5,382） |
| 3 | Qoder `app-plugin\0a0fcb….log` | 212,784→214,454（+1,670） | 漂移：同一日志树 |
| 4 | Qoder `app-plugin\16f383….log` | 187,280→189,242（+1,962） | 漂移：同一日志树 |
| 5 | Qoder `app-plugin\d291a4….log` | 151,060→152,694（+1,634） | 漂移：同一日志树 |
| 6 | Qoder `app-plugin\8460d3….log` | 19,600→21,306（+1,706） | 漂移：同一日志树 |
| 7 | Qoder `app-plugin\accf4a….log` | 15,338→17,044（+1,706） | 漂移：同一日志树 |
| 8 | HiView `BasicData\basic_data.db` | 34,025,472→34,078,720（+53,248） | 漂移：运行中服务库（跑后现场又 +20,480） |
| 9 | shittimlogon `logs\overlay.log` | 1,376,922→1,376,981（+59） | 漂移：mtime 恰落在两轮扫描之间 |

**EXIT=1 是有意旗标**：脚本对"三轴逐字节相等"打的是严格旗标，活盘上必然红；按裁定，
活盘判据落在上面的逐名差异块（9 条全点名、无未点名残差）。104 行 `[winenum]` 原始日志
全部 `win32:5`（ACCESS_DENIED，102 唯一路径 + 2 条既有重复枚举）。

M1 七条验收判据的逐条证据与「未闭合」边界、变异证明清单、setup.exe 重验，
见 `docs/acceptance/2026-10-10-winenum-m1.md`。

---

## 10. 「扫描总数比整块卷还大」的超额分解（2026-10-10，提权）

**触发**：用户拿界面顶部的 `C:\ 92.4 GB` 与「80 GB」对照，判为多算 12 GB。
核实后**前提比这更严重**：80 GB 不是已用空间，是**整块 C 盘的容量**。

| 坐标 | 值 | 来源 |
|---|---|---|
| C: 总容量 | 85,899,341,824 B = **80.00 GiB** | `Get-Volume` 与 `Win32_LogicalDisk`（两个独立来源同值；后者就是 `electron/services/drives.ts` 用的那条查询） |
| C: 已用 | **77.21 GiB**（同日非提权那次为 76.85 GiB） | 同上，`Size − FreeSpace` |
| 被验方（提权，`Scanner`+winFs，307 s） | 100,699,505,381 B = **93.78 GiB** / 535,659 文件 / 110,531 目录 / 打不开 8 | `scripts/_gap-decomposition.mjs` |
| 被验方（非提权，298 s） | 84,739,954,367 B = **78.92 GiB** / 470,064 文件 / 打不开 103 | 同脚本非提权跑 |

⇒ 提权轮的总数**超过整块卷的物理容量 13.78 GiB**。这与口径之争无关：任何口径的"已用"都不可能大于容量，
这个数**按构造就是错的**。非提权轮（78.92）也已经盖过卷级已用（76.85），而它连 SVI 和 103 个目录都没算进去。

### 10.1 为什么必须换事实源

`scripts/oracle.mjs`（`Get-ChildItem -Recurse -Force | Measure-Object Length -Sum`）与被验方**同口径**：
同样逐目录项计数、同样取表观大小。所以 §9 那句"三轴逐字节相等、Δ 全部点名"**证明不了总数对**，
只证明两边共享同一个盲区 —— 硬链接按名重复计在这条对账里两边同时犯、互相抵消。

能拆开这笔账的独立轴只有两个：`stat` 的 **nlink/ino**，和 MFT 的**逐记录**视图。前者这次给了答案（10.2）；
后者在本轮顺带撞出自己的缺陷（10.4），所以**目前只有 nlink 这一条轴可用**。

### 10.2 硬链接重复计 = 14.418 GiB（实测，`scripts/_nlink-audit.mjs`，提权，102 s）

逐名 `lstat(bigint)`，按 `(dev,ino)` 去重：

```
文件 535,749 个名
Σsize 逐名                 90,208,416,896 = 84.013 GiB
  其中单名文件 438,913 个              = 59.633 GiB
  其中参与硬链接的 96,836 个名          = 24.380 GiB
Σsize 每个链接组只取一份（41,610 组）   =  9.962 GiB
⇒ 硬链接重复计                          = 14.418 GiB      （nlink 直方图 2:34,212 3:4,048 4:2,310 … 21:1）
   链接组里"没被扫到的名" = 0 ⇒ 重复计完全落在被验方的覆盖范围内，不是外部链接的假账
```

**两跑之间的 9.77 GiB 已点名**：本探针的 `lstat` 打不开卷根那几个系统文件（正是 `core/fs/finddata.ts:6`
"地图合计比盘上已用少 9.05 GB"那批、也是被验方靠 finddata 兜底的那批）。`Get-ChildItem C:\ -Force -File`
读出 `pagefile.sys 10,570,670,080`（9.845 GiB）+ `swapfile.sys 16,777,216` = **9.861 GiB**，
84.013 + 9.861 = 93.874 vs 被验方 93.78 ⇒ 余 0.09 GiB = pagefile 是活动文件、两跑之间自己在长。

### 10.3 超额分解（对卷级已用 77.21 GiB，被验方超额 16.57 GiB）

| 项 | 量 | 状态 |
|---|---|---|
| 硬链接按名重复计 | **+14.418 GiB** | 实测、精确、占超额 **87%** |
| 表观大小 vs 簇分配（Compact OS 压缩 / 稀疏 / 簇取整） | **≥ +2.25 GiB** | 下界。去重后表观 79.456 − 已用 77.21 = +2.25，而这一项还要与下一行**反向**抵消，所以压缩那一侧真实值比 2.25 大 |
| SVI + `$MFT` + `$Bitmap` + `$LogFile` + `$Extend`（在被验方**没算**、但在"已用"里） | −? GiB | **未量** —— 要 MFT 或备份语义才拿得到，见 10.4 |

**对那份外部分析的裁定**（四条嫌疑，逐条对代码/实测核过）：

- **junction/符号链接跟随 —— 否。** `core/fs/winenum.ts:450` `kindOf` 先判 `FILE_ATTRIBUTE_REPARSE_POINT`
  归 `other`，`core/scan/walk.ts:195` 不跟随不计数；真造 `mklink /J` 的 `tests/integration/winenum-real.test.ts:57`
  与计数闭合 `tests/integration/attrs-real.test.ts:85` 钉着。
- **硬链接重复计 —— 是，且是主犯（14.4 GiB）。** 但它给的"嫌疑最大"的**理由**是错的：它猜 WinSxS↔System32，
  实测 Top 是 Edge 包存储 —— `EdgeCore\155.0.4283.45\msedge.dll` 4 个名 × 0.329 GiB = **+0.987 GiB**、
  `EdgeWebView\154.0.4258.62\msedge.dll` 4 个名 = **+0.978 GiB**、`WindowsApps\...Photos...\mager.onnxe` 2 个名 = +0.282 GiB，
  WinSxS 的 `msedge.dll` 才排第 4（+0.265 GiB）。
- **表观 vs 占用 —— 是，但是设计如此**（§1 口径行、`docs/acceptance/2026-09-25-phase0-3.md:38` 已对用户披露；
  本机 Compact OS：System32 逻辑 2.46 GB / 占用 504 MB）。它是第二项，不是第一项。
- **1000 vs 1024 —— 是标签问题，不是差额来源。** `shared/format.ts` 全仓一处、统一 1024 进制却标 "GB"，
  所以顶部总数与 Top-10 不可能互斥；代价是 1 "GB" 比厂商标称大 7.4%。
- 另纠正一处：`hiberfil.sys`/`pagefile.sys`/`$Recycle.Bin` **不是被静默吞掉**，是 `core/scan/scanner.ts:197`
  故意计入（`collectShallowFiles`）；按名跳过的只有 `core/fs/errors.ts:22` 那两个。

### 10.4 顺带撞出来的：`core/ntfs/volume.ts` 只读到 MFT 的 12%

同一次提权跑里 MFT 半边打印 `visited 109,560 / unparsable 716,369 / blank 61,111`（三者相加 = 887,040 = `recordCount`，
所以不是"少读了"，是**读到了却解不出来**）。两条证据说明这不是"这台机器 MFT 就是小"：

1. 在用记录 109,559 条，而卷上可枚举条目 ≥ 646,190（被验方自己报的 535,659 文件 + 110,531 目录）—— **至少漏 83%**。
2. `visited` 只占 887,040 个槽位的 12.3%，且解得出的部分集中在开头 109,560 × 1024 B = **107 MiB** 之内。

根因假设：`boot.ts:102` 的 `mftByteOffset = mftLcn × clusterSize` 只是 `$MFT` 的**起始**簇，
`eachMftRecord` 从这里按 `n × bytesPerFileRecord` **线性**推偏移，隐含"`$MFT` 在盘上是一段连续区"；
而全仓没有任何 data-run 解码。**这条假设尚未证实**：探针里 `fsutil file queryextents C:\$MFT` 那段
正则没匹配上输出，打出来的 `extents = 0（连续）` 是**解析失败、不是证据**，别拿它当反面结论。
要坐实得重跑一次并把 extents 原文打出来（顺带验证"失败是不是从 107 MiB 处整齐开始"—— 现在手里没有逐条数据，
只有总数，所以"整齐截断"这一条也只是形状可疑，不是已证）。

连带后果（必须记账）：`core/ntfs/mft.ts` 注释里那批"本机真卷实测"数字（"扫 100,344 条记录、
56,194 个非驻留 `$DATA`、925 条带 `$ATTRIBUTE_LIST`、`$MFT` 长度 908,328,960"）**全部出自这个 12% 的偏样本**，
MFT 模块"已用真卷验证过"这个状态比文档声称的弱得多。修它之前，MFT 路线（含 10.3 第三行未量的那笔）不能用。

### 10.5 本轮改了什么

- `core/ntfs/mft.ts` 暴露 `allocatedSize`（非驻留 `$DATA` 头 +0x28；驻留与目录恒 0），
  **只用于对账，不进任何界面数字**（与 §7 非目标一致）。6 条新单测；变异 `+0x28 → +0x30` → 2 条红 → 还原 `git diff` 干净。
- `src/renderer/components/Breadcrumb.tsx` 顶部总数加口径标签（原先只有 `formatBytes(currentSize)`，
  而 `DetailPanel`/`FileTable`/treemap tooltip 三处都写了「表观大小」—— 就这一处漏标，
  于是 `C:\ 92.4 GB` 被读成"C 盘用了 92.4 GB"）。**这是止血，不是修好。**
- 真正的修法是规格 §5.2 的 **M2 协议 v2（+AllocationSize +FileId）**：`FileIdBothDirectoryInformation`
  一次 `NtQueryDirectoryFile` 就同时给 FileId 与 AllocationSize，**不多花 syscall**，
  够把 10.3 的 87% 直接消掉。代价：树聚合、`fixture-scan`/`reconcile-winenum` 的逐字节平价判据、
  以及"同一份字节归谁"的产品裁定（先遍历到的算数）都要连带重对。

## 11. walk 档并行化（scan_parallel）真机对照（2026-10-18 · M5 验收）

平台：Windows x64 / 8 逻辑核 / NVMe。被测：`crates/scanner` 的 `scan::scan_tree_with`（单线程对照）
与 `scan_parallel::scan_tree_parallel_with`（两阶段并行：A 并行建树 + B 单线程 canonical fold）。
跑手：`tests/walk_parity.rs` 的 `bench_real_machine`（`DC_BENCH_ROOT=d:\DeepClean\src-tauri\target`，release）。

| 轮次 | 耗时 | files | dirs | bytes_counted |
|---|---|---|---|---|
| 单线程 | **727 ms** | 44,841 | 2,977 | 20,239,720,616 |
| 并行 #0 | **349 ms** | 44,841 | 2,977 | 20,239,720,616 |
| 并行 #1 | 391 ms | 44,841 | 2,977 | 20,239,720,616 |
| 并行 #2 | 386 ms | 44,841 | 2,977 | 20,239,720,616 |

- **加速 ≈ 1.9–2.1×**。8 核只拿到 2 倍：目录枚举是元数据 I/O，单卷 NTFS 的元数据并发
  本身有上限（MFT 记录读放大），这不是线程池的问题 —— 与 SpaceSniffer 的实测形态一致。
- **等价**：3 轮并行全部与单线程**递归逐字段相等**（含 Top 表顺序、跳过样本序）。
  合成夹具（~2,500 文件 + 硬链接 + junction + 深链 + 存储截断）5 轮 + 窄参 5 轮 + 零上限 1 轮同绿。
- **两条给后人的坑**（都在测试里钉了）：
  1. NTFS 目录 LastWriteTime 在文件写入后**惰性回填**，触发条件是"该目录被打开"——
     睡 200ms 没用，递归开过一遍才有新值。两趟对照之间若有目录时间戳漂移，测的是 NTFS
     落账时机而不是扫描器。所以对照前必须先吃一趟**热身扫描**。
  2. 首次真机对照（无热身）报"树逐字段不等"，分歧点正是刚被 cargo 编译写过的
     `target\release\deps` 的 mtime —— 与上面的坑同源，修热身后三轮全绿。

## 12. scan_one 双模对账跑手（2026-10-18 · MS6）

`examples/scan_one.rs` 新增 `--mode=walk|mft|auto`：

- `walk`（默认）：目录枚举并行档（与产品同路），原样打 JSON，`--out` 兼容提权流程。
- `mft`：MFT 直读档；`probe_mft` 不过（非盘符根 / 非管理员 / 非 NTFS）退出码 4。
- `auto`：probe 过了就**同卷双跑**（MFT 一趟 + walk 一趟），把
  `Δ = mft_counted − walk_counted` 逐项分解；probe 不过回退 walk 单趟。不落 JSON。

对账分解口径（字节全部从 MFT 树的真实节点读出）：

```
+ $METADATA 元文件   （walk 看不见；meta_records 条）
+ $ORPHANS 孤儿      （walk 不可达；orphan_records 条）
+ ADS 备用流          （walk 目录项里没有 ADS；ads_bytes）
+ 名单跳过内容        （SKIP_ALWAYS：SVI / DumpStack.log.tmp —— MFT 档不按名跳）
= 已解释合计
残差 = Δ − 已解释     （驻留取整：MFT 驻留 alloc=0 vs walk 目录项分配值；
                       两趟之间磁盘自身变动；walk.denied 条目的 MFT 侧字节）
unaccounted = |残差| / mft_counted，验收线 < 1%
```

非提权 shell 实测（`d:\` 全盘，debug build，仅验证出口与 walk 侧账目）：

| 项 | 值 |
|---|---|
| probe 判定 | `NeedsElevation` → 正确回退 walk 单趟 |
| files / dirs | 2,044,969 / 44,591，错误 0 |
| bytes_counted | 384,019,559,920（卷已用 387,306,590,208） |
| unaccounted（walk 自身） | 3.29 GB ≈ **0.85%**，`accounting_ok=true` |
| workingset / peak | 279 MB / 405 MB |

MFT vs walk 的对账数字需**提权终端**真跑（MFT 直读裸卷要管理员）：

```
cargo run --release --example scan_one -- "d:\" --mode=auto
```

### 12.1 提权双跑对账（2026-10-18，真机 D:\，release）—— MS6 验收通过

| 项 | MFT 档 | walk 档 |
|---|---|---|
| wall | 50,301 ms | 26,551 ms |
| workingset / peak_rss | 285 MB / **1.45 GB** | 575 MB / **1.45 GB** |
| files / dirs | 2,045,226 / 44,597 | 2,045,226 / 44,597 |
| counted | **387,120,971,776** | 384,447,786,704 |
| 卷已用 | 387,708,637,184 | 同左 |

对账分解（Δ = mft − walk = **+2,673,185,072**）：

```
+ $METADATA 元文件    2,988,642,304 （15 条）
+ $ORPHANS 孤儿               8,192 （5 条）
+ ADS 备用流             57,507,840 （175 条）
+ 名单跳过内容              20,480 （SVI）
= 已解释合计          3,046,178,816
残差                     -372,993,744 （驻留取整 / 两趟间盘面变动 / reparse 侧字节）
unaccounted = 0.096% < 1%  —— 通过（walk 自身对卷级：未计入 3.26 GB，自洽）
```

真机暴露并修掉**三个记账 bug**（前两个被 `mod.rs` 哨兵拦截 counted=802GB，第三个被本对账跑手拦下 2.773%）：

1. **`$BadClus:$BAD`（记录 8）**：带名流 sparse 名义映射整卷（ads_alloc = 411,592,290,304 =
   卷容量一位不差）。`tree.rs::rec_alloc` 整条归 0 兜底 + ADS 报数排除；夹具改真机形态钉回归。
2. **sparse 流头字段报名义值**：`+0x28` 对 sparse 流报含 sparse 段的名义值（`$UsnJrnl:$J`
   报 3.88 GB、实占近 0）。`record.rs` 解析层对非驻留流解 run list，`data_alloc_clusters /
   ads_alloc_clusters` = Σ 有 LCN 段的簇数；解不动回落头字段。普通流重算与头字段相等，无损。
3. **碎裂流重算必须分片求和**：run list 只盖**本记录**那段 VCN；流被 `$ATTRIBUTE_LIST`
   切进扩展记录时（大而碎文件的常态，D:\ 扩展段 Σ=11.03 GB）合并只认 VCN=0 段 → 扩展段
   全丢，首跑 unaccounted=2.773%。`apply_extensions` 尾部按分片求和（各段 VCN 不相交），
   任一段解不动回落 VCN=0 段头字段（仍报全流）。修复后 counted +8.66 GB → 0.096%。

旁证：扩展丢=0；两跑之间盘面自身在动（编译/测试在写 target），孤儿 20,413→5、损坏 6→4；
在用记录中仍有一批无名无数据的记录既不进树也不进孤儿，残差 −0.37 GB 为其字节上界（<0.1%）。
