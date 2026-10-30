# 2026-10-27 release 重打

**一句话结论**：release 从 10-25 那版重打到今天，含勾选延迟修复、三处文案改口径、设置页重做
（三块卡片 + 壁纸 + 毛玻璃 + 莫比乌斯环）全部改动。**过程中抓到一个只在 release 暴露的编译错误**
（`main.rs` 的 `use tauri::Manager` 挂着 debug 门控，debug 编得过、release 过不去）。

```
target\release\deepclean-app.exe                       16,247,808 B   17:52:46
target\release\bundle\nsis\DeepClean_0.1.0_x64-setup.exe  222,478,531 B（212.17 MiB） 17:52:46
```

---

## 1. 为什么这次不只是「再跑一遍 cargo build」

未闭合清单第 1 条写的是**安装包没重打**：`bundle\nsis\` 那份仍是 10-18 的旧产物，
而 10-25 已把 manifest 改成 `requireAdministrator` —— 分发的仍是 `asInvoker` 的旧包，
与代码不一致。所以这次跑的是 `tauri build`（exe + NSIS 打包），不是 `cargo build --release`。

---

## 2. 抓到的那个缺陷（只在 release 暴露）

第一次 `tauri build` 报：

```
error[E0599]: no method named `path` found for reference `&AppHandle`
   --> src\main.rs:111:49
111 |             let Ok(app_data) = ctx.app_handle().path().app_data_dir() else {
    = help: items from traits can only be used if the trait is in scope
    = help: trait `Manager` which provides `path` is implemented but not in scope
```

**根因**：`main.rs` 里 `use tauri::Manager;` 挂着 `#[cfg(debug_assertions)]` ——
因为加壁纸之前**只有** `dev_autoscan`（debug-only）用它。昨天加的两条壁纸通道
（`dc-wallpaper` 协议要 `app.path()`、`dc_pick_wallpaper` 要 `get_webview_window`）
在 release 档也要用同一个 trait，于是 release 编不过。

**为什么昨天没发现**：`cargo build`（debug）能过、`cargo test` 能过、`cargo check` 能过 ——
**三个都在 debug 档**。`cargo check --release` 从没跑过。

**修法**：把那个 import 的 `#[cfg(debug_assertions)]` 摘掉，并把这条教训写进注释
（"别再按 debug 门控"）。修完先单独跑 `cargo check --release` 确认这一档能编，
再去跑完整的 `tauri build` —— 不要拿十几分钟的打包当编译检查。

**这条值得记进方法的理由**：本仓有「debug 档验不到提权」那条已知缺口（未闭合清单第 2 条，
按设计就是如此）。今天是**另一件事**：不是验不到，是**编译过不去**。
它同样只在一档出现，但下一次跑 release 之前能靠 `cargo check --release` 当场发现 ——
所以真正的教训是那句命令应该进出包前置。

---

## 3. 产物核对（做到的四条）

| 核对项 | 结果 |
| --- | --- |
| 内嵌 manifest 是否 `requireAdministrator` | ✅ `requestedExecutionLevel level="requireAdministrator"`，且 `longPathAware=true` 同在我们那份合并版里 |
| release 里有没有 debug-only 的门 | ✅ `DC_ENV_ROOT` / `DC_AUTOSCAN` / `DC_SETTINGS_DIR` / `DC_LICENSE_DIR` **五个全部 absent** |
| 新壁纸通道在不在产物里 | ✅ `dc-wallpaper` / `dc_pick_wallpaper` / `wallpapers` 三个串都在 |
| 版本资源 | ✅ 安装包与包内 exe 均 `FileVersion 0.1.0` / `ProductVersion 0.1.0` / `LegalCopyright © 2026 TihiroKano` |

---

## 4. 没做的（如实登记）

1. **装机验收没跑**（`m6-install-verify.ps1` 那六相）。它要 UAC（`installMode=perMachine`），
   且会改这台机器的 HKLM / Program Files / 开始菜单 —— 那一步要单独点头，不能顺手做。
   ⇒ **「装进包里的那份 exe 带 requireAdministrator」这句仍然没有装机后的证据**，
   验到的只是 `target\release` 那份（打包时被 patch 过）。两者按 `m6-install-verify.ps1`
   的判据只该差 `__TAURI_BUNDLE_TYPE_VAR_` 那三个字节。
2. **`__TAURI_BUNDLE_TYPE_VAR_` 的值是 `DEB` 不是 `NSS`**。装机验收脚本的注释写的是
   「`tauri build` 会把 `UNK` 改写成 `NSS`」，而这次实测 `target/release` 那份是
   `DEB`（`tauri` 自己 patch 的，`Info Patching … with bundle type information: nsis` 那行之后）。
   这可能是 tauri 2.12 的变化，也可能那份注释从一开始就写错。
   **没有证据判断，所以只登记不改**：真机装机那一步会用「差异恰好三个字节」这条判据自己回答。
3. **release 里真删过一次**仍然没有证据，而且按设计不会有（`DC_ENV_ROOT` 是 debug-only 口子）。
4. **`scripts-syntax.test.ts` 那条**已在上次改成并发，本次全量 1082 条通过。

---

## 5. 验证

| 闸 | 结果 |
| --- | --- |
| `cargo check --release` | ✅ Finished（零告警）—— 这一条从今天起该进出包前置 |
| `tauri build` | ✅ exe + NSIS bundle 两件都出 |
| `cargo test --workspace` | ✅ **28 组 `test result: ok` / 0 FAILED / 0 个 `failures:` 块** |
| `vitest run`（全量） | ✅ **1082 passed / 0 failed**（73 文件） |

> 取判据的方式记一笔：`cargo test | Select-String` 那条管道会让 `$LASTEXITCODE` 变成 `-1`
> 或 `0` 之类与测试结果无关的值（本仓 `attribute-exit-code-to-the-real-command` 那条纪律）。
> 所以上面那行是**从输出正文里数**：`test result: ok` 28 次、`test result: FAILED` 0 次、
> `^failures:$` 0 次 —— 数出来是绿的，不是"退出码看着像绿的"。
