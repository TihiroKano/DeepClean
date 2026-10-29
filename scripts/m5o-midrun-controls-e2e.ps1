# M5-O 真机验收：**扫描/检测途中改控件**（M5-M §3 ② 那格欠账）
# **全程零删除**：只读检测，跑完逐名点名文件数与总字节未变。
#
# 出处：`docs/acceptance/2026-10-13-tauri-m5-m.md` §3 ② ——
# 「M5-F/M5-J 验过"途中点导航"与"途中轮询"，没验过"途中改输入"。代价：途中改输入会不会让
# 一次过期的检测报告被当成新的用，今天没量过。」
#
# 量三件事，都是**用户真点得出来的动作**：
#   A 跑着的时候，上一轮报告那些控件必须是**点不动**的（组复选框 `disabled={busy}`、
#     「这份别删」同一道）—— 这是结构性那道，界面上看着"能点"而服务端拒 = 最坏的形状。
#   B 跑着的时候去设置页把「重复文件 · 最小尺寸」改一档（改一档=立刻存，没有保存按钮），
#     **回到重复页，那一屏旧报告里那句「候选 N 个（≥ X）」必须还是旧值** ——
#     页面自己写着「改完要重跑一次才按新值算」，这一句此前从没被肉眼看过一次。
#   C 等这一轮跑完（它是**改之前**开的 ⇒ 仍按旧值），再开第三轮 ⇒ 必须按新值，
#     且候选数**真的变了**（夹具刻意做成 4 MiB 与 9 MiB 两档：旧值 4 MB 时两档都算候选，
#     新值 8 MB 时只剩 9 MiB 那批 ⇒ 这一格要么数对、要么当场红，不存在"两边都一样所以看不出来"）。
#
# 「窗口没打开」不许成为一种能求值的状态：B 与 C 之前都先断言"这一轮确实还在跑"
# （地标 = 「取消」那颗按钮在 + 「已读 N」在涨）。跑太快抢不到窗口 ⇒ **当场红**，
# 而不是把这一相跳过然后回报"全绿"。
#
# 纪律照 m5n / m5j：UIA 名字一律码点拼（无 BOM 的 UTF-8 会被 PowerShell 5.1 按 ANSI 读，
# 乱码的名字与"元素不存在"在日志里长得一模一样）；复选框按 `ControlType.CheckBox` + `IsEnabled` 取；
# `<select>` 的选项文字不进 UIA Name ⇒ 改档用**键盘**（SetFocus + 真按一次 DOWN），
# 而"改到了没有"由设置页自己那句回执判定，不由我猜选项顺序；拍照前先顶到 z-order 最上。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$Fix    = "D:\dc-m5o-fixture",
    [string]$SetDir = "D:\dc-m5o-settings",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    [int]$Small     = 60,     # 4 MiB 那批（旧值算候选、新值不算）
    [int]$Large     = 20,     # 9 MiB 那批（两档都算候选；其中两份内容相同 ⇒ 有组可勾）
    # 换构建跑必须换前缀：`m5o-01-…` 那五张 + FAIL 是 debug 态既有的证据图，不许被这一棒覆盖。
    [string]$Prefix = "m5o-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool share);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$N_DUP_NAV   = U 0x91CD,0x590D,0x6587,0x4EF6                                  # 重复文件
$N_START     = U 0x5F00,0x59CB,0x67E5,0x627E,0x91CD,0x590D,0x6587,0x4EF6      # 开始查找重复文件
$N_CANCEL    = U 0x53D6,0x6D88                                                # 取消
$S_READ      = U 0x5DF2,0x8BFB                                                # 已读
$S_CAND      = U 0x5019,0x9009                                                # 候选
$S_NARROW    = U 0x8FD9,0x4EFD,0x522B,0x5220                                  # 这份别删
$N_SETTINGS  = U 0x8BBE,0x7F6E                                                # 设置
$S_CUR       = U 0x5F53,0x524D,0x6309                                          # 当前按
$S_JI        = U 0x8BA1                                                       # 计
$S_NO_DUP    = U 0x6CA1,0x6709,0x53D1,0x73B0,0x5B8C,0x5168,0x91CD,0x590D,0x7684,0x6587,0x4EF6  # 没有发现完全重复的文件
$S_SAVED     = U 0x5DF2,0x5B58,0x597D                                          # 已存好（设置页那句服务端回执的头三字，逐字从 Settings.tsx:185 抄）

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null
$script:Hwnd = [System.IntPtr]::Zero
$script:Win = $null
$script:Fails = @()

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA 树枚举一直失败（COM）"
}
function Names($root) { (Get-Els $root | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
function PageText($root) { ((Names $root) -join '|') }
function FlatText($root) { ((Names $root) -join '') }
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Has-Substr($root, [string]$sub) { return [bool](Find-Substr $root $sub) }
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    $t = PageText $root
    throw "${sec}s 内没出现 '$sub'。整页文本头 300 字：$($t.Substring(0, [Math]::Min(300, $t.Length)))"
}
function Raise-Window([System.IntPtr]$h) {
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 350; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Ensure-OnTop([string]$why) {
    $ok = [Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    Raise-Window $script:Hwnd
    Start-Sleep -Milliseconds 300
    if (-not $ok) { throw "SetWindowPos(TOPMOST) 失败（$why）" }
}
function Invoke-ByName($root, [string]$name, [string]$expectAfter = '', [int]$tries = 4) {
    for ($t = 1; $t -le $tries; $t++) {
        $e = Find-Substr $root $name
        if (-not $e) { Start-Sleep -Milliseconds 400; continue }
        if (-not $e.Current.IsEnabled) { throw "命中的 '$name' 是 disabled（点它没有后果，判据会假过）" }
        $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        if ($expectAfter -eq '') { Start-Sleep -Milliseconds 700; return }
        $end = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $end) { if (Find-Substr $root $expectAfter) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  点 '$name' 没等到 '$expectAfter'（第 $t/$tries 次），重试"
    }
    throw "点了 $tries 次 '$name' 始终没出现 '$expectAfter'"
}
function CheckBoxes($root) {
    return @($root.FindAll($SCOPE_D, [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
}
# 「这一轮还在跑」的判据 = 取消那颗按钮在，且「已读 N」那个数在动。
# 拿"页面还没出结果"当"还在跑"是错的：开跑前它也没结果。
# 为什么按 `ControlType.Button` + **名字逐字等于**「取消」而不是子串：报告尾巴那句
# 「这一轮被取消」也含这两个字（Duplicates.tsx:605），拿子串判"还在跑"会在跑完之后
# 继续等到超时 —— 而超时之后的那一相就变成在一张静止的屏上做的。
function Find-Cancel($root) {
    foreach ($e in (Get-Els $root)) {
        if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $e.Current.Name -eq $N_CANCEL) { return $e }
    }
    return $null
}
function Assert-Running([string]$tag, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    $last = -1
    while ((Get-Date) -lt $end) {
        $flat = FlatText $script:Win
        $cancel = Find-Cancel $script:Win
        $m = [regex]::Match($flat, "$S_READ\s*([0-9,]+)")
        if ($cancel -and $m.Success) {
            $n = [int]($m.Groups[1].Value -replace ',', '')
            if ($last -ge 0 -and $n -gt $last) { Write-Host "  $tag：还在跑（「$S_READ」$last → $n，「$N_CANCEL」那颗按钮在）"; return $n }
            $last = if ($last -lt 0) { $n } else { [Math]::Max($last, $n) }
        }
        Start-Sleep -Milliseconds 400
    }
    throw "$tag：$($sec)s 内抢不到「正在跑」的窗口（要么跑太快结束了，要么「$S_READ」/「$N_CANCEL」根本没出现）—— 这一相没测到东西就是失败，不许当通过"
}
# 等这一轮跑完 = 那颗「取消」按钮消失（它只在 busy 时渲染）。不用子串找，理由见 Find-Cancel。
function Wait-RunDone($root, [int]$sec, [string]$tag) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        if (-not (Find-Cancel $root)) { Start-Sleep -Milliseconds 800; return }   # 让报告尾巴那句先渲染完
        Start-Sleep -Milliseconds 500
    }
    throw "$tag：$($sec)s 后那颗「$N_CANCEL」按钮还在（这一轮没结束，后面那相的读数不可信）"
}
# 报告里那句「候选 N 个（≥ X）」的门槛值 —— 它是**这一轮实际用的值**（页面读 report.minSizeBytes 而不是本地 state）。
# 括号与 ≥ 一律走码点：本文件是无 BOM 的 UTF-8，PowerShell 5.1 按 ANSI 解码，
# 写成字面量的话"日志里看着是对的"（字节往返）而与 UIA 那个真字符**永不相等** ——
# 症状就是"界面明明有这句，正则读不出"，和"界面没这句"长得一模一样。
$CH_LP = [string][char]0xFF08   # （
$CH_RP = [string][char]0xFF09   # ）
$CH_GE = [string][char]0x2265   # ≥
function Read-ReportThreshold($root) {
    $pat = $S_CAND + '[^' + $CH_LP + ']*' + $CH_LP + $CH_GE + ' *([0-9.]+ ?(?:B|KB|MB|GB))' + $CH_RP
    $flat = FlatText $root
    $m = [regex]::Match($flat, $pat)
    if ($m.Success) { return $m.Groups[1].Value }
    $i = $flat.IndexOf($S_CAND)
    $seg = if ($i -ge 0) { $flat.Substring($i, [Math]::Min(80, $flat.Length - $i)) } else { '（整页没有「' + $S_CAND + '」）' }
    throw "读不出报告里那句「$S_CAND …$CH_LP$CH_GE …$CH_RP」。原文片段：$seg"
}
function Read-SettingsEcho($root) {
    # JSX 把「当前按 {x} 计」拆成三个文本节点，拼起来是「当前按 8.0 MB 计」—— 两侧的空格都在，
    # 所以这里必须留 \s*：漏一个就变成"界面没这句"，而它其实一直在。
    $m = [regex]::Match((FlatText $root), "$S_CUR\s*([0-9.]+ ?(?:B|KB|MB|GB))\s*$S_JI")
    if (-not $m.Success) { throw "读不出设置页那句「$S_CUR … $S_JI」" }
    return $m.Groups[1].Value
}
# 服务端回执那句：`已存好：8 MB（依据是服务端回执，不是这次点击本身）`。
# 它写的是**整数 MB**，而上面那句走 formatBytes（"8.0 MB"）—— 两种渲染必须指同一个数，
# 所以这里换算成同一套字串再比，而不是各读各的都"看着对"。
function Read-SavedEcho($root) {
    # 冒号是**全角** U+FF1A（`已存好：8 MB`），写成 ASCII ':' 会一条都不命中，
    # 而"抓不到数"与"界面没这句"在日志里长得一样 —— 所以拼出来，不靠字面量。
    $pat = $S_SAVED + [string][char]0xFF1A + ' *([0-9]+) MB'
    $m = [regex]::Match((FlatText $root), $pat)
    if (-not $m.Success) { return $null }
    return [int]$m.Groups[1].Value
}
function Fmt([long]$n) {
    $units = @('B', 'KB', 'MB', 'GB', 'TB', 'PB'); $v = [double]$n; $i = 0
    while ($v -ge 1024 -and $i -lt $units.Count - 1) { $v /= 1024; $i++ }
    if ($i -eq 0) { return "$([Math]::Round($v)) B" }
    return $v.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture) + ' ' + $units[$i]
}
# 按**控件类型 + 名字逐字**取按钮，不按"名字里含这几个字"：
# `<li>` 这类容器的聚合 Name 也含「这份别删」，而容器永远 IsEnabled=true ——
# 拿子串匹配统计"点得动几个"会把容器算进去，量出一条根本不存在的缺陷
# （本仓在复选框上为同一件事付过学费：`-like` 命中的常是旁边那个 Text）。
function Find-Buttons($root, [string]$exactName) {
    return @(Get-Els $root | Where-Object {
        $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button' -and $_.Current.Name -eq $exactName
    })
}
function Press-Key([byte]$vk, [int]$times) {
    for ($i = 0; $i -lt $times; $i++) {
        [Native.U32]::keybd_event($vk, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 60
        [Native.U32]::keybd_event($vk, 0, 2, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 350
    }
}
function Shot([string]$file) {
    # 原来是「抓整块桌面再按 UIA BoundingRectangle 裁」：裁完宽度是窄的，Task 1 那道只量宽度的闸拦不住
    # 它，而 UIA 矩形左沿 ≠ 窗口可见左沿（2026-10-15 实测差 40-55 px）⇒ 每张都裁进一条别窗口的像素。
    # Save-DcShot 自己会顶窗（min→restore→AttachThreadInput→真点标题栏），所以不再调 Ensure-OnTop；
    # 拿不到 DWM 帧时它直接 throw，不会退回整屏 —— 这一棒的五张图还要做逐字节互不相同的判据。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    if ($info.Width -lt 400 -or $info.Height -lt 300) { throw "帧尺寸 $($info.Width) x $($info.Height) 不像一扇真窗口" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节" }
    Write-Host "  截图 -> $file ($len 字节)"
}

try {
    # ---- 夹具：两档大小 + 一对真重复（9 MiB 那批里，两档门槛下都算候选）----
    if (Test-Path $Fix) { Remove-Item -Recurse -Force $Fix }
    New-Item -ItemType Directory -Force -Path $Fix | Out-Null
    $sB = 4194304L; $lB = 9437184L
    # 变量名**不能**叫 $small / $large：PowerShell 的比较是不区分大小写的，那会把参数
    # `$Small` / `$Large`（文件个数）整个覆盖掉，症状是 `for ($k=1; $k -le $Small)` 拿一个
    # byte[] 当上界 —— 报出来的行号还在上面那几行，看着像数组分配坏了。
    $patSmall = New-Object byte[] $sB; for ($i = 0; $i -lt $sB; $i++) { $patSmall[$i] = [byte](($i * 7 + 13) -band 0xff) }
    $patLarge = New-Object byte[] $lB; for ($i = 0; $i -lt $lB; $i++) { $patLarge[$i] = [byte](($i * 11 + 7) -band 0xff) }
    for ($k = 1; $k -le $Small; $k++) { [System.IO.File]::WriteAllBytes((Join-Path $Fix ("s{0:d3}.bin" -f $k)), $patSmall) }
    for ($k = 1; $k -le $Large; $k++) { [System.IO.File]::WriteAllBytes((Join-Path $Fix ("l{0:d3}.bin" -f $k)), $patLarge) }
    $patSmall = $null; $patLarge = $null
    if (Test-Path $SetDir) { Remove-Item -Recurse -Force $SetDir }
    New-Item -ItemType Directory -Force -Path $SetDir | Out-Null

    # ---- 独立口径：候选数与总字节由 PowerShell 自己数 ----
    $all = @(Get-ChildItem $Fix -Filter *.bin)
    $expTotalBytes = ($all | Measure-Object -Property Length -Sum).Sum
    $candAt = { param($mb) @($all | Where-Object { $_.Length -ge ($mb * 1MB) }).Count }
    Write-Host ("夹具：{0} 个文件 / {1} 字节；≥4MB 候选 {2} 个、≥8MB 候选 {3} 个" -f $all.Count, $expTotalBytes, (& $candAt 4), (& $candAt 8))
    if ((& $candAt 4) -eq (& $candAt 8)) { throw "夹具不对：两档门槛下候选数一样，那 B/C 两相根本量不出差别" }

    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑（PID $(($stale.Id) -join ', ')）—— 先关掉再跑，脚本不抢窗口" }
    $env:DC_SETTINGS_DIR = $SetDir
    # DC_SETTINGS_DIR 是 settings.rs:198 的 #[cfg(debug_assertions)] 重定向 ⇒ 打包版拿不到，
    # 而这一棒**真的会改门槛**（②③ 两相就是改控件）⇒ release 上那一下落在用户真的 settings.json 里。
    # 拍快照、finally 还原。
    $script:SetTok = Protect-DcSettings
    # 变量名一律 $dcApp（PowerShell 大小写不敏感，$r 会撞脚本里的局部变量）。
    # 这一棒要的是"扫描跑完之后"再开始它的途中相（途中相是**重复检测**，不是扫描），
    # 所以用默认等待、不带 -NoWait；旧写法那句 `Wait-Substr $w $Fix 240` 换成 helper 的
    # "地图面包屑里出现这棵根"，判据更强一档。
    # 诊断面：旧写法自己 Start-Process 时挂了 -RedirectStandardError，helper 现在把这一格接回来了
    # （`-StdErrLog`），红的时候 catch 里会把那份 stderr 的尾巴打出来。
    # 文件名带时刻：上一轮的实例攥着同名文件会让这一轮红在「文件正被另一进程使用」，那条红看着像产品坏了。
    $appLog = Join-Path $env:TEMP ('dc-m5o-stderr-{0}.log' -f (Get-Date -Format 'yyyyMMddHHmmss'))
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $Fix -WaitSec 240 -StdErrLog $appLog
    $script:Own = $dcApp.Proc.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd
    $w = $dcApp.Win
    Write-Host "  扫描跑完"

    # ---- 先读设置页那一格的初始值（不假设默认是 4 MB，读出来当基准）----
    Invoke-ByName $w $N_SETTINGS
    $t0 = Read-SettingsEcho $w
    Write-Host "  设置页初始门槛 = $t0（这一格后面还要改它）"
    Invoke-ByName $w $N_DUP_NAV $N_START

    # ---- 第 1 轮：跑完，拿到一份"有控件可点"的报告 ----
    # 地标不能选「候选」：跑着的时候那句进度也叫「候选 80（全文 hash 阶段）」，
    # 拿它当"报告出来了"就会在报告还不存在时去读门槛 —— 第一版就是这么红的。
    Invoke-ByName $w $N_START $S_READ
    [void](Assert-Running "第 1 轮" 60)
    Wait-RunDone $w 300 "第 1 轮"
    [void](Wait-Substr $w $S_GROUPED 30)
    $th1 = Read-ReportThreshold $w
    Write-Host "  第 1 轮报告门槛 = $th1（应等于设置页那句 $t0）"
    if ($th1 -ne $t0) { $script:Fails += "第 1 轮报告用的门槛与设置页不一致：$th1 vs $t0" }
    Shot (Join-Path $OutDir "${Prefix}01-run1-report.png")

    # ---- A：第 2 轮跑着的时候，上一轮那些控件必须点不动 ----
    Invoke-ByName $w $N_START
    [void](Assert-Running "第 2 轮（改控件之前）" 45)
    $boxes = @(CheckBoxes $w)
    if ($boxes.Count -lt 1) { throw "A：跑着的时候上一轮报告的复选框一个都不在（$($boxes.Count) 个）—— 那「点不动」这一相没有对象，测了个空" }
    $enabled = @($boxes | Where-Object { $_.Current.IsEnabled })
    Write-Host "  A：复选框 $($boxes.Count) 个，其中 enabled 的 $($enabled.Count) 个（期望 0）"
    if ($enabled.Count -gt 0) { $script:Fails += "A：检测途中还有 $($enabled.Count) 个组复选框点得动 —— 勾了服务端也不收，界面上却像能点" }
    $narrowOut = @(Find-Buttons $w $S_NARROW)                 # 这份别删
    $narrowBack = @(Find-Buttons $w (U 0x653E,0x56DE,0x5F85,0x5220))   # 放回待删
    $narrowAll = @($narrowOut) + @($narrowBack)
    $narrowOn = @($narrowAll | Where-Object { $_.Current.IsEnabled })
    if ($narrowAll.Count -lt 1) { throw "A：一个「$S_NARROW」/「放回待删」按钮都没按 ControlType.Button 抓到 —— 这一相没有对象，测了个空" }
    Write-Host "  A：「$S_NARROW」/「放回待删」按钮 $($narrowAll.Count) 个（按类型+逐字名取的），enabled 的 $($narrowOn.Count) 个"
    if ($narrowOn.Count -gt 0) { $script:Fails += "A：检测途中还有 $($narrowOn.Count)/$($narrowAll.Count) 个「$S_NARROW」点得动 —— 服务端那一轮已经在按旧清单跑，勾了就是拿一份过期报告去改选择" }
    Shot (Join-Path $OutDir "${Prefix}02-midrun-controls-disabled.png")

    # ---- B：跑着的时候去把门槛改一档 ----
    Invoke-ByName $w $N_SETTINGS
    $sel = $null
    foreach ($e in (Get-Els $w)) { if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.ComboBox' -or $e.Current.ClassName -match 'select|combobox') { $sel = $e; break } }
    if (-not $sel) { throw "B：设置页找不到那个下拉（按 ComboBox/className 都没抓到）—— 不许改用鼠标点坐标" }
    Ensure-OnTop "改档"
    $sel.SetFocus(); Start-Sleep -Milliseconds 400
    Press-Key 0x28 1        # VK_DOWN：选项按升序排，DOWN 只会往**大**的走
    $t1 = Read-SettingsEcho $w
    if ($t1 -eq $t0) { Press-Key 0x28 1; $t1 = Read-SettingsEcho $w }
    if ($t1 -eq $t0) { throw "B：按了两次 DOWN 门槛仍是 $t0 —— 键盘手势没落到控件上（不许退回去猜坐标）" }
    Write-Host "  B：门槛已改档 $t0 → $t1（改一档=立刻存，回执那句是「$S_SAVED…」）"
    if (-not (Has-Substr $w $S_SAVED)) { $script:Fails += "B：改了档而设置页没有「$S_SAVED」那句服务端回执 —— 只有本地 state 变了不算存好" }
    $savedMb = Read-SavedEcho $w
    if ($null -eq $savedMb) {
        $script:Fails += "B：读不出回执那句里的整数 MB（界面写了「$S_SAVED」却没抓到数）"
    } elseif ((Fmt ([long]$savedMb * 1MB)) -ne $t1) {
        $script:Fails += "B：服务端回执说 $savedMb MB，而界面那句写 $t1 —— 同一件事两种渲染分叉了"
    } else {
        Write-Host "  B：回执 $savedMb MB 与界面那句 $t1 同源 ✅"
    }
    Shot (Join-Path $OutDir "${Prefix}03-settings-changed.png")

    # ---- B 的另一半：回到重复页，那一屏**旧报告**必须还写旧值 ----
    Invoke-ByName $w $N_DUP_NAV $S_CAND
    $thOld = Read-ReportThreshold $w
    Write-Host "  B：途中回到重复页，报告那句仍是 $thOld（新值是 $t1 ⇒ 不许被改写）"
    if ($thOld -ne $th1) { $script:Fails += "B：途中改设置把**已经跑着的那一轮**的报告门槛改了（$thOld ≠ $th1）—— 过期报告被当成新的用" }
    Shot (Join-Path $OutDir "${Prefix}04-midrun-report-still-old.png")

    # ---- 第 2 轮跑完：它是**改之前**开的 ⇒ 仍按旧值 ----
    Wait-RunDone $w 300 "第 2 轮"
    $th2 = Read-ReportThreshold $w
    Write-Host "  第 2 轮（改档之前开的）报告门槛 = $th2"
    if ($th2 -ne $th1) { $script:Fails += "第 2 轮是改档**之前**开的，却用上了新门槛（$th2 ≠ $th1）" }

    # ---- C：第 3 轮必须按新值，且候选数真的变了 ----
    Invoke-ByName $w $N_START $S_READ
    Wait-RunDone $w 300 "第 3 轮"
    $th3 = Read-ReportThreshold $w
    $mCand = [regex]::Match((FlatText $w), "$S_CAND\s*([0-9,]+)")
    $cand3 = if ($mCand.Success) { [int]($mCand.Groups[1].Value -replace ',', '') } else { -1 }
    Write-Host "  C：第 3 轮报告门槛 = $th3（设置页现在是 $t1）、候选 $cand3 个"
    if ($th3 -ne $t1) { $script:Fails += "C：新一轮没按新门槛（$th3 ≠ $t1）⇒「改完要重跑才按新值算」那句是假的" }
    if ($cand3 -eq (& $candAt 4) -and $t1 -ne $t0) { $script:Fails += "C：门槛从 $t0 提到 $t1 而候选数没变（$cand3）—— 这一档改了等于没改" }
    Shot (Join-Path $OutDir "${Prefix}05-run3-new-threshold.png")
    $hs = @("${Prefix}01-run1-report.png", "${Prefix}02-midrun-controls-disabled.png", "${Prefix}03-settings-changed.png",
            "${Prefix}04-midrun-report-still-old.png", "${Prefix}05-run3-new-threshold.png") |
        ForEach-Object { (Get-FileHash (Join-Path $OutDir $_) -Algorithm SHA256).Hash }
    if (($hs | Sort-Object -Unique).Count -ne $hs.Count) { throw "五张图里有逐字节相同的 ⇒ 某一相根本没改变画面" }

    # ---- 把设置改回原档并复验（夹具目录是一次性的，但"改得回去"本身也该被验一次）----
    Invoke-ByName $w $N_SETTINGS
    $sel2 = $null
    foreach ($e in (Get-Els $w)) { if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.ComboBox' -or $e.Current.ClassName -match 'select|combobox') { $sel2 = $e; break } }
    $sel2.SetFocus(); Start-Sleep -Milliseconds 300
    # 回到起点只能往**小**按（VK_UP=0x26）。第一版这里按 DOWN 想"绕回来"，
    # 结果一路升到 32.0 MB —— 列表是升序的，DOWN 到头也不会回到 4。
    $back = Read-SettingsEcho $w
    $tries = 0
    while ($back -ne $t0 -and $tries -lt 12) { Press-Key 0x26 1; $back = Read-SettingsEcho $w; $tries++ }
    Write-Host "  还原：按了 $tries 次 UP，设置页现在 $back（起点 $t0）"
    if ($back -ne $t0) { $script:Fails += "还原失败：改不回 $t0（现在 $back）—— 下一棒用这份设置目录会拿到意外的门槛" }

    # ---- 零删除的反证 ----
    $now = @(Get-ChildItem $Fix -Filter *.bin)
    $nowBytes = ($now | Measure-Object -Property Length -Sum).Sum
    if ($now.Count -ne $all.Count -or $nowBytes -ne $expTotalBytes) {
        throw "零删除这一条没守住：$($now.Count)/$($all.Count) 个文件、$nowBytes/$expTotalBytes 字节"
    }
    Write-Host "  文件数与总字节一字未改（$($now.Count) 个 / $nowBytes 字节）"

    if ($script:Fails.Count -gt 0) {
        Write-Host "---- 判定：有未成立项 ----"
        foreach ($f in $script:Fails) { Write-Host "  X $f" }
        throw "$($script:Fails.Count) 条判据未成立"
    }
    Write-Host "DONE：途中改控件 —— 旧控件点不动、跑着的那轮不被新值改写、下一轮才按新值且候选真的变了"
    Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue
    $script:Own = $null
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    # 红的时候把子进程 stderr 的尾巴打出来 —— 这一格是 m5o 原来挂在 -RedirectStandardError 上的用途，
    # 迁移途中丢过一次，现在由 helper 的 -StdErrLog 接回来。
    if ($appLog -and (Test-Path $appLog)) {
        $tail = @(Get-Content $appLog -Tail 12 -ErrorAction SilentlyContinue)
        Write-Host ("  STDERR（{0}，共 {1} 行，末 {2} 行如下）" -f $appLog, @(Get-Content $appLog -ErrorAction SilentlyContinue).Count, $tail.Count)
        foreach ($l in $tail) { Write-Host "    | $l" }
    } else {
        Write-Host "  STDERR 那份日志不在（$appLog）—— 进程可能根本没起来到写 stderr"
    }
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
} finally {
    # 实测：catch 里 `exit 1` 之后 finally 照样跑，且退出码不变（1）—— 所以这一格在红的那趟也会还原。
    Restore-DcSettings $script:SetTok
}
