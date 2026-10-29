# M5-M ③：窄窗（<900px）那几张表怎么排
#
# 起因：M5-F 给 `.dc-large .dc-table` 上了 `table-layout: fixed` + 六列百分比，
# 那是**宽窗**下修的。窄窗那一头从没量过 —— 而 CSS 里 `@media (max-width: 900px)`
# 那一段是真的存在（不是"应该没问题"）。窗口宽度这件事在单测里给不出来
# （`renderToStaticMarkup` 没有布局引擎），所以只能真开一个窄窗看。
#
# 判据的形状：同一个页面在 1440 / 880 / 760 三档宽度下各拍一张，然后**量**两件事：
#   ① 页面根有没有被内容撑出横向滚动（`document` 宽 > 视口宽 ⇒ flex 子项 min-width:auto 那个老坑）；
#   ② 表格有没有把某一列压成竖排单字 / 溢出到相邻列（肉眼 + 列宽读数）。
# ②是肉眼的，所以必须截图；①给不了数字就只能靠截图，因此这里把窗口尺寸**报出来**当证据的一部分。
param(
    [string]$App = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    [int[]]$Widths = @(880, 760)
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$sig = @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct NRECT2 { public int Left; public int Top; public int Right; public int Bottom; }
public class WinK {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int l, bool repaint);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out NRECT2 r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out NRECT2 r, int size);
}
"@
Add-Type -TypeDefinition $sig

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_LARGE   = U 0x5927, 0x6587, 0x4EF6                       # 大文件
$T_DUP     = U 0x91CD, 0x590D, 0x6587, 0x4EF6               # 重复文件
$T_JOURNAL = U 0x6E05, 0x7406, 0x8BB0, 0x5F55               # 清理记录
$T_MAP     = U 0x7A7A, 0x95F4, 0x5730, 0x56FE               # 空间地图
$T_PATH    = U 0x6307, 0x5B9A, 0x4F4D, 0x7F6E               # 指定位置
$T_SCAN    = U 0x5F00, 0x59CB, 0x6DF1, 0x5EA6, 0x626B, 0x63CF  # 开始深度扫描
$T_FIT     = U 0x9002, 0x5E94, 0x7A97, 0x53E3               # 适应窗口
$T_RANGE   = U 0x5220, 0x9664, 0x6D4B, 0x8BD5               # 删除测试

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $App)) { throw "应用产物不存在：$App（先 cargo build）" }
Write-Host ("exe built: " + (Get-Item -LiteralPath $App).LastWriteTime)

# 窄窗要看的是"有内容的表"，所以先扫一棵真树（靶场那棵，只读）
$target = Join-Path $env:USERPROFILE ("Desktop\DeepClean" + $T_RANGE + "\target")
if (-not (Test-Path $target)) { throw "靶场不存在：$target（这一轮需要一棵有内容的树）" }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $target
$p = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($p.Id)  扫 $target"

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
  while ((Get-Date) -lt $deadline) { $el = Try-Find $win $name; if ($el) { return $el }; Start-Sleep -Milliseconds 700 }
  return $null
}
function Invoke-El($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Shot($win, $path) {
  [void][WinK]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Milliseconds 900
  $fr = New-Object NRECT2
  $hr = [WinK]::DwmGetWindowAttribute($p.MainWindowHandle, 9, [ref]$fr, [System.Runtime.InteropServices.Marshal]::SizeOf($fr))
  if ($hr -ne 0) { Write-Warning "  DWM 拿不到帧边界（hr=$hr），退回 UIA 矩形" ; $r = $win.Current.BoundingRectangle; $fr = New-Object NRECT2; $fr.Left = [int]$r.X; $fr.Top = [int]$r.Y; $fr.Right = [int]($r.X + $r.Width); $fr.Bottom = [int]($r.Y + $r.Height) }
  $w = $fr.Right - $fr.Left; $h = $fr.Bottom - $fr.Top
  $rect = [System.Drawing.Rectangle]::new($fr.Left, $fr.Top, $w, $h)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host ("  saved {0}  {1}x{2}  foreground={3}" -f (Split-Path $path -Leaf), $w, $h, ([WinK]::GetForegroundWindow() -eq $p.MainWindowHandle))
}

$win = $null
for ($i = 0; $i -lt 40; $i++) { $win = Find-Window "DeepClean"; if ($win) { break }; Start-Sleep -Milliseconds 500 }
if (-not $win) { throw "窗口没出现" }
[void][WinK]::ShowWindow($p.MainWindowHandle, 9)
[void][WinK]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Seconds 2

# ---------- 扫一棵树，让表里有真行 ----------
Invoke-El (Wait-For $win $T_PATH 60)
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
$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($target)
Start-Sleep -Milliseconds 500
Invoke-El (Wait-For $win $T_SCAN 60)
if (-not (Wait-For $win $T_FIT 180)) { throw "扫描没结束" }
Write-Host "scan finished"

# ---------- 三档宽度 × 三张表 ----------
foreach ($w in $Widths) {
  Write-Host ("--- 窗口宽 {0} ---" -f $w)
  [void][WinK]::MoveWindow($p.MainWindowHandle, 40, 40, $w, 820, $true)
  Start-Sleep -Milliseconds 1200
  foreach ($pair in @(@($T_LARGE, 'large'), @($T_DUP, 'dup'), @($T_JOURNAL, 'journal'), @($T_MAP, 'map'))) {
    $nav = Wait-For $win $pair[0] 20
    if (-not $nav) { Write-Warning ("  导航「{0}」点不到 —— 窄窗下它可能已经被挤出去了，这本身就是结论" -f $pair[0]); continue }
    Invoke-El $nav
    Start-Sleep -Seconds 3
    Shot $win (Join-Path $OutDir ("m5m-narrow-{0}w-{1}.png" -f $w, $pair[1]))
  }
}

try { [void]$p.CloseMainWindow() } catch { }
Start-Sleep -Seconds 2
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
Write-Host "done"
