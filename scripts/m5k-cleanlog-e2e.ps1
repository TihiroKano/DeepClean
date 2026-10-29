# M5-K 真机验收：逐条删除的落盘日志（§29）+ 记录页那格 logPath
#
# 跑的是**已授权的桌面靶场**：%USERPROFILE%\Desktop\DeepClean删除测试\target。
# 与 m3-e2e-cleanup.ps1 同一条 UI 链（指定位置 → 开始深度扫描 → 垃圾清理 → 全选可清理项
# → 我了解 → 确认预估 → 开始清理 → 清理记录），差别只在**事后读什么**：
#   m3 那次问的是文件系统与回收站（删除本身成没成）；
#   这一次问的是「日志里有没有逐条留下它们」（§29 那一格），并与独立口径交叉。
#
# 三条独立对账，都不读任务回执：
#   A. 磁盘：那 3 个种子文件真的没了 + 回收站条目数 +3（Shell COM）。
#   B. 日志：本轮新增的行里，每个被删路径各有一条 `status=success`，且有 start/end 一对。
#   C. 界面：清理记录页的页脚给的是**真路径**（含 deepclean.log），
#      而不是那句「没能确定日志文件路径」。
#
# 中文一律走码点（PowerShell 5.1 会把 .ps1 里的中文字面量按 ANSI 读成乱码，
# 于是每次 UIA 查找都静默失败 —— 本仓记过账）。码点从渲染端源码抄，见 .dc-k-probe/labels.py。
param(
    [string]$App = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 截图名前缀。默认 `m5k-` 那两张是 M5-K 验收文档正在引用的 10-13 证据，
    # 复跑必须换前缀，否则会把别人的证据图静默覆盖（本轮就发生过一次，已还原）。
    [string]$Prefix = "m5k-"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$sig = @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct NRECT { public int Left; public int Top; public int Right; public int Bottom; }
public class WinFnK {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out NRECT r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out NRECT r, int size);
}
"@
Add-Type -TypeDefinition $sig

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_PATH     = U 0x6307, 0x5B9A, 0x4F4D, 0x7F6E              # 指定位置
$T_SCAN     = U 0x5F00, 0x59CB, 0x6DF1, 0x5EA6, 0x626B, 0x63CF  # 开始深度扫描
$T_FIT      = U 0x9002, 0x5E94, 0x7A97, 0x53E3              # 适应窗口
$T_CLEAN    = U 0x5783, 0x573E, 0x6E05, 0x7406              # 垃圾清理
$T_ALL      = U 0x5168, 0x9009, 0x53EF, 0x6E05, 0x7406, 0x9879  # 全选可清理项
$T_ACK      = U 0x6211, 0x4E86, 0x89E3                      # 我了解
$T_CONFIRM  = U 0x786E, 0x8BA4, 0x9884, 0x4F30              # 确认预估
$T_EXEC     = U 0x5F00, 0x59CB, 0x6E05, 0x7406              # 开始清理
$T_JOURNAL  = U 0x6E05, 0x7406, 0x8BB0, 0x5F55              # 清理记录
$T_NOLOG    = U 0x6CA1, 0x80FD, 0x786E, 0x5B9A, 0x65E5, 0x5FD7, 0x6587, 0x4EF6, 0x8DEF, 0x5F84  # 没能确定日志文件路径

$ErrorActionPreference = 'Stop'
# 靶场那串路径里也有中文 —— 同样不许当字面量写（PowerShell 5.1 按 ANSI 读 .ps1）。
# DeepClean删除测试\target
$T_RANGE = U 0x5220, 0x9664, 0x6D4B, 0x8BD5
$target  = Join-Path $env:USERPROFILE ("Desktop\DeepClean" + $T_RANGE + "\target")
if (-not (Test-Path $target)) { throw "授权靶场不存在：$target" }
$envroot = Join-Path $target "envroot"
$scratch = Join-Path $envroot "TEMP"
$LogFile = Join-Path $env:APPDATA "com.deepclean.app\logs\deepclean.log"

# ---------- 1. 造种子（3 个 4 KiB 文件，规则 windows-temp 认领的就是这一格） ----------
if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$seeded = @()
1..3 | ForEach-Object {
    $f = Join-Path $scratch ("m5k-e2e-{0}.tmp" -f $_)
    [System.IO.File]::WriteAllBytes($f, (New-Object byte[] 4096))
    $seeded += $f
}
Write-Host ("seeded {0} x 4096 B -> {1}" -f $seeded.Count, $scratch)

# 日志的"本轮之前"基线：文件可能已存在（同一台机器跑过多次），只认新增的那几行
$beforeLines = 0
if (Test-Path $LogFile) { $beforeLines = @(Get-Content -LiteralPath $LogFile -Encoding UTF8).Count }
Write-Host ("log before: {0} lines @ {1}" -f $beforeLines, $LogFile)

function Recycle-Count {
    $sh = New-Object -ComObject Shell.Application
    return $sh.NameSpace(10).Items().Count
}
$rbBefore = Recycle-Count
Write-Host "recycle bin items before: $rbBefore"

# ---------- 2. 带 DC_ENV_ROOT 起应用（禁止根那两键**不**重定向，理由见 m3 脚本头） ----------
if (-not (Test-Path $App)) { throw "应用产物不存在：$App（先 cargo build）" }
$exeStamp = (Get-Item -LiteralPath $App).LastWriteTime
Write-Host ("exe built: {0}" -f $exeStamp)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $envroot
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($p.Id)"

function Find-Window($name) {
    $d = [System.Windows.Automation.AutomationElement]::RootElement
    $c = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    return $d.FindFirst([System.Windows.Automation.TreeScope]::Children, $c)
}
function Try-Find($win, $name) {
    try {
        $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($e in $all) { if ($e.Current.Name -like "*$name*") { return $e } }
        return $null
    } catch { return $null }
}
function Wait-For($win, $name, $sec) {
    $deadline = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $deadline) {
        $el = Try-Find $win $name
        if ($el) { return $el }
        Start-Sleep -Milliseconds 700
    }
    return $null
}
function Invoke-El($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Take-Shot($win, $path) {
    [void][WinFnK]::ShowWindow($p.MainWindowHandle, 9)
    [void][WinFnK]::SetForegroundWindow($p.MainWindowHandle)
    Start-Sleep -Milliseconds 900
    # UIA 的 BoundingRectangle 含 DWM 的透明投影边：拿它当裁剪框会把**左边一条别的窗口的字**
    # 和**下面一截任务栏**一起拍进验收图（这两张一开始就是这样，图里 x<30 是别人家的内容）。
    # 截图是泄露面 —— 桌面内容不许跟着进版本库，所以按 DWM 的真实帧边界裁。
    # 这套 P/Invoke 先在别的窗口上验过再用（`D:/dc-tmp/probe-dwm2.ps1`：DWM 与 GetWindowRect
    # 对同一窗口差 ~9px，正是投影边；原来那版把 RECT 写成 `System.Drawing.Rectangle`（四个 double），
    # 那是 marshaling 层的错，会读出全零或垃圾）。
    $r = $win.Current.BoundingRectangle
    $rect = [System.Drawing.Rectangle]::new([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
    $fr = New-Object NRECT
    $hr = [WinFnK]::DwmGetWindowAttribute($p.MainWindowHandle, 9, [ref]$fr, [System.Runtime.InteropServices.Marshal]::SizeOf($fr))
    if ($hr -eq 0 -and ($fr.Right - $fr.Left) -gt 200 -and ($fr.Bottom - $fr.Top) -gt 200) {
        $rect = [System.Drawing.Rectangle]::new($fr.Left, $fr.Top, ($fr.Right - $fr.Left), ($fr.Bottom - $fr.Top))
    } else {
        Write-Warning "  DWM 帧边界拿不到（hr=$hr），退回 UIA 矩形 —— 这张图左边可能带进别人的窗口"
    }
    $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $mine = [WinFnK]::GetForegroundWindow() -eq $p.MainWindowHandle
    Write-Host ("saved {0} ({1}x{2}) foreground={3}" -f (Split-Path $path -Leaf), $rect.Width, $rect.Height, $mine)
    if (-not $mine) { Write-Warning "  截图时窗口不在最前 —— 这张可能是废的" }
}

$FAIL = @()
function Check($label, $cond, $detail) {
    if ($cond) { Write-Host ("  PASS  {0}" -f $label) }
    else { Write-Host ("  FAIL  {0} :: {1}" -f $label, $detail); $FAIL += $label }
}

$win = $null
for ($i = 0; $i -lt 40; $i++) { $win = Find-Window "DeepClean"; if ($win) { break }; Start-Sleep -Milliseconds 500 }
if (-not $win) { throw "窗口没出现" }
[void][WinFnK]::ShowWindow($p.MainWindowHandle, 9)
[void][WinFnK]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 1200
try { $win.SetFocus() } catch { }

# ---------- 3. 扫描 ----------
$radio = Wait-For $win $T_PATH 60
if (-not $radio) { throw "「指定位置」没出现" }
Invoke-El $radio
Start-Sleep -Seconds 1
$edit = $null
for ($i = 0; $i -lt 20; $i++) {
    try {
        $c = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
    } catch { $edit = $null }
    if ($edit) { break }
    Start-Sleep -Milliseconds 300
}
if (-not $edit) { throw "路径输入框没出现" }
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($envroot)
Start-Sleep -Milliseconds 500
Invoke-El (Wait-For $win $T_SCAN 60)
Write-Host "scanning $envroot"
$done = Wait-For $win $T_FIT 180
if (-not $done) { throw "扫描 180 秒内没结束" }
Write-Host "scan finished"
Start-Sleep -Seconds 2

# ---------- 4. 清理链 ----------
Invoke-El (Wait-For $win $T_CLEAN 30)
Start-Sleep -Seconds 4
$sel = Wait-For $win $T_ALL 30
if (-not $sel) { throw "「全选可清理项」不可点 ⇒ 规则一条都没命中，DC_ENV_ROOT 没生效" }
Invoke-El $sel
Start-Sleep -Seconds 3
$ack = $null
for ($i = 0; $i -lt 40; $i++) {
    try {
        $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($e in $all) {
            if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.CheckBox' -and $e.Current.Name -like "*$T_ACK*") { $ack = $e; break }
        }
    } catch { }
    if ($ack) { break }
    Start-Sleep -Milliseconds 700
}
if (-not $ack) { throw "「我了解」复选框没找到" }
$ack.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
Start-Sleep -Seconds 1
Invoke-El (Wait-For $win $T_CONFIRM 30)
Start-Sleep -Seconds 3
$ex = Wait-For $win $T_EXEC 30
if (-not $ex) { throw "「开始清理」没出现" }
if (-not $ex.Current.IsEnabled) { throw "「开始清理」仍被禁用 —— 确认链没走通" }
Invoke-El $ex
Start-Sleep -Seconds 10
Take-Shot $win (Join-Path $OutDir "${Prefix}01-executed.png")

# ---------- 5. 记录页 ----------
Invoke-El (Wait-For $win $T_JOURNAL 30)
Start-Sleep -Seconds 5
Take-Shot $win (Join-Path $OutDir "${Prefix}02-journal.png")

# ---------- 6. 事后读三面 ----------
$after = @()
if (Test-Path $LogFile) { $after = @(Get-Content -LiteralPath $LogFile -Encoding UTF8) }
$new = @()
if ($after.Count -gt $beforeLines) { $new = $after[$beforeLines..($after.Count - 1)] }
Write-Host ""
Write-Host "===== 本轮新增的日志行（$($new.Count) 行）====="
$new | ForEach-Object { Write-Host "  $_" }

Write-Host ""
Write-Host "===== 对账（独立口径，不读 task.deleted[].ok）====="
$still = @($seeded | Where-Object { Test-Path $_ }).Count
$rbAfter = Recycle-Count
Check "A 磁盘：3 个种子都没了" ($still -eq 0) "还剩 $still 个"
Check "A 回收站：条目数 +3" ($rbAfter -eq ($rbBefore + 3)) "$rbBefore -> $rbAfter"

$shapeOk = @($new | Where-Object { $_ -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[CLEAN\] ' }).Count
Check "B 每行都是「本地时间 + [CLEAN]」开头" ($shapeOk -eq 0) "$shapeOk 行不合形状"
$starts = @($new | Where-Object { $_ -match ' \[CLEAN\] clean start ' }).Count
$ends   = @($new | Where-Object { $_ -match ' \[CLEAN\] clean end ' }).Count
Check "B 有且只有一对 start/end" ($starts -eq 1 -and $ends -eq 1) "start=$starts end=$ends"
$miss = @($seeded | Where-Object { $f = $_; -not (@($new | Where-Object { $_ -like "*$f*status=success*" }).Count -ge 1) })
Check "B 每个被删路径各有一条 status=success" ($miss.Count -eq 0) ("没记到：" + ($miss -join ', '))
$endLine = @($new | Where-Object { $_ -match ' \[CLEAN\] clean end ' }) | Select-Object -Last 1
Check "B 结尾那行带 success=3 refused= 两个计数" ($endLine -match 'success=3' -and $endLine -match 'refused=') "$endLine"
$stampDay = (Get-Date).ToString('yyyy-MM-dd')
Check "B 时间戳是今天（本地，不是 UTC 也不是常量）" (@($new | Where-Object { $_ -like "$stampDay*" }).Count -eq $new.Count) "有行不是今天开头：$stampDay"

$pageText = ''
try {
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) { $pageText += '|' + $e.Current.Name }
} catch { }
Check "C 页脚给的是真路径（含 deepclean.log）" ($pageText -like '*deepclean.log*') "页面文本里没有那个文件名"
Check "C 那句「没能确定日志文件路径」不再出现" (-not ($pageText -like "*$T_NOLOG*")) "页脚还在说没有日志"
$seedOnPage = @($seeded | Where-Object { $f = $_; $pageText -like "*$f*" }).Count
Check "C 记录页上也点名了那 3 条（与日志同一批事件）" ($seedOnPage -eq 3) "页面里只找得到 $seedOnPage 条"

# ---------- 7. 收尾 ----------
try { [void]$p.CloseMainWindow() } catch { }
Start-Sleep -Seconds 2
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }

Write-Host ""
if ($FAIL.Count -eq 0) {
    Write-Host "===== M5-K 真机：全部判据通过 ====="
    Write-Host ("log : {0}" -f $LogFile)
    Write-Host ("shots: ${Prefix}01-executed.png / ${Prefix}02-journal.png")
    exit 0
}
Write-Host ("===== M5-K 真机：{0} 条判据红 :: {1} =====" -f $FAIL.Count, ($FAIL -join '; '))
exit 1
