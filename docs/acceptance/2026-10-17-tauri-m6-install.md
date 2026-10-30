# M6-B Task 6 装机验收：装 → 四格核对 → 首启投递 → 卸载 → 残留

日期：2026-10-17（本机 Windows 11 22631，150% 缩放，C: 已用 96.3%）
载体：`scripts/m6-install-verify.ps1`（**分相**跑：baseline / install / verify / firstlaunch / uninstall / residue）
授权：用户批准「装，验完卸载」；UAC 两次（装一次、卸一次）。

## 〇、跑之前的两道前置

`tauri build` 会为打包**再链一遍** exe（`Finished release profile in 5m 15s` 之后才 makensis），
所以旧规矩仍然成立：**闸要跑在装进包里的那份上**，而不是先前那次 `cargo build --release` 的产物。

| 跑在哪份 exe 上 | 字节 | SHA-256 前 16 | files | dirs | totalBytes | 四个错误桶 |
| --- | --- | --- | --- | --- | --- | --- |
| `target/release`（11:35 那次链接，`UNK`） | 25,002,332 | `D9E7D6EC1EE3B74E` | 89,801 | 57 | 1,032,734,840 | 全 0 |
| 同上（11:39 `tauri build` 重链，`UNK`） | 25,002,332 | `D9E7D6EC…` | 89,801 | 57 | 1,032,734,840 | 全 0 |
| **装出来的那份**（`C:\Program Files\DeepClean`，`NSS`） | 25,002,332 | `D45D8F3612685F58` | 89,801 | 57 | 1,032,734,840 | 全 0 |

夹具 `D:\deepclean-fixture\f100k`，`status=completed truncated=False`，`elapsedMs` 分别 925 / 917 / 359
（最后一趟快是因为 NTFS 缓存已经热了，不是换了口径）。三轴逐项相同 ⇒ 交付物与 M6 封口时量到的
是同一件事。**扫描范围那格仍是「指定位置」+ 那行路径**（`6b0fb88` 那条修复在装出来的那份上仍在）。

## 一、装：四格

| 格 | 实测 |
| --- | --- |
| ARP 条目 | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DeepClean`，`DisplayName=DeepClean`、**`Publisher=TihiroKano`**、**`DisplayVersion=0.1.0`**（版本号按"保留现状"那条决定） |
| 开始菜单 | `DeepClean.lnk` → `C:\Program Files\DeepClean\deepclean-app.exe`（逐字比对目标路径） |
| 装出来的 exe | 25,002,332 B，SHA `D45D8F36…` |
| WebView2 | 本机已有 `pv=155.0.4283.60` ⇒ `offlineInstaller` 那一段被跳过（判据：装完机器上运行时版本没变、也没多出一份） |
| 签名 | `NotSigned`（按"不签名"那条决定，不是缺陷） |

### 一处**正文判据写错**的地方：「与 target/release 同 SHA 才算同一件东西」

装出来的 exe 与 `target/release/deepclean-app.exe` **SHA 不同**，第一趟 `verify` 就红在这里。
逐字节比对之后：两份**长度完全相同、只差 3 个字节**，而那 3 个字节落在内嵌常量

```
__TAURI_BUNDLE_TYPE_VAR_UNK   ← target/release 那份
__TAURI_BUNDLE_TYPE_VAR_NSS   ← 装进包里的那份
```

上（偏移 12,599,792，紧接常量的那三个字符）。`tauri build` 会为不同 bundle target 各链一遍，
把"我被打进哪种安装器里"这个事实写进二进制。所以：

- 旧判据（同 SHA）**按构造不可能成立**，不是打包坏了；
- 换成的新判据是**"差异恰好是这一处"**：长度相同 + 差异字节数 = 3 + 首个差异位置就是那串常量的尾部 +
  两份分别拼出 `UNK` / `NSS`。差 0 处说明装的是没打包上下文的那份，差 >3 处说明有别的东西被动过 ——
  两种都红。
- 而"闸跑在装进包里的那份上"这条老规矩，这次是**直接拿装出来的 exe 复跑第 2 道闸**来兑现的（见 §〇 第三行），
  不再靠"两份 SHA 相同"这个中间推论。

## 二、首启投递（空数据目录）

把 `%APPDATA%\com.deepclean.app` **改名**到 `.m6bak`（不是删），启动装好的那份，等 12 s，关掉，然后：

- `license/codes.sha256` 被投递，**65,105 B 与 `src-tauri/resources/codes.sha256` 逐字节相同**（SHA 比对）
  ⇒ release + 空数据目录的那条自投递链走通了，不依赖任何 dev-only 口子。
- `logs/` 目录建出来了。**`deepclean.log` 不存在 —— 这是对的**：`FileCleanLog::create`
  （`src-tauri/src/cleanlog.rs:36`）只做 `create_dir_all(logs)` 就把路径存下，
  文件要到**第一条清理记录 append** 时才落。正文 Task 6 Step 3 那句"logs/deepclean.log 建出来"
  是照记忆写的错判据，已就地改掉并写明理由。
- 收尾：首启那趟造出来的文件丢弃、原目录改回原名。**独立复核**：跑完 `find` 到 18 个文件
  （基线 17 + §〇 那一趟在装好的应用上导出的 1 份报告），`.m6bak` 已不存在。
- **一格没测到，明写**：本机基线里**没有 `license.dat`**（授权状态还没落到这台机器上，全盘只有单测
  在 Temp 下造的那些），所以"改名再改回来没动过设备凭据"这一格**无对象可核**，脚本打印的是
  `RESTORED license.dat 基线不存在 ⇒ 这一格无对象可核（不是通过，是没测）`。

## 三、卸载与残留 —— 抓到一条真缺陷

`uninstall.exe /S`（第二次 UAC），退出码 0。逐项：

| 检查 | 结果 |
| --- | --- |
| `HKLM\...\Uninstall\DeepClean` | 消失 ✅ |
| `HKLM\...\WOW6432Node\...\DeepClean` | 本来就没写过（64 位安装）✅ |
| 开始菜单快捷方式 | 消失 ✅ |
| `C:\Program Files\DeepClean` | 整个目录删除 ✅ |
| `%APPDATA%\com.deepclean.app` | **保留**（按设计：用户数据不该被卸载器删，不是缺陷） |
| `HKLM\SOFTWARE\TihiroKano\DeepClean` | **留下了** ❌ 默认值还指着 `C:\Program Files\DeepClean`（该目录已不存在） |

**为什么这条要修而不是登记**：一把"注册表说这东西装在 `C:\Program Files\DeepClean`、而卸载表里查无此项"
的键，正是本产品自己拿来判残留的那一类形状。交付物留下它自己要扫的东西。

修法走 tauri 支持的 `bundle.windows.nsis.installerHooks`（`config.schema.json:3236` 那一格），
新增 `src-tauri/windows/uninstall-hooks.nsh`，在 `NSIS_HOOK_POSTUNINSTALL` 里删那把产品键。
~~`DeleteRegKey HKLM "Software\${PUBLISHER}\${PRODUCT_NAME}"`~~ —— 这一句是**错的**（模板里没有这两个名字，
NSIS 会原样留字面量、删一把不存在的键并且不报错），真名是 `${MANUFACTURER}` / `${PRODUCTNAME}`，见 §四。
**只删产品那一层，不动 `SOFTWARE\TihiroKano`** —— 同一发布者名下若还有别的应用，
顺手拆父键会把它们的家也拆了；留一把空的公司键是可接受的，拆错家不是。

（修完的复跑结果见下一节 —— 要重装再重卸才能证明。）

## 四、那条残留缺陷已修好并复跑闭合（第一版钩子是**静默空转**的）

### 4.1 第一版钩子没生效，而且一点错都不报

第一版写的是 `DeleteRegKey HKLM "Software\${PUBLISHER}\${PRODUCT_NAME}"` —— 装→卸复跑之后
`residue` 仍然红在同一把键上。查下来是 NSIS 的一条静默失败面：

- 模板里**根本没有** `PUBLISHER` / `PRODUCT_NAME` 这两个名字；
- NSIS 对未定义变量**原样留字面量**（不报错、不展开），于是这条 `DeleteRegKey` 打在
  `Software\${PUBLISHER}\${PRODUCT_NAME}` 这把不存在的键上 —— **删除不存在的键是成功的**，
  makensis 不报错、卸载器退出码 0、什么也没删。
- 反向确认过：`HKLM\SOFTWARE` 下没有多出任何带 `$` 的野键名（`DeleteRegKey` 不创建键），
  所以症状只有"残留还在"这一条，没有任何一处会指向"我的钩子写错了名字"。

**探法**（写进 `src-tauri/windows/uninstall-hooks.nsh` 的注释里，下次不用再猜）：
在宏体里放一行 `!error "...=[${NAME}]..."`，已定义的展开成值、未定义的留字面量，一次构建就能把
一批候选名字全部分类；顺带证明了这个宏**确实被模板插入执行**（`!error` 在宏体里会中断构建，
它响了就说明插入没问题 —— 排除掉"钩子名字写错所以从没跑过"这一类）。实测展开：

| 名字 | 展开结果 |
| --- | --- |
| `${MANUFACTURER}` | `TihiroKano` ✅ 这才是发布者 |
| `${PRODUCTNAME}` | `DeepClean` ✅ |
| `${MAINBINARYNAME}` | `deepclean-app` ✅ |
| `${PUBLISHER}` / `${PUBLISHER_NAME}` / `${PUBLISHERNAME}` / `${PRODUCT_NAME}` / `${PRODUCTFILENAME}` / `${NAME}` / `${VENDOR}` / `${COMPANY}` / `${IDENTIFIER}` / `${INSTALLLOCATION}` / `${REG_KEY}` | 全部**原样留字面量** ⇒ 模板里没有 |

另外那条"文件路径写错了所以没被读"的可能，是用同样手法反向排掉的：把 `!error` 放在文件顶层，
`makensis` 当场报 `!include: error in script: "D:\DeepClean\src-tauri\windows\uninstall-hooks.nsh" on line 1`
⇒ 文件确实被 include 了，`installerHooks: "windows/uninstall-hooks.nsh"`（相对 `src-tauri/`）这个写法是对的。

### 4.2 修好之后的复跑（带钩子的包，12:39 那份，221,903,957 B）

| 相 | 结果 |
| --- | --- |
| `baseline` | `arp=0 startmenu=0 programFilesDeepClean=False`；装之前那把残留键**在**（`Test-Path` = True，第一轮留下的活体证据） |
| `install` | 退出码 0，`$INSTDIR` 3 个文件 |
| `verify` | 四格全过；`EXE_DIFF 字节数=3`、位置就是 `__TAURI_BUNDLE_TYPE_VAR_` 尾部、`built='UNK' installed='NSS'` |
| `uninstall` | 退出码 0 |
| `residue` | `Uninstall\DeepClean` absent=True、WOW6432Node 那把 absent=True、**`TihiroKano\DeepClean` absent=True**、快捷方式 0、`$INSTDIR` 已删；`%APPDATA%\com.deepclean.app` 按设计保留 ⇒ **RESIDUE_DONE** |
| 独立复核（不读脚本自己的输出） | `HKLM:\SOFTWARE\TihiroKano` **仍在且是空的**（`parent subkeys=0`）—— 钩子只删产品那一层，没顺手拆发布者的家；`C:\Program Files\DeepClean` 不存在 |

### 4.3 这一份包的测量链是闭合的，中间那一格用的是**证明**而不是推断

`闸要跑在装进包里的那份上` 这条规矩，在这一份上是这样兑现的（卸载之后包内 exe 已不在盘上，所以顺序很重要）：

1. `verify` **实测**：装出来的那份与 loose 那份长度相同、只差那 3 个字节，且差异位置与内容都点到了名字
   （不是"应该一样"，是"差的就是这一处"）。
2. 装好之后当场在**装出来的那份**上跑过第 2 道闸（上一轮，`m6g5-hooked-*`）：89,801 / 57 / 1,032,734,840、四桶全 0。
3. 本轮在 build 3 的 loose exe 上复跑（`m6g6-build3-*`）：三轴逐项相同、`elapsedMs=545`、四桶全 0。

⇒ 1+3 之间只差那 3 个字节的一个字符串常量，而它不参与扫描；三轴数字在两侧各测了一遍，完全一致。



## 五、本文之后又重打过两次包 —— 现在要交付的那份**没被装过**（收盘登记）

本文 §〇～§四 那条链跑在 **12:39 那份包**上。此后包又重打过两次，差额都是产品侧的：

| 时刻 | 大小 | 触发重打的改动 | 装/卸有没有跑过 |
| --- | --- | --- | --- |
| 12:39 | 221,903,957 B | 带 `installerHooks` 的那份（§4.2 复跑对象） | **跑过**（四格 + 首启投递 + 卸载 + 残留三把键） |
| 15:12 | 221,902,754 B | `98b92c5` 渲染端：滚动条隐藏 + 窄窗两处 | 没装过 |
| 16:45:55 | 221,903,371 B | `c28ba69` `build.rs`：用 gcc 的 `-B` 顶掉 MinGW 的 `default-manifest.o` | 没装过 |

盘上现存的就是 16:45 那份：`src-tauri/target/release/bundle/nsis/DeepClean_0.1.0_x64-setup.exe`，
221,903,371 B，sha256 前 24 位 `e6494def61febf9dffba8bfd`。

所以"装机验收通过"这句话的准确范围是：**12:39 那份通过**；当前包在「装 → 四格 → 首启 → 卸载 → 残留」
这条链上还没有证据。已知差额两条，一条肉眼可查（渲染端 CSS），一条行为可查（嵌入清单 ⇒ 长路径）。

关于清单那半，有一条**推断闭合但没直测**的证据链：16:41 那次改动换来的是零告警构建（此前 `ld` 报
`.rsrc merge failure: multiple non-default manifests`），而当前 loose exe 里
`Microsoft.Windows.Common-Controls` 只出现 **1 次**（两份清单并存时会是 2 次）⇒ MinGW 那份默认清单
已不在产物里，留下的就是合并那份（同时带 comctl v6 与 `longPathAware`）。**没做**的是直接解 PE
资源目录取 RT_MANIFEST(ID=1) 原文逐字比对 —— 这一格到"推断"为止，别当实测引用。

另外两格（装出来的那份上复跑第 2 道闸、ARP 里 `bundle.license` 的可见性）用户明令自己测，本轮不代跑；
换包之后前面那条链要不要重跑，是一个还没得到答案的问题。
