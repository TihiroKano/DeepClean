DeepClean V0.4 开发目标

## 一、版本定位

在 V0.1 Scanner 与 V0.3 Analyzer 的基础上，建立可扩展的垃圾文件识别与风险分类系统，能够发现 Windows、应用程序以及开发环境中具有清理价值的缓存、临时文件和日志。

V0.4 只负责「发现和判断」：不删除文件、不修改文件、不执行清理、不做 UI、不做 AI 自动判断。

核心流程：`ScanResult → Analyzer → Cleanup Rule Engine → Cleanup Candidates → 风险等级 + 可释放空间`

## 二、核心目标

V0.4 完成后应能回答：「C 盘现在有哪些东西可能可以清理？」并进一步回答「为什么它可以清理？」「清理它有什么影响？」「预计能释放多少空间？」

## 三、清理规则引擎

统一规则系统，每条规则包含：

```ts
interface CleanupRule {
  id: string; name: string; category: string; description: string
  riskLevel: 'safe' | 'caution' | 'high' | 'forbidden'
  scanner: Function
  cleanStrategy: string
  recoverable: boolean
}
```

例如：Windows 临时文件、浏览器缓存、缩略图缓存、Shader Cache、npm Cache、pip Cache、Gradle Cache、日志文件。

## 四、风险等级

- 🟢 **Safe** —— 通常可安全清理。用户 Temp、浏览器缓存、缩略图缓存、部分 Shader Cache、部分应用临时文件。特点：可重新生成、不含用户原始数据、删除后一般不影响系统运行。
- 🟡 **Caution** —— 可清理但可能导致重新下载或重新生成。npm cache、pnpm store、pip cache、Gradle cache、Maven cache、Docker build cache。删除后可能：下次安装重新下载、首次启动重新生成、增加网络流量、延长构建时间。
- 🟠 **High Risk** —— 默认不加入普通清理。大型应用缓存、部分游戏缓存、部分软件临时数据。必须明确说明「清理后可能需要重新下载数据」。
- 🔴 **Forbidden** —— 禁止通过普通清理功能处理。`C:\Windows\System32`、`C:\Windows\WinSxS`、Windows Installer、系统关键 DLL、Boot 文件、Recovery 文件、用户个人文档、桌面文件、下载文件。规则引擎发现这些路径时 `riskLevel = forbidden` 且**不可加入清理任务**。

## 五、Windows 临时文件识别

`%TEMP%`、`%TMP%`、`C:\Windows\Temp`。识别：文件数量、总大小、最后修改时间、可访问文件、无法访问文件。输出示例：

```
Windows 临时文件
文件：18,421   占用：4.72 GB   风险：Safe
原因：临时文件，可由系统或应用重新生成。
```

## 六、浏览器缓存识别

第一阶段支持 Chrome / Edge / Firefox。重点识别 `Cache`、`Code Cache`、`GPUCache`、`ShaderCache`、`Service Worker Cache`。

不要直接删除浏览器用户数据。必须区分**缓存** vs **用户数据**：Cookies、Bookmarks、History、Passwords、Extensions 默认 Forbidden / Not Cleanup。

## 七、缩略图缓存

识别 `thumbcache_*.db`。统计文件数量、总大小、路径。风险 Safe，原因：Windows 可重新生成缩略图缓存。

## 八、Shader Cache

识别 NVIDIA / AMD / Intel / DirectX / 应用 Shader Cache。示例：`NVIDIA Shader Cache 3.17 GB，风险 Safe/Caution，说明：删除后可能在下次运行程序时重新生成`。

注意：**不能简单根据文件名删除，必须建立明确的路径规则。**

## 九、日志文件识别

识别 `.log`、`.tmp`、`.dmp`、旧日志。但必须避免：系统关键日志、正在使用的日志、应用配置文件。日志清理需要**路径 + 文件类型 + 文件年龄**共同判断。

## 十、开发环境缓存（特色模块）

- Node.js：npm cache、pnpm store、Yarn cache
- Python：pip cache、`__pycache__`
- Java：Gradle cache、Maven cache
- Android：Gradle、Android build cache
- Docker：Build Cache、Unused Images、Unused Containers
- Electron / VS Code：缓存、日志、临时数据

但**项目源码、配置文件、用户数据不得进入自动清理候选**。

## 十一、缓存规则必须可扩展

不能把规则全部写死在一个巨大的 `cleanup.js` 里。建议按域分文件：

```
core/rules/{windows/{temp,thumbnail,shader}.ts,
             browsers/{chrome,edge,firefox}.ts,
             development/{npm,pip,gradle,maven,docker}.ts}
```

以后增加规则不应该修改核心引擎。

## 十二、规则扫描接口

```ts
interface RuleResult { ruleId: string; name: string; paths: CleanupItem[]; totalSize: number; fileCount: number; riskLevel: RiskLevel; description: string }
interface CleanupItem { path: string; size: number; type: 'file' | 'directory'; modifiedTime: number }
```

## 十三、规则执行流程

`Rule → 扫描目标路径 → 发现候选文件 → 过滤 → 安全检查 → 统计 → 生成 RuleResult`

## 十四、安全过滤器

规则发现文件后不能直接成为清理候选，中间加 `SafetyFilter`。检查：是否系统关键路径 / 是否用户数据 / 是否正在使用 / 是否存在符号链接风险 / 是否属于允许的规则范围 / 是否超过规则限制。任何一项不符合 → 拒绝进入清理候选。

## 十五、路径安全

必须建立路径白名单/黑名单机制。不允许用 `path.includes("Temp")` 这种简单判断；必须进行**标准化路径、绝对路径解析、父子路径关系检查**，避免误匹配。

## 十六、符号链接处理

遇到 Symbolic Link / Junction / Reparse Point，默认**不跟随**。防止循环目录、跨磁盘扫描、意外进入系统目录。

## 十七、清理候选合并

多个规则可能发现同一文件（Shader / Browser / Application 规则都可能命中同一路径）。必须以 `canonicalPath` 作为唯一标识去重，最终同一个文件只能出现一次。

## 十八、空间统计

按类别汇总（Windows / 浏览器 / GPU Cache / 开发环境 / 日志 → 理论可释放），同时按风险区分 Safe / Caution / High Risk / Forbidden。**Forbidden 不得计入可清理空间。**

## 十九、可清理空间的定义

必须区分两个数：**理论可释放**（规则发现的全部候选）与**实际可释放**（经过权限、文件状态、安全过滤、重复项之后真正可进入后续清理流程的大小）。示例：理论 32.8 GB → 过滤后 27.4 GB（Safe 15.2 / Caution 12.2）。

## 二十、规则测试

每一个规则必须有测试。例如 TempRule 覆盖：正常 Temp / 空 Temp / 不存在 Temp / 无权限 Temp / 包含系统文件 / 符号链接。测试目标：**宁可漏掉垃圾，也不能误识别用户重要数据。**

## 二十一、性能要求

不允许每条规则都重新扫描整个 C 盘。正确方式是 V0.1 Scanner → 统一 ScanResult → Rule Engine → 各规则从已有数据中匹配。对于明确的缓存目录，可以直接检查目标路径。

## 二十二、V0.4 暂时不做

明确禁止：删除文件、自动清理、一键清理、AI 判断、UI 美化、Liquid Glass、重复文件检测、云端数据库、用户账号、自动优化系统、注册表清理、内存优化、开机加速。**尤其不要碰注册表。** DeepClean 的定位是「磁盘空间分析与安全清理」，不是「Windows 全能优化大师」。

## 二十三、V0.4 验收标准

建立 Cleanup Rule Engine / Windows Temp 识别 / 浏览器缓存识别 / 缩略图缓存识别 / Shader Cache 识别 / 日志识别 / npm cache / pnpm cache / pip cache / Gradle cache / Maven cache / Docker cache 基础识别 / 风险等级 / SafetyFilter / 路径安全检查 / 符号链接保护 / 候选去重 / 理论与实际可释放空间统计 / 规则单元测试 / 异常文件不中断整个分析过程 / 不删除任何文件。

## 二十四、完成后的架构

File Scanner → ScanResult → 分叉为 Analyzer（Treemap / Large Files / Directory Analysis）与 Rule Engine（Windows / Browser / Dev Rules）→ SafetyFilter → Cleanup Candidates → 【V0.5 Cleaner】

## 二十五、核心原则

1. 识别和删除必须完全分离。2. 任何规则都不能直接执行删除。3. 规则必须能够解释「为什么认为它可以清理」。4. 宁可少清理，也不能误删。5. 规则引擎必须可扩展。6. 禁止把 AI 当作安全判断的最终依据。

Scanner 负责「发现文件」；Analyzer 负责「分析文件」；Rule Engine 负责「识别可能可清理的文件」；SafetyFilter 负责「阻止危险对象」；Cleaner 在 V0.5 才真正负责「删除」。

---

## 附：接手时已定的四条口径（2026-09-27，人类伙伴确认；不要当未决问题重问）

1. **§22 的禁止项按「冻结不扩」处理**（沿用 V0.2/V0.3 已定口径）。`core/rules/`（21 条声明式规则 + 四级风险 + 防双计认领表）、`core/clean/`（六门禁执行器）、`core/dup/`（两阶段重复检测）**已经存在且真跑过删除验证**：不删、不隐藏、也不再往上加任何东西。V0.4 只做规格书 §19/§20 那两处真缺口。
   > **M5-P1 T3a 修订（2026-10-13）**：那句「15 条」与「不再往上加」已被本次改动**部分推翻**，
   > 原句保留在这里，因为「当时冻结的是什么」本身就是事实源。条数 **15 → 18**，新增的三条见下面第 5 条。
   > 没被推翻的是另外三样：一条删除代码都不新增（识别与告知这一侧才是改动面）、
   > 既有 15 条的地盘逐字节不变（`claimed` 先声明者计账 + 新规则只能追加在表尾）、
   > 声明层闸门在**整张表**上求值（所以第 2 条那条「不拆成每规则一文件」的裁定照旧成立）。
   > **M5-P1 T3b-i 修订（2026-10-13）**：条数 **18 → 20**，追加的两条见下面第 6 条。上面那句
   > 「15 → 18」保留不动 —— 它是当时那一批的事实源。这一批换的是**判据的另一族**：
   > 那两条**不走 leaf**，判据就是写死的 `%VAR%\…` 模板本身（跨设备稳定的工具约定），
   > 因此既没有 `leaf*` 也就没有 `scopeFence`；前 15 条地盘逐字节不变、只追加在表尾这两条照旧成立。
   > **M5-P1 T3b-ii 修订（2026-10-13）**：条数 **20 → 21**，追加的那条见下面第 7 条。上面两句
   > 「15 → 18」「18 → 20」保留不动 —— 它们是当时那两批的事实源。这一批换的不是判据而是**档位**：
   > `user-downloads-installers` 是整张表上**第一条 🟠 High**（此前 🟠 那一格在 `bytesByRisk` 里恒为 0），
   > 判据仍复用第 5 条 `installer-artifacts` 那十种包形状，只是地盘换成 `%USERPROFILE%\Downloads`、
   > 且 `recursive: false` 只碰顶层。前 15 条地盘逐字节不变、只追加在表尾这两条照旧成立。

2. **§11 的「每条规则一个 .ts 文件」不采纳，保留声明式注册表。** 理由：`validateRuleSet` 这道声明层闸门是在**数据**上跑的（禁止根冲突、只上报根冲突、路径重叠都是对整张表求值），拆成 13 个模块后它要么退化成跨文件聚合、要么得另建一个汇总入口，而拆文件不带来任何功能增益。「加规则不改引擎」这条要求已经由「加一项进表」满足。

3. **§10 清单里那三项「故意不做」维持原判，不重开**：
   - **Docker** 与 **Electron** 缓存：Task 19 的判断是通用 `<App>\Cache` 通配过不了 §28 原则四的叶子路径判据，硬凑就是假字节数；Electron 是当时抓到的**静默漏项**，要补只能补成「只报告不可删」或 🟠 manual-only。
   - **`node_modules` / `__pycache__` / virtualenv**：路径模板的 `*` 恰好匹配一层，「任意深度按目录名匹配」在现语言里**表达不出来**，这是记录在案的语言边界而不是漏做。要放开必须先给引擎加一种新的匹配子，而那动的是 §16 门禁的底层判据。

4. **V0.4 的真缺口只有两处**（其余 §3/§4/§15/§16/§17/§18/§21 均已在代码里，逐条证据：`core/rules/types.ts:55-76` 的字段与 §3 的 `CleanupRule` 逐项对得上；`core/rules/engine.ts:624` 的 `if (riskLevel !== 'forbidden')` 就是 §18 要求的「Forbidden 不计入可清理」）：
   - **§19**：「理论可释放」与「实际可释放」目前不是一个有名有姓的成对数字。现在 `reclaimableBytes` 是理论值，过滤后的数散在预览模型里（`core/rules/preview.ts:343-344`）。
   - **§20**：要求**每条规则一套六用例**（正常 / 空 / 不存在 / 无权限 / 含系统文件 / 符号链接），现在只有引擎级测试。目标口径是原文那句「宁可漏掉垃圾，也不能误识别用户重要数据」。

   另需自查的一处：§5 要求每条规则报「可访问文件 / 无法访问文件」两个数，现状未核实，开工时先查再决定是不是第三处缺口。

5. **M5-P1 T3a 追加的三条**（`core/rules/registry.ts` 与 `crates/rules/src/builtin.rs` 逐字段同，追加在表尾）：

   | id | category | 判据 |
   |---|---|---|
   | `app-cache-data` | `app-transient` | 任意深度、目录 basename ∈ 12 个 Chromium/Electron 约定缓存名（`Cache` / `Code Cache` / `GPUCache` / … / `component_crx_cache`） |
   | `app-rotated-logs` | `app-transient` | 任意深度、文件 basename ∈ `*.?.log` / `*.log.??` / `*.etl` —— **只认轮转件**，正在写的 `Foo.log` 一条不碰 |
   | `installer-artifacts` | `installer-leftover` | 任意深度、目录 basename ∈ `*updater` / `*Updater` / `pending` / `Update` / `updates` ∧ 文件 ∈ `*.exe` / `*.msi` / `*.nupkg` / `*.zip` 等十种包形状 |

   **这一批按构造就是机器无关的**，这是它与前 15 条最实质的区别：前 15 条的地盘是写死的路径模板
   （换台设备就是 0 命中却照样上报"已实现"），这三条的判据是 **basename 名单**——认的是
   「几千个应用共用同一批约定名」这件事，`paths`（`%LOCALAPPDATA%` / `%APPDATA%` / `%PROGRAMDATA%`）
   在它们这里**只是围栏，不是判据**。代价与失效方向也一并写清：名单人工维护，第一版必然漏
   （有的应用把缓存叫 `scratch`），而漏的后果是**少删**，不是多删 —— 方向是刻意选的。
   无围栏的 basename 判据会任意深度伸进 `Program Files` 里应用自带的运行时资源，所以
   「有 `leaf*` 就必须有 `scopeFence`，否则整条拒」写进了声明层闸（plan §0.1 / §4.3），不靠约定。

6. **M5-P1 T3b-i 追加的两条**（`core/rules/registry.ts` 与 `crates/rules/src/builtin.rs` 逐字段同，同样只追加在表尾）：

   | id | category | 判据 | recoverable |
   |---|---|---|---|
   | `dev-tool-cache` | `app-transient` | 六个**显式路径模板**：`%LOCALAPPDATA%\electron\Cache`、`%LOCALAPPDATA%\electron-builder\Cache`、`%LOCALAPPDATA%\NuGet\v3-cache`、`%LOCALAPPDATA%\NuGet\Cache`、`%PROGRAMDATA%\USOShared`、`%PROGRAMDATA%\USOPrivate`；全收、递归 | true |
   | `crash-dumps` | `app-transient` | `%LOCALAPPDATA%\CrashDumps` ∧ `filePatterns: ["*.dmp"]`，递归 | false |

   这两条与第 5 条那三条的**区别在判据那一族**：第 5 条判的是任意深度的 basename 名单（所以必须有围栏），
   这两条判的是**工具自己约定的固定位置**（electron / electron-builder / NuGet 把缓存写死在那些目录，
   `USOShared` / `USOPrivate` 是 Windows 更新编排器的固定目录），点名它们本身就是判据，无需围栏。
   失效方向也不同：名单漂移只让第 5 条少删，而这两条**换台设备就可能 0 命中**（工具没装、或改了新路径）——
   那同样是少删，不是多删。

   两处**已登记**的地盘重叠（不是漏做，方向由 `claimed` 先声明者计账保证不虚高）：
   `electron\Cache` 与 `NuGet\Cache` 这两个目录名同时命中第 5 条 `app-cache-data` 的 leafDirs，
   而它排在前面，所以那两处字节归它、`dev-tool-cache` 名下只留 `claimed-by-other-rule`；
   要不要把 `dev-tool-cache` 排到 `app-cache-data` 之前，是 T6 拿真机 golden 判的归属决策
   （`m5-p-golden.md` 第三节把 `electron\Cache` 452.6 MiB 记在 §5.4 名下，与此处表序给出的归属不一致）。
   两条都**不挂** `requiresDetector`（`requiresDetector` 只属于 `dev-cache` 那一族；
   `dev-tool-cache` 这个名字里的 dev 是描述，不是类别），也都**不在**默认勾选豁免名单里（🟡 档）。

7. **M5-P1 T3b-ii 追加的那条**（`core/rules/registry.ts` 与 `crates/rules/src/builtin.rs` 逐字段同，同样只追加在表尾）：

   | id | category | 判据 | 风险 | 默认勾选 | recoverable |
   |---|---|---|---|---|---|
   | `user-downloads-installers` | `installer-leftover` | `%USERPROFILE%\Downloads` **顶层**（`recursive: false`）∧ 文件 ∈ 第 5 条那十种包形状 | 🟠 High | **否** | false |

   这条与第 5 条 `installer-artifacts` 共用同一份 `filePatterns`，形状判据逐字相同；换掉的是三件事 ——
   **地盘、档位、默认勾选**。理由写在字段上而不是写在类别上：下载目录里躺的是用户自己找回来的文件，
   不是应用生成的缓存，删了不会自动重新生成，也不保证还能重新下得到（官网链接会失效、别人发来的那份只此一份）。
   所以 `recoverable: false` + 🟠 + `excludedFromDefaultSelection: true`。

   🟠 **不等于** 🔴，这一格要照 §16 的口径读：🔴 的字节不进 `reclaimableBytes`，🟠 的字节**照常进**
   （`reclaimableBytes` = safe + caution + high）—— 用户要能看见那块地值多少；同时它不进默认勾选，
   一键全选点不到它（§3.5 的派生 `defaultUnselectableRuleIds()` 是全仓唯一事实源，名单从一条变成两条：
   `huggingface-cache` 与这一条）。两个方向合起来才是这条规则的完整意思：只进合计就是「替用户勾掉了
   自己的下载目录」，只挡勾选就是「那块地盘从预估里静默消失」。判据各一条，两侧同一姿态：
   Rust `engine.rs::a_high_rules_bytes_are_reclaimable_but_never_default_selected`、
   TS `rules-registry.test.ts`「a high rule 的字节进 reclaimableBytes，却进不了默认勾选」；
   `recursive: false` 那一半由 `a_non_recursive_rule_claims_the_top_level_only` 钉住
   （同一棵树换成递归必须吃到子目录 —— 没有那组对照，「没收到」可能只是走不到那里）。
   参考机上下载目录 0 命中（plan §9.2），所以这条**没有真机证明**，只有合成树 +
   `m3-parity.json` 新增的 `downloads` 用例两侧对账。
