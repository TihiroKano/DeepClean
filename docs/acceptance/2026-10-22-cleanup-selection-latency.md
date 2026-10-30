# 2026-10-22 垃圾清理页首次勾选延迟

**一句话结论**：延迟不在勾选上。一次勾选触发 `dc_preview`，服务端每次全量重算**与勾选无关**的报告
（机器事实采集 + 整树规则评估），实测约占 99.9% 的时间。报告改为**按会话缓存**后，勾选重算从
**约 490 ms 降到 1.4–3.6 ms**，且 `confirm`（删除授权）那一趟仍然实时重算。

---

## 1. 现象与定位

人类伙伴报告：「当前垃圾清理页面首次点击勾选的延迟过高」。

沿 `dc_preview` 这条链读下来，一次勾选要做的事是（`service.rs::build_preview`）：

```
选中变化 → usePreview（渲染端）→ invoke('dc_preview')
  → build_preview
      → app_facts_for_tree      机器事实采集（注册表 / 进程表 / 文件系统 / 全树路径索引）
      → rule_report_with_facts  整树规则评估
      → build_preview_model     ← 只有这一步真的看勾选
```

**关键读出来的事实**：`selection` 根本不在 `rule_report_with_facts` 的形参里
（`service.rs:594`）。报告是 `f(树, 机器事实, report_claims)` 的函数，勾选不在其中。
另外 `builtin.rs` 里**没有一条规则**设 `older_than_days`，所以连 `now` 都不影响报告
（`engine.rs:1121` 那个时间分支在生产规则集上永不进入）。

## 2. 实测（优化前）

探针：临时 `#[ignore]` 测试，直接驱动产品同一条链，跑完即删。
树：`C:\Windows`，**125,139 文件 / 35,374 目录**，debug 构建。

| 段 | 耗时 | 与勾选有关 |
| --- | --- | --- |
| `app_facts_for_tree` 合计 | **~244 ms** | ❌ |
| ├ `TreeSource::new`（全树归一化路径索引） | 165–170 ms | ❌ |
| ├ 注册表三根卸载表 | 7–9 ms | ❌ |
| ├ 进程表 Toolhelp32 | 10–13 ms | ❌ |
| └ 文件系统探测 + 判定 | ~50 ms | ❌ |
| `rule_report_with_facts` 合计 | **~244 ms** | ❌ |
| └ 其中 `TreeSource::new` **又建了一遍** | 165 ms | ❌ 纯重复 |
| **`build_preview_model`** | **0.7 ms** | ✅ |

**每次点击 ≈ 490 ms，真正跟勾选相关的 0.7 ms —— 比例约 700:1。**

## 3. 两处改动

### A. 去掉重复的全树索引（零语义变化）

一次 `build_preview` 里 `app_facts_for_tree` 与 `rule_report_with_facts` **各建了一次**
`TreeSource::new`。两份索引喂的是同一棵不可变的树 ⇒ 第二份与第一份逐字节相同。

改法：新增 `rule_report_with_facts_reusing` / `app_facts_for_tree_reusing`，两者吃调用方
建好的同一份 `TreeSource`；`report_for_preview` 里只 `TreeSource::new` 一次。
原函数签名与行为不变（内部改为建一次后委托），现有调用方零改动。

### B. 报告按会话缓存

缓存槽是 `Session::report_cache: Mutex<Option<(bool, Arc<RuleReport>)>>`。

**为什么挂在 `Session` 上而不是进程级静态槽**：第一版写成了 `OnceLock` 全局槽，全量测试里
`a_forbidden_selection_never_lands_in_the_estimate` 挂掉 —— 另一条用例留下的假报告污染了它。
那不是测试的问题，是**缓存生命周期没跟着会话走**。挂在 `Session` 上之后，换一次扫描就是换一个
`Session`，缓存随旧会话一起丢弃，**结构上不可能**把上一轮的账套到这一轮上
（比"记得把 scan_id 写进键里"可靠：那种约定靠人守）。

键只剩 `report_claims` 一个：它决定报告**形状**（`claimed_paths` 挂不挂），同一个会话上两种都会
出现（不带 tilePaths / 带 tilePaths），混用会把一张不带认领表的报告交给 §12 的归属反查，
于是「这个文件归哪条规则」全线查不到、全落 `unclaimed`。

### 谁不许读这个缓存

**`confirm` 那一趟（`confirm.is_some()`）永远实时重算，且不写缓存。**
回执是 §18 删除的授权凭据，必须锚在**当下这份**机器事实：拿一份旧报告出回执，可能删掉一个刚装上
的应用的数据（`orphan-app-data` 的判据正是「装了没」）。那 490 ms 花在用户显式按下「确认」上完全
可接受 —— 这一份慢是**刻意保留**的。

## 4. 判据（四条，都做过变异验证）

`src-tauri/src/service.rs` 的 `preview_tests`：

| 用例 | 钉住什么 | 变异验证 |
| --- | --- | --- |
| `a_second_preview_on_the_same_session_reuses_the_report` | 同会话同 claims ⇒ 复用 | 把 `reuse` 恒设 false ⇒ **红** |
| `a_different_scan_id_never_reuses_the_report` | 换会话不许串账 | 把会话缓存改成共享 ⇒ **红** |
| `the_claims_variant_is_part_of_the_cache_key` | claims 变体不许混用 | 把 claims 从键里去掉 ⇒ **红** |
| `the_confirm_round_trip_never_reads_the_cached_report` | confirm 不许吃缓存 | 把 `reuse` 恒设 true ⇒ **红** |

判据形态是**行为**不是实现：往缓存里塞一份假报告（`windows-temp` 424,242 字节，与任何真树都对不上），
看 `build_preview` 是否原样把它念出来。原样念出来才证明它真读了缓存；若它又算了一遍，假数据会被
真报告覆盖，断言当场红。

## 5. 实测（优化后）

同一棵树、同一条链：

| 场景 | 耗时 |
| --- | --- |
| 冷启动一次（建索引 + 采事实 + 评估） | 557–779 ms |
| **缓存命中后每次勾选** | **1.4–3.6 ms** |

> ⚠️ 这轮读数比 §2 那次高（基线 1048 / 974 / 1228 ms 对 490 ms），是**同一台机器负载不同**，
> 不是改动引入的回归 —— 两次运行里"优化前形状"与"优化后形状"是**同一次运行内**对照的，
> 比例结论不受影响。只登记区间，不拿单次当结论。

**收益量级**：勾选重算从约 490 ms 降到个位数毫秒，约 **100–300×**。
debug 构建；release 按项目 M5-F 记录的 2.4–4× 折算，绝对值更低，比例不变。

## 6. 代价（如实登记，不隐藏）

同一次页面停留内，若中途装了 / 卸了应用、或应用起了进程，`orphan-app-data` 与 `app-cache-data`
的判定**不会自动刷新** —— 要刷新就重新扫一次或重开这一页（换 `scan_id`）。

方向是安全的：机器事实变新只会**减少**提议（装上了 ⇒ 判 present ⇒ 不删），而缓存住的是更早那份，
最坏情况是"该停的提议没停"，由 `confirm` 那一趟的实时重算兜住。

## 7. 验证

| 闸 | 结果 |
| --- | --- |
| `cargo test --workspace` | **全绿**（118 passed / 0 failed，另各 crate 均 0 failed） |
| 零告警 | 编译无 warning |
| `npm test` | **1025 passed / 1 failed** |

那 1 条失败是 `tests/unit/scripts-syntax.test.ts`，**与本次改动无关**：它逐个用 node 解析全部
`scripts/*.mjs`，全量并发跑时超过 20 s 默认超时。单独跑 **7.5 s 通过**（exit 0）。
这是既有的机器负载敏感问题，不是回归。

## 8. 未做（明确不在本次范围）

- **前端连点排队**（`usePreview.ts:107`）：每次勾选都发请求且不可取消，`seq` 只丢弃过期响应、
  不取消已发出的计算。缓存落地后单次成本已降到个位数毫秒，这一项的收益随之变小，
  故未动。若将来仍有连点堆积，再按需加防抖或 AbortController。
- 探针文件（`perf_probe_selection.rs` / `perf_probe_facts.rs` / `perf_after_probe.rs`）用完即删，
  未进仓库。

---

# 附：同日的第二轮排查（勾选点不动 / 扫描结束卡在「扫描中」）

人类伙伴随后补充两条现象：

1. 「自动勾选的部分，点击勾选没反应（勾线无法取消，但是提示勾选的数值却会变化）」
2. 「debug 版本扫描结束会卡死（耗时已经停了，但是仍提示扫描中)」

**现象 2 已定位并修复；现象 1 在当前代码上复现不出来。** 分开说。

## A. 现象 1：勾选框「点不动」—— 复现失败，如实登记

先确认了这两个读数来自**不同来源**（这是读出来的，不是猜）：

| 界面上的东西 | 数据来源 |
| --- | --- |
| 勾选框 `checked={i.selected}` | **服务端回的模型**（`preview.rs:269`） |
| 「已勾 N 项」计数 | **前端本地 `selected` state**（`Cleanup.tsx:606`） |

所以「勾选框不变而计数变」只可能来自"服务端回的模型里 `selected` 没跟上"。
于是两个方向都实测了：

**服务端**（临时 Rust 探针，按界面真实四步走：空 → 全选 → 取消一条 → 勾回，缓存已热）：

```
① 空勾选      windows-temp selected=false included=false
② 自动全选    windows-temp selected=true  included=true
③ 取消一条    selected=false included=false      ← 正确
④ 勾回（命中缓存） selected=true  included=true  ← 正确
```

**真窗口**（CDP 驱动，真鼠标 `Input.dispatchMouseEvent`，逐行点）：

| 场景 | 结果 |
| --- | --- |
| 单点取消 | ✅ 19→18，勾选框同步变 false |
| 22 行逐行真鼠标点击（每行先滚进视口） | ✅ 全部正常，`ALL-ROWS-OK` |
| 连点同一条两下 | ✅ 19→18→19（互相抵消，不是失效） |
| 取消后观察 6 秒 | ✅ 状态稳定，不弹回 |
| 复现截图形态（先手动取消「缩略图缓存」再点第一行） | ✅ 18→17 正常 |

**结论：没能复现。** 一个可能的解释是**跑的是旧构建**：桌面快捷方式 `DeepClean-Tauri.lnk`
指向 `src-tauri\target\release\deepclean-app.exe`，那份的构建时间是 **10-21 20:03**，
不含本次修复。若现象仍在，请用新构建再试一次；仍在则说明触发条件与上面六种都不同，需要新线索。

> 排查中有一条**被我自己推翻的**结论，一并登记：最初以为「列表滚不动导致下面 17 行点不到」。
> 实测 `.dc-clean` 是 `overflow:auto` 的滚动容器（`scrollHeight 3008 > clientHeight 720`），
> 能滚。那次"点不到"是**探针没滚动**造成的假象，不是产品缺陷。

## B. 现象 2：扫描结束仍显示「扫描中」—— 已修复

### 成因（读代码 + 实测）

`service.rs::start_scan` 的扫描线程里，两件事的先后是错的：

```rust
st.status = Status::Completed;      // 458 行：状态已定，耗时随之冻结
st.finished_at_ms = Some(now_ms()); // 465 行：所以界面「用时」不动了

// … 第 480-498 行：开发环境页预热（warm_detector_status + warm_dev_env_report）
let _ = app2.emit(SCAN_EVENT, … done …);  // 500 行：界面才知道扫描结束了
```

界面拿状态的**唯一**通道是 `dc://scan` 事件（`useScan.ts:56`），而这条事件被预热挡在后面：

| 实测 | 数值 |
| --- | --- |
| `C:\Windows`（35,374 目录）预热耗时 | **3267 ms**（另一次 5253 ms） |
| 代码注释自记：全盘 C: 预热 | **约 12 s** |

那 3–12 秒里：耗时已经停住、界面仍念「扫描中…」—— 用户读成"卡死"。

### 修法

**把 `done` 事件提到预热之前**。顺序调换是安全的：

- 事件里带的是同一份 `snapshot`（读的是**已经写好**的状态），与预热不相干；
- 预热仍留在扫描线程上 ⇒ 窗口依旧不会因此未响应（那才是它原本的目的，没变）。

### 判据

`the_done_event_is_emitted_before_the_dev_env_warmup` —— 比较 `start_scan` 函数体里
`emit(SCAN_EVENT` 与 `warm_detector_status()` 的**源码位置**。

用源码顺序而不是运行时判据，理由写在用例注释里：`start_scan` 必须要一个真的 `AppHandle`
（`tauri::test` 之外造不出来），而这条缺陷的全部内容就是"两行的先后"。

判据内核抽成 `done_event_precedes_warmup(src) -> Option<bool>`，这样**正反两条用例走同一段逻辑**：
反序源码答 `Some(false)`、正序答 `Some(true)`、锚点缺失答 `None`（**不许退化成 true** ——
找不到锚点时"通过"是假绿）。第一版的反面对照是自己造字符串跟自己比，那种对照证明不了判据有判别力。

### 修复后实测

**debug 版**（`C:\Windows`）：

```
MARKS [{"t":20,"ui":"idle"},{"t":156,"ui":"running"},{"t":15857,"ui":"completed"}]
服务端日志：开发环境页预热 t1792649331065-0（5253 ms）
```

**release 版**（点首页真实按钮走全盘，走的是桌面快捷方式指向的那份产物）：

```
{"t":214,"live":"扫描中…"}
{"t":21425,"live":null}          ← 界面在 21.4 s 结束「扫描中」
服务端日志：开发环境页预热 t1792649970972-0（24003 ms）
```

⚠️ **这两个数是这一节最重要的证据**：预热花了 **24003 ms**，比界面结束的时刻（21425 ms）
**还要长**。界面并没有等它 —— 修复前界面必须等的正是这 24 秒，那正是"卡死"的体感。
预热仍照常跑完并填进缓存，开发环境页首开依然免付那笔钱。

（release 实测里 `hasCompleteLine` 没匹配到，是因为扫描完成后应用按规格**自动跳到空间地图**
（`App.tsx` 的 `autoEntered`），首页那一行文案随即不在 DOM 里 —— 不是缺陷。）

