# 2026-10-21 · 垃圾清理页版式重构（照图二那套骨架，色彩保留原样）+ 四处修复

## 第四轮（人类伙伴：Loading 放中间放大 + 白色，且首次打开只加载一次）

> 「我的建议是 loading 和加载特效放在中央。现在的逻辑是点击垃圾清理出现 loading，然后界面出来了，
>  loading，自动清理执行自动打勾。我需要优化成首次打开 Loading 加特效放中间放大些
>  （loading 用白色字体），然后界面出来就是自动打勾的页面。」

### ① 那"两段加载"到底是什么

拆开是三个瞬间，中间那个是缺陷：

| 时刻 | 发生了什么 | 用户看到 |
|---|---|---|
| T1 | 进页面，`selected` 还是空的 ⇒ 第一次 `previewCleanup` | Loading |
| T2 | 回包（**全未勾选**的模型）⇒ 画出来 | **一版"什么都不勾"的页面** ❌ |
| T3 | 自动打勾 effect 填 `selected` ⇒ 第二次请求 ⇒ 回包 | 又一段 Loading，然后才是对的那页 |

T2 那一版不但是多余的，还让人以为"清理页默认什么都不勾"。

**修法**：把「这一份模型是否已反映当前勾选」变成可判的事实 —— `modelMatchesSelection`
（逐条对 `PreviewItem.selected`，那是服务端按 `selection` 算出来的，`preview.ts:218`）。
对不上就不画内容，居中 Loading 继续占着 ⇒ 用户看到的第一次画面就是**已打勾**的那一页。

⚠️ 判据**不能用 `digest`**：它覆盖的是账目字段（字节/文件数），不覆盖"谁被勾了"，
拿它比会得到"勾选变了而 digest 没变"，过渡态永远认不出来。

### ② 居中 Loading 的门必须开在"用户还没动过勾选"上

第一版没有这道门，真机直接红：`flashes=3`。原因 —— `modelMatchesSelection` 判的是
"模型与当前勾选对得上"，而**用户每点一次复选框，模型都会短暂对不上**，于是居中 Loading
在每次勾选时都盖回来，正好违反上一轮"勾选不闪"那条要求。

现在：`settling = Boolean(model) && !autoFilled.current && !modelMatchesSelection(...)`。
两段各有各的门，互不干扰：

| 场景 | 谁负责 | 结果 |
|---|---|---|
| 首屏（自动打勾那一次） | `settling` | 盖住中间物，一次加载直达成品 |
| 用户手动勾选之后 | `shouldShowLoading` | 不闪，旧数字继续显示、新数算完替换 |

### ③ 位置 / 尺寸 / 颜色

| 项 | 上一版 | 现在 |
|---|---|---|
| 位置 | 工具栏里的一格 | `.dc-revalue-stage` 占满内容区、`place-items: center` |
| 点阵 | `--uib-size: 34px` | **64px** |
| 文字 | `12px`，跟 `--accent` 走（偏蓝） | **18px**，`#ffffff` |
| 颜色 | 点 `var(--accent-2)` | 点与字都是 **白** |

![居中 Loading](docs/acceptance/assets/cleanup-layout-loading-centered.png)

### 判据

`modelMatchesSelection` 的 9 条在 `tests/unit/cleanup-settling.test.tsx`（含三条反面对照）。
**变异已验**：把逐条 `selected` 对账删掉（只比 id 集合），5 条同时红。

真机侧（`COLD_EVIDENCE` 那一行是冷进第 30ms 采到的实测值）：

```
COLD_EVIDENCE {"text":"Loading","dotCount":16,"hasOldBar":false,"inStage":true,
               "stageCentered":"center","color":"rgb(255, 255, 255)",
               "dotSize":"64px","fontSize":"18px","atMs":30}
AFTER_CLICKS  {"has":false, ...}  flashes=0        ← 勾选/取消/再勾，零次再现
```

**登记一处没验到的**：那张居中图是**注入同构副本**拍的 —— 真实那一次只活几十毫秒，
`PrintWindow` 也按不住它。所以"长什么样"由注入图证明，"何时出现/是否居中/白不白/多大"
由上面那行 `COLD_EVIDENCE`（真时序采样）证明，两件事分开取证，不混为一谈。

**顺带记一条工具坑**：`SetForegroundWindow` 在这台机器上拿不到前台锁（本仓 m6 那几棒反复撞过），
所以"先顶窗再截屏"在无人值守时会**拍到别人家的窗口**（本轮第一次就拍到了一屏浏览器）。
为此新增 `scripts/lib-dc-printwindow.ps1`：走 `PrintWindow(flag=2)` 让目标窗口自己画进 DC，
不依赖前台；出图后还量一次非黑像素比例（实测 98.8%），低于 2% 直接拒收，
免得把一张全黑图当证据。

---

## 第三轮（人类伙伴：勾选不再闪 Loading + 换成 16 点动画）

> 「当前栏首次取消勾选都会重新进入 loading。这个能优化吗？只在第一次进入垃圾清理页面加载就好。
> loading 用这串代码的动画。」

### ① 勾选不再闪 Loading —— 改的是 `loading` 的**语义**，不是展示

根因：这个 hook 的 `loading` 一直表示「**这一次请求在飞**」。而勾选/取消一条就会触发一次
重新计价（单条内存 IPC，毫秒级），于是每次点击都在工具栏旁边闪一下 —— 那一闪恰好发生在
刚点完复选框之后，读起来像卡了。

现在它表示「**这一页还没有任何预估可显示**」，判据抽成纯函数 `shouldShowLoading(hadAnyPreview, isPending, cacheHit)`：

| 情形 | 旧行为 | 现在 |
|---|---|---|
| 冷进页面（缓存没有） | 显示 | **显示** |
| 勾选 / 取消勾选后重算 | 显示 ❌ | **不显示**（静默替换数字） |
| 切页回来 / 命中缓存 | 不显示 | 不显示 |
| 换一次扫描（新会话） | 显示 | 显示（`hadPreview` 随 `scanId` 重置） |

**代价如实登记**（人类伙伴 2026-10-21 选 A 时已确认）：勾选之后统计带与「计入预估」那一列会有
几十到几百毫秒的滞后，那段时间屏幕上没有任何"在等"的提示。宁可数字慢半拍，也不要在复选框旁边闪动画。

### ② 换成 16 颗点跳动的动画

从原作照抄几何（16 条 `nth-child` 的位置 / 延迟 / 缩放、`@keyframes jump` 的 ±120% 位移），只改三件事：

| 改动 | 原作 | 这里 | 理由 |
|---|---|---|---|
| 类名前缀 | `.container` / `.dot` | `.dc-jump` / `.dc-jump-dot` | 那两个通用类名进全局样式表会和任何叫 container 的东西撞 |
| 颜色 | `--uib-color: black` | `var(--accent-2)` | 深钴蓝底上黑色等于看不见 |
| 尺寸 | `--uib-size: 60px` | `34px` | 它现在挂在工具栏里，不是整屏主角；几何全是比例算的，缩小后同构 |

16 颗点用 `Array.from({ length: LOADING_DOTS })` 生成而不是手写 16 个 `<div>`：
手写会让"少画一颗"变成静默的视觉缺陷，而 `dots.length === 16` 是可断言的（真机上已量）。

![16 点 Loading](docs/acceptance/assets/cleanup-layout-loading.png)

### 判据（这一条的机器可读形式）

`shouldShowLoading` 的四格 + 三条反面对照在 `tests/unit/use-preview-loading.test.tsx`。
**变异已验**：把 `if (hadAnyPreview) return false` 那一行删掉（回到"每次勾选都闪"），
用例 ③ 与那条对照同时红。

真机侧（`cleanup-layout-loading-probe.mjs`）：

```
COLD_EVIDENCE {"text":"Loading","dots":16,"hasOldBar":false,"atMs":30}   ← 冷进第 30ms 打到它
BASELINE      {"has":false, ... "rows":22}
AFTER_CLICKS  {"has":false, ... "rows":22}  flashes=0                   ← 勾选/取消/再勾，零次再现
```

⚠️ 这一相的第一版判据是错的，记录下来：它用"切到 home 再切回 cleanup"构造"首次进入" ——
那一条**永远等不到** Loading，因为模块级缓存（人类伙伴 2026-10-20 要的「保存本次记录」）
让切回来的那一瞬同步命中、按设计就不该闪。真正的冷进只可能发生一次，所以现在由
`cleanup-layout-drive.mjs` 在切页那一刻 30 ms 采样写证据，探针读那份证据判 ①、
再连点三次判 ②。

---

## 追加的两条（人类伙伴第二次反馈）

> 「这个页面目前无法滑动。而且每次点击或取消勾选会出现重新计价，重新计价这段改成 Loading。」

### ① 无法滑动 —— 是我上一轮引入的回归

**根因**：这一页的滚动原先由 `.dc-table-wrap` 承担（`flex: 1; overflow: auto`）。版式从表格换成
卡片列表时，那个容器一起删了，而**没有谁接手这条职责**：`.dc-clean` 既没有 `overflow`，
也不是 flex 项（`.dc-view` 是 `display: flex; flex-direction: column`），于是 22 行里的后 18 行
在窗口下方被直接裁掉 —— 既滚不到也看不见。

**修法**：`.dc-clean` 补齐三条（与 `.dc-home` 一直以来的写法逐条对齐）：

```css
flex: 1;        /* 它才是 .dc-view 那一列里的 flex 项 */
min-height: 0;  /* flex 项默认 min-height: auto ⇒ 内容高时它不肯缩，会把父容器顶开 */
overflow: auto; /* 才真的出现滚动 */
```

**为什么 1004 个用例一个都没响**：因为**没有任何一条判据在问"这一页能不能滚"**。
现在补了两层：

| 层 | 判据 | 位置 |
|---|---|---|
| 源码 | `.dc-clean` 必须同时带那三条 | `cleanup-layout-contract.test.ts` ⑥ |
| 真机几何 | 找可滚祖先 → 把末行 `scrollIntoView` → 末行可见高度 ≥ min(半行, 40px) | `cleanup-layout-probe.mjs` 的 `scrollY` |

⚠️ **几何判据改了四版，前三版的红全是判据自己的错**（这段值得留着）：

1. 拿 `innerHeight` 当可视区 —— 容器上面压着 40px 标题条，可视区是 `[40, 578]` 不是 `[0, 578]`；
   而且它对"滚过了头"是瞎的。
2. 要求末行**整行**落在可视区内 —— 1440 档就红。不是排版坏了：末行下面还有总量条、风险分账、
   说明、确认区，滚到底时末行只剩一截是正常的。
3. 要求"滚到底时列表与可视区有交集" —— 880 档红。实测滚到底那一屏依次是
   总量条 77px + 分账 51px + 说明 50px + **禁止根长文 347px** + 确认区 76px ≈ 601px，
   而 880 档容器可视高度只有 532px：**这一页最底部那几块加起来比一屏还高**，
   滚到底时列表当然已经滚过去了。
4. **正解**：把末行 `scrollIntoView` 再看它进没进可视区 —— 这问的才是"能不能滚到列表末尾"，
   与"列表下面还有多少东西"无关。

真机实测（三档全绿）：`滚了 2983px / 末行可见 221.3/221.3px`（1440）；
`滚了 5749px / 末行可见 439.7/439.7px`（880）。

### ② 重新计价改成 Loading

原来是一整行「不确定态进度条 + 旋转环 + 正在重新计价」。现在只留**一个环 + `Loading`**：

- 挂在**工具栏那一行的原位**（计数与「全选可清理项」之间），不是页头另起一行 ——
  后者会让整页在用户刚点完复选框时往下跳一下。实测：Loading 出现前后列表 top 都是 305.3，
  **零位移**；它与按钮在同一水平带（`272.7–288.7` vs `268–293.3`）。
- 旧的 `.dc-revalue-bar` / `dc-indeterminate` 动画已整条移除。
- 首次进页面（`model` 还是 null、没有工具栏可挂）时走 `.dc-revalue-row` 那一格，两条互斥，
  不会同屏出现两个"在等"。

那一格只活几百毫秒，正常节奏截图拍不到，所以单开了一支高频采样（30 ms）的探针：
`cleanup-layout-loading-probe.mjs`，四条判据（文案 / 环 / 旧条已撤 / 不推列表）。

## 顺带补的一条闸：`scripts/*.mjs` 语法

这一轮在 `cleanup-layout-probe.mjs` 上**连续栽了七次**同一件事：那段页面代码整块放在模板字符串里，
注释里再写一个反引号就把字符串提前收口，而报错行号指向那句中文注释，看起来像注释本身有错。

所以加了 `tests/unit/scripts-syntax.test.ts`：把 `scripts/*.mjs` 逐个 `node --check`，
外加一条点名 `PROBE` 体内没有反引号的判据（红的时候一眼知道是哪段）。
变异已验：塞一个反引号进去，两条同时红。

---

## 要求与判读

人类伙伴的原话：**「垃圾清理界面UI排版重构，采用图二这种类型，但是整体色彩保留当前样式。」**

两张参考图拆开看，图一是当前实现（六列表格 + 底部总量条），图二是目标骨架：

| 层 | 图二 | 本轮落地 |
|---|---|---|
| 页头 | 标题 + 副标题 + 右侧「一键清理」主按钮 | 保留原三件，新增副标题一句 |
| 统计带 | 左环形 + 右三格数字 | 新增：环形 + 扫描项 / 可回收 / 预计可释放 |
| 条目区 | 卡片列表，每行：勾选框 + 图标 + 名称与描述 + 风险 / 占用 / 文件 / 计入预估 | 表格 → 卡片列表，字段一个不少 |

「色彩保留当前样式」落成一条硬约束：**新结构一个色值都不写死**，全部引既有 token
（`--glass-fill-quiet` / `--glass-edge` / `--glass-inner` / `--glass-specular` / `--glass-sheen` /
`--accent*` / `RISK_COLORS`）。所以面板仍是深钴蓝玻璃，不是图二那种浅色纱面。

## 统计带的取数口径（人类伙伴拍板选了 A）

三个数**全部读服务端已算好的字段，界面只做一次除法**：

| 格子 | 字段 | 说明 |
|---|---|---|
| 扫描项 | `model.items.length` | 这一趟扫到几条规则命中 |
| 可回收（报告合计） | `model.reportReclaimableBytes` | 报告自己的 🟢🟡🟠 合计 |
| 预计可释放 | `model.totalBytes` | **已勾选并计入**的合计（= 表格「计入预估」列之和） |
| 环形百分比 | `totalBytes ÷ reportReclaimableBytes` | 全选时两者逐字节相等 ⇒ 满环 |

抽成导出纯函数 `cleanupHeadline(model)`，单测直接喂模型跑（`cleanup-headline.test.tsx`）。
`reportReclaimableBytes === 0` 时给 0%，不做 0/0（NaN 会让环形静默画不出来）。
**没有第二个除法**（比如拿它比整盘容量）：盘的总量不在这份模型里，硬凑就是在界面另立口径。

## 动了什么

### 前端

| 文件 | 改动 |
|---|---|
| `src/renderer/pages/Cleanup.tsx` | 表格 → 统计带 + 卡片列表；新增导出 `cleanupHeadline` / `riskDot` / `riskText` / `categoryIcon` |
| `src/renderer/components/Donut.tsx` | 新增 `size` / `label` / `variant` 三个可选 prop（**默认值与旧实现逐像素相同**） |
| `src/renderer/styles/global.css` | 新增统计带与卡片列表的样式（+700 行，含逐条来由注释）；删掉两条变成死规则的旧样式 |

`Donut` 那条改动值得单独说明：几何按 200 px 版的比例算（`Math.round(200*0.11)=22`、
`Math.round(100*0.74)=74`），所以首页那一个像素没动，只有清理页的小环传 `size={104}`。

### 判据

| 文件 | 钉的是什么 |
|---|---|
| `tests/unit/cleanup-headline.test.tsx` | 三格取数口径、环形除法、0/0 的处置、风险符号与类别图标 |
| `tests/unit/cleanup-layout-contract.test.ts` | **别人在量的五条形状**（见下节）对版式重构不敏感 |
| `scripts/cleanup-layout-probe.mjs` | CDP 几何探针：对齐 / 溢出 / 格数 / 数字截断 |
| `scripts/cleanup-layout-e2e.ps1` | release 版真机：扫 D 盘根 → 三档宽度 → 三张图 |
| `scripts/cleanup-layout-real-e2e.ps1` | debug 版真机：11.4 MB 夹具（有真实字节）→ 两档 + 两张图 |
| `scripts/cleanup-layout-drive.mjs` | 首页驱动（切「选择位置」→ 选盘 → 点真按钮 → 等扫完） |
| `scripts/cleanup-layout-select-all.mjs` | 「全选可清理项」那一相 |

## 五条既有契约（重构不许碰，已由单测钉住）

这一页上有五条形状是**别的脚本在量的**，它们全都不在截图上 —— 版式一改最典型的坏法是
「页面更好看了，而某一棒 e2e 从此永远红在找不到元素上」。逐条登记：

| # | 形状 | 谁在读 |
|---|---|---|
| ① | 勾选框由 `.dc-clean-check` 包着、尺寸 15×15 | `--shot` 二十多步点它并读 `checked`；`m5-preview` 按 ControlType.CheckBox 取 |
| ② | 「全选可清理项」仍在，仍走 `onSelectedChange(selectableIds)` | `m3-e2e-cleanup.ps1:155`、`m5k-cleanlog-e2e.ps1:193` |
| ③ | 大号数字紧跟「预计释放」（`…10.0 MB预计释放…`） | `m5n-tile-dup-e2e.ps1:146` 的 `Read-Total` 正则 |
| ④ | 「清理预览」「预计释放」两个地标 | `m5-preview` / `m5c-tile` / `m5f-perf` 判"到了清理页" |
| ⑤ | 页头 `.dc-clean-head` 里同时有标题与那颗 `.dc-cta` | `cleanup-one-click-button.test.ts` 那一组 |

③ 那条差点被我改坏：重构时一度想把底部那个大号读数合并进统计带（"同一个数别画两遍"），
但 `Read-Total` 认的正是那个形状，改掉它那一棒会红在"读不出预估"上而不是红在产品缺陷上。
所以**总量条原样保留**，并在代码里写明原因。

## 验证

| 闸 | 结果 |
|---|---|
| `tsc -p tsconfig.web.json --noEmit` | exit 0 |
| `tsc -p tsconfig.node.json --noEmit` | exit 0 |
| `vitest run` | **67 files / 1026 tests 全绿**（版式重构前 62/987；重构 +17；滚动/Loading 修复 +12；Loading 语义 +7；语法闸 +3；居中落定 +9） |
| `cargo test --workspace` | 全部 crate 0 failed |
| `cargo build --release` | Finished，exe 15,581,696 B（内嵌新版前端） |
| release 真机 e2e | 3 格全绿 + Loading 相：1440 / 880 / 1440-勾选后 |
| debug 真机 e2e（11.4 MB 夹具） | 2 格全绿，数字念全无截断 |

探针量到的数（`D:\dc-tmp\cleanup-layout*.json`）：

```
phys=1440 css=946 统计带=True 行数=22 勾上=19 溢出=0px 对齐偏差=0px 勾选框=[15,15]
  SCROLL 可纵向滚=true 滚了=2983px 末行可见=221.3/221.3px via=div.dc-clean
phys=880  css=572 统计带=True 行数=22 勾上=19 溢出=0px 对齐偏差=0px 勾选框=[15,15]
  SCROLL 可纵向滚=true 滚了=5749px 末行可见=439.7/439.7px via=div.dc-clean
phys=1440 css=946 统计带=True 行数=22 勾上=19 溢出=0px 对齐偏差=0px 勾选框=[15,15]   ← 勾选后
  SCROLL 可纵向滚=true 滚了=2983px 末行可见=221.3/221.3px

LOADING {"text":"Loading","spinner":true,"oldBar":false,
         "loadBox":{"top":272.7,"bottom":288.7},"btnBox":{"top":268,"bottom":293.3},"listTop":305.3}
BASELINE {"has":false, ... ,"listTop":305.3}     ← 前后 listTop 相同 = 零位移
```

滚到底那一屏的实物证据：`cleanup-layout-scrolled-bottom.png`（列表末尾 → 总量条 → 风险分账 →
禁止根长段 → 确认区，全部可达）。

真实字节夹具上的读数（`cleanup-layout-real-1440.png`）：
`STATS ["22 项","3.1 MB","3.1 MB"]`，第一行 `3.1 MB / 6 / 3.1 MB`，回收站与 Hugging Face 正确显示「—」。

## 版式重构中真撞到的三个缺陷（都是截图或探针当场抓出来的）

写在这里，因为三条都属于"判据看着全绿、产品已经坏了"那一族。

### 1. 窄窗模板少写一格 → 第 7 格折到下一行

`--dc-clean-grid` 宽窗七格、窄窗只写了六格。第 7 格（计入预估）没有列可落，被 grid 折到
第二行左边 —— 截图上是「0 B」孤零零挂在描述底下。**而当时的几何探针全绿**：它比的是
"表头与行内格子的右缘"，格数一变右缘反而更整齐。后来加了"数格子"那条判据才抓得住。

### 2. 572 CSS 视口下七列装不下 → 结论列被挤出右缘 32.7px

修好格数之后，880 物理（CSS 572）档下固定列合计超宽，描述列被压成 0、末列溢出。
根因是**七列并排这件事本身**在 572 px 上就不可行。处置是改结构而不是继续收窄：
三个数字列装进**一格**（`.dc-clean-row-nums`），窄窗时整组换到第二行（`grid-column: 1 / -1`）。
第一版写成 `3 / -1`（从描述列开始）只拿到 214 px，仍溢出 13.4 px —— 也是探针量出来的。

### 3. 数字组宽度少算了两道 gap → 末列溢出 4px

`244px` 是手写的固定宽度，而三列子项加两道 `gap` 需要 254。改成
`calc(86px + 56px + 88px + 2 * var(--sp-1))`，并让表头与行内**共用** `--dc-clean-nums` 一个变量
（两处各写一份时，4 px 的差值来自"表头用 `justify-self: end`、行内用 `text-align: right`"）。

前两个只有截图/数格子抓得到，第三个是探针量到的。**所以这一页的验收必须同时有几何与肉眼两层。**

## 顺手发现、**没动**的问题（不在授权范围）

1. **`scripts/lib-dc-release.ps1` 的 release 驱动通道当前是坏的，与本任务无关。**
   工作区里 `src/renderer/pages/Home.tsx` 有一份未提交改动，把「指定位置」改成了
   「选择位置」+ 盘符下拉（去掉自由文本框）；而 helper 还在找「指定位置」那个单选钮
   与它下面的 `<input>`，于是每一棒 `Start-DcReleaseApp -ScanRoot` 都停在
   「找不到『指定位置』那档」。受影响的是 `m5-preview` / `m5c-tile` / `m5n-tile-dup` /
   `m6b-pages` / `m6b-scale` 等所有走这条通道的脚本。**本轮没改**：那是别人未完成的半成品，
   改它会让我的提交夹带一份我没验过的改动。本轮的 e2e 因此走 CDP 通道（与 `m6b-scale` 同源），
   并在脚本头里写明这个前提。
2. `scripts/_*.mjs` 那条 ignore 规则把"验收驱动脚本"也一起挡在仓外。本轮的两个驱动
   （`cleanup-layout-drive.mjs` / `cleanup-layout-select-all.mjs`）**故意不用 `_` 前缀**，
   因为它们是被 e2e 引用的正式件，不是一次性探针。
3. `src-tauri/dist/` 里每次 `vite build` 都会换一批带哈希的文件名，旧的那批被
   `emptyOutDir` 清掉了 —— 如果历史提交里引用过旧文件名（比如某份验收文档贴了路径），
   那些链接现在指向不存在的文件。本轮没查那批引用。
