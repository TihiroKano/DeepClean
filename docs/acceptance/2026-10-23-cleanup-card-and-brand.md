# 2026-10-23 · 清理页条目卡改版 + 品牌与排版（字体 / logo / 导航高光）

> 这一份是**补记**。三轮改动当时只落到工作区与对话里，没有同时写文档 —— 2026-10-24
> 人类伙伴问「当前进度有没有写入进度文档中」，答案是"没有"，于是补这一份。
> 下文所有数字都来自当时的探针输出与测试运行，不是事后回忆。

三轮的原始要求（人类伙伴逐轮原话）：

1. 「将这里的每个选项的框大小限制为一致。详情内容为最简模式(一段话概况核心内容)，加入查看详情，
   点击出现详情框。将风险、占用等信息居中放置(当前偏上)。图二的上方这段话删掉。」
2. 「这里标签出现了重合现象，修一下。卡片等高的高度再增加点。所有字体优化为 Anthropic 的字体。
   图二可以看选择框上有高光露出来了，修一下。左上角的 logo，换为图三。」
3. 「这个药丸点和安全字体还是重合了，继续修。应用图标换成图二的。」

---

## 一、清理页条目卡改版

### ① 每个选项的框一样大 → 卡片等高

要求落在"卡片等高"上（当时问过，人类伙伴选了这一档）。

关键在**声明的位置**：`.dc-clean-rows` 里每个 `li.dc-clean-row` 是**各自独立的 grid 容器**，
彼此不共享行高 —— 只在行内改 `align-items` 得到的是"行内各格等高"，不是"行与行等高"。
所以把父级也变成 grid，在它上面声明：

```css
.dc-clean-rows { display: grid; grid-auto-rows: 1fr; }
```

**实测**：22 行行高 56.0 ~ 56.0，差 **0px**。

### ② 卡片再高一点 → `min-height: 56px`

不用加 `padding`：padding 会把文字块一起往里推，而摘要行是 `nowrap` + 省略号，挤了就变形。
`min-height` 只在内容本来就矮时补白，内容高过它时完全不参与 —— 正是"矮的那些长高、长的不变"。

高度从 49.3px 提到 56px。

> ⚠️ **这个 49.3px 的可回溯性说明白**：它是加 `min-height` **之前**那次真机探针的读数，
> 而探针当时还没有 `heights` 字段（`cleanup-layout-probe.mjs` 只在"等高/居中"那一支里量行高，
> 也就是本轮新写的 `cleanup-card-detail-probe.mjs`）。所以"改前多高"**在当前产物里复核不到**，
> 只有"改后 56.0 且差 0px"是可复现的。

### ③ 详情最简模式 + 「查看详情」详情框

列表里每行只留**一句概况**，其余全部进浮层。

概况的取法（`firstSentence` / `itemSummary`，均为导出纯函数）：

- 取规则表自己那句话（`PreviewItem.description`，服务端给的、进过 digest 的那一份）的**第一句**，
  按 `；` 或 `。` 切；
- **一个字都不现编**：切分只做截断、不做改写，文案出处仍是那张规则表；
- 表外规则（`dup:*` 伪项等）的 `description` 是空串 —— 空串是事实，
  **不补"通用说明"**（那句没有出处却被哈希进过执行凭据），退回"命中了几个目录"这个已算出的事实。

**实测**：22 条摘要**全部单行**（多行计数 0），「查看详情」22 个与 22 行一一对应。

详情框（`ItemDetail`）：

| 项 | 实现 |
|---|---|
| 挂载位置 | `Portal` 到 body —— 这页每块卡都带 `backdrop-filter`，留在原地会被后一块玻璃压住 |
| 语义 | `role="dialog"` + `aria-modal="true"` |
| 内容 | 完整文案、占用/文件、计入预估、是否可再生、清理方式、勾选粒度、目录清单、拒因 |
| 关闭 | × 按钮、点遮罩、Esc —— **三条都通** |
| 取数 | 按 `ruleId` 从**当前模型**现取，不存快照（勾选一变模型重算，存快照会显示已被替换的旧读数） |

### ④ 风险 / 占用居中（原来偏上）

上一版是 `align-items: start` + 各格 `padding-top` 补位 —— 那是描出来的对齐，描述一换行就散。
改成行上 `align-items: center` 一处负责，并把三处补位（勾选位、图标砖、风险格、数字列）的
`padding-top` / `margin-top` 全部撤掉。

**实测**：22 行里风险药丸、数字组与内容块的中心线偏差 **0.0px**。

### ⑤ 删掉图二上方那句副标题

`扫描到的可清理项 · 勾选后计入预估，确认之后才会删` —— JSX 与 `.dc-clean-sub` 样式两处一起清掉，
不留"节点没了、规则还在"的死代码。

---

## 二、品牌与排版

### ① 字体：Anthropic 风格 = 开源等效字体**本地打包**

人类伙伴给了参考仓库 [`TartSlayer/anthropic-style-cn`](https://github.com/TartSlayer/anthropic-style-cn)。

**为什么不直接写 Styrene / Copernicus**：那是 Anthropic 的商业授权字体，不能随应用分发，
绝大多数 Windows 上也没有。只把名字写进 `font-family` 得到的是一行永远不生效的声明。

落地：12 个 woff2（共 166 KB，全部 **OFL 1.1**，授权表见 `docs/fonts-LICENSE.txt`），
四个族各有分工：

| 变量 | 族 | 用在哪 |
|---|---|---|
| `--font-ui` | DM Sans | 正文、按钮、数字 |
| `--font-title` | DM Serif Display | 页面大标题（`清理预览`、详情框标题） |
| `--font-brand` | Poppins | 侧栏导航文字、卡片项目名、统计标签 |
| `--font-mono` | JetBrains Mono | 路径、指纹、要逐字符对齐的读数 |

排序纪律：**拉丁在前、中文在后**。反过来的话雅黑的拉丁字形会先把字母接走，打包的 DM Sans 永远轮不到。

中文不打包（一套思源黑体 SC 10 MB 起步，Windows 上雅黑汉字已够用）。

**实测**：`document.fonts` 里 12 个 face 全部 `loaded`、0 个 `error`；
`body` 解析到 DM Sans、`.dc-mono` 到 JetBrains Mono、标题到 DM Serif Display。

### ② 导航选中态的高光外露

根因不是间距：`inset 0 1px 0` 描的是**盒子**的顶边，而盒子是矩形 —— 圆角只负责裁剪、
不负责收边，于是四个角上那段高光笔直走到矩形边缘，露在胶囊轮廓之外。

改成贴内沿的一整圈（`inset 0 0 0 1px`，由 `border-radius` 一起收圆），
再加 `overflow: hidden` 作为第二道保险。

### ③ 标签重合（详情框头部）—— **被指了两次，第一次修错了**

第一次（10-23 第二轮）：风险药丸压在 × 上。当时判定为 `flex` 分配错误并改了，
方向对但**改错了位置**（把整块的伸缩也撤了），于是 × 从右上角跑到药丸后面、悬在框中间。
第三次修回正确形状：

```
.dc-clean-detail-title  { flex: 1 1 auto; }   ← 整块吃满中间，× 才留在右上角
.dc-modal-title         { flex: 0 1 auto; }   ← 标题不伸缩，药丸紧跟标题
.dc-clean-detail-title .dc-badge { flex: none; }
```

**实测**：药丸↔× 缝 370.8px、重叠 0、× 距框右内边 **0.7px**。

### ④ 药丸圆点压字 —— **被指了三次，前两次都没修到根**

| 轮次 | 当时的改法 | 为什么没治好 |
|---|---|---|
| 1–2 | 在 `.dc-clean-row-risk .dc-badge` 里写 `display: inline-flex` | **只覆盖列表行里的药丸**；详情框头部那颗不在该容器下 |
| 3 | 规则**上移到 `.dc-badge-risk` 本体** + 圆点改 `display: block` | 修好 |

真因：没有 flex 接管时，`<i class="dc-risk-dot">` 是 `inline-block`，
与文字处在同一条行内流里，被基线与行高挤到一起，圆点压住「安」字左半边。

**实测**：圆点与文字重叠 **0px²**、间隙 5px、中心线差 0.3px、药丸 `display: flex`。

### ⑤ logo 与应用图标

来源：人类伙伴先后给了**图三**（字标）与**精修版宣传图**（图标＋字标横向组合），
以及 `DeepClean_Logo_Assets.zip` 成套素材。

需要说清的一件事：图三那张 wordmark 与第一次部署的**逐像素相同**（max diff = 0，同一张原图）；
真正的差别在图标 —— 精修版是「裸 D 字形 + 四角星爆」，资源包母版是「圆角方块底 + 内部 D」，
两者是不同的画。

由于精修版只有**带深蓝底的宣传图**（无透明通道），做了抠图：

- 用边缘采样拟合深蓝渐变底 + 差异软 alpha；
- 对 D 字形内部的**镂空做连通域判断**，让负空间真正透出侧栏色（否则留一块脏斑）；
- 字标把白「Deep」与青「Clean」按通道分开取（青色在深蓝底上通道最小值接近背景，一刀切会削掉整段）；
- 收紧 alpha 下限去掉原图光弧留下的暗晕。

左上角最终是「图标 26×26 ＋ 字标 110.1×20」的横向组合。

图标落点（全部换成精修版）：

| 落点 | 用途 |
|---|---|
| `src-tauri/icons/icon.ico` | 打包与安装器（七档：16/24/32/48/64/128/256） |
| `src/renderer/assets/app-icon.png` | 512 母版 |
| `build/icon.png` | 256 |
| `src/renderer/assets/deepclean-wordmark.png` | 抠出的透明字标 |

**验证到二进制这一层**：从 `release/deepclean-app.exe` 里抽出图标资源，确认是精修版 D 字形 ——
"构建成功但图标没换"是这条链上最常见的静默失败。

### ⑥ 删掉无人引用的 `brand.png`

`src/renderer/assets/brand.png`（115 KB）自 `2038c60` 起就无人引用，已 `git rm`。

---

## 三、判据与证据

### 单测

| 项 | 数 |
|---|---|
| 文件 / 用例 | **69 文件 / 1075 例全绿** |
| 本轮新增 | `tests/unit/cleanup-item-detail.test.tsx`（20）、`tests/unit/theme-fonts-brand.test.ts`（29） |
| 反面对照 | 两组都写了（改回 `inset 0 1px 0`、把 `flex: 1` 塞回标题、把最简模式换回整段 description、去掉 `grid-auto-rows`……各自必须红） |

`typecheck:web` 与 `typecheck:node` 均 **0**。

### 真机（`scripts/cleanup-card-detail-e2e.ps1`，1440 / 880 两档）

```
LAYOUT2026 行数=22 行高=56~56（差 0px） 药丸中心差=0px 数字中心差=0px 摘要多行=0 查看详情=22
HEAD  dotInfo={overlap:0, gap:5, centerDelta:0.3} badgeDisplay=flex
      gapBadgeClose=370.8  closeToRight=0.7  overlapBadgeClose=0
NAV   hasBoxTopHighlight=false  overflow=hidden
THEME loaded=[DM Sans, DM Serif Display, Poppins, JetBrains Mono] errored=[]
      brandIcon=26x26  brandWord=110.1x20
```

证据图（`docs/acceptance/assets/`）：

- `cleanup-card-1440-list.png` —— 列表：等高卡片、单行摘要、每行「查看详情」、三列居中
- `cleanup-card-1440-detail.png` —— 详情框：药丸紧跟标题、× 在右上角、圆点与文字分开
- `cleanup-card-880-list.png` —— 窄窗

---

## 四、代价与教训（如实登记）

### 四条踩过的坑

1. **字体路径写错 → 构建成功但一个 woff2 都没打包。**
   `fonts.css` 在 `styles/` 下写成 `url('./fonts/…')`，解析成不存在的 `styles/fonts/`。
   `vite build` **不报错**，只在 stderr 留一句 "will remain unchanged"，产物里没有字体 ——
   界面照常渲染、全部回退系统字体。已改为 `../assets/fonts/`，并让测试**同时校验磁盘上真有那些文件**。

2. **`--font-brand` 定义了却没人引用。**
   Poppins 的五个 woff2 躺在产物里但一个字节都没用上。真机探针靠
   `document.fonts` 里 Poppins 一个 face 都不 `loaded` 抓到。已接给导航/项目名/统计标签，
   并加了一条"每个 `--font-*` 都必须出现在某条 `font-family` 里"的判据。

3. **修重合时过度修正。**
   第一次修详情框头部把整块的 `flex: 1` 也撤了，药丸不压 × 了，但 × 跑到框中间。
   探针因此加了一条 `closeToRight` 专门盯这个方向 —— **修复本身也要有判据盯着**。

4. **探针拿过渡态当终态。**
   `CLOSE_ESC` 的同步返回值被当判据：React 还没重渲染（读到 1），350ms 后才是 0。
   已改成只认落定后的读数。

### 两条边界

- **精修版是抠出来的，不是原始透明素材。** 界面在深色玻璃上效果干净，但它源自一张
  无透明通道的宣传图。若日后拿到官方透明底母版，直接替换 `app-icon.png` 与
  `deepclean-wordmark.png` 即可，CSS 一行都不用改。
- **中文不是 Anthropic 那套字形。** 打包的四族都是 latin 子集，汉字走系统雅黑/Noto。
  这是体积上的取舍（思源 SC 一套 10 MB 起步），不是遗漏。

### 本轮未做

- 简化版 / 单色版 logo（图一中间与右侧那两栏）：对应"小尺寸、托盘、印刷"场景，
  本应用暂不需要；16px 那一档官方版实测仍可辨认。
- 工作区里另有大量与本轮无关的未提交改动（`core/dup` 删除、`FileTable.tsx` 等），
  本轮**未触碰**，也未纳入提交。
