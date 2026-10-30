DeepClean V0.3 开发目标

## 一、版本定位

版本：V0.3

核心目标：基于 V0.1 已完成的扫描数据，实现独立的大文件分析与空间占用统计模块，帮助用户快速定位 C 盘中真正占用大量空间的文件、目录和文件类型。

V0.3 不进行文件删除、不实现垃圾清理、不进行 UI 美化。

本版本只关注：数据分析 → 排序 → 筛选 → 定位 → 输出结果

## 二、核心功能

### 1. Top 大文件分析

从 V0.1 Scanner 已生成的数据中提取所有文件。按照文件大小从大到小排序。

默认提供：Top 20 / Top 50 / Top 100

示例：

```
01  xxx.vhdx       18.72 GB
02  game.pak       14.36 GB
03  archive.zip     9.82 GB
04  backup.iso      8.41 GB
05  video.mp4       6.72 GB
```

必须保证：不重新扫描文件系统；直接复用已有 ScanResult。

### 三、大文件阈值筛选

支持按照文件大小筛选。预设：> 100 MB / > 500 MB / > 1 GB / > 5 GB / > 10 GB
同时支持自定义：> X MB / GB

例如：筛选 > 2 GB → 结果：87 个文件，总占用 146.3 GB

### 四、文件类型统计

按照扩展名统计文件。例如：

```
文件类型统计
.pak       83.2 GB    142 个
.mp4       31.7 GB    386 个
.zip       18.4 GB     72 个
.iso       12.6 GB     13 个
.vhdx       9.8 GB      4 个
.exe        6.3 GB    127 个
.dll        4.7 GB   1842 个
```

每种类型统计：文件数量 / 总大小 / 平均大小 / 最大文件 / 占磁盘比例

### 五、目录空间排行

统计所有目录的空间占用。例如：

```
目录空间 Top 20
01  C:\Users                  86.4 GB
02  C:\Program Files          42.7 GB
03  C:\Windows                28.6 GB
04  C:\ProgramData            18.5 GB
05  C:\Games                   9.7 GB
```

同时支持进入目录继续分析。

### 六、文件扩展名分析

处理特殊情况：无扩展名 / 隐藏文件 / 系统文件 / 多重扩展名 / 大小写不同扩展名

例如 `.PAK` `.pak` `.Pak` 统一归类为 `.pak`；无扩展名文件统一归类 `[无扩展名]`。

### 七、文件详细信息

每一个分析结果至少包含：`name` `path` `size` `extension` `createdTime` `modifiedTime` `accessedTime` `isHidden` `isSystem`

```
名称：example.vhdx
路径：C:\Users\Kano\AppData\Local\...
大小：18.72 GB
类型：VHDX
创建时间：2026-06-13
修改时间：2026-09-26
```

### 八、快速定位

分析结果必须能够定位到原文件。支持：打开文件 / 打开所在目录 / 复制完整路径。

```
Top 100 → example.vhdx → 打开所在位置 → Windows Explorer
```

### 九、结果排序

至少支持：大小 ↓ / 大小 ↑ / 修改时间 ↓ / 修改时间 ↑ / 文件名 A-Z / 文件名 Z-A / 扩展名。默认：大小 ↓

### 十、数据统计

扫描完成后生成总体统计：

```
C:\
总文件：1,284,391
总目录：82,431
最大文件：18.72 GB
Top 100 文件总占用：127.6 GB
>1 GB 文件：184 个
>5 GB 文件：27 个
>10 GB 文件：8 个
```

### 十一、空间占用比例

计算：文件大小 ÷ C 盘总容量。

```
example.vhdx  18.72 GB
C盘：237 GB
占用：7.90%
```

目录同理。

### 十二、分析性能要求

V0.3 必须使用 V0.1 已生成的数据。禁止：打开大文件 / 读取大文件内容 / 复制大文件 / 重新扫描 C 盘。
只读取 ScanResult，然后在内存中进行分析。

对于 100,000 / 500,000 / 1,000,000+ 文件都应该能够正常完成排序和统计。

### 十三、内存优化

不要为了 Top 100 永久保存大量无用对象。可以采用：扫描数据 → 文件记录 → Top-K。
例如只需要 Top 100 时，可以使用 Top-K / Min Heap 思路，而不是无脑「所有文件 → sort() → 截取前 100」。
对于百万级数据，应尽量降低额外内存开销。

### 十四、异常处理

分析阶段遇到：文件不存在 / 权限不足 / 文件信息读取失败 / 路径异常 / 损坏的扫描数据，不能导致整个分析任务失败。
统一记录 `AnalysisWarning` 并继续处理其他数据。

### 十五、扫描结果缓存

V0.3 开始建立统一的分析数据接口。建议：

```
ScanResult → AnalysisEngine
               ├── LargeFileAnalyzer
               ├── FileTypeAnalyzer
               └── DirectoryAnalyzer
```

以后继续增加 JunkAnalyzer / DuplicateAnalyzer / CacheAnalyzer，而不修改 Scanner 核心。

### 十六、数据接口

```ts
interface LargeFile { name: string; path: string; size: number; extension: string; modifiedTime: number }
interface FileTypeStats { extension: string; fileCount: number; totalSize: number; averageSize: number; largestFile: string }
interface DirectoryStats { path: string; name: string; size: number; fileCount: number; directoryCount: number }
```

### 十七、V0.3 暂时不做

本版本明确不加入：文件删除 / 垃圾清理 / 自动清理 / 重复文件检测 / AI 判断 / 文件预览 / 云端服务 / 用户系统 / Liquid Glass / 最终 UI / 清理推荐。这些放到后续版本。

### 十八、V0.3 验收标准

大文件：获取 C 盘全部文件 / Top 20 / Top 50 / Top 100 / 自定义大小筛选 / 按大小排序
文件类型：按扩展名统计 / 文件数量统计 / 总大小统计 / 平均大小 / 最大文件 / 无扩展名归类 / 扩展名大小写统一
目录：目录空间排行 / 文件数量 / 子目录数量 / 占 C 盘比例
文件操作：打开文件 / 打开所在目录 / 复制路径
稳定性：百万级文件分析 / 异常文件不中断分析 / 不重新扫描磁盘 / 不读取文件内容 / 不修改任何用户文件

### 十九、V0.3 完成后的能力

```
扫描 C:\ → 完整 ScanResult → AnalysisEngine（LargeFile / FileType / Directory）→ 分析结果
                                                              ↓
                                                    Top100 · 文件类型 · 目录排行
```

DeepClean 从「能够扫描磁盘」升级为「能够分析磁盘空间组成」。这就是后续 V0.4 垃圾识别的基础。

### 二十、开发原则

不删除任何东西。不修改任何用户数据。不重新扫描已经扫描过的数据。分析模块与 Scanner 解耦。先保证数据正确，再考虑显示方式。

最终原则：**Scanner 负责「看见」，Analyzer 负责「理解」，Cleaner 负责「处理」。三者必须保持独立。**

---

## 附：本仓库接手时已定的两条口径（2026-09-27，人类伙伴确认）

1. **§7 的 `isHidden` / `isSystem` 诚实标为未知。** 本项目已实测：Windows 上 `fs.Stats.st_mode` 只能证明 READONLY，Normal / Archive / Hidden / System 四种属性全部读成同一个值 33206（证据见 `docs/benchmarks/results.md` §8，判据实现见 `shared/classify.ts:137-162`，Task 15 定稿）。因此这两个字段存三态（true / false / unknown），当前恒为 unknown，UI 写「未知（stat 读不到）」，**不许猜、不许用 false 冒充**。将来若上 N-API `GetFileAttributesW`，只填值、不改接口。
2. **`accessedTime` 采集，但标注不可靠。** `Stats.atimeMs` 与 size/mtime/attrs/birthtime 出自同一次 `stat`，零额外 syscall；但 NTFS 会延迟更新最后访问时间，该值可能明显偏旧。字段旁边必须如实标注，且**不得**用它做任何排序默认值或判据。
