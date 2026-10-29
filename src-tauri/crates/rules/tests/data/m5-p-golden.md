# M5-P 本机审计快照（golden 期望集）

**这不是夹具树，是外部口径的实测快照。** 验收时拿引擎在这台机器上真扫出来的报告跟它比，
所以它必须与 `src-tauri/crates/rules` 的产出**不同源**：下面所有数字由 PowerShell 侧独立测量得到，
不是 DeepClean 扫描器算的。

## 一、比较口径（先读这段，否则这张表会被用错）

**这台机器的树不是静止的。** 同一个 .NET 栈式 walker、同一批路径，间隔约 40 分钟跑两遍：

| 路径 | 第一次 | 第二次 | 差 |
|---|---|---|---|
| `LOCAL\flutter_webview_windows` | 384,152,572 B / 3,937 文件 | 385,705,353 B / 3,960 文件 | **+1,552,781 B / +23 文件** |
| `PROGRAMDATA\Comms\Hiview` | 671.4 MiB（`Get-ChildItem -Recurse` 法） | 641.3 MiB（.NET walker 法，skipped=0） | **−30 MiB** |
| `PROGRAMDATA\Comms` | `Skipped = 4` | — | 遍历中有目录被跳过 |

kazumi 进程在写它自己的 WebView 缓存，华为的 hiview 在轮转删自己的日志。所以：

- **按精确比的是身份，不是字节**：规则 id、命中路径集合、风险档、`excludedFromDefaultSelection`
  标志、命中文件数 —— 这几项**逐条点名，零容差**。
- **字节只作下限**（`>=`），且必须允许上面那种量级的漂移。
  把字节写成等值判据的后果很具体：它会红，然后有人会去**重测到对上为止**，那张表就废了。
- `LongPathsEnabled = 0` ⇒ 少计方向的风险常驻，`Skipped` 列必须随报告一起打印，
  `Skipped > 0` 的行不许参与"没漏"的论证。
- 硬链接按路径各算一次（本表口径），与引擎 `claimed` 防双计**不同源** ⇒ "总数相等"从来不是判据。

## 二、原始数据（四份，路径里的 `%USERPROFILE%` 是入库时归一化的）

| 文件 | 内容 | 行数 |
|---|---|---|
| `m5-p-audit-sizes.csv` | LOCAL / ROAMING / PROGRAMDATA / PROFILE **顶层**目录递归字节 + Skipped | 299 |
| `m5-p-audit-subdirs.csv` | 上表若干项的**子目录级**递归字节（与 sizes 同一个 walker） | 41 |
| `m5-p-audit-installers.csv` | ⚠️ **≥20 MB 的文件清单，未按扩展名过滤**（`-Include` 在 `-Recurse -Depth` 下失效，实测含 9 个 `.log`、9 个 `.dmp`、4 个 `.dll`、1 个 `.mp4`） | 73 |
| `m5-p-audit-crossref.csv` | 顶层目录 × 五路存活判据（卸载表 / Appx / 开始菜单 / Program 目录 / 进程） | 91 |

最后一行是**已知缺陷登记**，不是笔误：`installers.csv` 不能当"安装器形状"的真值源用，
只能当"大文件"候选清单。安装器形状的真值要从 `subdirs.csv` 的更新目录行 + 文件名形状取。

## 三、正例：每条新规则**必须**点名命中（漏一条即红）

> **归属修订（T3b-i 之后，2026-10-13）**：本节原先把 `electron\Cache` 452.6 / `electron-builder\Cache`
> 73.6 记在 `dev-tool-cache` 名下，**那是错的**。这三条规则都在表尾，而 `app-cache-data`（第 16 条）
> 的 `leafDirs` 含 `Cache`，按 `claimed` **先声明者计账**，凡以 `Cache` 收尾的路径都归 16：
> `electron\Cache`、`electron-builder\Cache`、`NuGet\Cache` 三处**全部**被 16 扫走，
> `dev-tool-cache` 实际只拥有 `%PROGRAMDATA%\USOShared`、`%PROGRAMDATA%\USOPrivate`、
> `%LOCALAPPDATA%\NuGet\v3-cache`。
> **字节没有丢也没有重计**（合计不变），变的只是"这笔账挂在哪一行"。裁定：**不改表序**——
> 表序是 `claimed` 的判据（`builtin.rs` 的有序 id 测试钉着），为归属好看而重排，
> 风险大于收益。下方两节的数字按此重挂：**"必须命中"的判据是"这笔字节被某条新规则认领了"**，
> 括号里给的归属是当前表序下的实际赢家。
>
> **第二处修订（T6 真机对账之后）**：上面那句"`dev-tool-cache` 实际只拥有 USOShared /
> USOPrivate / NuGet\v3-cache"仍然不准。真机跑出来 `%PROGRAMDATA%\USOShared` 里 70 个 `*.etl`
> 归第 17 条 `app-rotated-logs`（`*.etl` 在它的 `leafFiles` 名单里），`dev-tool-cache` 对这些
> 拿到的是 `claimed-by-other-rule`（JSON 逐条点名 70 条）。所以 `dev-tool-cache` 实测只剩
> `USOPrivate` 52.72 MiB / 3 文件。**这不是双计缺陷，是归属**；证据见
> `docs/acceptance/2026-10-13-tauri-m5-p.md` §2.5。

| 规则 | 必须点名的命中（MiB，取 `installers.csv` / `subdirs.csv`） | 下限 |
|---|---|---|
| `installer-artifacts` | `@deepseek-aidsh-desktop-updater\installer.exe` 307.1；`QuarkCloudDrive\User Data\updates\*.exe` 305.8；`quark-cloud-drive-updater\pending\*.exe` 291.8；`@zcodedesktop-updater`（installer 155.9 + pending 156.1）；`qoder-cn-updater\installer.exe` 198.9；`folia-major-updater\installer.exe` 141.5；`whale-balance-desktop-updater\installer.exe` 97.8；`Desktop\KtSender-1.2.5\windowsdesktop-runtime-8.0-win-x64.exe` 56.0；`Comms\PCManager\DriverUpgrade` 371.0（下载的驱动包） | **2,081.9** |
| `app-rotated-logs` | `Comms\Hiview\HiviewPlatform.{1..4}.log` 200.0 + `HiviewService.{1..5}.log` 250.0（**只算轮转件**，同名无后缀的 12.1 + 5.0 是在写文件，命中即红）；`Comms\BasicService\LogMonitor` 0.6 / **13,813 文件** | **450.6**，且这一行**按文件数判**，按字节判会以为没活干 |
| `app-cache-data` | `electron\Cache` 452.6（**同一个 `electron-v44.2.0-win32-x64.zip` 存了 3 份**，要各算一条）；`electron-builder\Cache` 73.6；`flutter_webview_windows\kazumi` 367.8；`.cache\codex-runtimes` 1,366.6；`USOShared` 91.4 + `USOPrivate` 52.7 | **2,404.7** |
| `crash-dumps` | `LOCAL\CrashDumps` 322.7 / 10 文件（其中 7 个 `kazumi.exe.*.dmp`）；`Comms\BasicService\werdump` 72.0 / 4 文件 | **394.7** |
| `orphan-app-data` | `@genieworkbuddy-desktop-updater` 462.9；`webcast_mate-updater` 374.1；`Starward` 208.1；`ToDesk_Daas` 128.0；`leigod_person_7002` 82.2 + `ROAMING\leigod` 49.1；`tidalab-updater` 50.6 + `ROAMING\tidalab` 61.3；`adrive-desktop-updater` 93.5；`clash_win-updater` 82.8 | **1,592.6**，且**八条全部 🟠 + 全部不进默认勾选** |
| `user-downloads-installers` | **本机 0 命中**：`%USERPROFILE%\Downloads` 顶层 18 个文件里最大的非安装器是 40.6 MiB 的 mp4，没有任何 `exe/msi/zip/7z/rar` | **0** |

**领地重叠是这条表的隐藏考点**：`npm-cache\_cacache` 459.3 + `_npx` 45.2 已经在既有规则
`npm-cache`（第 7 条）名下。`app-cache-data` 若把它们**再算一遍**，`reclaimable_bytes` 就虚高 504.5 MiB ——
这正是 `claimed` 表先声明者计账要挡的事，也是 M5-N 刚修掉的那类静默双计。所以本表要求：
`app-cache-data` 的命中集合**不含**任何 `npm-cache\**` 路径。

## 四、反例：同一条规则**不许**命中（命中即红）

全部是本机真实存在的目录，不需要第二台设备：

| 不许命中 | 实测 | 为什么容易被吃 |
|---|---|---|
| `C:\Program Files (x86)\Microsoft\Edge\Application\**` | 893.0 / 929 文件 | `leafDirs: ["Cache"]` 无围栏时的典型越界 |
| `C:\Program Files\Huawei\PCManager\**` | 879.3 / 29,634 文件 | 应用自带运行时资源，删了不是"可再生" |
| `%LOCALAPPDATA%\Programs\nodejs\**` | 313.9 / 26,923 文件 | `LOCALAPPDATA\Programs` 被当容器时的越界 |
| `PROGRAMDATA\NVIDIA\**`（含 `NGX`） | 1,194.2 / 122 文件 | 现役 DLSS 模型；名字带 NVIDIA 但不是缓存 |
| `PROGRAMDATA\Package Cache\**` | 115.2 / 39 文件 | 注册表 Uninstall 串直接指向这里，删了卸载器作废 |
| `ROAMING\urban-friendship-story\game_settings.json` + `memory_history.db` | 31.8 / 176 文件 | 看着像残留，实际是**游戏存档** |
| `ROAMING\Tencent` / `ROAMING\Claude`（`claude-code` 293.0）/ `Packages\Claude_pzs8sxrjxfjjc` 236.6 | 1,298.9 / 322.1 / 236.6 | 应用存活（Claude 是已装 MSIX）⇒ 注册表单路判据会误杀 |
| `%USERPROFILE%\.qoder-cn` | 1,884.2 / 19,166 文件 | 有进程在跑 ⇒ `orphan` 判据必须弃权 |
| `LOCAL\Microsoft\Edge\User Data\**` 中非 `Cache`/`Code Cache` 的部分 | 1,106.1 / 4,669 文件 | 书签/密码/历史；既有 `browser-cache` 规则的边界不变 |
| `WinSxS` / `System32` / `C:\Windows\Installer` 29.5 / `$Recycle.Bin` | — | 禁止根与只上报根，四层闸的既有不变量 |
| `D:\DeepClean\node_modules\**` | — | 围栏外（非 C:）**且**本轮刻意不开 `node_modules` |
| `%LOCALAPPDATA%\Programs\nodejs\node_modules\**\cache` | 真机 10 条 | **P2-T5 补**：`app-cache-data` 曾认领这些**源码目录**（`undici\lib\cache`、`make-fetch-happen\lib\cache`…）。glob 按 Windows 语义大小写不敏感，精确名 `Cache` 同时命中所有 `cache` —— 形状判据防住"名字不像缓存"，没防住"同名但语义是代码" |
| 任何 claimed root 含 `\node_modules\` | — | **P2-T5 补**：已进 `golden.rs` 的常驻反例闸；并配 `PackageTree 排除 > 0` 的反空跑断言 —— 排除数为 0 长得和"这台机器没有包树"一模一样，只有钉住才分得开 |

## 五、这张表证明什么、不证明什么

- **证明**：本机已知可回收项没被漏（召回下限）+ 已知近似形状没被吃（精度下限）。
- **不证明**：换台设备还这样。`user-downloads-installers` 在本机 0 命中就是活例 —— 它在这台机器上
  **无法被验收**，只能靠合成树里的近失形状证明它既会命中也会弃权。
- 形状清单（`Cache` / `Code Cache` / `GPUCache` / `blob_storage` / `*updater` / `pending` …）
  是**人工维护的名单**，第一版必然漏（有的应用把缓存叫 `scratch`）。漏的后果是**少删**，不是多删。

> 写验收文档时不许把上面三条压缩成"已验证通用"。`orphan-app-data` 的弃权语义也**不能**复用
> `requiresDetector`（后者是"探测器说没装 → 整条规则消失"，`engine.rs:850-853`，方向相反）；
> 新字段若漏进 `RULE_OPTIONAL_FIELDS`（见 `types.rs:86-89` 那段警告），带它的规则会被判
> `invalid-shape` ⇒ 地盘从合计里**静默消失**。本表第三节的"下限"同时就是那条静默失效的探测器。
