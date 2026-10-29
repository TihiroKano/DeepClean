# release 可用的「起应用 + 扫一棵树」驱动通道。
#
# 为什么要有这个文件：M6 之后打包版是交付物，而 14 个真机 e2e 里有 13 个靠
# `DC_AUTOSCAN` 起扫描 —— 那个变量在 `src-tauri/src/main.rs:99` 上是
# `#[cfg(debug_assertions)]`，release 拿不到 ⇒ 那些脚本在打包版上结构上跑不了。
# 这里改成**驱动界面**（指定位置 → 真点 → 等扫完），debug 与 release 走同一条路，
# 不留两套代码，也不给 release 开任何新口子（`DC_ENV_ROOT` / `DC_SETTINGS_DIR`
# 都是按 debug 门控的，把它们放进 shipped 二进制是安全面，不做）。
#
# 用法（脚本里 dot-source 之后调）：
#   . "$PSScriptRoot\lib-dc-release.ps1"
#   $r = Start-DcReleaseApp -App $App -ScanRoot 'D:\some\fixture'
#   $script:Win = $r.Win; $script:Hwnd = $r.Hwnd
#
# 依赖：调用方（或本文件）已 Add-Type UIAutomationClient / UIAutomationTypes。

if (-not ('DcRelU32' -as [type])) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
'@ -Name DcRelU32 -Namespace DcRel -ReferencedAssemblies System.Runtime.InteropServices
}

# 截图必须按 **DWM 的真实帧边界** 裁，不能按 UIA 的 BoundingRectangle：后者含透明投影边，
# 拿它当裁剪框会把左边一条**别的窗口的字**和下面一截任务栏一起拍进验收图。
# 截图是泄露面 —— 桌面内容不许跟着进版本库。（这条不是新发现，`m5k-cleanlog-e2e.ps1:119`
# 早就写明并修过；本轮另两个脚本重新犯了它，7 张图带着聊天面板与 IDE 状态条进了提交。）
# 类型名刻意与 m5k 的 `NRECT` / `WinFnK` 错开 —— 那两个是 m5k 无条件 Add-Type 的，
# 同名重复定义会让 dot-source 它的脚本当场炸。
if (-not ('DcFrameRect' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DcFrameRect { public int Left; public int Top; public int Right; public int Bottom; }
public class DcWinFrame {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool fUnknown);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out DcFrameRect r, int size);
}
'@
}

function Save-DcShot {
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Hwnd,
        [Parameter(Mandatory = $true)][string]$OutPath,
        [int]$OwnerPid = 0
    )
    # Windows 的**前台锁**会拒绝后台进程的 SetForegroundWindow：本轮第一次拍（那时还没发生过
    # 任何真鼠标点击）就是这么顶不起来、拍到了别人家的窗口，而后面几张靠前面的点击合法拿到了前台。
    # SwitchToThisWindow 是任务切换器用的那条 API，能过这一关。两种都试，每轮现读前台句柄。
    # 正解是 m4-license-e2e.ps1 里那套（仓里本来有三套顶窗实现，这次并成一套）：
    # min→restore 是文档给的"重新拿回前台权"的路子，再用 AttachThreadInput 把我们的输入队列
    # 临时接到目标线程上 —— 单靠 SwitchToThisWindow 在第一次拍的时候还是会输给别人家的窗口。
    $mine = $false
    for ($t = 0; $t -lt 5; $t++) {
        [void][DcWinFrame]::ShowWindow($Hwnd, 6)     # SW_MINIMIZE
        Start-Sleep -Milliseconds 350
        [void][DcWinFrame]::ShowWindow($Hwnd, 9)     # SW_RESTORE
        $dummyPid = [uint32]0
        $tgtTid = [DcWinFrame]::GetWindowThreadProcessId($Hwnd, [ref]$dummyPid)
        $curTid = [DcWinFrame]::GetCurrentThreadId()
        [void][DcWinFrame]::AttachThreadInput($curTid, $tgtTid, $true)
        [void][DcWinFrame]::SetForegroundWindow($Hwnd)
        [void][DcWinFrame]::SwitchToThisWindow($Hwnd, $true)
        [void][DcWinFrame]::AttachThreadInput($curTid, $tgtTid, $false)
        Start-Sleep -Milliseconds 400
        if (-not $mine -and $t -ge 1) {
            # 最后一档：把一次**真实点击**落在窗口自己身上。前台锁的放行条件之一是
            # "用户刚在这个窗口上有过输入"，而第一次拍照之前根本没有输入发生过 ——
            # min/restore + AttachThreadInput 在这台机器上就会输给 IDE 的窗口。
            # 落点取标题栏中点（那是应用的 -webkit-app-region: drag 区，单击无副作用）。
            $pt = New-Object DcFrameRect
            if ([DcWinFrame]::DwmGetWindowAttribute($Hwnd, 9, [ref]$pt, [System.Runtime.InteropServices.Marshal]::SizeOf($pt)) -eq 0) {
                [void][DcRel.DcRelU32]::SetCursorPos([int](($pt.Left + $pt.Right) / 2), [int]($pt.Top + 10))
                Start-Sleep -Milliseconds 150
                [void][DcRel.DcRelU32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
                [void][DcRel.DcRelU32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
                Start-Sleep -Milliseconds 250
            }
        }
        if ([DcWinFrame]::GetForegroundWindow() -eq $Hwnd) { $mine = $true; break }
    }
    if (-not $mine) {
        Write-Warning "  五轮都顶不起这扇窗（前台句柄 $([DcWinFrame]::GetForegroundWindow()) ≠ $Hwnd）—— 调用方应当拒收这张图"
    }
    $fr = New-Object DcFrameRect
    $hr = [DcWinFrame]::DwmGetWindowAttribute($Hwnd, 9, [ref]$fr, [System.Runtime.InteropServices.Marshal]::SizeOf($fr))
    if ($hr -eq 0 -and ($fr.Right - $fr.Left) -gt 200 -and ($fr.Bottom - $fr.Top) -gt 200) {
        $x = $fr.Left; $y = $fr.Top; $w = $fr.Right - $fr.Left; $h = $fr.Bottom - $fr.Top
    } else {
        # 兜底**不能是整屏**：那正是这一系列修复要消灭的东西（桌面内容不许进版本库）。
        # 拿不到真实帧就只有两种可能 —— 句柄是 Zero（调用方传错了）或窗口已关；两种都不该出图。
        throw "Save-DcShot: 拿不到 DWM 帧边界（hr=$hr, hwnd=$Hwnd）—— 拒绝出图。句柄为 0 通常是调用方在 helper 返回前就拍了照。"
    }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $src = New-Object System.Drawing.Point($x, $y)
    $sz = New-Object System.Drawing.Size($w, $h)
    $g.CopyFromScreen($src, [System.Drawing.Point]::Empty, $sz)
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    $mine = [DcWinFrame]::GetForegroundWindow() -eq $Hwnd
    Write-Host ("  SHOT {0} ({1}x{2}) foreground={3}" -f (Split-Path $OutPath -Leaf), $w, $h, $mine)
    if (-not $mine) { Write-Warning "  截图时窗口不在最前 —— 这张可能是废的" }
    return [pscustomobject]@{ Width = $w; Height = $h; Foreground = $mine }
}

function U-Str([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }

function Start-DcReleaseApp {
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [string]$ScanRoot = '',
        [int]$WaitSec = 240,
        [switch]$BackHome,          # 扫完要不要点回首页（要接着点「导出 JSON 报告」那类首页控件才需要）
        [switch]$NoWait,            # 点完「开始深度扫描」就返回，不等扫完（m5f 那类"扫描途中"采样才需要）
                                    # 判据见本文件末尾的 Assert-DcNoWaitReturnedMidScan：不带这个开关时
                                    # 同一棵树上必须等到位出现，带了就必须"还没出现"——两边都要红过才算这个开关存在。
        [string]$HomeMark = '',     # 首页就绪的标记文字；默认「扫描范围」
        [scriptblock]$Shot = $null, # 可选截图钩子，两个节点上回调 ('1-ready' / '2-typed')，
                                    # 并把 hwnd 与窗口对象一起传出去 —— 调用方的 $script:Hwnd
                                    # 在本函数返回前是拿不到的，不传过去它就只能拍到整屏。
                                    # '2-typed'（路径已进 React）。文件名与前缀由调用方拼。
        [string]$StdErrLog = ''     # 可选：把子进程的 stderr 收到这个文件。m5o 那一棒原来自己
                                    # Start-Process 时挂了 -RedirectStandardError，迁到 helper 之后
                                    # 那格诊断面就没了（红的时候只能看界面说什么，看不到 stderr 说什么）。
    )
    $AE = [System.Windows.Automation.AutomationElement]
    $SC = [System.Windows.Automation.TreeScope]::Children
    $SD = [System.Windows.Automation.TreeScope]::Descendants
    # 局部变量别叫 $TRUE —— 那是 PowerShell 的只读常量，赋值当场炸（本会话已撞过 $home / $true 两次）
    $okTrue = [System.Windows.Automation.Condition]::TrueCondition
    $CT = [System.Windows.Automation.ControlType]

    # 中文一律码点拼：.ps1 无 BOM 时 PS 5.1 按 ANSI 读字面量，乱码的名字与"按钮不存在"在日志里长得一样
    $tScope = U-Str 0x6307, 0x5B9A, 0x4F4D, 0x7F6E                 # 指定位置
    $tReady = if ($HomeMark) { $HomeMark } else { U-Str 0x626B, 0x63CF, 0x8303, 0x56F4 }  # 扫描范围
    $tCta   = U-Str 0x5F00, 0x59CB, 0x6DF1, 0x5EA6, 0x626B, 0x63CF # 开始深度扫描
    $tDone  = U-Str 0x67E5, 0x770B, 0x626B, 0x63CF, 0x7ED3, 0x679C # 查看扫描结果
    $tHome  = U-Str 0x9996, 0x9875                                 # 首页
    $tMap   = U-Str 0x9002, 0x5E94, 0x7A97, 0x53E3                 # 适应窗口（空间地图独有）

    # 前置：残留实例一律拒绝 —— 上一轮的实例会把这一轮的界面与日志都搅浑
    $res = @(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue)
    if ($res.Count -gt 0) { throw "已有 $($res.Count) 个 deepclean-app 在跑（PID $($res.Id -join ',')）—— 先关掉再跑" }
    if (-not (Test-Path -LiteralPath $App)) { throw "产物不存在：$App" }
    if ($ScanRoot -and -not (Test-Path -LiteralPath $ScanRoot)) { throw "要扫的树不存在：$ScanRoot" }

    # 抛错时必须把**自己起的**进程收掉：调用方的 finally 是按它拿到的 $p 杀的，
    # 而这里在返回之前 throw 的话调用方根本还没拿到句柄 —— 本轮就漏了一个 8640 在盘上。
    trap {
        if ($p) {
            try { if (-not $p.HasExited) { $p.Kill(); Write-Host "  DC_ABORT 回收自己起的进程 pid=$($p.Id)" } } catch { }
        }
        # 裸 `throw` 在 trap 里会把原始异常换成一句 "ScriptHalted" —— 调用方的 catch 于是只能看到
        # 那三个字，真实原因（哪个元素没等到、哪次顶窗失败）全丢了。2026-10-17 查一跑失败就是这么瞎的。
        Write-Host "  DC_ABORT 原因：$($_.Exception.Message)（helper 行 $($_.InvocationInfo.ScriptLineNumber)）"
        throw $_.Exception
    }
    $start = @{ FilePath = $App; PassThru = $true }
    if ($StdErrLog) {
        # 同名旧文件如果被上一轮的残留实例攥着，Start-Process 会当场红在「文件正被另一进程使用」，
        # 那条红看着像产品坏了。所以：先确认没有残留实例（上面那条闸已经拦过），再把同名旧文件删掉。
        if (Test-Path $StdErrLog) { Remove-Item $StdErrLog -Force }
        $start['RedirectStandardError'] = $StdErrLog
        Write-Host "  DC_STDERR_LOG=$StdErrLog"
    }
    $p = Start-Process @start
    $win = $null
    for ($i = 0; $i -lt 80; $i++) {
        # 同一进程有两个顶层窗口（真窗口 + 6x6 的 `Tao Thread Event Target`），按类名挑
        $cands = $AE::RootElement.FindAll($SC, [System.Windows.Automation.PropertyCondition]::new($AE::ProcessIdProperty, $p.Id))
        $win = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($win) { break }
        if ($p.HasExited) { throw "进程自己退了（exit=$($p.ExitCode)），窗口都没开出来" }
        Start-Sleep -Milliseconds 500
    }
    if (-not $win) { throw "40 秒内没按 PID $($p.Id) 抓到 'Tauri Window'" }
    $hwnd = [System.IntPtr]::new($win.Current.NativeWindowHandle)

    function Raise { [void][DcRel.DcRelU32]::SetWindowPos($hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003); [void][DcRel.DcRelU32]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 250 }
    function Names { $win.FindAll($SD, $okTrue) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } }
    function Find-Sub([string]$sub) { $win.FindAll($SD, $okTrue) | Where-Object { $_.Current.Name -and $_.Current.Name.Contains($sub) } | Select-Object -First 1 }
    function Click-At($e) {
        Raise
        $r = $e.Current.BoundingRectangle
        if ($r.Width -lt 6 -or $r.Height -lt 6) { throw "元素矩形 $($r.Width)x$($r.Height) 不像能点的：$($e.Current.Name)" }
        [void][DcRel.DcRelU32]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
        Start-Sleep -Milliseconds 220
        [void][DcRel.DcRelU32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [void][DcRel.DcRelU32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 220
    }

    $end = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $end) { if (Find-Sub $tReady) { break }; Start-Sleep -Milliseconds 400 }
    if (-not (Find-Sub $tReady)) { throw "首页没出来（找不到「$tReady」）" }
    if ($Shot) { & $Shot '1-ready' $hwnd $win }

    if ($ScanRoot) {
        $sc = Find-Sub $tScope
        if (-not $sc) { throw "找不到「$tScope」那档" }
        Click-At $sc
        # 条件等待，不是固定睡 700 ms：点完到 React 重渲染出那个输入框之间没有别的信号可抓，
        # 睡死一个值就会在机器忙的时候假报"切换没生效"（本轮就这么红过一次）。
        $edit = $null
        $endE = (Get-Date).AddSeconds(12)
        while (-not $edit -and (Get-Date) -lt $endE) {
            $edit = ($win.FindAll($SD, $okTrue) | Where-Object { $_.Current.ControlType -eq $CT::Edit } | Select-Object -First 1)
            if (-not $edit) {
                # 顶一次再点一次：窗口若被别的窗压住，第一次点击会落到别人身上
                Start-Sleep -Milliseconds 500
                $sc2 = Find-Sub $tScope
                if ($sc2) { Click-At $sc2 }
            }
        }
        if (-not $edit) { throw "点了两次「$tScope」之后 12 秒内仍没有输入框 —— 切换没生效" }
        $vp = $null
        if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
            $vp.SetValue($ScanRoot)
            Start-Sleep -Milliseconds 600
        }
        $cta = Find-Sub $tCta
        if (-not $cta) { throw "找不到「$tCta」按钮" }
        if (-not $cta.Current.IsEnabled) {
            # UIA SetValue 未必派发 React 监的那个 input 事件（下拉框那格栽过，见 m5-topfiles 注释），
            # 判据是按钮放没放开 —— `disabled={startTarget.length === 0}` 只有 state 真收到值才解除。
            Click-At $edit
            Start-Sleep -Milliseconds 300
            [System.Windows.Forms.SendKeys]::SendWait($ScanRoot)
            Start-Sleep -Milliseconds 800
            $cta = Find-Sub $tCta
        }
        if (-not $cta.Current.IsEnabled) { throw "填了「$ScanRoot」之后「$tCta」仍是 disabled —— React 没拿到值" }
        if ($Shot) { & $Shot '2-typed' $hwnd $win }

        $cta.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        # 完成判据以**地图上出现了这棵根**为准 —— 「有个扫描结束了」证明不了"扫的是这棵树"。
        # 扫完应用会自己跳到空间地图（m5f 那句「回首页」就是这个行为），所以正常路径就是
        # 等地图起来 + 面包屑含 ScanRoot；调用方若要回到首页（比如还要点导出），带 -BackHome。
        if ($NoWait) {
            # m5f-perf 那一棒要的是**扫描途中**：① 连续采样「已扫描文件」每轮都得换新数、
            # ③ 途中把另外三页各开一次。等扫完再返回，这两相就永远拿不到证据。
            # 所以这里在点完「开始深度扫描」之后立刻返回，把轮询交给调用方自己接管。
            Write-Host "  DC_SCAN started root=$ScanRoot (NoWait: 不等完成，途中相归调用方)"
            return [pscustomobject]@{ Proc = $p; Win = $win; Hwnd = $hwnd }
        }
        $t0 = Get-Date; $done = $null; $onMap = $false
        while (((Get-Date) - $t0).TotalSeconds -lt $WaitSec) {
            $ns = @(Names)
            if ($ns -contains $tMap) {
                $onMap = $true
                if (@($ns | Where-Object { $_ -like "*$ScanRoot*" }).Count -gt 0) { $done = 'root'; break }
            }
            if (-not $onMap -and (@($ns | Where-Object { $_ -and $_.Contains($tDone) }).Count -gt 0)) { $done = 'home'; break }
            Start-Sleep -Milliseconds 900
        }
        if (-not $done) {
            $now = (Names) -join '|'
            if ($now.Length -gt 260) { $now = $now.Substring(0, 260) }
            throw "${WaitSec} 秒内没等到地图上的这棵根（onMap=$onMap）；界面现在说的是：$now"
        }
        Write-Host "  DC_SCAN ok root=$ScanRoot waited=$([int]((Get-Date) - $t0).TotalSeconds)s via=$done"

        if ($BackHome) {
            $h = ($win.FindAll($SD, $okTrue) | Where-Object { $_.Current.Name -eq $tHome } | Select-Object -First 1)
            if (-not $h) { throw "要回首页但找不到「$tHome」导航项" }
            $h.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            $hb = Find-Sub $tDone
            $endH = (Get-Date).AddSeconds(20)
            while (-not $hb -and (Get-Date) -lt $endH) { Start-Sleep -Milliseconds 400; $hb = Find-Sub $tDone }
            if (-not $hb) { throw "点了「$tHome」之后 20 秒内没出现「$tDone」" }
            Write-Host "  DC_BACK_HOME ok"
        }
    }

    # 只回对象，不回闭包：函数内定义的 `Raise` / `Click-At` 出了作用域就解析不到，
    # 调用方要用就自己 dot-source 或按 Hwnd 自己置顶。
    return [pscustomobject]@{ Proc = $p; Win = $win; Hwnd = $hwnd }
}

function Stop-DcReleaseApp {
    param($r)
    if (-not $r) { return }
    Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    $left = @(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) { $left | ForEach-Object { $_.Kill() } }
    Write-Host "  DC_CLEANUP residual=$(@(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue).Count)"
}

function Protect-DcSettings {
    # release 侧没有 DC_SETTINGS_DIR（settings.rs:198 那个重定向是 #[cfg(debug_assertions)] 的），
    # 所以在打包版上点「排除此文件夹」会写进**用户真的那份** %APPDATA%\com.deepclean.app\settings.json。
    # 对清理工具来说，一条留在真设置里的排除项是会静默改变将来删除范围的，不是无害噪音。
    # 这里拍一份"当时存不存在 + 内容"的快照，配 Restore-DcSettings 在 finally 里还原。
    param([string]$Dir = (Join-Path $env:APPDATA 'com.deepclean.app'))
    $f = Join-Path $Dir 'settings.json'
    if (-not (Test-Path $f)) {
        return [pscustomobject]@{ Dir = $Dir; Existed = $false; Backup = $null }
    }
    $bak = Join-Path $env:TEMP ("dc-settings-snap-{0}.json" -f (Get-Date -Format 'yyyyMMddHHmmssfff'))
    Copy-Item $f $bak -Force
    return [pscustomobject]@{ Dir = $Dir; Existed = $true; Backup = $bak }
}

function Restore-DcSettings {
    param($Token)
    if (-not $Token) { return }
    $f = Join-Path $Token.Dir 'settings.json'
    if (-not $Token.Existed) {
        if (Test-Path $f) {
            Remove-Item $f -Force
            Write-Host "  SETTINGS restored: 跑之前没有 settings.json，这一棒造出来的已删（$f）"
        } else {
            Write-Host "  SETTINGS untouched: 这一棒没写设置"
        }
        return
    }
    Copy-Item $Token.Backup $f -Force
    Remove-Item $Token.Backup -Force -ErrorAction SilentlyContinue
    Write-Host "  SETTINGS restored from snapshot ($f)"
}

function Assert-DcNoWaitReturnedMidScan {
    param(
        [Parameter(Mandatory = $true)][string]$App,
        [Parameter(Mandatory = $true)][string]$ScanRoot,
        [int]$SettleSec = 420
    )
    # -NoWait 这个开关的**正反两相**判据。缺了它，"加了个开关"和"开关真在做事"就分不开：
    # 红的一相是「开关被忽略 ⇒ 返回时扫描已经完成」，另一相是「返回得太早 ⇒ 连这棵树都没开始扫」。
    $AE = [System.Windows.Automation.AutomationElement]
    $SD = [System.Windows.Automation.TreeScope]::Descendants
    $COND = [System.Windows.Automation.Condition]::TrueCondition
    $tDone = U-Str 0x67E5, 0x770B, 0x626B, 0x63CF, 0x7ED3, 0x679C   # 查看扫描结果
    $tMap  = U-Str 0x9002, 0x5E94, 0x7A97, 0x53E3                 # 适应窗口（空间地图独有）

    # "扫完了"的信号必须与 Start-DcReleaseApp 自己那条**同形**：地图上出现这棵根，或首页出「查看扫描结果」。
    # 不能只写"某个元素的名字含 ScanRoot"—— 我们刚刚把 ScanRoot 亲手打进首页那个「指定位置」输入框里，
    # 输入框自己的 Name/Value 就含这串路径，于是"扫描完成"会在返回后 213 ms 被**自己填的那个格子**判成成立。
    # （实测：第一版就是这么"通过"又"红"的 —— 反向那一相恒真，余量永远接近 0。）
    $isDone = {
        param($ns)
        ($ns -contains $tMap -and (@($ns | Where-Object { $_ -like "*$ScanRoot*" }).Count -gt 0)) -or
        (@($ns | Where-Object { $_ -and $_.Contains($tDone) }).Count -gt 0)
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $ScanRoot -NoWait
    $names = @($dcApp.Win.FindAll($SD, $COND) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
    $returnedMs = [int]$sw.Elapsed.TotalMilliseconds

    if (& $isDone $names) {
        Stop-DcReleaseApp -r $dcApp
        throw "NoWait 没生效：返回只用了 $returnedMs ms，而界面上已经是完成态（地图上有这棵根，或首页出「$tDone」）"
    }
    # 反向那一相：等它真的跑完。等不到位说明返回发生在点「开始深度扫描」之前（开关做过头了）。
    $end = (Get-Date).AddSeconds($SettleSec); $seen = $false
    while ((Get-Date) -lt $end) {
        $ns = @($dcApp.Win.FindAll($SD, $COND) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
        if (& $isDone $ns) { $seen = $true; break }
        Start-Sleep -Milliseconds 1000
    }
    $doneMs = [int]$sw.Elapsed.TotalMilliseconds
    Stop-DcReleaseApp -r $dcApp
    if (-not $seen) { throw "NoWait 返回得太早：$SettleSec 秒内这棵根（$ScanRoot）既没上地图也没出完成词 —— 扫描根本没开始" }
    # 余量不足 = 这棵树太小，量不出"途中"这件事。实测拿 src-tauri\target 当根时 returnedAt 与
    # completedAt 只差 364 ms —— 那一趟**看着是绿的，其实和没跑一样**（换台机器就翻红，或更糟：翻绿而扫描
    # 早就完成了）。所以余量不够直接拒绝出结论，而不是打个 warning 继续。
    $margin = $doneMs - $returnedMs
    if ($margin -lt 3000) {
        throw "NoWait 判据无归因力：返回后 $margin ms 扫描就完成了（要 ≥3000 ms 才算量到「途中」）—— 换一棵更大的树当 ScanRoot 再跑（m5f 用的是 C:\Windows，release 侧约 54 s）"
    }
    Write-Host ("  NOWAIT_PROBE ok returnedAt={0}ms completedAt={1}ms margin={2}ms（两相都验：返回时没完成、之后确实完成）" -f $returnedMs, $doneMs, $margin)
    return [pscustomobject]@{ ReturnedMs = $returnedMs; CompletedMs = $doneMs; MarginMs = $margin }
}
