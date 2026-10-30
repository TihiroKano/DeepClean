# M6 出包前置第 3 道闸：真扫整卷 C:\ —— 以及我自己的 TEMP 覆盖造出的一次假回归

日期 2026-10-17 ｜ 分支 `v0.7-dev-env` ｜ 执行：B 角
上游：用户 2026-10-14 立的两道进入条件之一「打包之前必须先跑一次本机扫描并核对文件数一致」
（`docs/superpowers/plans/2026-10-14-deepclean-tauri-m5-p3.md` 之外的另一处：
 `.superpowers/sdd/2026-10-14-p4-wave/m6-packaging-plan.md:394`）。

被验方 = **release** 真扫整卷 `C:\`，不是夹具。命令与 `golden.rs:93-95` 同一条
（`#[ignore]`，`DC_GOLDEN_ROOT` 默认就是 `C:\`）。

---

## 〇、结论

| 闸 | 读数 |
|---|---|
| `cargo test --release golden_reconciliation_on_this_machine -- --ignored` | **1 passed / 0 failed**，`GOLDEN_C2_EXIT=0`，196.89 s |
| 反例闸 | **零命中** —— 没有任何 finding 的地盘落在 Program Files / Windows / 回收站 |
| `safety_blocked` | `false` |
| C: 树 | **476,422 files / 87,055 dirs**（总 80.00 GiB，可用 2.92 GiB） |

⇒ **这条进入条件达成**，出包的前置满足。

---

## 一、三个组（与 run10 的口径逐字对齐，可直接对表）

| 组 | run10（10-14） | run11（10-17，本轮） |
|---|---|---|
| 既有 15 条基线 | 1,349.00 | **2,552.83** |
| M5-P1 那六条 | 9,363.94 | **8,630.33** |
| 第 22 条 orphan-app-data | 361.95 / 1,251 文件 / roots 17 | **361.95 / 1,252 / 17** |

三条要逐条说清，不许一句"磁盘漂移"盖掉：

1. **第 22 条 361.95 MiB / 1,251→1,252 / roots 17 三条全对上**，M5-P3 那次前移的账
   在真机上**复现了**。这是本轮最重要的一格：它证明 `33d5022` 那个改动在整卷 C: 上
   稳定，不是夹具上的巧合。
2. **既有 15 条 +1,203.83 MiB** 的绝大部分是 `windows-temp`（0 → 1,242.20 MiB / 19,879 文件）。
   **这不是真回归，是我自己的环境造成的**，见 §2。
3. **M5-P1 那六条 −733.61 MiB**：`installer-artifacts` 3,662.58 → 3,080.55（−582.03）。
   这一格**我没有归因到根因**，只核到"下载目录里那批安装包被清走/移动了会得到这个方向"。
   因为 `installer-artifacts` 的采集面是用户目录，我不打算为了对账去动它。
   **如实登记为未归因**，不写成"正常漂移"。

---

## 二、一条**我自己造的假回归**，以及它怎么被抓住的

### 2.1 现象

第一次跑（`golden-c1.log`）出来是：

```
[旧] windows-temp    Safe files=0    0.00 MiB roots=0
既有 15 条基线 = 1310.63 MiB
```

而盘上 `%TEMP%` 实测 **19,878 文件 / 1,200.4 MB**（Python 走 `SHGetFolderPathW`，
不经环境变量量的）。
⇒ "规则坏了"与"基线掉了一条"两个结论同时摆在眼前。

### 2.2 根因：是我命令里的 TEMP 覆盖

那条命令为了不让 C: 只剩 2.92 GiB 时 `dlltool` 写不出临时文件而假报代码错
（`m6-packaging-plan.md:407-408` 记过：C: 剩 3.2 G 时 `cargo test` 报
`dlltool could not create import library`），写了：

```powershell
$env:TMP='D:\dc-tmp'; $env:TEMP='D:\dc-tmp'; $env:TMPDIR='D:\dc-tmp'
```

而 `windows-temp` 的采集面是 `paths: ['%TEMP%']`（`core/rules/registry.ts`）。
于是扫描器去扫 `D:\dc-tmp`，那棵树**不在** `C:\` 里面 ⇒
`windows-temp` 名下只有一条排除记录：

```json
{"ruleId": "windows-temp", "path": "D:\\dc-tmp", "reason": "not-scanned",
 "detail": "本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）"}
```

⇒ **不是产品缺陷，是我的环境把采集面挪走了。**

### 2.3 判据：改回真 `%TEMP%` 重跑，看见它回来

同一棵树、同一条闸，只把三件套指回 `C:\Users\…\AppData\Local\Temp`：
`windows-temp` = **19,879 文件 / 1,242.20 MiB**，基线从 1310.63 → 2552.83
（+1,242.20，与那条规则的字节数**逐位相同**）。
两次的 `files=476422` 完全相同（`dirs` 87,051 → 87,055，+4 是 Temp 树的目录）。

⇒ 归因是**复现出来的，不是推理出来的**。

### 2.4 这一条留给我们自己的教训（不只是"改回来了"）

`%TEMP%` 这类**环境变量驱动的采集面**有一个失效形状：
为了构建稳定性而改临时目录，会**连带改掉被验产品的行为**，
而症状长在"规则少了一条"上，不在构建上。
下次跑这条闸，TEMP 三件套要与**真实用户会话一致**；构建期的临时目录另外想办法
（本轮 cargo 的 toolchain 变量 `TMPDIR` 与产品读的 `TEMP` 不是同一个需求，
但我在同一条命令里把它们一起改了，这就是漏洞本身）。

---

## 三、顺带：C: 真的在满

两次量到的都是 **总 80.00 GiB / 可用 2.92 GiB**。
树从 run9 的 393,660 文件涨到本轮 **476,422（+21%）**，与余量下降到 2.92 GiB 同向。

这与出包直接相关：212 MB 那个包里含 214 MB 的 WebView2 运行时，
NSIS 的 LZMA 固体压缩峰值占用高于输入总和，而 C: 只剩 2.92 GiB。
下一棒真要重打包时，**先把 NSIS 的临时目录指到 D:**（D: 余量 28.95 GiB），
不要照抄"上次在 C: 上压成功了"。

---

## 四、这一轮没做的

- **没有出包**。用户说的是"setup 之前有个 C 盘扫描的前置"，前置本轮已达成；
  但 `npm run build:tauri` + `cargo build` + `npx tauri build` 那一串我没跑
  （前端 `dist` 目前落后于 `shared/format.ts`，是 `68c8d1a` 留下的）。
  要出包等下一棒，并且按 §3 先处理 C: 余量。
- **`installer-artifacts` −582 MiB 未归因**（§1.3）。
- **`recoverable` / 弃权 225 条（Present 128 + Unknown 97）没逐条看**，
  那要读 `target/m5-p-golden-report.json` 全文，本轮只做了汇总对账。
