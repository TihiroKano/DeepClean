# 按窗口句柄直接抓位图（不依赖"窗口在最前"）。
#
# 为什么需要它：本仓记过一条老坑 —— `SetForegroundWindow` 会被 Windows 的前台锁拒绝
# （`docs/acceptance` 里 m6 那几棒反复撞过），于是"先顶窗再截屏"这条路在无人值守时会拍错窗口。
# `PrintWindow` 让**目标窗口自己**把内容画进我们给的 DC，不需要它在前台、也不需要它没被遮挡。
#
# ⚠️ 限制如实写着：`PW_RENDERFULLCONTENT`（flag=2）是 Chromium/WebView2 系应用能正常出图的那一档
# （它走 DWM 合成路径）；用 0 那一档在很多 WebView2 版本上会得到一张全黑图。
# 本文件在出图后会**量一次非黑像素比例**，低于阈值就拒绝，避免把一张黑图当证据。
param(
    [Parameter(Mandatory = $true)][System.IntPtr]$Hwnd,
    [Parameter(Mandatory = $true)][string]$OutPath,
    [double]$MinNonBlackRatio = 0.02
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct PwRect { public int Left, Top, Right, Bottom; }
public class PwWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out PwRect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out PwRect r, int size);
}
'@ -ReferencedAssemblies System.Runtime.InteropServices

# 优先用 DWM 的真实帧边界（不含透明投影边），拿不到再退回 GetWindowRect
$r = New-Object PwRect
$hr = [PwWin]::DwmGetWindowAttribute($Hwnd, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
if ($hr -ne 0 -or ($r.Right - $r.Left) -lt 200) {
    [void][PwWin]::GetWindowRect($Hwnd, [ref]$r)
}
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -lt 200 -or $h -lt 200) { throw "窗口矩形 ${w}x${h} 不像一扇真窗口" }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# flags=2 → PW_RENDERFULLCONTENT（WebView2/Chromium 系应用要这一档才不是黑图）
$ok = [PwWin]::PrintWindow($Hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { $bmp.Dispose(); throw "PrintWindow 返回 False（句柄 $Hwnd）—— 拒绝出图" }

# 量非黑像素比例：全黑图是 PrintWindow 的典型失败形态，必须拒收
$nonBlack = 0
$stepX = [Math]::Max(1, [int]($w / 80))
$stepY = [Math]::Max(1, [int]($h / 50))
$sampled = 0
for ($y = 0; $y -lt $h; $y += $stepY) {
    for ($x = 0; $x -lt $w; $x += $stepX) {
        $sampled++
        $c = $bmp.GetPixel($x, $y)
        if ($c.R -gt 12 -or $c.G -gt 12 -or $c.B -gt 12) { $nonBlack++ }
    }
}
$ratio = if ($sampled -gt 0) { $nonBlack / $sampled } else { 0 }
if ($ratio -lt $MinNonBlackRatio) {
    $bmp.Dispose()
    throw ("PrintWindow 出来的图几乎全黑（非黑像素 {0:P1} < 阈值 {1:P1}）—— 这张不能当证据" -f $ratio, $MinNonBlackRatio)
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host ("  PRINTWINDOW {0} ({1}x{2}) 非黑 {3:P1}" -f (Split-Path $OutPath -Leaf), $w, $h, $ratio)
