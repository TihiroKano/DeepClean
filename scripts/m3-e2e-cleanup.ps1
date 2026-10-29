# M3 端到端真机验收：扫描 → 清理预览 → 全选 → 确认预估 → 开始清理 → 清理记录
#
# 靠 dev-only 的 DC_ENV_ROOT 把**规则领地**五个键（TEMP / LOCALAPPDATA / APPDATA /
# PROGRAMDATA / USERPROFILE）重定向进已授权靶场的一个子目录，于是 `windows-temp` 规则
# 认领的就是我自己造的 3 个文件。
#
# **SYSTEMDRIVE / WINDIR 不重定向** —— 禁止根与只上报根全从这两个解析。搬走它们
# 就等于把 §16 那道结构闸挪进沙箱自己夸自己通过，那次清理验的就不再是守卫了。
# 这条由 `the_dev_override_never_moves_the_guard_keys` 钉着。
param(
    [string]$App = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$sig = @"
using System;
using System.Runtime.InteropServices;
public class WinFn {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Add-Type -TypeDefinition $sig

$target = Join-Path $env:USERPROFILE "Desktop\DeepClean删除测试\target"
if (-not (Test-Path $target)) { throw "授权靶场不存在：$target" }
$envroot = Join-Path $target "envroot"
$scratch = Join-Path $envroot "TEMP"          # = 重定向后的 %TEMP%
$scanRoot = $envroot                          # 扫描根取它的父目录

# ---------- 1. 造种子 ----------
if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$seeded = @()
1..3 | ForEach-Object {
    $f = Join-Path $scratch ("m3-e2e-{0}.tmp" -f $_)
    [System.IO.File]::WriteAllBytes($f, (New-Object byte[] 4096))
    $seeded += $f
}
Write-Host "seeded 3 x 4096 bytes into $scratch"

# 回收站计数的独立口径（Shell COM），删完要拿它对账
function Recycle-Count {
    $sh = New-Object -ComObject Shell.Application
    return $sh.NameSpace(10).Items().Count
}
$rbBefore = Recycle-Count
Write-Host "recycle bin items before: $rbBefore"

# ---------- 2. 带口子起应用 ----------
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $envroot
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($p.Id)  DC_ENV_ROOT=$envroot"
Start-Sleep -Seconds 8

function Find-Window($name) {
    $d = [System.Windows.Automation.AutomationElement]::RootElement
    $c = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    return $d.FindFirst([System.Windows.Automation.TreeScope]::Children, $c)
}
# 注意：`PropertyCondition` 的三参（MatchSubstring）构造在 PowerShell 里取不到重载，
# 直接抛 "Cannot find an overload for new and the argument count: 3"。
# 早先那版把它包在 try/catch 里返回 $null —— 于是**每一次查找都静默失败**，
# 表现成"页面没渲染"，而真相是查询条件构造不出来。改成拉全树在 PowerShell 侧过滤。
function Try-Find($win, $name) {
    try {
        $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($e in $all) {
            if ($e.Current.Name -like "*$name*") { return $e }
        }
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

# 截图前必须把窗口提到最前：CopyFromScreen 只拍得到可见区域，
# 窗口被盖住时拍出来的是**别人的脸**，而 UIA 照样答得出来 —— 于是"点了、截了、看着对"全程成立。
function Take-Shot($win, $path) {
    [void][WinFn]::ShowWindow($p.MainWindowHandle, 9)
    [void][WinFn]::SetForegroundWindow($p.MainWindowHandle)
    Start-Sleep -Milliseconds 900
    $r = $win.Current.BoundingRectangle
    $rect = New-Object System.Drawing.Rectangle([int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
    $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $mine = [WinFn]::GetForegroundWindow() -eq $p.MainWindowHandle
    Write-Host ("saved {0}  ({1}x{2})  foreground={3}" -f (Split-Path $path -Leaf), $rect.Width, $rect.Height, $mine)
    if (-not $mine) { Write-Warning "  截图时窗口不在最前 —— 这张图可能是废的" }
}

$win = $null
for ($i = 0; $i -lt 40; $i++) { $win = Find-Window "DeepClean"; if ($win) { break }; Start-Sleep -Milliseconds 500 }
if (-not $win) { throw "窗口没出现" }

# WebView2 的 UIA 树要窗口**可见且在前台**才长出来：不先把窗口提起来，
# 后面每一次 FindFirst 都会回 null，而"页面没渲染"和"树还没建"在日志里一模一样。
[void][WinFn]::ShowWindow($p.MainWindowHandle, 9)
[void][WinFn]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 1200
try { $win.SetFocus() } catch { }

# ---------- 3. 由 UI 起扫（不用 DC_AUTOSCAN：极快的扫描会在订阅落地前就发完 done）----------
$radio = Wait-For $win "指定位置" 60
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
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($scanRoot)
Start-Sleep -Milliseconds 500
Invoke-El (Wait-For $win "开始深度扫描" 60)
Write-Host "scanning $scanRoot"
# 扫描完成后 App 会**自动跳进空间地图**，首页随之卸载 —— 所以不能等首页的「查看扫描结果」，
# 那个按钮在轮询窗口里根本没机会出现。等地图工具栏才是"扫完了"的可靠信号。
$done = Wait-For $win "适应窗口" 180
if (-not $done) { $done = Wait-For $win "查看扫描结果" 5 }
if (-not $done) { throw "扫描 180 秒内没结束（既没进地图，首页也没出结果按钮）" }
Write-Host "scan finished"
Start-Sleep -Seconds 2

# ---------- 4. 清理预览 ----------
Invoke-El (Wait-For $win "垃圾清理" 30)
Start-Sleep -Seconds 4
Take-Shot $win (Join-Path $OutDir "m3-01-preview.png")

# ---------- 5. 全选 ----------
$sel = Wait-For $win "全选可清理项" 30
if (-not $sel) { throw "「全选可清理项」不可点 ⇒ 规则一条都没命中，DC_ENV_ROOT 没生效" }
Invoke-El $sel
Start-Sleep -Seconds 4
Take-Shot $win (Join-Path $OutDir "m3-02-selected.png")

# ---------- 6. 确认预估 ----------
# 「我了解…」那一格是 CheckBox：它不吃 InvokePattern（早先按名字匹配抓到的是旁边的
# Text 标签，于是抛 "Unsupported Pattern"，勾选根本没打上，「开始清理」因此一直禁用）。
$ack = $null
for ($i = 0; $i -lt 40; $i++) {
    try {
        $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($e in $all) {
            if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.CheckBox' -and $e.Current.Name -like '*我了解*') { $ack = $e; break }
        }
    } catch { }
    if ($ack) { break }
    Start-Sleep -Milliseconds 700
}
if (-not $ack) { throw "「我了解」复选框没找到" }
$ack.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
Start-Sleep -Seconds 1
Invoke-El (Wait-For $win "确认预估" 30)
Start-Sleep -Seconds 4
Take-Shot $win (Join-Path $OutDir "m3-03-confirmed.png")

# ---------- 7. 开始清理 ----------
$ex = Wait-For $win "开始清理" 30
if (-not $ex) { throw "「开始清理」没出现" }
if ($ex -and -not $ex.Current.IsEnabled) { throw "「开始清理」仍被禁用 —— 确认链没走通" }
Invoke-El $ex
Start-Sleep -Seconds 8
Take-Shot $win (Join-Path $OutDir "m3-04-executed.png")

# ---------- 8. 清理记录页 ----------
Invoke-El (Wait-For $win "清理记录" 30)
Start-Sleep -Seconds 5
Take-Shot $win (Join-Path $OutDir "m3-05-journal.png")

# ---------- 9. 独立对账：不读任务回执，问文件系统与回收站 ----------
$still = @($seeded | Where-Object { Test-Path $_ }).Count
$rbAfter = Recycle-Count
Write-Host ""
Write-Host "===== 事后对账（独立口径，不读 task.deleted[].ok）====="
Write-Host ("seeded files still on disk : {0} / 3   (期望 0)" -f $still)
Write-Host ("recycle bin items          : {0} -> {1}   (期望 +3)" -f $rbBefore, $rbAfter)
Write-Host ("envroot still exists       : {0}" -f (Test-Path $envroot))

Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Write-Host "DONE"
