# M6-B Task 4：八页 × 三档宽度的横向溢出矩阵（在**打包版**上量）。
#
# 为什么不是"开窄窗拍几张看看"：判据 ① 是 `document.scrollWidth > innerWidth` 这一个数。
# flex 子项 `min-width:auto` 那个老坑撑出来的常常是**右边一段空白可滚动区**，截图上看着一切正常，
# 只有数字会说"这一格溢出了 214 px"。所以每一格都量，图只作肉眼复核。
#
# 两件事分开报，否则会被读成一件事：窗口**物理**宽（MoveWindow 给的）与 **CSS 视口**宽
# （innerWidth）在 150% 下差 1.5 倍；CSS 里若写 `@media (max-width: 900px)`，比的是后者。
# 本轮实测两份样式表里 `@media` 计数为 **0** ⇒ 窄窗行为全由 flex / table-layout 撑着，没有断点可依赖。
#
# 与 `m5m-narrow-window-e2e.ps1` 的分工：那一棒绑 `DC_ENV_ROOT`（debug-only），
# 这一棒不认领任何规则领地 —— 量的就是排版，所以它能在 shipped 二进制上跑。
param(
    [string]$App    = 'D:\DeepClean\src-tauri\target\release\deepclean-app.exe',
    [string]$Root   = 'D:\deepclean-fixture\f100k',
    [string]$OutDir = 'D:\DeepClean\docs\acceptance\assets',
    [int[]]$Widths  = @(1440, 880, 760),
    [string]$Prefix = 'm6bscale-',
    [int]$Port      = 9223
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DcScaleRect { public int Left; public int Top; public int Right; public int Bottom; }
public class DcScaleWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int l, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out DcScaleRect r);
}
'@ -ReferencedAssemblies System.Runtime.InteropServices
# 不做 DPI-aware，MoveWindow 给的宽度会被系统按缩放虚拟化（150% 下 880 实际落成 1320），
# 那三档就白跑了 —— 这条与截屏那套同源（见仓里 DPI 那条老坑）。
[void][DcScaleWin]::SetProcessDPIAware()

$json = 'D:\dc-tmp\m6b-scale.json'
Remove-Item $json -ErrorAction SilentlyContinue
# CDP 端口由**启动环境**注入：WebView2 运行时自己认它，产品里没有为验收留的任何后门。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

try {
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑 —— 先关掉，脚本不抢窗口" }
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $Root -WaitSec 240
    $h = $dcApp.Hwnd

    foreach ($w in $Widths) {
        $r = New-Object DcScaleRect
        [void][DcScaleWin]::GetWindowRect($h, [ref]$r)
        $height = $r.Bottom - $r.Top
        [void][DcScaleWin]::MoveWindow($h, 60, 40, $w, $height, $true)
        Start-Sleep -Milliseconds 1500
        Write-Host "--- 窗口物理宽 $w（保持高 $height）---"
        node (Join-Path $PSScriptRoot 'scale-probe.mjs') --port $Port --physical $w --out $json --endview ([char]0x5927 + [char]0x6587 + [char]0x4EF6)
        if ($LASTEXITCODE -ne 0) { throw "scale-probe 在 $w 这一档红了（退出码 $LASTEXITCODE）" }
        # 表格页最容易溢出，图就停在它上面拍；Save-DcShot 拿不到 DWM 帧会自己拒绝出图。
        $info = Save-DcShot -Hwnd $h -OutPath (Join-Path $OutDir ("${Prefix}{0}w-largefiles.png" -f $w))
        if (-not $info.Foreground) { throw "拍 $w 这档时窗口不在最前" }
        Write-Host ("  SHOT {0}w -> {1}x{2}" -f $w, $info.Width, $info.Height)
    }

    $rows = (Get-Content $json -Raw | ConvertFrom-Json).rows
    $bad = @($rows | Where-Object { $_.overflowPx -gt 1 })
    # 两条轴都要判：**撑出滚动**（老坑）与**裁掉且滚不到**（更隐蔽 —— 根不滚，因为 overflow:hidden 把
    # 多出来的那一截吃掉了，"没有横向滚动条"这件事在这里不是通过，是内容没了）。
    $clipped = @($rows | Where-Object { $_.worst -and -not $_.worst.reachable })
    # 第三轴：地图页那块画布不许被挤成 0。这一条是**被前两轴的假绿逼出来的** ——
    # 把面板改成可缩之后 ①② 当场全绿，而 CDP 量出画布宽 0：主内容整个没了，"没有溢出"变成了"地图没了"。
    # 180 与 global.css 里 `minmax(180px, 1fr)` 是同一个数，两处必须一起改。
    $starved = @($rows | Where-Object { $null -ne $_.mapCanvasW -and $_.mapCanvasW -lt 180 })
    Write-Host ("MATRIX cells={0} 撑出横向滚动={1} 越过右缘且滚不到={2} 画布被挤没={3}" -f $rows.Count, $bad.Count, $clipped.Count, $starved.Count)
    foreach ($m in @($rows | Where-Object { $null -ne $_.mapCanvasW })) {
        Write-Host ("  CANVAS phys={0} css={1} 画布宽={2}px" -f $m.physicalWindowWidth, $m.innerW, $m.mapCanvasW)
    }
    foreach ($b in $bad) { Write-Host ("  X[滚动] phys={0} {1} 溢出 {2}px worst=<{3} class={4}>" -f $b.physicalWindowWidth, $b.view, $b.overflowPx, $b.worst.tag, $b.worst.cls) }
    foreach ($c in $clipped) { Write-Host ("  X[裁掉] phys={0} css={1} {2} 越右缘 {3}px <{4} class={5}>" -f $c.physicalWindowWidth, $c.innerW, $c.view, $c.worst.overPx, $c.worst.tag, $c.worst.cls) }
    foreach ($s in $starved) { Write-Host ("  X[画布] phys={0} css={1} 空间地图 画布只剩 {2}px（下限 180）—— 前两轴全绿而主内容没了" -f $s.physicalWindowWidth, $s.innerW, $s.mapCanvasW) }
    # 第四轴：没有为滚动条预留布局空间，且滚动仍然可用。
    # **这一轴证明不了"看不见条"** —— 本机 WebView2 用覆盖式滚动条，删掉隐藏规则之后
    # offsetWidth-clientWidth 照样是 0，真滚轮滚动瞬间截图也逐字节相同（详见 scale-probe.mjs 那段注释）。
    # 所以这里报的是"布局没被条吃掉 + 程序化滚得动"，不写"滚动条已隐藏"。
    $barLeft = @($rows | Where-Object { $_.barTaken -gt 0 })
    $cantScroll = @($rows | Where-Object { $_.scrollables -gt 0 -and $_.scrolled -eq $false })
    $docBar = @($rows | Where-Object { $_.docBarWidth -gt 1 })
    Write-Host ("  布局/滚动：真可滚元素共 {0} 个，被条占掉布局的 {1} 个；根被垂直条占宽的 {2} 格；可滚但程序化滚不动的 {3} 格" -f `
        (@($rows | Measure-Object -Property scrollables -Sum).Sum), $barLeft.Count, $docBar.Count, $cantScroll.Count)
    foreach ($x in $barLeft) { Write-Host ("  X[占布局] phys={0} {1} 还有 {2} 个可滚元素被条占掉布局" -f $x.physicalWindowWidth, $x.view, $x.barTaken) }
    foreach ($x in $cantScroll) { Write-Host ("  X[滚不动] phys={0} {1} 有 {2} 个可滚元素而程序化滚动没动 —— 条藏了，滚动也没了" -f $x.physicalWindowWidth, $x.view, $x.scrollables) }
    Copy-Item $json (Join-Path $OutDir 'm6b-scale.json') -Force
    if ($bad.Count -gt 0 -or $clipped.Count -gt 0 -or $starved.Count -gt 0 -or $barLeft.Count -gt 0 -or $cantScroll.Count -gt 0) {
        throw "矩阵：撑出滚动 $($bad.Count) / 被裁掉 $($clipped.Count) / 画布挤没 $($starved.Count) / 条没藏住 $($barLeft.Count) / 滚不动 $($cantScroll.Count) —— 逐格点名在上面"
    }
    Write-Host "DONE（八页 × 三档：不撑滚动、不裁内容、画布不挤没；布局没被滚动条吃掉且程序化滚动有效 —— 这一句不含「看不见条」，那条本机量不出来）"
} finally {
    Get-Process deepclean-app -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Seconds 2
    Get-Process deepclean-app -ErrorAction SilentlyContinue | Stop-Process -Force
}
