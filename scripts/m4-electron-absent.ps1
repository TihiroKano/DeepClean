# M4 §7.6.3 的收口：证明「不带授权功能的构建（今天的 Electron 线）界面上零变化」。
#
# 之前那句"整块不渲染"只有 `license-card.test.tsx` 里 `absent → 渲染空` 那一条单测撑着，
# 没有跑过一次真界面。这条脚本补的就是那次真跑：
#   ① 正向对照 —— 设置页**确实渲染出来了**（「关于」那一块在、重复检测阈值那颗下拉在）。
#      没有这一条，"看不见离线授权"可能只是页面白屏或者根本没进去，那什么也没证明。
#   ② 反向断言 —— 整棵树里没有任何元素叫「离线授权」。
#
# UIA 名字全部由码点拼（本文件是无 BOM 的 UTF-8，Windows PowerShell 5.1 会按 ANSI 读，
# 拼出来的乱码名和"按钮真的不在"长得一模一样）。
param(
    [string]$Electron = "D:\DeepClean\node_modules\electron\dist\electron.exe",
    [string]$AppDir   = "D:\DeepClean",
    [string]$OutDir   = "D:\DeepClean\docs\acceptance\assets"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$N_SET      = U 0x8BBE,0x7F6E                       # 设置
$N_LICENSE  = U 0x79BB,0x7EBF,0x6388,0x6743         # 离线授权  ← 必须**不**存在
$N_ABOUT    = U 0x5173,0x4E8E                       # 关于      ← 正向对照
$N_DUPMIN   = U 0x91CD,0x590D,0x6587,0x4EF6         # 重复文件（那一档的标题前缀）

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA enumeration kept failing (COM)"
}
function Find-Name($root, [string]$name) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -eq $name) { return $e } }; return $null }
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Shot([string]$file) {
    # 拍**整块桌面**存进版本库 = 把任务栏、别的窗口、桌面上任何正在显示的东西一起存档。
    # 改成共享的 DWM 帧裁图（只裁应用窗口），并且"不在最前就拒收这张图"。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "screenshot is $len bytes - too small to be a rendered window" }
    Write-Host "  shot -> $file ($len bytes)"
}

try {
    if (-not (Test-Path "$AppDir\out\main\index.js")) { throw "Electron 产物没 build（先 npm run build）" }
    # 这一棒验的是「Electron 那条线不带授权卡」，而 Electron 壳已于 2026-10-13 整体删除
    # （36 文件 10,604 行，见 docs/acceptance/2026-10-13-electron-shell-removal.md）⇒ 它**再也跑不了**。
    # 留着是因为它那张图还是 M4 的证据；但那张图是**整块桌面**（2160x1440），属于泄露面，
    # 重拍已无对象 —— 要撤证据得连 M4 验收文档一起定，别只删图。
    if (-not (Test-Path -LiteralPath $AppDir)) { throw "Electron 壳已删除（$AppDir 不存在）—— 这一棒不可重跑，不要在此浪费时间" }
    $p = Start-Process -FilePath $Electron -ArgumentList '.' -WorkingDirectory $AppDir -PassThru
    $script:Own = $p.Id
    Write-Host "  electron pid=$($p.Id)"
    $w = $null
    for ($i = 0; $i -lt 80; $i++) {
        $w = $A::RootElement.FindFirst($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $p.Id))
        if ($w) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $w) { throw "no window for pid $($p.Id)" }
    $script:Hwnd = [System.IntPtr]::new($w.Current.NativeWindowHandle)
    [void][Native.U32]::SetForegroundWindow($script:Hwnd)
    Start-Sleep -Seconds 4

    # 侧栏那颗「设置」要等渲染进程把整棵树挂上来才查得到（第一次跑就是 4 秒太短，直接报没有那颗）
    for ($i = 0; $i -lt 20; $i++) { if (Find-Name $w $N_SET) { break }; Start-Sleep -Milliseconds 700 }
    if (-not (Find-Name $w $N_SET)) { throw '侧栏里始终没有「设置」那一颗' }
    # 点进设置（点了没到就重试 —— WebView 的 UIA 树在头几秒会重排，Invoke 可能空转）
    for ($t = 1; $t -le 4; $t++) {
        $el = Find-Name $w $N_SET
        if (-not $el) { throw "侧栏里没有「设置」那一颗" }
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Start-Sleep -Milliseconds 900
        if (Find-Substr $w $N_ABOUT) { break }
        Write-Host "  第 $t 次点击没进设置页，重试"
    }

    # ① 正向对照：页面真的渲染了
    if (-not (Find-Substr $w $N_ABOUT)) { throw "「关于」没出现 —— 设置页没渲染，那'看不见授权卡'什么也没证明" }
    if (-not (Find-Substr $w $N_DUPMIN)) { throw "重复检测那一档没出现 —— 同上，缺正向对照" }
    Write-Host "  正向对照：设置页渲染完整（关于 + 重复文件·最小尺寸 都在）"

    # ② 反向断言：授权卡整块不存在
    $bad = Find-Name $w $N_LICENSE
    if ($bad) { throw "这个构建不该出现的「离线授权」那一块出现在界面上" }
    Write-Host "  反向断言：整棵树里没有「离线授权」"

    Shot (Join-Path $OutDir 'm4-electron-no-license-card.png')
    Write-Host "DONE"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  at line $($_.InvocationInfo.ScriptLineNumber)"
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
} finally {
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
}
