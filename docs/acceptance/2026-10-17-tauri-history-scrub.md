# 2026-10-17 · 历史抹除记录：66 张 DWM 修图前的整屏验收图

一句话：`v0.7-dev-env` 上 66 张早于截图修正的整屏截图，已从**全部历史**中抹掉 —— 420 条提交重放、170 条哈希改变、对象库少 163 MiB；图本身没销毁，在本地归档和一份 bundle 里。

## 1. 为什么抹

`102ecd8`（抹除后 `de412a2`，`fix(scripts,m6): 截图改按 DWM 真实帧裁 —— 我本轮把桌面像素提交进了版本库`）之前，e2e 脚本按 `GetWindowRect` 算好的矩形去 `CopyFromScreen`。那个调用抓的是**屏幕那块位置的像素**，不是那个窗口的像素 —— 于是落进 `docs/acceptance/assets/` 的图带着别的应用的内容。已肉眼复核 `m3-01-preview.png`：左缘那条中文文本来自另一个程序。

这些图随仓库公开就是隐私外泄面。修正之后重拍的 68 张不受影响，仍被跟踪。

范围取**一次抹干净**（66 张，含 `scripts/shot-leak-gate.mjs` 白名单里那 3 张），因为先抹 3 张再抹 66 张等于改写两遍、哈希对照表也作废两次。用户裁定原文：「先抹掉吧」。

## 2. 动手之前的两道保险，和抹完之后回证它们成立

| 保险 | 实测 |
| --- | --- |
| 全量备份 | `D:\dc-tmp\deepclean-pre-scrub-202610171701.bundle`，275,904,436 B；`git bundle verify` → `The bundle records a complete history`，内含旧四分支 tip（`v0.7-dev-env` = `f4f42fd`） |
| 证据留档 | `D:\dc-scrub-archive`，111,542,888 B = 66 张 PNG + `MANIFEST.tsv`（文件名 / sha256 前 16 位 / 添加它的提交 / 原仓库路径） |
| 抹后回证 | 对旧历史（`refs/original`，删前）逐张 `git cat-file blob <旧路径>` 取 sha256，与归档文件、MANIFEST 三方比对 → **OK=66 BAD=0** |

最后一行是关键：它把"抹只是把它从版本库拿掉"从一句声明变成一条跑出来的判据。

## 3. 方法与范围

```
git filter-branch --force --index-filter
  "git rm --cached --ignore-unmatch --quiet --pathspec-from-file=<66 条路径>"
  --tag-name-filter cat -- --all
```

`git filter-repo` 本机没有（`git: 'filter-repo' is not a git command`），走内置 `filter-branch`。420 条提交全部重放，228 s。随后 `update-ref -d refs/original/refs/heads/v0.7-dev-env` → `reflog expire --expire=now --expire-unreachable=now --all` → `gc --prune=now`。

| 项 | 结果 |
| --- | --- |
| 被改写的分支 | 只有 `v0.7-dev-env`。`main` / `v0.2-treemap` / `v1.0-tauri` 报 unchanged，tip SHA 逐字未变（`e3a1e49` / `2c38fc9` / `c1d9274`）—— 这三条分支的历史里本来就没有这些图 |
| 哈希变化 | 170 条变、250 条不变，见 §6 |
| 提交数 | 420 → 420（未 prune 空提交，形状一对一） |
| 对象库 | `size-pack` 266,054 KiB → 98,750 KiB（少 167,304 KiB） |
| 工作树 | 68 张 PNG 仍被跟踪；66 张已从磁盘与索引移除（归档在 `D:\dc-scrub-archive`） |

## 4. 四条判据（跑出来的，不是推出来的）

1. **路径命中 0**：对 66 条路径逐条 `git log --all --format=%H -- <path>` → `PATHS_STILL_PRESENT=0/66`。
2. **blob 不可达**：66 条路径背后是 64 个不同 blob（两对内容相同），逐个 `git cat-file -e` 全部失败；且这 64 个 SHA 与保留的 68 张 PNG 的 blob 集合**交集 0** —— 没有这一步，"图还在因为别处有同字节文件"这种假阴就查不出来。`ORPHAN=0 OVERLAP=0 / 64`。
3. **逐提交树对比**（跨库：把 bundle 克隆到 `D:\dc-tmp\pre-scrub-clone`，再 fetch 现仓库）：170 对 old/new 每一对都满足 `新树 == 旧树 − 66 条路径中的若干条` → `changed_pairs=170 mismatches=0`。这条证明改写**没有多删任何东西**。
4. **分支 tip 树 diff**：`v0.7-dev-env` 旧 tip vs 新 tip = 66 行、全部 `D`、全部落在 `docs/acceptance/assets/*.png`；另三条分支各 0 行。

## 5. 代价，逐条登记

1. **M3-B / M4 等里程碑的部分视觉证据不再随仓库交付。** 文档里 64 处提及、涉及 41 个图名、分布在 19 个 md（见 §7.2）自此指不到仓库里的文件；判据文字和当时读到的数字一字未改。真死链只有一条 markdown 图片语法（`docs/acceptance/2026-10-11-tauri-m3-b.md:87`），已就地划掉原句并写明图在哪、为什么没。这不叫"历史干净了"，叫"证据出库"。
2. **旧提交哈希引用失效**：md 里 161 处、74 个 7 位哈希（25 个文件）指向被改写的提交，`git show` 拿不到（见 §8）。处理方式是**不改原句、由 §6 对照表解析** —— "当时记的是哪个号"本身就是审计对象，就地换成新号等于把这次改写抹掉。
3. **bundle 还攥着旧历史。** 此刻"抹掉"的准确含义是"不在版本库里"。`D:\dc-tmp\deepclean-pre-scrub-202610171701.bundle` 删除之前，拿到那个目录的人能还原全部 66 张图。删除要单独决定（我的建议：留到确认发布仓库不再需要它之后）。
4. **白名单清空带来的判据变化。** `scripts/shot-leak-gate.mjs` 原有三条豁免（两张 M3-B 预览、一张 M4 无授权卡）随图消失，留着就是一扇指向日光下已不存在之物的大门 —— 谁再用同名文件提交一张整屏，这道闸会静默放过。`tests/unit/shot-leak-gate.test.ts` 里那条"遍历白名单确认每项不在 offender 里"的断言在空表时是静默空过，已改成 `expect(Object.keys(ALLOW_LIST)).toEqual([])`，把"白名单为空"钉成一条会红的判据。抹后现跑：`SHOT_LEAK_OK limit=1900`。

<!--FRAG-HASHMAP-->

<!--FRAG-PATHS-->

<!--FRAG-REFS-->

## 6. 哈希对照表（170 条被改写的提交）

未列出的 250 条哈希未变，文档里引用到它们的地方照常可 `git show`。
查法：`git show <抹除后哈希>`；反向查用本表第二列搜。

| 抹除前 | 抹除后 | 提交主题 |
| --- | --- | --- |
| `f4f42fd` | `c28ba69` | fix(build,m6-b): 那条"摘不掉"的 .rsrc merge failure 其实摘得掉 —— 用 gcc 的 -B 顶掉 MinGW 的 default-manifest.o |
| `a252980` | `72fe6fe` | fix(scripts,m6-b): 三处 —— helper 的 trap 把原因吞成 ScriptHalted、param 块缺逗号、oracle.mjs 那句 ±1 口径是错的 |
| `bc6cb32` | `94a68a4` | fix(test,m6-b): 清掉 crate 侧两条代码告警 —— 多余 mut 与带大写的测试名 |
| `7db3f8a` | `98b92c5` | style(m6-b): 全站隐藏滚动条 —— 规则进了包，但本机量不出它生效，第四轴因此改成只声明量得到的事 |
| `993223a` | `abc184e` | feat(m6-b): 四条裁定落地 —— MIT / 报告补覆盖量 / 玻璃判据口径定稿 / 窄窗画布不再被挤没 |
| `657bb0f` | `15c7fe7` | docs(plan,m6-b): Task 7 三格对完 —— 7.1/7.3 已被并发会话做掉且更严，7.2 等一个前提裁定 |
| `001b1a7` | `439ade0` | test(m6-b,t4): 八页 × 三档溢出矩阵 —— 正文那条判据 24 格全绿，加第二条轴才红出真缺陷 |
| `2604ddb` | `fd1bee4` | test(m6-b,t3,t5): 设置页与记录页补上 release 证据 + 玻璃那条真判据第一次量出数（八页里六页只剩骨架） |
| `1beff88` | `8ec80d1` | docs(plan,m6-b): 待决 #3 结清（装机已批准并跑完两轮）+ 订正 #7 那句"还没装机"的前提 |
| `bc9d7e5` | `7fdcf5d` | fix(bundler,m6-b,t6): 卸载残留修好并复跑闭合 —— 钩子第一版静默空转，因为 NSIS 的未定义变量原样留字面量 |
| `ba42c95` | `1162058` | test(m6-b,t6): 装机验收第一轮跑完（四格 + 首启投递 + 卸载）—— 抓到一条卸载残留缺陷，钩子已加但未复跑 |
| `6b0333b` | `e3aacf5` | test(m6-b,t6): 第 2 道闸在重编后的 release exe 上复跑逐字相同 + 装机验收脚本就位（分相，尚未跑） |
| `d4d2d5a` | `b88b662` | test(e2e,m6-b,t2-8): m5f-perf 迁到 release —— Task 2 闭合，helper 加 -NoWait 并配两相反证 |
| `da59dd0` | `ce34fe9` | docs(plan,m6-b): 订正我自己上一条的数 —— 绑 DC_ENV_ROOT 的是 6 棒不是 3 棒 |
| `5e5d7ae` | `0a1c415` | test(e2e,m6-b,t2-7): m5o-midrun 迁到 release —— 途中改控件五相在打包版上全过，且这是设置快照守卫第一次真被用上 |
| `13f5319` | `cf2a10f` | docs(plan,m6-b): 第 4/5 棒外派核账 + 第 6 棒 m5j 裁定留 debug（第三类"release 拿不到"） |
| `640c8fa` | `76e192e` | test(m6-b,t5): Liquid Glass 静态盘点 —— 先把量具做出来，别急着"补玻璃" |
| `13e09b6` | `0ed8fa7` | test(e2e,m6-b,t2-5): m5e-topfiles 迁到 release 并在打包版跑通 |
| `e0ef4f8` | `2bb5454` | test(e2e,m6-b,t2-4): m5e-report 迁到 release 并在打包版跑通 |
| `434e5fb` | `9782712` | test(e2e,m6-b,t2-3): m5e-paths 迁到 release —— §28 两条白名单命令在打包版上各开出一个窗口 |
| `d435f07` | `f0a9de8` | test(e2e,m6-b,t2-2): m5e-exclusions 迁到 release 并在打包版跑通 —— 顺带修掉我自己造的变量遮蔽 |
| `fe11b52` | `1dc608d` | docs(plan,m6-b): 订正 Task 2 的棒数 —— 总量 11 棒不是 10，剩 10 不是 9 |
| `0c0cd35` | `66783c1` | test(e2e,m6-b,t2-1/10): m5-dupes 迁到 release 驱动通道并在打包版上跑通 |
| `e3e28d0` | `c83ad1b` | build(tauri): 重打 src-tauri/dist —— 把 68c8d1a 那条亚秒档补进交付物 |
| `df36b68` | `687e9b0` | test(m6-b,t1): 证据泄露守卫 —— docs/acceptance 里的整屏图进不了仓 |
| `96b79c3` | `b697fa2` | chore(gitignore): 收掉 dc-tmpscan100k.json 这条长期噪音 —— 它让「工作树干不干净」这条判据失真 |
| `c3e44fe` | `970913f` | chore(gitignore): 把 .superpowers/sdd/.gitignore 自己也收进来 |
| `6b27093` | `98fc762` | chore(gitignore): .superpowers 从「全关」改成只收 Markdown —— 那 75 份「为什么这么做」终于进库 |
| `bef2cf5` | `f21bebf` | test(golden,m6): 出包前置第 3 道闸跑通 —— 真扫整卷 C:\ 476,422 文件，反例闸零命中，以及一条我自己造的假回归 |
| `4a8dd5e` | `2225c27` | docs(plan,m6-b): M6 收尾计划 + 接手文档 —— 先堵证据泄露，再把 12 棒迁到 release 通道 |
| `68c8d1a` | `6b8ffc9` | fix(format): 亚秒不再说「0s」—— 补上 formatElapsed 的亚秒档，真数显示不四舍五入到秒 |
| `199bd40` | `19dab76` | test(commands): 补上「桥刻意不送」这一侧的量具 —— 形参表 ⊆ 桥送的键，顺带修好剥注释那层把 acknowledgedRisk 吞掉的解析器 |
| `6ac6a36` | `35c01b3` | feat(build,m6): 安装包改为断网可装 + 补 copyright/installerIcon —— 四条裁定落地，并收掉一套分叉流程 |
| `92867e1` | `0388f18` | fix(scripts,m6): 五棒 e2e 不再把整块桌面存进版本库；m4 那棒等一个界面从来没有过的词红了四天 |
| `6b0fb88` | `854abdb` | fix(renderer,m6): 扫描范围那三格提到 useScan —— 回首页后不再与实际扫的树互相打脸 |
| `aceea2c` | `0fbdea2` | test(scripts,m6): 靶场真删复跑 —— 「执行链在真机上通了」这句话第一次有证据（10-13 之后头一次） |
| `102ecd8` | `de412a2` | fix(scripts,m6): 截图改按 DWM 真实帧裁 —— 我本轮把桌面像素提交进了版本库 |
| `a7ba7eb` | `baf6553` | docs(m5-p3,m6): 跨两个会话的「窗口左缘一列残字」结案 —— 不是溢出，是裁图裁到别的窗口上 |
| `ea217d6` | `22a639e` | test(scripts,m6): 补上 release 驱动通道 —— 回执链第一次在打包版上跑通 |
| `981ba05` | `0ca1ce5` | docs(m5-p3,m6): 一条能销、一条**不能**销 —— 外加收回我今天自己写错的「🟠 没看过」 |
| `4162b86` | `7520332` | chore(cleanlog,m6): 两条 dead_code 收进 #[cfg(test)]，顺带改掉那句与代码不符的注释 |
| `2b8495a` | `07ce1f8` | docs(m6): 包本体的静态核对 —— 不装机能验的都验了，剩下三格只能作者给 |
| `054005b` | `3fa5f09` | fix(renderer,m6): CSS 注释里的 glob 把 .dc-brand 整条规则吃掉了 —— 重打包并在新包内 exe 上复跑闸 |
| `95db246` | `e8f767e` | test(scripts,m6): 出包前置第 2 道闸跑通 —— 两条独立口径都修了，被验方三轴零残差 |
| `2cdf05e` | `d4385aa` | fix(service,m6): 「用时」完成后钉在 完成−开始，不再随谁来取快照往上走 |
| `3b1f93e` | `3a4d6a7` | feat(build,m6): 应用 manifest 合并版（长路径不再取决于谁胜出）+ 出包前置配齐 |
| `86d1610` | `5c12b56` | docs(plan,m5-p3): .rsrc 双 manifest——摘 A 这条路实测走不通（应用起不来），已回滚并留下证据 |
| `4f09355` | `ae8e1ca` | test(bridge,cleaner,m5-p3): 钉住回执的线上键名 + e2e 第三相改判为几何包含 |
| `47fe9c5` | `ca85459` | fix(cleaner,renderer,m5-p3): 回执带上它绑定的那份模型指纹 —— 「开始清理」不再永久灰 |
| `0c8532d` | `c0182ed` | docs(plan,m5-p3): 更正两条我自己写错的派单前提（windows-sys 新 feature / M5-H 的 Win32_VideoController 判据） |
| `b0be149` | `9d32ed5` | fix(bridge,m5-p3): 确认档位真的上链 —— 🟠 拿到回执了；执行链那一环登记为死格 |
| `97a4831` | `62815ea` | docs(acceptance,plan,m5-p3): P3 封口 —— 201.56 MiB 档位归位、真机两条轴零残差、召回仍 2/10 |
| `33d5022` | `a408220` | feat(rules,m5-p3): T2 第 22 条前移到六条形状规则之前 —— 位置依赖六处全改成不比下标 |
| `d593eb6` | `e80c885` | test(rules,m5-p3): T1 前移的三条判据先落 —— 目的那两条两侧红，15 条免疫那两条两侧绿 |
| `a838c39` | `31dbc92` | docs(plan,m5-p3): P3 计划落盘 + 更正 P2 那句「修法=表序前移」的量级 |
| `bc19ded` | `96862f5` | docs(m5-p2): 更正那句「本仓已无截图通路」—— 通路在，欠的是没跑 |
| `85c8df1` | `13d6529` | docs(plan,acceptance,m5-p2): P2-T4 落棒 —— 第 22 条在生产路径跑通，但对账按证据判「没达标」 |
| `bbd7bdf` | `6effc21` | fix(shell,golden,m5-p2): 卷根也算安装根 —— 装在别的卷上、没有卸载表条目的应用不再是盲区 |
| `b2014dc` | `bff0b5f` | fix(appfacts,m5-p2): 本体证据两条闸 —— 角色词与短条目不许替具体应用作证（两侧同形） |
| `1891070` | `a5a8581` | fix(appfacts,m5-p2): C5 的收尾码是 18 不是 259 —— 真机每次快照都被读成「中途断了」 |
| `940bbed` | `b1707e3` | feat(service,m5-p2): P2-T4 接线 —— 机器事实表真的交给评估层了，一次扫描只采一次 |
| `288702d` | `e0f4b85` | feat(rules,m5-p2): P2-T4a 第 22 条 orphan-app-data 上表 —— 新类别 orphan-data，空表下零提议 |
| `67f079d` | `61495e6` | test(golden,m5-p2): 裁定 2 按证据判「不做」，并把一次性核查变成常驻判据 |
| `aa7ac4e` | `f6ea873` | docs(rules,m5-p2): 裁定 2 的指针收成一行中性注释 —— 两侧同形，代码里不预设结论 |
| `e4459d5` | `5164db0` | docs(plan,m5-p2): P2-T5 落棒 —— 裁定 1 落地了什么、两侧变异各红哪几条、合成夹具的计数变化 |
| `911302d` | `b7e22fe` | test(rules,m5-p2): P2-T5 —— 对账夹具补上真机那一格，让 package-tree 进零容差比对的集合 |
| `8f91934` | `e9d4a77` | test(rules,m5-p2): P2-T5 五条 TS 用例补上 Rust 那侧的孪生 —— 含把哨兵加严、不改弱任何一处 |
| `461f705` | `fe67f83` | feat(rules,m5-p2): P2-T5 裁定 1 落地 —— 包树不进 leaf 采集，两侧同判据、不枚举而非事后过滤 |
| `f71b58c` | `0f337e7` | docs(plan,m5-p2): 真机数据里查出 app-cache-data 吃的是源码目录 —— 形状判据的固有失效面，裁定归 P2-T5 |
| `690d4d0` | `28a68dc` | docs(plan,m5-p2): §5 落棒 —— 那条红的真因是第三种（真表被扣在夹具围栏的名单上），哨兵没松，Rust 实测无洞 |
| `1d77283` | `7f16e77` | test(rules,m5-p2): P2-T3 声明层两条新闸补上 TS 侧的孪生用例 —— 此前只有 Rust 在钉 |
| `d55fb30` | `dc6a1f1` | test(appfacts,m5-p2): P2-T3 分歧 (b) 的产品侧那一格补断言 —— dedup_roots「留第一份」此前只有注释、没有牙 |
| `d4acb12` | `b57ae59` | feat(facts,m5-p2): P2-T3 分歧 (b) 收口 —— 基准侧补 dedup（留第一份），并钉住裁定点名的那一格 |
| `5c71873` | `62849aa` | test(rules,m5-p2): P2-T3 把 TS 的结构性哨兵移植进 Rust —— 内置表在「枚举到就 panic」的取数面上跑，Rust 是干净的 |
| `2479620` | `7d2c77a` | feat(rules,m5-p2): P2-T3 TS 半边落完 —— 第三种采集模式 + 三档分名弃权；回归轴的哨兵名单改为「产品声明的地板」 |
| `6b54a65` | `09c4788` | docs(plan,m5-p2): P2-T3 未提交半边的发现登记 —— 结构性哨兵抓到枚举越界，Rust 可能看不见 |
| `0ad9df2` | `ed72d28` | feat(rules,m5-p2): P2-T3 Rust 半边 —— 引擎真的消费 app_facts：第三种采集模式 + 三档分名弃权 + 声明层互斥闸 |
| `e9c8750` | `e851834` | docs(plan,m5-p2): P2-T3 开工前自测基线 —— cargo 619 passed/0 failed exit 0、npm 63 文件 1064 passed、两侧 tsc exit 0 且 error TS = 0 |
| `d671390` | `9b7f6fa` | docs(plan,m5-p2): 分歧(b)裁定 —— 标准根 basename 不当本体证据，Rust 对、TS 缺 dedup |
| `88486c8` | `6f1ff7d` | docs(plan,m5-p2): P2-T2 TS 半边落棒记录 —— 四条红的根因逐条、listStatus 删除、6 条两侧分歧 |
| `d822bf9` | `2616418` | feat(appfacts,m5-p2): P2-T2 TS 半边收官 —— 基准与 Rust 投影逐格对平 |
| `f150408` | `453b76a` | feat(appfacts,m5-p2): P2-T2 Rust 半边 —— 注册表与进程两通道接上，Absent 从此可达 |
| `546958d` | `14f2597` | docs(plan,m5-p2): 更正 §4.4 写反的那句 —— 安装根没枚举是多判 Absent（多删），不是多判 Present |
| `9dfda0e` | `ad34014` | docs(plan,m5-p2): P2-T1 落棒记录 —— 20 条判据 + 闸的两层会红证明 + 8 条偏离（含 §4.4 疑似写反） |
| `24aafb1` | `84b432b` | feat(appfacts,m5-p2): P2-T1 三态机器事实表 + C3/C4/C6 只读探针 + 能红的只读静态闸 |
| `f34f427` | `4d875ac` | docs(plan,m5-p2): 应用事实探针与卸载残留规则的实施计划落盘 |
| `dda643f` | `6b76595` | docs(acceptance,m5-p1): T6 本机 golden 对账入库 —— 基线数量出来、两处归属更正、一处定性自我撤回 |
| `a0cf206` | `a0dd03d` | fix(rules,m5-p1): crash-dumps 改成容器入口 + 目录名判据 —— 补上真机对账抓出的白漏 |
| `0d4f9ce` | `100ca26` | fix(rules,m5-p1): 围栏地板加第四条 —— Defender 病毒库不是安装包残留 |
| `7d79fc0` | `c9f55c2` | feat(renderer,m5-p1): T5b 把确认档位的把手接到界面上 —— 🟠 不再永远确认不动 |
| `b968dd0` | `d34fff1` | feat(renderer,m6): 代管提交另一会话的渲染端现场 —— 窗口控件 + mountain-bg 换掉 silk + 玻璃 tokens |
| `ef00998` | `8a6b4df` | docs(plan,m5-p1): T5a 落棒记录入库 —— 文案进模型指纹那半、历史 digest 换号逐格点名、变异 A/B 两种形态 |
| `321b8ac` | `1afcd78` | feat(rules,m5-p1): T5a 规则文案上预估模型 + 进 digest 覆盖字段 |
| `3908936` | `7609abf` | feat(rules,m5-p1): T4 按最高风险档确认 —— 🟠 没被 ack 就出不了回执 |
| `5eb6732` | `d914b44` | docs(plan,m5-p1): T3b-ii 落棒记录与 §7 变异 5 实跑结果入库 |
| `d52bf7f` | `3f278bc` | docs(rules,parity,m5-p1): T3b-ii 条数修订入库 + Downloads 形状另开一条 case |
| `a359958` | `8f752b4` | feat(rules,m5-p1): T3b-ii 表上第一档 🟠 user-downloads-installers 上表（20→21） |
| `a67861d` | `0a68501` | fix(rules,m5-p1): golden 的归属映射按 claimed 实际赢家更正 —— electron\Cache 一族归 16 不归 5.4 |
| `95bea97` | `9327627` | docs(plan,m5-p1): T3b-i 落棒记录与 §10 待填行入库 |
| `2b4ae36` | `c85d875` | docs(rules,parity,m5-p1): T3b-i 条数修订入库 + 双侧区分形状补进 builtin 用例 |
| `a4e02ee` | `4015ecd` | feat(rules,m5-p1): T3b-i 表尾两条显式模板规则上表（18→20） |
| `f4433d8` | `7d54719` | docs(plan,m5-p1): T3a 落棒记录与 §16 条数修订入库 |
| `2171169` | `b441749` | test(rules,m5-p1): T3a 变异证明跑出来的两处补牙 —— 名单比字面量、夹具要有区分形状 |
| `5b888cb` | `4502981` | feat(rules,m5-p1): T3a 表尾三条容器入口规则上表（15→18） |
| `f98d6e6` | `d8c41fb` | feat(rules,m5-p1): T2 遍历层 —— leaf 判据任意深度，围栏在枚举边界生效 |
| `116c66c` | `9eca8de` | feat(m5-o),fix(css): 途中改控件量实了 —— 跑着的那轮不被新值追改；顺手修掉「置灰链接看着能点」 |
| `c3528fb` | `79e2c1d` | docs(plan,m5-p1): T1 落棒记录进 §10 单一事实源 —— 闸门实数（cargo 72/4/1、vitest 86/994、tsc 0）与六条计划内偏离逐条点名 |
| `8066edd` | `c118651` | feat(rules,m5-p1): 声明层围栏闸上表 —— leaf* 采集根没配 scopeFence 就整条拒，失效才可发现 |
| `b950b70` | `1282576` | docs(plan,m5-p1): 形状判据 + 围栏 + 按档确认的实施计划落盘 |
| `5f586f8` | `f966acd` | docs(spec,m5-p): 形状判据 + 应用事实探针 + 按档风险确认 |
| `5cb3c4a` | `cdfaf06` | test(rules,m5-p): 本机审计快照落成 golden 期望集（形状判据那一轮的前置） |
| `8078b12` | `540f5d4` | chore(deps): 重生成 lock（−3,766 行 electron 依赖树），留下的包逐一对过版本没漂 |
| `912776d` | `13b86e7` | chore(electron): 删掉 Electron 壳（36 文件 / 10,604 行），core/ 与 shared/ 留作对账基准 |
| `dd4f5b0` | `b9a25d2` | feat(cleaner,m5-n): §12 与 §20 同勾真机链跑通 —— 量到同一条路径被计两次，修在整项计价那一层 |
| `c90bb39` | `146d561` | fix(m5-m): 窄窗第三条（页脚长路径被右缘截断）修完并重拍，登记的那格欠账结掉 |
| `ef0059f` | `1295f12` | chore(m5-m): 跟上 src-tauri/dist 里那份渲染端产物（CSS 改了，dist 是版本控制里的） |
| `52bdfdd` | `3703bd1` | feat(m5-m): 同刻背靠背对账结清 M1/M2 那笔欠账（三棵树三轴全等）+ 窄窗一量就中，修掉顶栏溢出与竖排单字 |
| `3c17b4b` | `07f4c06` | feat(cleaner,app,m5-k): 逐条删除的落盘日志接上（§29）—— 路上抓到两个缺陷，其中一个让一条外部对账从没跑过 |
| `8321a5c` | `1486014` | feat(rules,cleaner,m5-l): rejectedRules 带上规则名与逐条原因，预览那句才答得出"为什么不算钱" |
| `22815aa` | `888fe7d` | feat(m5-j): 规格 M5 那一行「十万级文件重复检测不卡界面」量完了，顺手把 M5-G 的修复在真盘对上账 |
| `4fa0fe4` | `221b306` | test(dupes): 补上真硬链接那一格 —— §2.7 的认簇账目此前只被假身份表钉过 |
| `aa6cc14` | `a380196` | docs,chore(m5-i): 补上"注册了必须有人调"那道反方向闸，并清掉七处与代码矛盾的旧断言 |
| `a1f8e3e` | `6f11899` | feat(scanner,m5-h): M1-T6 提权重扫收口（真跑了一次 UAC）+ 那条 .rsrc 告警查清 |
| `9a87f12` | `cbf8a90` | fix(dup,m5-g): 两件待裁定收口 —— rank-6 判据两侧一起修，重复检测的禁止根清单接上（它不是"两侧共同缺口"） |
| `4af63d6` | `e87668e` | fix(ui): 扫描途中三页不许说假话 —— 「无匹配大文件」与会话已失效都分清了，操作列不再被拆成竖排单字 |
| `caa2524` | `153975d` | test(m5-f): 把「十万级不卡界面」那三笔欠账量完 —— 三轴逐位对账 + 锁内成本点名 |
| `78fff7b` | `62c2944` | feat(m5-e): 扫描报告导出接上，桥里 ni() 归零；并与 TS 那份逐字段零容差对账 |
| `2606fed` | `a944001` | feat(m5-e): §4 大文件表接上（Top 100 来自扫描途中的堆），整页从死页变成有真数据 |
| `4298e5e` | `c7281dc` | feat(m5-e): §7 视图排除接通（只改这张地图），并补上载荷里缺的那两份"本轮累计" |
| `c77963a` | `7027ff4` | feat(m5-e): §28 白名单两条接上（打开 / 打开所在位置），拒绝那一格做成可单测的纯函数 |
| `48e4a41` | `0655100` | feat(m5-e): 设置那一格接上真机（读 / 夹取 / 原子写 / 重启还在），桥桩 8 → 6 |
| `f7541f8` | `816b04b` | feat(m5-d): §3.6 开发环境页接到真机 —— 探测层、扫描途中的模型计数，外加翻掉子代理那笔变异账 |
| `6385bf0` | `78f3ee9` | feat(m5-d): devenv 纯判定层落仓（九探测器 + Docker 三格 + 模型计数 + 视图），与 TS 零容差 |
| `dc4c643` | `551b5cc` | feat(app): dc_app_version 接上 —— 设置页「关于」那一格不再是桩（桥里剩 9 个桩） |
| `b698616` | `c70b2a7` | fix(scanner): 文件子项的 path 一直是空串 —— 地图右键四项对文件全拿到 ""（§12 顺带接通） |
| `33d5279` | `912d188` | feat(dupes): M5-B 重复组 → §17 预览链真接通了（真机三相，零删除） |
| `3ed151c` | `bd566c6` | docs(m4): 三个变异的复现不依赖那个 gitignore 掉的临时脚本 |
| `366037d` | `97e09fa` | docs(m4): §10 真码清单与投递链入档（含两次泄密面的更正）+ M3 复核一节 |
| `7aabdfb` | `089280a` | test(m4): 投递链真机五相 exit=0（真码真表真进程）+ 一条明文码泄漏闸 |
| `1e2a9bc` | `700896e` | docs(license): crate 与工具里那三处「真码不在本仓库」按事实改写（代码一字未改） |
| `b41fdb7` | `edf97ac` | fix(ui): 激活码占位符换成真码形制（35 个字符），卡标题改口「授权」 |
| `b21ff13` | `468f6dc` | feat(license): 投递链 —— 清单内嵌进二进制、首启落到授权目录，全新安装第一次能自己激活 |
| `528165e` | `5aee6ce` | feat(license): 那 1000 个真码进仓 —— 只进哈希，明文清单留在仓库外 |
| `3cae5cc` | `324d584` | docs(m4): 记一笔我自己的提交标题错 —— fb7d44a 装的是 §9 三件收口，改版本体在 e38a292 |
| `fb7d44a` | `14950c6` | feat(dev): M4 改版为在线激活 —— 网络这一关走在碰文件系统之前，crate 一字未改 |
| `e4bfa19` | `14b0ac3` | feat(dupes): M5 检测半边接到界面 —— dc_dupes_run/cancel 在位、真机跑出一组真重复 |
| `c33d6aa` | `3dc4807` | docs(m3c): 结掉那条无归因力的遗留 —— 根因是 C: 满致 ld 写不出临时文件，重定向 TMPDIR 到 D: 后 333/333 全过 |
| `c8a8e91` | `f5708f4` | docs(m3c): 封口补记 —— DC_ENV_ROOT 落地、五图入档、一条疑点降级、一条无归因力遗留 |
| `02aff05` | `a8c6ee0` | feat(dev): DC_ENV_ROOT 只重定向规则领地五个键 —— M3 真机清理链封口 |
| `c420645` | `e2a85a2` | docs(m4): §8 在线激活改版入档 —— 五相真机 + 两张失败图 + 那条"不增加授权强度"的实话 |
| `e38a292` | `566a7fc` | feat(license): M4 改版为在线激活 —— 网络这一关走在碰文件系统之前，crate 一字未改 |
| `38bdb52` | `faf349c` | docs(m3c): 记录 dc_clean_journal 更正的落地、变异证明与一次整文件 cp 的自伤 |
| `1690548` | `39bdfa4` | fix(m3c): dc_clean_journal 改成真契约 —— JournalFilter -> JournalPage + 跨任务账本 |
| `dbafb97` | `7946334` | docs(m4): §7 渲染层与真机点激活收口 —— 三态三图 + 可重跑的 e2e 脚本 |
| `e8ad673` | `d27b6ca` | build(tauri): 把 src-tauri/dist 真放进版本控制 —— 此前 0 个文件被跟踪 |
| `6cf97a3` | `ce77a3a` | feat(ui): M4 授权卡 —— 设置页那块能点激活了（并把 activate wire 的键改名避开日志闸） |
| `5713c2b` | `7a5e4cf` | docs(m3c): 更正 —— dc_clean_journal 契约是错的，M3 未封口 |
| `18be959` | `0e4cfdc` | docs(m3c): 记录补真机清理截图试过的三条路与停手理由 |
| `93ac04d` | `a6fe5c0` | docs(m4): §6.6 点名的未测面扩到整层 AppHandle 胶水（三函数而非一个） |
| `8bfd07b` | `83e1bb2` | docs(m4): 更正判据计数 —— 新增是 18 条不是 17，30ce37f 那句同样错 |
| `188519f` | `ba2a7a0` | docs(m4): 更正验收 —— IPC 那件已封口，缺口缩到「没有激活面板」与真码清单 |
| `30ce37f` | `9f0e5ac` | feat(app): M4 IPC 接线 —— activate/status 两条命令进 invoke_handler |
| `6e3344c` | `da62d6d` | docs(m3c): 勾掉已落地步骤 + 实施记录（半成品续做、两条零报错漏算、不可达裁定） |
| `a16a322` | `26205bc` | test(app): M3-C C-3 执行入口的整批拒绝判据（走真 WindowsCleanFs） |
| `0cf0519` | `cec2234` | feat(app): M3-C C-3 IPC 接线 —— dc_execute 只认确认指纹 |
| `84cf513` | `e206968` | feat(cleaner): M3-C C-3 前半 —— journal 五态 + §19 磁盘侧独立读数 |
| `d6abc38` | `0881985` | feat(cleaner): M3-C C-2 执行器 —— 默认进回收站 + 有界重试 + 取消 |
| `54ebe64` | `f4dbdd7` | review(m3c-c1): 修复评审 minor 项 |
| `98bb2dd` | `e972bc0` | test(cleaner): M3-C C-1 授权闸与 TS 零容差对账 |
| `0cc2a45` | `0915879` | acceptance(m3b): 真机预览截图验收 + 自动化脚本 |

## 7. 被抹掉的 66 张

### 7.1 清单（sha256 取自 `D:\dc-scrub-archive\MANIFEST.tsv`，与归档文件逐张校验一致）

| 仓库内路径 | 添加它的提交（抹除前 → 抹除后） | sha256 前 16 位 |
| --- | --- | --- |
| `docs/acceptance/assets/m3-01-preview.png` | `02aff05` → `a8c6ee0` | `e7e10efc309d336a` |
| `docs/acceptance/assets/m3-02-selected.png` | `02aff05` → `a8c6ee0` | `474d7490a6b20554` |
| `docs/acceptance/assets/m3-03-confirmed.png` | `02aff05` → `a8c6ee0` | `ac4e6fc7291faf33` |
| `docs/acceptance/assets/m3-04-executed.png` | `02aff05` → `a8c6ee0` | `a2e8f60b86980608` |
| `docs/acceptance/assets/m3-05-journal.png` | `02aff05` → `a8c6ee0` | `df6c3ee9b6f54655` |
| `docs/acceptance/assets/m3b-preview-20261011-113557.png` | `0cc2a45` → `0915879` | `b3daa46d1e78c24f` |
| `docs/acceptance/assets/m3b-preview-20261011-113930.png` | `0cc2a45` → `0915879` | `4ff2ad3f39abd99e` |
| `docs/acceptance/assets/m4-delivery-01-fresh-unlicensed.png` | `7aabdfb` → `089280a` | `e9613807ec3f2774` |
| `docs/acceptance/assets/m4-delivery-02-licensed-real-code.png` | `7aabdfb` → `089280a` | `2b218f3582158619` |
| `docs/acceptance/assets/m4-delivery-03-code-not-in-table.png` | `7aabdfb` → `089280a` | `3ed98d5cf2553277` |
| `docs/acceptance/assets/m4-delivery-04-licensed-after-restart.png` | `7aabdfb` → `089280a` | `9b242d4514194262` |
| `docs/acceptance/assets/m4-electron-no-license-card.png` | `fb7d44a` → `14950c6` | `856036a5932013a8` |
| `docs/acceptance/assets/m4-license-01-unlicensed.png` | `dbafb97` → `7946334` | `487aade8547fe536` |
| `docs/acceptance/assets/m4-license-02-licensed.png` | `dbafb97` → `7946334` | `1c46bbcc4800f2c3` |
| `docs/acceptance/assets/m4-license-03-device-mismatch.png` | `dbafb97` → `7946334` | `d99c638d31858ce5` |
| `docs/acceptance/assets/m4-license-04-no-network.png` | `c420645` → `e2a85a2` | `5ec5d0c9bfe5bbf3` |
| `docs/acceptance/assets/m4-license-05-net-blocked.png` | `c420645` → `e2a85a2` | `46bea6e31d99b924` |
| `docs/acceptance/assets/m5-dupes-real.png` | `e4bfa19` → `14b0ac3` | `273fc0656c625b49` |
| `docs/acceptance/assets/m5b-01-preview.png` | `33d5279` → `912d188` | `370da023c890b044` |
| `docs/acceptance/assets/m5b-02-confirmed.png` | `33d5279` → `912d188` | `8b2d849cb3c60137` |
| `docs/acceptance/assets/m5b-03-receipt.png` | `33d5279` → `912d188` | `8b2d849cb3c60137` |
| `docs/acceptance/assets/m5b-FAIL.png` | `b0be149` → `9d32ed5` | `7fc68628e1592e1a` |
| `docs/acceptance/assets/m5b-rel-01-preview.png` | `ea217d6` → `22a639e` | `558ab9debf55624b` |
| `docs/acceptance/assets/m5b-rel-02-confirmed.png` | `ea217d6` → `22a639e` | `e6777ff4cbed4646` |
| `docs/acceptance/assets/m5b-rel-03-receipt.png` | `ea217d6` → `22a639e` | `e6777ff4cbed4646` |
| `docs/acceptance/assets/m5c-tile-counted.png` | `b698616` → `c70b2a7` | `aff51ea624a809de` |
| `docs/acceptance/assets/m5c-tile-unclaimed.png` | `b698616` → `c70b2a7` | `693d629515cf5152` |
| `docs/acceptance/assets/m5d-devenv-caliber.png` | `f7541f8` → `816b04b` | `61c5254994eff48a` |
| `docs/acceptance/assets/m5d-devenv-page.png` | `f7541f8` → `816b04b` | `8a2cf1fc0567f31d` |
| `docs/acceptance/assets/m5e-excluded-banner.png` | `4298e5e` → `c7281dc` | `64dd03e5fe0e52b8` |
| `docs/acceptance/assets/m5e-report-exported.png` | `78fff7b` → `62c2944` | `33d94f894d13c135` |
| `docs/acceptance/assets/m5e-reveal-explorer.png` | `c77963a` → `7027ff4` | `da74230d4dde03b1` |
| `docs/acceptance/assets/m5e-settings-32mb.png` | `48e4a41` → `0655100` | `9b8c27e92e1458c5` |
| `docs/acceptance/assets/m5e-topfiles-floor100mb.png` | `2606fed` → `a944001` | `67359f6a6175b4fa` |
| `docs/acceptance/assets/m5e-topfiles.png` | `2606fed` → `a944001` | `7a3d3872632218db` |
| `docs/acceptance/assets/m5f-after-scan.png` | `caa2524` → `153975d` | `e3b8f5f4a47c6ce6` |
| `docs/acceptance/assets/m5f-during-scan.png` | `caa2524` → `153975d` | `39cc35e037c1c27c` |
| `docs/acceptance/assets/m5f-largefiles-filled.png` | `4af63d6` → `e87668e` | `4f57118e35e0dd97` |
| `docs/acceptance/assets/m5f-mid-clean.png` | `4af63d6` → `e87668e` | `65135dc5f380dd0f` |
| `docs/acceptance/assets/m5f-mid-devenv.png` | `4af63d6` → `e87668e` | `6a130d63438f3e06` |
| `docs/acceptance/assets/m5f-mid-dupes.png` | `4af63d6` → `e87668e` | `3a0bb215583ce64d` |
| `docs/acceptance/assets/m5j-cancelled.png` | `22815aa` → `888fe7d` | `e9981d5be69fc587` |
| `docs/acceptance/assets/m5j-detect-running.png` | `22815aa` → `888fe7d` | `bb55a82c4181b470` |
| `docs/acceptance/assets/m5k-01-executed.png` | `3c17b4b` → `07f4c06` | `69a55aacfbeeb14a` |
| `docs/acceptance/assets/m5k-02-journal.png` | `3c17b4b` → `07f4c06` | `86518cc12269e024` |
| `docs/acceptance/assets/m5m-narrow-760w-dup.png` | `52bdfdd` → `3703bd1` | `0c1e9f0593498aaf` |
| `docs/acceptance/assets/m5m-narrow-760w-journal.png` | `52bdfdd` → `3703bd1` | `553229dfb673d8c3` |
| `docs/acceptance/assets/m5m-narrow-760w-large.png` | `52bdfdd` → `3703bd1` | `3913a3555a6dc19f` |
| `docs/acceptance/assets/m5m-narrow-760w-map.png` | `52bdfdd` → `3703bd1` | `96a8dd3ab044d0ce` |
| `docs/acceptance/assets/m5n-01-dup-only.png` | `dd4f5b0` → `b9a25d2` | `ea6f10c9500fcdbd` |
| `docs/acceptance/assets/m5n-02-disjoint.png` | `dd4f5b0` → `b9a25d2` | `f3fd82415c102cbf` |
| `docs/acceptance/assets/m5n-03-overlap.png` | `dd4f5b0` → `b9a25d2` | `ae1e7e33f26ebb86` |
| `docs/acceptance/assets/m5n-04-receipt.png` | `dd4f5b0` → `b9a25d2` | `32e54d7d3f2e9555` |
| `docs/acceptance/assets/m5n-before-fix-double-count.png` | `dd4f5b0` → `b9a25d2` | `c51393d802f450af` |
| `docs/acceptance/assets/m5o-01-run1-report.png` | `116c66c` → `9eca8de` | `99bbed52015e0295` |
| `docs/acceptance/assets/m5o-02-midrun-controls-disabled.png` | `116c66c` → `9eca8de` | `3d6f8df05ddb569b` |
| `docs/acceptance/assets/m5o-03-settings-changed.png` | `116c66c` → `9eca8de` | `8f274d021128e84b` |
| `docs/acceptance/assets/m5o-04-midrun-report-still-old.png` | `116c66c` → `9eca8de` | `661ceb193a14d3c2` |
| `docs/acceptance/assets/m5o-05-run3-new-threshold.png` | `116c66c` → `9eca8de` | `d6c55478e56c04d9` |
| `docs/acceptance/assets/m5o-before-fix-link-no-disabled-style.png` | `116c66c` → `9eca8de` | `bfebe3dfc6527e53` |
| `docs/acceptance/assets/m6-gate-1-home.png` | `95db246` → `e8f767e` | `62f3ef33942b34d6` |
| `docs/acceptance/assets/m6-gate-2-typed.png` | `95db246` → `e8f767e` | `5155573dbe54d073` |
| `docs/acceptance/assets/m6-gate-3-done.png` | `95db246` → `e8f767e` | `bb0165203d28d7d3` |
| `docs/acceptance/assets/m6-gate-4-exported.png` | `95db246` → `e8f767e` | `0cf335f0c66dff25` |
| `docs/acceptance/assets/m6-release-home-after-css.png` | `b968dd0` → `d34fff1` | `e5ca847153dbc9c1` |
| `docs/acceptance/assets/m6-release-home.png` | `116c66c` → `9eca8de` | `52a9bd63301b4a7f` |

### 7.2 文档里剩下的 64 处提及（文件名指向日光下已不存在的图）

这些句子一字未改 —— 它们记录的是当时看到的东西。要重看那些图，去本地归档。

| 文档 | 提及次数 |
| --- | --- |
| `docs/acceptance/2026-10-11-tauri-m4.md` | 9 |
| `docs/acceptance/2026-10-12-tauri-m5-e.md` | 7 |
| `docs/acceptance/2026-10-11-tauri-m3-c.md` | 5 |
| `docs/acceptance/2026-10-12-tauri-m5-c.md` | 4 |
| `docs/acceptance/2026-10-13-tauri-m5-k.md` | 4 |
| `docs/acceptance/2026-10-13-tauri-m5-n.md` | 4 |
| `docs/superpowers/plans/2026-10-16-deepclean-tauri-m6-b.md` | 4 |
| `docs/acceptance/2026-10-11-tauri-m3-b.md` | 3 |
| `docs/acceptance/2026-10-12-tauri-m5-b.md` | 3 |
| `docs/acceptance/2026-10-13-tauri-m5-m.md` | 3 |
| `docs/acceptance/2026-10-13-tauri-m5-o.md` | 3 |
| `docs/acceptance/2026-10-15-m6-packaging-gate.md` | 3 |
| `.superpowers/sdd/2026-10-14-p4-wave/m6-packaging-plan.md` | 2 |
| `docs/acceptance/2026-10-12-tauri-m5-d.md` | 2 |
| `docs/acceptance/2026-10-12-tauri-m5-f.md` | 2 |
| `docs/acceptance/2026-10-14-tauri-m5-p3.md` | 2 |
| `docs/superpowers/plans/2026-10-14-deepclean-tauri-m5-p3.md` | 2 |
| `.superpowers/sdd/2026-10-16-b-role-review.md` | 1 |
| `docs/acceptance/2026-10-11-tauri-m5.md` | 1 |

## 8. 旧哈希死引用（74 个哈希 / 161 处 / 25 个文件）

就地改号会把这次改写本身抹掉，所以原句保留，由 §6 解析。逐处定位：
`git grep -n -E '\b0cc2a45\b' -- '*.md'`

| 引用次数 | 文件数 | 抹除前 | 抹除后 |
| --- | --- | --- | --- |
| 1 | 1 | `02aff05` | `a8c6ee0` |
| 1 | 1 | `0ad9df2` | `ed72d28` |
| 1 | 1 | `0c0cd35` | `66783c1` |
| 2 | 2 | `0cc2a45` | `0915879` |
| 1 | 1 | `0cf0519` | `cec2234` |
| 3 | 2 | `0d4f9ce` | `100ca26` |
| 1 | 1 | `102ecd8` | `de412a2` |
| 1 | 1 | `13e09b6` | `0ed8fa7` |
| 1 | 1 | `1690548` | `39bdfa4` |
| 3 | 2 | `1891070` | `a5a8581` |
| 1 | 1 | `199bd40` | `19dab76` |
| 3 | 1 | `1d77283` | `7f16e77` |
| 2 | 2 | `2171169` | `b441749` |
| 4 | 1 | `2479620` | `7d2c77a` |
| 1 | 1 | `24aafb1` | `84b432b` |
| 1 | 1 | `288702d` | `e0f4b85` |
| 2 | 2 | `2b4ae36` | `c85d875` |
| 1 | 1 | `30ce37f` | `9f0e5ac` |
| 4 | 2 | `321b8ac` | `1afcd78` |
| 3 | 3 | `33d5022` | `a408220` |
| 2 | 2 | `33d5279` | `912d188` |
| 3 | 3 | `3908936` | `7609abf` |
| 3 | 2 | `3b1f93e` | `3a4d6a7` |
| 1 | 1 | `3ed151c` | `bd566c6` |
| 3 | 1 | `461f705` | `fe67f83` |
| 3 | 3 | `47fe9c5` | `ca85459` |
| 2 | 1 | `4f09355` | `ae8e1ca` |
| 2 | 2 | `54ebe64` | `f4dbdd7` |
| 2 | 2 | `5b888cb` | `4502981` |
| 2 | 1 | `5c71873` | `62849aa` |
| 2 | 2 | `6385bf0` | `78f3ee9` |
| 4 | 2 | `68c8d1a` | `6b8ffc9` |
| 1 | 1 | `6ac6a36` | `35c01b3` |
| 3 | 2 | `6b0fb88` | `854abdb` |
| 1 | 1 | `6b54a65` | `09c4788` |
| 1 | 1 | `6e3344c` | `da62d6d` |
| 2 | 2 | `7d79fc0` | `c9f55c2` |
| 2 | 2 | `8066edd` | `c118651` |
| 1 | 1 | `84cf513` | `e206968` |
| 2 | 1 | `8f91934` | `e9d4a77` |
| 3 | 1 | `911302d` | `b7e22fe` |
| 2 | 1 | `912776d` | `13b86e7` |
| 2 | 1 | `92867e1` | `0388f18` |
| 2 | 2 | `95db246` | `e8f767e` |
| 2 | 1 | `96b79c3` | `b697fa2` |
| 2 | 2 | `97a4831` | `62815ea` |
| 4 | 3 | `98bb2dd` | `e972bc0` |
| 1 | 1 | `9a87f12` | `cbf8a90` |
| 3 | 3 | `a0cf206` | `a0dd03d` |
| 2 | 2 | `a16a322` | `26205bc` |
| 2 | 2 | `a359958` | `8f752b4` |
| 2 | 2 | `a4e02ee` | `4015ecd` |
| 3 | 1 | `aceea2c` | `0fbdea2` |
| 14 | 5 | `b2014dc` | `bff0b5f` |
| 2 | 1 | `b41fdb7` | `edf97ac` |
| 4 | 2 | `bbd7bdf` | `6effc21` |
| 1 | 1 | `bef2cf5` | `f21bebf` |
| 2 | 2 | `c33d6aa` | `3dc4807` |
| 2 | 1 | `d4acb12` | `b57ae59` |
| 1 | 1 | `d52bf7f` | `3f278bc` |
| 3 | 1 | `d55fb30` | `dc6a1f1` |
| 3 | 3 | `d593eb6` | `e80c885` |
| 2 | 1 | `d671390` | `9b7f6fa` |
| 1 | 1 | `d6abc38` | `0881985` |
| 1 | 1 | `d822bf9` | `2616418` |
| 1 | 1 | `e0ef4f8` | `2bb5454` |
| 4 | 2 | `e38a292` | `566a7fc` |
| 1 | 1 | `e3e28d0` | `c83ad1b` |
| 2 | 2 | `e8ad673` | `d27b6ca` |
| 2 | 2 | `ea217d6` | `22a639e` |
| 1 | 1 | `ef00998` | `8a6b4df` |
| 2 | 1 | `f150408` | `453b76a` |
| 1 | 1 | `f98d6e6` | `d8c41fb` |
| 2 | 1 | `fb7d44a` | `14950c6` |
