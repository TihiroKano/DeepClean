# DeepClean V0.5 – V0.8 实施计划书

**衔接文档：** 《DeepClean 项目实施书》（V0.1 扫描引擎 → V0.4 清理规则引擎 已完成）\
**本文档范围：** V0.5 安全清理 / V0.6 重复文件 / V0.7 开发环境清理 / V0.8 Liquid Glass UI\
**文档性质：** 面向实现的详细计划书，可直接作为后续开发的提示词/任务书基础

------------------------------------------------------------------------

# 〇、总览

## 0.1 承接关系

```
V0.4 清理规则引擎（已完成）
   │
   │  规则定义 + 风险等级字段 已就绪
   ▼
V0.5 安全清理 —— 把"规则"落地为"可执行、可预览、可回滚的清理动作"
   │
   ├──> V0.6 重复文件 —— 产出的重复组，作为一种特殊"清理候选"接入同一套安全清理通道
   │
   └──> V0.7 开发环境清理 —— 产出的各语言缓存，同样作为清理候选接入同一套安全清理通道
   │
   ▼
V0.8 Liquid Glass UI —— 在功能全部跑通后再做视觉精修
   │
   ▼
V1.0 正式版
```

**核心原则（贯穿 V0.5-V0.8）：**

> 无论清理项来自"规则引擎"（V0.4/V0.5）、"重复文件"（V0.6）还是"开发环境"（V0.7），
> 最终都必须流入同一个 `CleanupManager` 安全清理通道，接受同一套风险分级、预览、确认、日志、验证机制。
> **不允许任何模块绕过 CleanupManager 直接调用删除 API。**

## 0.2 新增/扩展目录结构

在原目录结构基础上新增：

```
deepclean/
├── core/
│   ├── scanner/          （V0.1，已完成）
│   ├── analyzer/         （V0.2/V0.3，已完成）
│   ├── rules/            （V0.4，已完成，本阶段扩展）
│   ├── safety/           ← 新增（V0.5）
│   │   ├── SafetyGuard.ts        禁止路径/系统文件硬保护
│   │   ├── CleanupManager.ts     任务队列 + 状态机
│   │   ├── CleanupPlanner.ts     预览计算（选中项 → 预估释放空间）
│   │   ├── Deleter.ts            实际删除执行（回收站/永久）
│   │   ├── Verifier.ts           清理后二次统计
│   │   └── Logger.ts             清理日志
│   ├── duplicate/        ← 新增（V0.6）
│   │   ├── SizeGrouper.ts
│   │   ├── FastHasher.ts
│   │   ├── FullHasher.ts
│   │   └── DuplicateManager.ts
│   ├── devenv/           ← 新增（V0.7）
│   │   ├── IDevEnvDetector.ts    统一探测接口
│   │   ├── detectors/
│   │   │   ├── NodeDetector.ts
│   │   │   ├── PythonDetector.ts
│   │   │   ├── JavaDetector.ts
│   │   │   ├── AndroidDetector.ts
│   │   │   ├── DockerDetector.ts
│   │   │   ├── VSCodeElectronDetector.ts
│   │   │   └── AIModelDetector.ts
│   │   └── DevEnvRegistry.ts
│   └── report/
├── renderer/
│   ├── glass/            ← 新增（V0.8）
│   │   ├── glassTokens.ts        设计令牌（颜色/透明度/模糊/圆角）
│   │   ├── GlassLayer.tsx        全局玻璃底层（CSS方案，可选WebGL2升级）
│   │   ├── GlassCard.tsx
│   │   ├── GlassSelect.tsx       下拉菜单（Portal 渲染，避免层级穿透）
│   │   └── envBackdrop.ts        真实桌面位图捕获（事件驱动刷新）【已作废并删除，见文末「附：V0.8 已定口径」第 2 条】
│   ├── pages/
│   │   ├── CleanupPreview.tsx    清理预览弹窗
│   │   ├── DuplicateFiles.tsx
│   │   └── DevEnvCleanup.tsx
│   └── components/
```

------------------------------------------------------------------------

# 第一部分　V0.5　安全清理（Safe Cleanup Engine）

## 1.1 目标

把 V0.4 规则引擎产出的"清理候选项"，转化为一条**不可绕过**的安全执行链路：

```
候选项(来自规则引擎/重复文件/开发环境)
   ↓
SafetyGuard 二次校验（黑名单/白名单/路径合法性）
   ↓
CleanupPlanner 生成预览（预估释放空间、风险等级、影响范围）
   ↓
用户确认
   ↓
CleanupManager 任务队列执行
   ↓
Deleter 实际删除（回收站优先）
   ↓
Verifier 清理后校验
   ↓
Logger 落盘日志 + 清理报告
```

## 1.2 SafetyGuard：硬保护层

这是**整个项目安全性的最后一道闸门**，独立于规则引擎存在，任何清理请求都必须经过它，即使请求来自"受信任"的内部模块。

```ts
interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  downgradedTo?: RiskLevel; // 例如系统判断风险应比规则声明的更高
}

class SafetyGuard {
  // 硬编码禁止清理的路径前缀，不受任何规则/用户配置影响
  static readonly FORBIDDEN_PREFIXES = [
    'C:\\Windows\\System32',
    'C:\\Windows\\WinSxS',
    'C:\\Windows\\Installer',
    'C:\\Windows\\Boot',
    'C:\\Program Files\\WindowsApps',
  ];

  check(path: string, declaredRisk: RiskLevel): SafetyCheckResult;
}
```

**规则：**

- 🔴 禁止级路径**不允许**出现在任何清理预览列表中——不是"标灰禁用"，而是**在候选生成阶段就被过滤掉**，用户界面上不应该看到它们作为可清理项出现。
- 路径必须是**具体化到叶子目录**，禁止笼统路径（呼应原实施书原则四）：

```
✅ C:\Users\xxx\AppData\Local\Temp
❌ C:\Users\xxx\AppData
```

  实现方式：`SafetyGuard` 对每条规则的 `paths` 字段做正则校验，路径深度小于阈值（如 4 层）且不在白名单精确匹配表中的，直接拒绝注册为规则。

- 所有校验结果（尤其是拒绝）写入日志，即使用户看不到也要留痕，便于问题排查。

## 1.3 CleanupPlanner：清理预览

**数据结构：**

```ts
interface CleanupItem {
  id: string;
  sourceModule: 'rule' | 'duplicate' | 'devenv'; // 来源，全部统一处理
  ruleId?: string;
  category: string;           // 例如 "浏览器缓存"
  riskLevel: 'safe' | 'caution' | 'high' | 'forbidden';
  paths: string[];
  estimatedSize: number;      // 字节
  fileCount: number;
  recoverable: boolean;       // 是否走回收站
  warning?: string;           // 高风险项的明确提示文案
}

interface CleanupPlan {
  items: CleanupItem[];
  totalEstimatedSize: number;
  generatedAt: number;
}
```

**预览 UI 行为（对应原实施书第十七章）：**

```
准备清理
✓ Windows 临时文件       8.2 GB   [安全]
✓ 浏览器缓存             3.7 GB   [安全]
✓ Shader Cache            2.1 GB   [安全]
⚠ npm cache               4.5 GB   [谨慎 — 下次构建需重新下载]
──────────────────────
预计释放                18.5 GB
[取消]        [开始清理]
```

- 🟠高风险项：复选框默认**不勾选**，需要用户主动勾选并二次弹窗确认文案。
- 🔴禁止项：不出现在此列表（由 SafetyGuard 在源头过滤）。
- 预估大小允许有 ±5% 误差提示（因为部分缓存在预览和执行之间可能发生变化），避免用户投诉"数字对不上"。

## 1.4 CleanupManager：任务队列与状态机

```ts
type TaskStatus = 'pending' | 'running' | 'success' | 'partial_failed' | 'failed' | 'cancelled';

interface CleanupTask {
  id: string;
  item: CleanupItem;
  status: TaskStatus;
  progress: number;        // 0-100
  totalSize: number;
  cleanedSize: number;
  successCount: number;
  failedCount: number;
  errors: CleanupError[];
}

interface CleanupError {
  path: string;
  code: 'EBUSY' | 'EPERM' | 'ENOENT' | 'UNKNOWN';
  message: string;
}
```

**状态机：**

```
pending → running → success
                  → partial_failed（部分文件删除失败，其余成功）
                  → failed（全部失败，如权限问题）
running → cancelled（用户中途取消，已删除部分保留，未删除部分放弃）
```

**并发策略：** 复用 V0.1 扫描器的 Worker 并发模型，但删除任务的并发数应**低于**扫描任务（建议 2-4），因为删除是写操作，对磁盘和文件系统日志的压力比只读扫描更大。

## 1.5 Deleter：删除执行策略

优先级顺序：

```
1. 移入回收站（Shell.Application / trash 库）—— 默认策略，可撤销
2. 若文件不支持回收站（如超长路径、系统临时文件）→ 永久删除，但需在预览阶段明确标注"不可恢复"
3. 遇到 EBUSY（文件被占用）→ 记录 + 跳过，不重试造成卡顿，清理报告中列出"以下文件被占用，建议重启后重试"
4. 遇到 EPERM（权限不足）→ 记录 + 跳过，不静默失败
5. 遇到 ENOENT（文件已被其他程序删除）→ 视为成功（目标已达成），仅记录
```

失败重试策略：**单次任务内不做自动重试**（避免因为占用文件导致长时间卡死），失败项统一汇总到清理报告，由用户决定是否重启后再次清理。

## 1.6 Verifier：清理后校验

对应原实施书第十九章"清理后验证"，具体实现：

```
1. 清理前记录目标路径的总大小（来自扫描缓存，无需重新全盘扫描）
2. 清理执行完成后，仅对"受影响的目录"做局部重新扫描（增量，而非全盘）
3. 对比 清理前大小 - 清理后大小 = 实际释放空间
4. 与预估释放空间对比，如果差异超过阈值（如 20%），在报告中标注"实际释放与预估存在差异"而非隐藏差异
5. 更新首页 C 盘概览的可用空间数字
```

## 1.7 日志 Schema

```
2026-XX-XX HH:mm:ss
[CLEAN] C:\Users\xxx\AppData\Local\Temp\a.tmp
SIZE=124MB
RISK=safe
STATUS=SUCCESS
```

失败示例：

```
2026-XX-XX HH:mm:ss
[CLEAN] C:\Users\xxx\AppData\Local\SomeApp\cache.db
SIZE=52MB
RISK=caution
STATUS=FAILED
ERROR=EBUSY
```

日志需支持按日期/风险等级/状态筛选，供"清理记录"页面直接消费。

## 1.8 验收标准

- [ ] 🔴禁止级路径在任何情况下都不会出现在清理预览列表中
- [ ] 清理预览与实际执行之间，用户可以取消且不产生任何删除
- [ ] 单个文件删除失败不会导致整个清理任务崩溃或卡死
- [ ] 清理完成后能看到"预计释放 vs 实际释放"的对比
- [ ] 所有删除动作（无论来源模块）均可在清理日志中追溯

------------------------------------------------------------------------

# 第二部分　V0.6　重复文件检测

## 2.1 目标

在不产生"无脑全盘 Hash"性能灾难的前提下，找出真正重复的文件，并把重复组作为候选项接入 V0.5 的安全清理通道。

## 2.2 两阶段算法

```
Stage 0：预筛选
  跳过 0 字节文件（无意义）
  跳过明显不该判重的系统路径（WinSxS 等，本身就是刻意的多副本）

Stage 1：按大小分组
  size 相同 → 视为候选组
  size 不同 → 直接排除（文件大小是最快的免费过滤器）

Stage 2：快速 Hash
  对候选组内文件，仅读取头部 4KB + 尾部 4KB + size 做快速哈希（如 xxHash）
  快速哈希不同 → 排除
  快速哈希相同 → 进入下一阶段

Stage 3：完整 Hash
  仅对通过 Stage 2 的候选，计算完整文件 SHA-256
  完整哈希相同 → 确认重复
```

**关键收益：** 假设 C 盘 100 万文件，经过 Stage 1（按 size 分组）后，通常只有几千到几万个文件进入 Stage 2，再经过 Stage 2 后进入 Stage 3（全量哈希）的可能只有几百到几千个——避免了对百万文件全部做重量级哈希运算。

## 2.3 并发模型

复用 V0.1 扫描器已经验证过的 Worker Pool 机制，但哈希计算是 CPU 密集型（而扫描是 I/O 密集型），建议：

```
FastHash Worker 数量 = CPU 核心数
FullHash Worker 数量 = CPU 核心数 / 2（因为大文件哈希会持续占用磁盘 I/O）
```

对超大文件（如 >2GB）的完整哈希，考虑流式读取 + 显示单独进度条，避免 UI 长时间无响应假死。

## 2.4 数据结构

```ts
interface DuplicateGroup {
  id: string;
  hash: string;
  size: number;
  files: DuplicateFileEntry[];
  totalOccupied: number;      // files.length * size
  reclaimable: number;        // totalOccupied - size（保留一份的情况下）
}

interface DuplicateFileEntry {
  path: string;
  mtime: number;
  selected: boolean;          // 是否被用户勾选为"待删除"
}
```

## 2.5 用户选择策略（不做危险的"自动选择"）

提供辅助排序，但**最终删除哪个必须用户确认**，不做自动一键删除：

```
排序辅助：
  按修改时间（推荐保留最新）
  按路径（推荐保留在特定目录，如非 Downloads/Temp 的那份）
  按磁盘（如 D 盘为备份盘，推荐保留 D 盘那份，删除 C 盘那份，释放系统盘空间）

界面呈现（对应原实施书第二十章示例）：
发现重复文件
example.zip
☐ C:\Downloads\example.zip     2.8 GB   （最旧）
☑ D:\Backup\example.zip        2.8 GB   （推荐保留）
☐ C:\Desktop\example.zip       2.8 GB
总占用：8.4 GB   理论可释放：5.6 GB
```

## 2.6 与 CleanupManager 集成

用户勾选完"待删除"的重复文件后，生成的仍然是标准 `CleanupItem[]`（`sourceModule: 'duplicate'`），**必须经过 SafetyGuard 校验**（例如防止用户不小心把系统目录下的文件误判为重复并删除）后，才进入 V0.5 的预览/确认/执行流程——不单独开一条删除通道。

## 2.7 边界情况

- 硬链接/符号链接：识别后不计入"可释放空间"，避免误导用户（删除一个硬链接不会真正释放空间）
- 跨磁盘重复：明确标注文件所在磁盘，避免用户误删备份盘上的唯一副本
- 文件在哈希计算过程中被移动/删除：按 V0.1 已有的"文件消失处理"逻辑跳过并记录，不中断整体检测

## 2.8 验收标准

- [ ] 不对全盘所有文件计算完整哈希，只对经过 size + 快速哈希过滤后的候选计算
- [ ] 重复文件删除必须经过用户手动勾选，无"自动全部删除"按钮
- [ ] 重复文件删除同样经过 SafetyGuard 与清理日志

------------------------------------------------------------------------

# 第三部分　V0.7　开发环境清理

## 3.1 目标

作为 DeepClean 的差异化功能，针对开发者机器上的各类缓存（往往体积巨大且用户自己很少主动清理）提供**识别准确、风险说明清晰**的专项清理。

## 3.2 统一探测接口

每个语言/工具的检测器实现同一接口，便于后续持续扩展新的生态：

```ts
interface IDevEnvDetector {
  id: string;                      // 'node' | 'python' | 'docker' ...
  displayName: string;
  isInstalled(): Promise<boolean>; // 先判断工具是否存在，避免对未安装的环境瞎报路径
  scan(): Promise<DevEnvFinding[]>;
}

interface DevEnvFinding {
  category: string;         // 'npm cache' | 'pnpm store' | '__pycache__' ...
  paths: string[];
  size: number;
  riskLevel: RiskLevel;
  note?: string;            // 例如 "清理后下次构建需重新下载依赖"
}
```

**为什么要先 `isInstalled()`：** 避免对没装 Docker 的用户扫描出"Docker 未使用数据 0 项"这种噪音，也避免对路径存在但工具已卸载的残留目录做出错误的风险判断。

## 3.3 各生态具体规则

| 生态 | 检测路径示例 | 风险等级 | 备注 |
|---|---|---|---|
| Node.js | `%AppData%\npm-cache`、pnpm store、Yarn cache | 🟡谨慎 | `node_modules` 单独归类到"大文件/项目文件"，不建议自动纳入清理规则（很多是当前正在用的项目） |
| Python | pip cache、`__pycache__`、遗留 virtualenv | 🟡谨慎 | `__pycache__` 可标 🟢安全（重新生成成本极低） |
| Java | Gradle cache、Maven `.m2` | 🟡谨慎 | 体积通常很大，需给出具体子目录级路径，不要笼统清空整个 `.gradle` |
| Android | Gradle Cache、SDK 缓存 | 🟡谨慎 | SDK 本体（platforms/system-images）不属于缓存，禁止纳入 |
| Docker | Images / Containers / Volumes / Build Cache | 🟠高风险 | 见 3.4，不是文件删除，需走 Docker Daemon |
| VS Code / Electron | 应用缓存、日志、CachedData | 🟢安全 | |
| AI / 本地模型 | 模型文件、缓存、临时下载 | — | 见 3.5，模型文件本体不进清理规则 |

## 3.4 Docker 的特殊处理

Docker 数据**不能**当作普通文件直接 `rm`（会破坏 Docker 内部元数据一致性，导致 daemon 异常）。正确做法：

```
不要：直接删除 C:\ProgramData\Docker\... 下的文件
而要：通过 Docker Engine API / CLI 执行标准清理命令
  docker system df          → 先获取可清理空间统计
  docker system prune       → 清理未使用的容器/网络/镜像/构建缓存（需用户确认）
  docker volume prune       → 清理未挂载的 volume（风险更高，可能误删有数据的卷）
```

- 若系统未运行 Docker Desktop / daemon 未启动，`isInstalled()` 返回 false 或提示"请先启动 Docker"。
- Volume 清理默认归入 🟠高风险甚至需要单独一次确认弹窗，因为无法保证 volume 内一定没有重要数据。

## 3.5 AI/大模型文件的豁免规则

严格遵守原实施书第二十一章的要求：

> 模型文件必须归类为"大文件"，而不是自动纳入清理规则被删除。

实现上：`AIModelDetector` 识别出的模型文件（如 `.safetensors`、`.gguf`、`.ckpt` 等）**不生成 `DevEnvFinding` 清理候选**，而是把它们推送到"大文件分析"模块（V0.3）的列表中，仅供用户手动决定是否删除，不出现在"一键清理开发环境"的默认预览里。真正可以自动纳入候选的，只有模型下载过程中产生的临时文件/缓存索引。

## 3.6 界面呈现

```
开发环境清理
Node.js       npm cache 2.1GB / pnpm store 3.4GB          [全选] [详情]
Python        pip cache 0.8GB / __pycache__ 0.3GB         [全选] [详情]
Docker        可清理镜像/构建缓存 12.6GB  ⚠ 需 Docker 运行中  [查看]
AI 模型       检测到 3 个大模型文件（共 26GB）→ 前往「大文件」查看
```

## 3.7 验收标准

- [ ] 未安装某工具时，该分类不产生误报路径
- [ ] Docker 清理走 Docker API/CLI，而非文件系统直接删除
- [ ] AI 模型文件不出现在"一键清理"默认勾选项中
- [ ] 所有开发环境清理项同样经过 SafetyGuard + CleanupManager 统一通道

------------------------------------------------------------------------

# 第四部分　V0.8　Liquid Glass UI

## 4.1 设计原则

严格遵守原实施书 Phase 7 的原则：

> 功能正确优先于视觉效果。

V0.8 只在 V0.5-V0.7 全部功能验收通过后启动，且**不应该为了视觉效果改动已跑通的业务逻辑/数据流**，只做渲染层的替换。

## 4.2 复用已验证的 Liquid Glass 技术方案

你在另一个 Electron 项目（小鲸鱼余额挂件应用的设置窗口重构）里，已经把 Liquid Glass 效果从"看起来像磨砂"打磨到"真机验证下圆角完整、模糊在真实 DWM 合成下生效"的程度，中间踩过的坑和验证过的参数可以直接作为 DeepClean 的起点，避免重走一遍弯路：

**直接复用的技术判断：**

- 壳层用 Electron（不需要为了玻璃效果换成 Tauri 或 WinUI3）。
- **不要依赖 `backdrop-filter` 模糊真实桌面**——在真实 DWM 合成下不可靠，只有关闭动画的开发者截图里才好看。正确做法是"事件驱动截屏"：监听窗口移动（仅在停止移动时截一次）/显示器变化/从最小化还原/壁纸更换这几个时机，捕获一次桌面位图，再用确定性的 CSS `filter: blur() saturate() brightness()` 处理，而不是用 `backdrop-filter` 实时采样。
- **不要用 Electron 的 `backgroundMaterial: 'acrylic'`**——会导致窗口外围出现一层直角矩形边框，与目标的大圆角玻璃效果冲突。
- 下拉菜单一定要用 **Portal** 渲染到独立层级，否则会和卡片/其他控件发生层级穿透、文字重叠。
- 图标统一用细线风格，不要用纯色色块图标。

**可直接作为起点的数值参考**（已在真机验证过，DeepClean 可以从这套数值开始微调，而不是从 0 摸索）：

| 参数 | 参考值 |
|---|---|
| 圆角网格（8pt 系统） | 28 / 20 / 16 / 12 px，按窗口/卡片/按钮/小控件分级 |
| 主窗口填充透明度 | 约 6-10% |
| 卡片填充透明度 | 约 8-14% |
| 下拉菜单填充透明度 | 约 24-30%（不透明度需明显高于卡片，否则菜单内容会被背景干扰导致不可读） |
| 模糊 | 窗口 blur 28-30px，卡片 blur 18px |
| 饱和度/亮度 | saturate 1.5-1.6，brightness 1.05-1.08 |
| 边框处理 | 不用硬 1px 边框，改用内嵌高光线（inset highlight）+ 暗线 + 双层软阴影 |
| 图标描边 | 约 1.5px |

**是否需要 WebGL2 折射层：** 上一个项目最终做到了 WebGL2 + SDF 圆角矩形 + 法线折射 + 色散的进阶效果，但这是一套独立的渲染管线（`glassTokens.js` + `GlassRenderer.js` + `GlassLayer.jsx`），投入成本较高。**建议 DeepClean 分两步走**（见 4.4），先用纯 CSS 方案覆盖 MVP 视觉需求，再评估是否值得把 WebGL2 折射层迁移过来——DeepClean 的界面以数据密度较高的 Treemap/列表为主，玻璃质感的边际收益要和纯 CSS 方案的开发成本一起权衡，不建议一开始就直接照搬完整 WebGL2 管线。

## 4.3 DeepClean 特有界面清单

在通用玻璃组件（`GlassCard` / `GlassSelect` / `GlassLayer`）基础上，DeepClean 需要额外考虑：

```
Sidebar 导航              — 玻璃卡片形式，当前项高亮
首页概览卡片              — C盘使用率进度条 + 可释放空间数字，玻璃卡片承载
Treemap 容器              — 内部矩形色块本身不做玻璃效果（会影响数据可读性），
                            仅外层容器/Tooltip/右键菜单使用玻璃风格
清理预览弹窗              — 高透明度玻璻弹窗，需保证列表文字在各种桌面壁纸背景下都可读
                            （上一个项目就踩过"复杂壁纸背景下文字与卡片边界不可读"的坑，
                            这里应直接提高文字区域的不透明底衬，而不是让整个弹窗都高透明）
重复文件对比卡片          — 并排展示多个路径，玻璻卡片 + 清晰的选中态
进度条/清理中动画         — 需要在玻璻背景下仍然保持高对比度，不能被模糊层削弱
```

## 4.4 分阶段实施

```
Phase 8a（基础）
  纯 CSS 玻璻层：glassTokens 数值表 + 基础 GlassCard/GlassSelect 组件
  覆盖 Sidebar / 概览卡片 / 弹窗 / 下拉菜单
  验收：功能不受影响，视觉达到"现代化磨砂玻璻"基础水准

Phase 8b（可选进阶）
  评估是否迁移 WebGL2 SDF 折射管线
  仅在 Phase 8a 已上线且有余力时进行，不阻塞 V1.0 发布
```

## 4.5 验收标准

- [ ] 真机（非开发者截图/禁用动画状态）下圆角完整，无直角边框残留
- [ ] 下拉菜单与其他卡片无层级穿透/文字重叠
- [ ] Windows 150% DPI 缩放下界面不错位（复用上一项目已验证的修复方案）
- [ ] 复杂桌面壁纸背景下，弹窗和卡片内文字仍然清晰可读
- [ ] 视觉改动不影响任何已跑通的清理/扫描业务逻辑

------------------------------------------------------------------------

# 第五部分　V0.5–V0.8 整合计划

## 5.1 整合后的核心架构

```
                    Scanner (V0.1)
                        │
                        ▼
                    Analyzer (V0.2/V0.3)
                        │
              ┌─────────┼─────────┐
              ▼         ▼         ▼
        Rule Engine  Duplicate  DevEnv
          (V0.4)      (V0.6)    (V0.7)
              │         │         │
              └────┬────┴────┬────┘
                   ▼          
              SafetyGuard （V0.5，统一硬保护闸门）
                   │
                   ▼
             CleanupPlanner （生成统一 CleanupPlan）
                   │
                   ▼
                用户确认
                   │
                   ▼
             CleanupManager （统一任务队列）
                   │
                   ▼
            Deleter + Verifier + Logger
                   │
                   ▼
               清理报告 / 清理记录
                   │
                   ▼
        Liquid Glass UI （V0.8，承载以上所有交互）
```

**整合要点：** V0.6 和 V0.7 本质上是"候选项生产者"，V0.5 的 SafetyGuard + CleanupManager 是唯一的"候选项消费者/执行者"。这样任何模块新增新的清理来源（未来可能还有浏览器插件缓存、系统还原点等），都只需要产出标准 `CleanupItem`，无需重新实现一遍风险控制。

## 5.2 建议开发时间线

```
Step 1：SafetyGuard + CleanupManager 骨架（不含具体规则，先跑通状态机与日志）
Step 2：接入 V0.4 已有规则引擎产出，实现 Windows 临时文件/浏览器缓存等安全清理项的完整闭环
Step 3：重复文件检测（Size分组→FastHash→FullHash），接入 CleanupManager
Step 4：开发环境清理（先做 Node/Python/VSCode 等纯文件类，Docker 单独放最后因为涉及外部进程调用）
Step 5：清理记录/报告页面打磨
Step 6：Liquid Glass Phase 8a（纯 CSS），覆盖以上所有已完成页面
Step 7（可选）：Liquid Glass Phase 8b（WebGL2 进阶）
```

## 5.3 V1.0 验收清单（对照原实施书第三十二章）

- [x] SpaceSniffer 级空间分析（V0.1-V0.3，已完成）
- [x] Treemap / 文件目录钻取 / 大文件分析（已完成）
- [ ] 重复文件（V0.6）
- [ ] 垃圾识别 / 应用缓存（V0.4，已完成规则部分，执行部分见 V0.5）
- [ ] 开发环境缓存（V0.7）
- [ ] 风险分级 / 安全清理 / 清理预览 / 清理验证 / 清理日志（V0.5）
- [ ] Liquid Glass UI（V0.8）
- [ ] Windows 10/11 兼容性验证
- [ ] 可独立打包（NSIS 或同等方案，可参考已有的小鲸鱼项目打包经验）

---

# 附：V0.8 已定口径（2026-10-08，人类伙伴当场改的两条裁定 —— 与本文件正文冲突时以本节为准）

V0.8 落地时范围被改了两处，而本文件 §4 与上面的文件树仍按原方案写着。**下一只手请先读这一节再读 §4**，
否则照 §4.2 把桌面位图加回来，`--shot` 那套 40 步判据不会有任何一道红（它只看 DOM 与命中测试）。

1. **「玻璃效果用部分毛玻璃即可」** —— 玻璃只上在浮层与卡片（`.dc-menu` / `.dc-mapctl` / `.dc-hud` /
   页面卡片），**窗口层不做玻璃**。本文件 §4.2 表里"窗口"那一档（圆角 28 / 填充 6–10% / blur 28–30px）
   在本项目当前的窗口骨架下画不出来：`createWindow` 是带原生标题栏的普通 `BrowserWindow`，既没
   `transparent` 也没 `frame:false`，真机截图上四个角是直角的。要做必须先 frameless + 自绘标题栏，
   那属于动窗口骨架，不在 V0.8 范围。
   同理，文件树里的 `GlassLayer.tsx`（"全局玻璃底层"）没有对应产物 —— 玻璃是 `src/renderer/styles/glass/tokens.css`
   里的一组 token 与四条选择器规则，不是一个组件。

2. **「不需要实现反射桌面的效果」** —— §4 的"事件驱动桌面截屏 + 一张位图铺在窗口底下"整条作废，
   已落地的实现也**已删除**（文件树第 77 行那个 `envBackdrop.ts` 在仓库里叫 `electron/main/env-backdrop.ts`，
   连同 `useBackdrop` / `dc:backdrop:event` / `BackdropFrame` / 三个节流常量与 6 条单测一起没了）。
   删的硬理由不是"没必要"，是**它注定不对**：那台状态机自己的判据要求"截屏时本窗口必须可见"
   （`eligible = isVisible && !isMinimized`），而 `desktopCapturer.getSources({types:['screen']})` 截的是整块屏
   ⇒ 那张"背景"里必然含 DeepClean 自己的界面，糊 29px 之后读起来是重影不是壁纸。这一条只有把窗口
   开在真桌面上才看得出来（`--shot` 按设计不挂截屏器，所以它一路零红也从没看过玻璃长什么样）。
   现在留下的 `backdrop-filter` 糊的是**本页自己的内容**（与裁定 4 允许的那一侧一致）。

3. **§4.2 那张"填充不透明度"表要按深浅色底换算，且方向不许反**。表里"卡片 8–14% / 菜单 24–30%"是
   浅色底上的**亮色叠加**口径；本项目是深色底，照抄会得到一块几乎全透的板子。落地值换算成深色不透明度
   `--glass-fill-card: .86` / `--glass-fill-menu: .92`，并且**菜单档必须 ≥ 卡片档** —— 这是表里给菜单那行的
   理由原话（"不透明度需明显高于卡片，否则菜单内容会被背景干扰"），而菜单恰好是浮在地图上、文字最多的一层。

4. **Treemap 的玻璃豁免只能落在容器 `.dc-treemap` 上**。落在 `.dc-canvas` 上会出事：`.dc-treemap` 里叠着
   两个 canvas（底色层 `.dc-canvas` + 交互层 `.dc-canvas.dc-canvas-top`，两者都是 `position:absolute; inset:0`），
   不透明底色铺到交互层上就把画好的格子整个盖掉了 —— 这是 V0.8 真踩过的一次（`fb55e3c`），
   而 40 步判据全绿。现在 `--shot` 步骤 03 之前有八道叠放判据守着，其中"祖先链不许有滤镜"与
   ".dc-app 的 `::before` 不许有 content"这两道就是专门为本节第 2 条准备的。
