# 2026-10-25 勾选延迟：勾没显示、也未计入

**一句话结论**：根因不是"服务端慢"，而是**复选框读的是服务端模型**（`checked={i.selected}`），
且「自动打勾之后的中间相」没有被 Loading 盖住 —— 页面停在「已勾 19 项 · 计入 0 项」那一相，
直到用户点一下触发新回包才恢复。修法三处：前端勾选框本地优先（`rowChecked`）、
`settling` 的门从 `autoFilled` 改成 `userTouched`、服务端把已删集合从「一刀关掉缓存」
改成「进缓存键」。**三处都配了判据，且都做过变异验证（把修法装回去必须红）。**

---

## 1. 现象（人类伙伴 2026-10-25 原话）

> 「点击勾选后会出现延迟，勾没显示出来，也未计入。」

配的截图里那 6 行全都没勾、「计入预估」一列全是「—」、「已勾 0 项」。

---

## 2. 根因（三件事叠在一起）

### 2.1 复选框读的是服务端字段

```
onChange → toggle() → App 的 selected 变 → usePreview 发 dc_preview
        →（等回包）→ payload 换成新模型 → checked 才跟着变
```

`PreviewItem.selected` 是服务端按 `selection` 算出来的（`core/rules/preview.ts:218`），
所以点击与显示之间**必然隔着一次 IPC**。这一段里屏幕上没有任何变化。

10-22 那份记录把服务端从 490 ms 降到 1.4–3.6 ms，但只要还走"等服务端"这一跳，
慢一次就复现一次。而 2.3 那件事正好让它在清理之后**一定**慢。

### 2.2 「计入」那一列与总数字同源，不能本地造假

`i.included` 与「预计释放」总数字是同一份账的逐行拆分（`model.totalBytes`）。
本地勾上而模型还没回包时，`i.bytes` 此刻还是 0 —— 先画一个「0 B」就是编一个数。
所以这一列**保持只读服务端**，回包后自然跟上。用户说的「也未计入」指的是截图里
那些行连勾都没有；勾显示了，这一列才会跟上。

### 2.3 真正让页面"卡住不动"的：settling 门错了 ref（**本次的主因**）

```ts
// 修之前
const settling = Boolean(model) && !autoFilled.current && !modelMatchesSelection(model, selected)
```

`autoFilled.current = true` 与 `onSelectedChange(selectableIds)` 在**同一个 effect 的同一拍**执行
（`Cleanup.tsx` 的自动打勾 effect）。于是自动打勾之后 `settling` **恒为 false**，
「勾已填进去、但模型还没反映它」那一相不再被 Loading 盖住，直接画给用户。

真机采样复现到的那一帧：

```
{"rows":22,"checked":19,"loading":false,"count":"已勾 19 项 · 计入 0 项","pricedRows":0}
```

页面停着不动，直到用户点一下触发新的回包才恢复 —— 读起来正是「勾选有延迟、勾没显示、也未计入」。

**这一相寿命很短**（报告缓存热时 1.4–3.6 ms），所以判据不能靠"某一拍正好没采到"来证明修好了：
探针改成从进页面第一帧起**持续采样**（50 ms 间隔），任何「有行勾着而一行都没计价」的帧都记为缺陷帧。

### 2.4 附带：清理之后缓存永久失效（10-22 修法的漏洞）

`report_for_preview` 原来这一行：

```rust
let reuse = reuse && deleted.is_empty();   // ← 已删集合非空 ⇒ 一律不复用
```

`deleted_paths` **只增不减**，于是清理过一次之后缓存**永久**失效，此后的每一次勾选
都重跑全树索引 + 机器事实采集 + 规则评估（`C:\Windows` 125k 文件实测 244 ms 起）。
真机日志坐实：`auto-1792922491488-2` 删了 330 个文件、`cleanedSize=10902721`。

---

## 3. 修法

### A. 前端：勾选框本地优先（`rowChecked`）

```ts
export function rowChecked(item: PreviewItem, selectedRuleIds: readonly string[]): boolean {
  if (selectedRuleIds.includes(item.ruleId)) return true   // 本地勾了 ⇒ 立刻勾，不等服务端
  return item.selected                                      // 本地没勾 ⇒ 听服务端的
}
```

**为什么不是 `checked={selected.includes(i.ruleId)}`**：那会把服务端那份 `selected` 整个丢掉，
而 `modelMatchesSelection` 要逐条对账它（判"模型是否已反映勾选"），首屏自动打勾那一相也依赖它。
所以只改**显示**这一层。

### B. `settling` 的门改成 `userTouched`

```ts
const userTouched = useRef(false)      // 只有 toggle / 全选 / 清空 会置位
const touch = useCallback(() => { userTouched.current = true }, [])
const settling = Boolean(model) && !userTouched.current && !modelMatchesSelection(model, selected)
```

`autoFilled`（程序自动填过一次）与 `userTouched`（人手动动过）是两件不同的事，
而该门的是后者。自动打勾那一相仍被盖住；手动勾选之后不盖（否则每次勾选都闪 Loading，
真机实测过 `flashes=3`）。

### C. 服务端：已删集合进缓存键

```rust
// 键从 (report_claims) 变成 (report_claims, deleted_snapshot)
Some((claims, key, r)) if *claims == report_claims && *key == deleted_key => ...
```

集合不变就一直复用；`execute_plan` 追加过 ⇒ 键变 ⇒ 重算一次，之后又稳定。
清理后**第一次**勾选付一次全量（数字要跟着磁盘现实走），之后每次都是缓存命中。

### D. 顺带修掉 `scripts-syntax` 测试的超时

我新加了两个 `.mjs` 探针之后，那条测试（串行 `execFileSync` 起 44 个 node 进程，
实测 49 s）当场超过 20 s 默认超时。**这不是被查对象的错**（44 个脚本单独 `--check` 全 exit 0），
所以修法是改**并发**（实测 7.3 s / 测试内 5.4 s），不是抬超时 ——
抬超时等于把这条闸的真实代价藏起来，下一次再加脚本还会红。

---

## 4. 判据（都做过变异验证）

### 前端

| 用例 | 钉住什么 |
| --- | --- |
| `cleanup-row-checked.test.tsx` ① | 本地勾了、服务端还没回包 ⇒ **立刻显示已勾** |
| ③ | 本地没勾、服务端说勾了 ⇒ 听服务端的 |
| ⑥ | 列表里没有的 id 不许点亮任何一行 |
| 对照 ×2 | 只翻本地 / 只翻服务端，答案都必须换 |
| `cleanup-layout-contract.test.ts` ⑧ | 源码闸：`const checked = rowChecked(i, selected)` 必须在，`checked={i.selected}` 不许回来 |
| ⑨ | 源码闸：`settling` 门 `userTouched.current`，三个改勾选入口都要 `touch()`，自动打勾 effect 不许碰它 |

**变异 1**（勾选框改回 `i.selected`）⇒ ⑧ 红。
**变异 2**（`settling` 门回 `autoFilled`）⇒ ⑨ 红。

### 服务端

| 用例 | 钉住什么 |
| --- | --- |
| `a_deleted_path_snapshot_bounds_the_cache` ① | 集合没变（哪怕非空）⇒ 复用缓存（假报告 424242 原样念出来） |
| ② | 集合变了 ⇒ 必须重算（拿真树的 100）—— 10-24「清理后数字要变」的回归防线 |
| ③ | 重算之后缓存里存的是新快照 ⇒ 之后又稳定复用 |
| 既有四条 | reuse / 换会话隔离 / claims 变体 / confirm 永不复用 —— 一条没动 |

**变异 3**（把 `&& *key == deleted_key` 从命中条件里摘掉）⇒ ② 红（`left: 424242, right: 100`）。

### 真机

| 判据 | 结果 |
| --- | --- |
| 全序列采样无缺陷帧 | 修好：`frames:21, blankFrames:0`；变异：`blankFrames:1`（那一帧正是 `已勾 19 项 · 计入 0 项`） |
| 点击同一拍即显示 | `lagMs:53`，`checked:true, rowOn:true, est:"40.0 KB", 已勾 19 项 · 计入 19 项` |
| 回包后「计入预估」跟上 | `est:"40.0 KB"`，`count` 稳定 |

**变异 4**（`settling` 门回 `autoFilled` 后重建二进制）⇒ 真机探针红，报出缺陷帧原文。
这条最关键：它证明 2.3 的诊断不是读代码猜的，而是能在真机上复现、也能被修掉的那一个。

---

## 5. 验证

| 闸 | 结果 |
| --- | --- |
| `vitest run`（全量） | **1034 passed / 0 failed**（69 文件） |
| `cargo test --workspace` | **19 个 crate 全绿，0 failed** |
| `tsc -p tsconfig.web.json --noEmit` | exit 0 |
| `vite build --config vite.config.tauri.ts` | built in ~3 s |
| `cargo build`（debug） | 已重打 —— dist 编译期嵌入，不重打跑的还是旧页面 |
| 真机 e2e | `CHECKBOX_LATENCY_OK` + `CHECKBOX_E2E_OK` |

---

## 6. 未做 / 已知代价（如实登记）

1. **真鼠标点击在这个 WebView2 上不可用**：`Input.dispatchMouseEvent`（含 mouseMoved +
   pressed + released 三连）**不会合成 click**，实测 `change` 事件计数为 0。全仓也没有别处
   成功用过它做点击（`scale-probe.mjs` 只用它发滚轮）。所以延迟判据用的是编程 `click()`
   （`Runtime.evaluate` + `userGesture:true`，与 `clean-dialog-e2e.mjs` 点「一键清理」同一条
   已验证路径）。**量的是"点击到显示"这一跳有多长，不是"哪种输入法更真实"** —— 这一格如实登记。
2. **`tsconfig.node.json` 有 5 个既有类型错误**（`usePreview.ts` 被 node 项目编译 + 3 处测试断言
   与实现签名不符）。已用 `git stash` 对上一个 commit 复现过：**同样 5 个，与本次改动无关**。
   未修 —— 不在本次范围。
3. **勾选后「预计释放」总数字仍有几十到几百毫秒滞后** —— 10-21 选定的取舍（宁可数字慢半拍，
   也不在勾选框旁边闪动画）。本次只把**勾选状态本身**变成即时。
4. **已删集合进键的代价**：集合每次变大都要重算一次报告。清理是低频、勾选是高频，方向是对的；
   但连续两次清理之间勾选，第二次要付一次全量。
5. **`checkbox-reconcile-probe.mjs` / `checkbox-reconcile-drive.ps1` 是调试伴生脚本**，
   保留是为了下次再遇到"勾选链哪一帧分叉"时能直接复用量；`_` 前缀那些旧探针不在版本库里，
   这两个刻意不带下划线，让 `scripts-syntax` 那条闸也一并查它们。
