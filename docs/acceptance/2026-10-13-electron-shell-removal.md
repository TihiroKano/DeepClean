# 2026-10-13 · 删除 Electron 壳（只清壳，对账基准留着）

人类伙伴的指令是「Electron 版的全部清掉」。执行时按现查的依赖收窄成了**只清壳**，
理由不是保守，是**这个仓库不是两半**：

- `src/renderer/`（Tauri 正在用的界面）引 `core/` **32 处**，其中是运行时代码不是类型 ——
  `TreemapCanvas.tsx:3` 的 `toTiles`（squarify 布局本体）、`DetailPanel.tsx:3` 的 `buildDetail`、
  `MapControls.tsx:1` 的 `MAX_SCALE/MIN_SCALE`。删 `core/` ⇒ `npm run build:tauri` 当场解析不出来。
- 6 个 Rust 对账目标现起 `node` + `esbuild` 跑 TS 当基准（`crates/{rules,cleaner,devenv,dupes}/tests/*parity*.rs`
  + `scripts/parity-{tree,rules,preview,gate}.mjs`），它们是 M3-A / M3-B / M5 / M5-B / M5-D 那批
  "零容差"结论的唯一裁判。
- 反向依赖为零（`core/` `src/` `shared/` 里引 `electron/` 的文件数 = **0**）⇒ 壳可以整块摘掉，
  这正是"只清壳"能成立的前提。

## 1. 删了什么（36 个文件、10,604 行）

| 类别 | 内容 |
| --- | --- |
| Electron 主进程/服务 | `electron/` 全部 11 个文件（main、preload、5 个 service、logger、shot-fixture） |
| 构建配置 | `electron.vite.config.ts`；`package.json` 的 `main`、`dev/build/start/dist/dist:portable/dist:setup/build:scanen/test:integration` 七条脚本、整个 electron-builder `build` 段、三个 devDep（`electron`/`electron-builder`/`electron-vite`） |
| Electron 侧渲染入口 | `src/renderer/index.tsx` + `index.html`（Tauri 入口 `tauri-main.tsx`/`tauri.html` 留着） |
| winenum 子系统 | `core/fs/winenum.ts`（winFs 与身份探针的本体）、`tools/scanen/scanen.cs`、`scripts/build-scanen.mjs`、`scripts/reconcile-winenum.mjs` |
| 只测壳的用例 | 15 条按 import 精确判定引 `electron/` 的（`clean-ipc`、`clean-journal-service`、`detect-env`、`devenv-model-tally`、`docker-detector`、`drives`、`dup-chain`、`logger`、`rules-detector-wiring`、`scan-service`、`scan-service-winenum`、`settings`、`shot-fixture-guard` + `tests/integration/{clean-e2e,clean-real}`），另加 `winenum-client`、`winfs`、`winenum-real` 三条随子系统一起走 |
| 未跟踪的产物 | `out/`、`resources/`（`resources/scanen.exe` 的构建入口已删） |

**判据是 import 而不是"文件里提到 electron"**：按后者数会得到 19 条，其中 4 条
（`clean-journal`、`dup-hardlink`、`tree-store-ext-counter` 等）其实只测 `core/`，
照那个数删就把**留下的基准**自己的单测删掉了。`clean-journal.test.ts` 那条
"`outcome` 默认拒绝"的全仓惯例闸因此活着。

## 2. 留着不动的东西（以及为什么它不是"垃圾"）

| 东西 | 留下的理由 |
| --- | --- |
| `core/`（除 winenum） | 两个身份：`core/analyze/*` 是 Tauri 渲染端的**活代码**；其余是 6 条跨语言对账的**基准**。它的 49 条 `core`-only 单测一起留着 —— 基准没有自己的单测，就等于裁判可以被悄悄改错 |
| `shared/`、`src/renderer/` | Tauri 产品的源 |
| `build/icon.png` + `icon.ico` | 图标的**母版**（1104² RGBA）。Tauri 的 bundle 图标是 `src-tauri/icons/icon.ico`，而 `tauri.conf.json` 只指它；M6 出包要重出多尺寸时母版是唯一源。删两个文件省不了什么，代价是 M6 重新画 |
| `.scan-cache/` | 不是缓存垃圾：`scripts/parity-preview.mjs` 的 esbuild 输出目录，也是 tsbuildinfo 新落点（`out/` 没了） |
| `fixtures/`、`D:\deepclean-fixture\f100k` | 被 SDD 记录与 M5-F/M5-M 的对账数字引用（f100k 是 89,801 文件那棵静侧三轴夹具，重建很慢） |
| `D:\dc-license-vault` | **1000 个真码的明文清单只在这里**（仓库外，删了不可回滚） |
| `D:\dc-tmp` | `crates/dupes/src/policy.rs` 的注释按路径引用它里面的 rank-6 探针（`probe-rank6c/d.cjs`） |
| `DeepClean_项目实施书.md` 的原始 zip | 规格书出处，8 KB |

## 3. 两条闸因为删除而红，处置是"改指"不是"删断言"

1. **`outcome` 默认拒绝闸**（`tests/unit/clean-journal.test.ts`）红在 `scandir 'electron'`。
   处置：扫描面从 `['core','electron','src','shared']` 收窄成 `['core','src','shared']`，
   并同步改掉文件头与 describe 头里那句"扫描面含 electron"（注释写假话比注释旧更坏）。
   它的反空跑 `files.length > 40` 原样保留 —— 这条闸的牙齿在"每处提及都要在豁免清单上点名"，
   不在目录数量。
2. **「真实读数只在服务层」**（`tests/unit/dup-hardlink.test.ts`）红在
   `ENOENT: electron/services/dup-service.ts`。这条钉的职责（"§20 的硬链接账必须有人在 core 之外
   注入真读数，不然永远'没量过'"）**没有消失，只是搬家并换了更强的形式**：
   生产注入点 = `src-tauri/src/dupes.rs:316` 的 `StatLinkProbe`，判据 =
   `crates/dupes/tests/smoke_real.rs` 那条真硬链接用例（同 inode 并簇、独立拷贝不许并进来、
   造不出硬链接当场失败）。**没有**改成"TS 测试去 grep Rust 源码"—— 那比真跑一遍弱。
   原位置留了点名注释说清去处，不留空壳。

## 4. 闸口（删除后重跑）

| 闸 | 删前 | 删后 |
| --- | --- | --- |
| `cargo test --workspace --no-fail-fast` | 536 passed / 1 failed（回收站那条被 C: 满挡住） | **537 passed / 0 failed**，`CARGO_EXIT=0` |
| `npm test` | 1216 passed / 76 files | **987 passed / 61 files**（−229 条随壳走，−1 条改指 Rust） |
| `npm run typecheck` | 0 | 0 |
| `npm run build:tauri` | — 没单独跑过 | **exit 0**，产物 `src-tauri/dist/`（这一条是"core/analyze 还活着"的直接证据） |
| 6 条跨语言对账 | 绿 | **绿**（基准没被伤到的判据） |

> M5-N 验收 §6 第 1 条（回收站那条红）在这一跑里自己好了 —— C: 从 3 MB 缓到 2.1 GB 后
> 计数不再漂，537 全绿。那条"未闭合"就此结掉。

## 5. 这次删除新造出的悬空引用（不打算回头改 22 份文档，在这里一次性登记）

- **`--shot` 那 41 步截图判据**：本体在 `electron/main/index.ts`，已删。
  `docs/` 里 **22 个文件、113 行**提到 `--shot`（含 V0.5/V0.6/V0.7/V0.9 那几份验收的判据编号）。
  读法：那些步骤号是**当时**的证据记录，今天不可重跑；Tauri 侧的对应物是
  `scripts/m3-e2e-cleanup.ps1`、`m5*-e2e.ps1` 这一族真机脚本（它们不依赖 Electron）。
- **`electron/` 路径**：`docs/` 里 **36 个文件、235 行**提到 electron（多数是叙述"改在主进程"这类
  历史语境，少数按文件路径引用被测物）。按路径找不到的那几处，就是本次删掉的壳层文件。
- **winenum 里程碑**（`docs/acceptance/2026-10-10-winenum-m1.md`、
  `docs/superpowers/plans/2026-10-09-winenum-m1.md`）：它的代码与三个复现工具全删，
  那份验收现在只有文字与数字，**跑不出原来的判据**。它的产出没有丢 ——
  M1 的 Rust 内核就是它的替代（`FileIdBothDirectoryInfo` 一次遍历同取文件 ID 与分配大小）。
- **两个 gitignored 探针**（`scripts/_elev-scan.mjs`、`_gap-decomposition.mjs`）还引着已删的
  `core/fs/winenum` ⇒ 它们现在跑不通。刻意留着没删：`docs/benchmarks/results.md` 与 winenum 验收
  按名字引用过它们，删了就把"当时怎么量出来的"这条线索也剪掉了。
- **`package.json` 少了七条脚本**：任何写着 `npm run dev` / `dist:portable` / `dist:setup` 的记录
  （含 `2026-10-09-setup-exe.md`、`2026-10-08-app-icon.md`、图标与安装包那几条记忆）
  现在都指向不存在的命令。桌面 `DeepClean.lnk` 早在 2026-10-11 清 `dist/` 时就已失效。

## 6. 一句话规矩（给下一棒）

`core/` 与 `shared/` 从今天起**只有一个身份：对账基准 + 渲染端活代码**，不是产品、不是"另一套实现"。
往 `core/` 加东西要先回答"它是给谁跑的" —— 只给 Electron 跑的东西已经没有地方跑了。
