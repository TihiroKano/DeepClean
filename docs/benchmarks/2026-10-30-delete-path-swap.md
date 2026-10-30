# 删除提速：真删通道从 shell 层换到内核层（2026-10-30）

**一句话结论**：真删（不进回收站）从 `SHFileOperationW` 换成 `DeleteFileW`，
**每千文件从 27 秒降到 0.27 秒，约 100×**。中间试过"批量 `SHFileOperationW`"，
实测**慢 10 倍**，已撤。回收站通道不变（界面上没有它的入口）。

---

## 1. 两条路的对照

**探针**：`src-tauri/examples/batchprobe.rs`（1.0.3 路与 1.0.4 路各删同一批文件）。

**环境**：本机 8 核 / 7.8 GB 内存 / SSD

| 路 | 每千文件 | 2000 文件墙钟 | 说明 |
| --- | --- | --- | --- |
| 1.0.3：`SHFileOperationW` 逐条（`FOF_NO_UI_FLAGS`，不带 ALLOWUNDO） | **27,078 ms** | 54.2 s | shell 层：每条付 COM 上下文 + shell 通知广播 + 卷信息查询 |
| 1.0.4：`DeleteFileW`（内核层） | **268 ms** | 0.54 s | 少一层包装，系统调用直达 NTFS |

**约 100×，不是预测的 1.6×**。我当时对 shell 层固定开销的估计低了两个数量级：
27ms/条里大部分是 `SHFileOperationW` 每次调用内部做的那套"初始化 shell 操作上下文、
广播 shell change 通知、查询卷信息"——这些是**每条一次**，与文件大小无关。

**旁证**：10-24 那次真机清理删 17143 个文件，按 27ms/条折算约 7.7 分钟 ——
与人类伙伴"删除有点慢"的体感吻合（那趟还只有批间并发，没有线程内提速）。

---

## 2. 中间那次失败：批量 `SHFileOperationW`（已撤）

第一版给 `WindowsCleanFs` 写了 `delete_many_permanently`：`pFrom` 双 null 分隔
传 256 条一批。**预期**是省掉每条的固定开销。**实测**：

| 路 | 16000 文件墙钟 | 每千文件 |
| --- | --- | --- |
| 逐条 `SHFileOperationW` | 6.1 s | 386 ms |
| 批量 `SHFileOperationW`（256/批） | 60.9 s | **3,805 ms** ← 慢 10× |

**为什么反向**：`SHFileOperationW` 对多路径列表**并不并行**，它内部仍是逐条处理，
而且一次挂 256 条路径还要多付"整批事务管理"的成本。shell 的批量入口是为
"资源管理器里拖 50 个文件"那种交互设计的，不是为程序性清库设计的。

**处置**：批量覆写整个函数已从代码里删掉，`CleanFs::delete_many_permanently`
的 trait 默认实现保留（它退化成逐条，调用方形状不变）。
这条记录留在这里，免得下一个人（或下一个我）再走一遍这条路。

---

## 3. 最终改动

| 位置 | 改动 |
| --- | --- |
| `WindowsCleanFs::delete_permanently` | shell → 内核（`DeleteFileW` / `RemoveDirectoryW`） |
| `classify_last_error` | 新增，与 `classify_shfile_error` **共用同一张分类表**（`errno` 形状 `WIN32_<code>` 不变） |
| `lib.rs` 那两条源码闸 | 从"全文件禁直接删除 API"改成**按函数作用域**：直接删除 API 只许在两个真删函数体里出现 |
| 批量快速路（执行器里那段） | 保留，但它现在走的是 trait 默认实现 = 逐条 `DeleteFileW` |

**语义对齐（逐条）**：

- 不进回收站：`DeleteFileW` 天然如此；
- `ERROR_FILE_NOT_FOUND` / `ERROR_PATH_NOT_FOUND` → **Ok**（删之前已被别人删掉 = 目标达成；
  1.0.3 的 shell 版对这种情况也回 0，行为不变）；
- 只读位：先 `SetFileAttributesW(FILE_ATTRIBUTE_NORMAL)` 摘掉再删。**这一条是行为变化**：
  shell 版对只读文件直接失败（静默模式下），缓存/`%TEMP%` 里大量带只读位的文件
  上一版全数删不掉；现在删得掉。系统/隐藏位不摘 —— 那两类真该让人看一眼。
- 瞬态/永久的分界、`errno` 形状：与 1.0.3 逐字相同（同一张表）。

**回收站通道（`fn recycle`）一个字没动**：仍走 `SHFileOperationW` + `FOF_ALLOWUNDO`。
界面上没有它的入口（唯一删除入口 `dc_auto_clean` 是 `permanent: true`），但 API 面保留。

**源码闸的改法**：`executor_uses_recycle_bin_with_allowundo` 原来把
`DeleteFileW` / `remove_file` 等从**整个文件**里 ban 掉 —— 那在"真删也走 shell"的年代
成立，现在会打红正确的代码。改成：

1. `fn recycle` 的**函数体**必须含 `FOF_ALLOWUNDO`、必须不含任何直接删除 API；
2. 抽掉两个真删函数体之后，**剩余代码**里不许出现直接删除 API。

意图没变（回收站不许被绕过、真删不许越界），机制从"文件级禁词"改成"作用域级"。

---

## 4. 验证

| 闸 | 结果 |
| --- | --- |
| `cargo check --workspace --all-targets` | ✅ EXIT=0，**零警告** |
| `cargo test --workspace` | ✅ EXIT=0，28 组全 ok |
| `batchprobe` 对照 | ✅ 上表，数字稳定复现两轮 |
| 回收站复核 | ✅ 探针跑完后回收站 0 条（shell 路确实没进回收站） |

---

## 5. 没做的 / 如实登记

1. **`IFileOperation` 批量版没有做**。它对真删路没有意义（`DeleteFileW` 更快），
   对回收站路理论上能省固定开销 —— 但那条路界面上没有入口，为它写几百行 COM
   样板不值得。哪天回收站路要开放给用户，再回来做。
2. **只读位摘除是行为变化**，没有单独的验收截图。有判据（`delete_permanently`
   的函数体里 `SetFileAttributesW` 被引用），但"真机上一个带只读位的缓存文件
   现在删得掉了"要装机才能看到。
3. **17143 条 × 0.27s/千 ≈ 4.6 秒**是 1.0.4 对那次真机清理的理论值（同盘同文件量），
   不是实测 —— 端到端要装机。
