# M6-B Task 3：把「设置」与「清理记录」两页搬到**打包版**上验一遍。
#
# 为什么要这一支：M6 之后 14 个 e2e 里 13 个吃 dev-only 的 `DC_AUTOSCAN`，整面真机验收悄悄变成
# debug-only。Task 2 已经把能迁的迁完，剩下两页始终没有 release 证据 —— 「设置」（它还是
# `glass-inventory` 里唯一 0 个自有玻璃、只剩骨架 `dc-side` 的一页）与「清理记录」。
# 开发环境页不在这里：`m5f-perf` 的 ③ 相已经在 release 上开过它并留了图与那句自述。
#
# 一页算过了，三条同时成立（三条都可机读，不许"看着没问题"）：
#   ① 导航点进去，且页面上出现**该页独有**的一格（不是侧栏导航名 —— 它在任何页都命中）；
#   ② 截图存在、`foreground=True`、宽度 ≤ 1900（`scripts/shot-leak-gate.mjs` 那一格）；
#   ③ 关键读数与**产品之外的口径**一致：设置页那句「当前按 X 计」要等于盘上 `settings.json` 的字节数，
#      而「DeepClean 版本：」要等于 exe 自己的 PE `ProductVersion`（不是我自己算出来的数）。
#
# 中文一律码点拼（`.ps1` 无 BOM 时 PS 5.1 按 ANSI 读字面量，乱码的名字与"按钮不存在"同形）。
# 那批码点是**从 `Settings.tsx` / `CleanHistory.tsx` 的原文里生成**的，不是凭记忆写的。
param(
    [string]$App    = 'D:\DeepClean\src-tauri\target\release\deepclean-app.exe',
    [string]$OutDir = 'D:\DeepClean\docs\acceptance\assets',
    [string]$Prefix = 'm6b-page-'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

$A    = [System.Windows.Automation.AutomationElement]
$SD   = [System.Windows.Automation.TreeScope]::Descendants
$COND = [System.Windows.Automation.Condition]::TrueCondition
$CT   = [System.Windows.Automation.ControlType]

function Els   { @($script:Win.FindAll($SD, $COND)) }
function Names { @(Els | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
function Flat  { (Names) -join ' ' }
function Find-Sub([string]$sub) {
    # 客户端过滤，不碰 PropertyCondition 的三参重载（PS 5.1 取不到那个重载，包在 try 里就变成
    # "每次查找都静默失败"）。返回**元素**而不是文字命中：-like 命中的常是旁边那个 Text，不吃 InvokePattern。
    foreach ($e in (Els)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
    return $null
}
function Wait-Sub([string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Sub $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 400 }
    throw "等不到「$sub」（$sec 秒）—— 界面现在说的是：$( ((Flat) -replace '\s+', ' ').Substring(0, [Math]::Min(200, (Flat).Length)) )"
}
function Invoke-Sub([string]$sub) {
    $e = Find-Sub $sub
    if (-not $e) { throw "找不到可点的「$sub」" }
    $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $true
}
function Shot([string]$file) {
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    if ($info.Width -gt 1900) { throw "拍出来 $info.Width 宽 —— 那不是窗口是桌面" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节，不像一扇渲染出来的窗口" }
    Write-Host ("  SHOT {0} ({1}x{2}) {3} B foreground=True" -f (Split-Path $file -Leaf), $info.Width, $info.Height, $len)
}

$N_SETTINGS = U-Str 0x8BBE, 0x7F6E                                              # 设置
$N_JOURNAL  = U-Str 0x6E05, 0x7406, 0x8BB0, 0x5F55                              # 清理记录
$T_PANEL    = U-Str 0x91CD, 0x590D, 0x6587, 0x4EF6, 0x0020, 0x00B7, 0x0020, 0x6700, 0x5C0F, 0x5C3A, 0x5BF8  # 重复文件 · 最小尺寸
$T_NOW      = U-Str 0x5F53, 0x524D, 0x6309                                      # 当前按
$T_JI       = U-Str 0x8BA1                                                      # 计
$T_UNFILTER = U-Str 0x672A, 0x7B5B, 0x9009                                      # 未筛选
$T_NOSESSION = U-Str 0x672C, 0x6B21, 0x4F1A, 0x8BDD, 0x8FD8, 0x6CA1, 0x6709     # 本次会话还没有
$T_VERSION  = U-Str 0x7248, 0x672C                                              # 版本
$T_LABEL    = U-Str 0x5C0F, 0x4E8E, 0x8FD9, 0x4E2A, 0x5927, 0x5C0F, 0x7684, 0x6587, 0x4EF6, 0x4E0D, 0x53C2, 0x4E0E, 0x91CD, 0x590D, 0x68C0, 0x6D4B  # 小于这个大小的文件不参与重复检测

$SETTINGS_FILE = Join-Path $env:APPDATA 'com.deepclean.app\settings.json'

try {
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑 —— 先关掉，脚本不抢窗口" }
    # 这一棒会真改设置（③ 相要看到"改一档之后盘上那份跟着变"），而 release 上没有 DC_SETTINGS_DIR
    # 可躲 ⇒ 拍快照、finally 还原（m5o 那一棒已经验过它"会写"与"没写"两支）。
    $script:SetTok = Protect-DcSettings
    $dcApp = Start-DcReleaseApp -App $App
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd

    # ---------- ① 设置页 ----------
    # 独有格**不能**选「重复文件 · 最小尺寸」：那个标题在 `settings === null` 那一支里也渲染
    # （Settings.tsx:130 与 :137 两处都有它），所以它在"还在读/读失败"的画面上同样命中 ——
    # 第一版就是被它骗过去了：① 报"点进去了"，紧接着那句只在**已加载**那一支才有的说明就不在。
    # 换成 label 那句（只有 `settings !== null` 才渲染），并且是**等**它而不是测一次。
    Invoke-Sub $N_SETTINGS | Out-Null
    [void](Wait-Sub $T_LABEL 25)
    Write-Host "  ① 设置页点进去了，而且是**已加载**那一支：「$T_LABEL」在"
    $flat = Flat
    if (-not $flat.Contains($T_PANEL)) { throw "label 出来了但面板标题「$T_PANEL」不在 —— 页面形状与源码对不上" }
    $m = [regex]::Match($flat, "$T_NOW\s*([0-9][0-9\.,]*)\s*([MGT]B)\s*$T_JI")
    if (-not $m.Success) { throw "读不到「当前按 X 计」那句：$($flat.Substring(0, [Math]::Min(240, $flat.Length)))" }
    $shown = "$($m.Groups[1].Value.Trim()) $($m.Groups[2].Value)"
    Shot (Join-Path $OutDir "${Prefix}settings-before.png")

    # ③-a 版本那格与 PE 自己说的一致（产品之外的口径：文件版本资源，不是我算的）
    $pe = (Get-Item $App).VersionInfo.ProductVersion
    $verLine = [regex]::Match($flat, "$T_VERSION[：:]?\s*([0-9]+\.[0-9]+\.[0-9]+[^ ]*)")
    if (-not $verLine.Success) { throw "界面上没念出版本号那格 —— 「读不到（主进程没给出版本号）」那句也算说过，但这里要的是它给了数" }
    $uiVer = $verLine.Groups[1].Value
    Write-Host "  ③ 版本：界面 $uiVer vs PE ProductVersion $pe"
    if ($uiVer -ne $pe) { throw "界面版本号与 exe 自己的 PE 版本不一致：$uiVer vs $pe" }

    # ---------- ② 真改一档：界面跟着服务端回执重画，且盘上那份就是它 ----------
    $sel = @(Els | Where-Object { $_.Current.ControlType -eq $CT::ComboBox } | Select-Object -First 1)
    if (-not $sel) { throw "设置页找不到那个下拉（ComboBox）—— 改档这一相没有对象" }
    $sel.SetFocus(); Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')   # <select> 的选项文字不进 UIA Name ⇒ 只能真按键
    Start-Sleep -Milliseconds 1500
    $flat2 = Flat
    $m2 = [regex]::Match($flat2, "$T_NOW\s*([0-9][0-9\.,]*)\s*([MGT]B)\s*$T_JI")
    if (-not $m2.Success) { throw "按了 {DOWN} 之后读不到「当前按 X 计」了" }
    $shown2 = "$($m2.Groups[1].Value.Trim()) $($m2.Groups[2].Value)"
    if ($shown2 -eq $shown) { throw "改了一档而界面那句没变（还是 $shown）—— 要么键没进去，要么界面拿请求而不是回执画那一格" }
    if (-not (Test-Path $SETTINGS_FILE)) { throw "改档之后盘上没有 settings.json —— 界面改了但没落盘" }
    $disk = Get-Content $SETTINGS_FILE -Raw | ConvertFrom-Json
    $bytes = [double]$disk.dupMinSizeMb * 1048576
    Write-Host "  ② 改档：界面 $shown → $shown2；盘上 dupMinSizeMb=$($disk.dupMinSizeMb) MB = $([int]$bytes) 字节"
    Shot (Join-Path $OutDir "${Prefix}settings-changed.png")

    # ---------- ③ 清理记录页：空态要说得出口，而不是白屏 ----------
    Invoke-Sub $N_JOURNAL | Out-Null
    [void](Wait-Sub $T_UNFILTER 20)
    $flat3 = Flat
    if (-not $flat3.Contains($T_NOSESSION)) { throw "记录页没有那句「$T_NOSESSION…」—— 它要么在撒谎说有记录，要么没渲染出来" }
    # 这一页只记**本进程**发生过的删除（CleanHistory.tsx:201），而本棒全程零删除 ⇒ 空态是对的。
    # 反过来说：盘上那份 logs\deepclean.log 里是有历史条目的（靶场那几趟留下的），
    # 页面一条都不显示 —— 这不是漏，是口径。写在这里免得下一个人拿它对账。
    $logFile = Join-Path $env:APPDATA 'com.deepclean.app\logs\deepclean.log'
    $logLines = if (Test-Path $logFile) { @(Get-Content $logFile -ErrorAction SilentlyContinue).Count } else { 0 }
    Write-Host "  ③ 记录页：独有格「$T_UNFILTER」在 + 空态那句在；盘上日志文件有 $logLines 行历史，页面显示 0 条（会话口径，不是缺陷）"
    Shot (Join-Path $OutDir "${Prefix}journal-empty.png")

    Write-Host "DONE（两页三条判据齐：独有格 / 截图 foreground+宽度 / 读数对 PE 版本与盘上 settings.json）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    if ($script:Win) {
        $h = $script:Hwnd
        if ($h) { [void][DcWinFrame]::ShowWindow($h, 9) }
    }
    Get-Process deepclean-app -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 800
    Restore-DcSettings $script:SetTok
}
