# M4 offline-license end-to-end: real clicks (UIAutomation) + real DPAPI writes + disk assertions.
#
# WHY THIS SCRIPT EXISTS: the M4 acceptance line says "real machine: click activate once
# (screenshot)". Before this, that was only ever claimed from unit tests.
#
#   phase A   fresh dir A -> card reads UNLICENSED -> type a fixture code -> Activate
#             -> card reads LICENSED **and** device.key + license.dat exist on disk
#   phase B   fresh dir B (its own device key, another code) - stands in for "another machine"
#   phase C   copy B's license.dat into A, reopen on A -> card must read INVALID/device-mismatch
#
# THREE THINGS THIS SCRIPT DELIBERATELY DOES NOT TRUST:
# 1. **The UI text alone.** Every phase also checks the filesystem. An earlier version of this
#    script ended with exit=0 and "DONE" while dir A contained only codes.sha256 - the click never
#    happened, the view never changed, and a script-level trap had swallowed every terminating
#    error. A screenshot of nothing looks exactly like a screenshot of something.
#    => $ErrorActionPreference = 'Stop', no swallowing trap, disk coordinates per phase.
# 2. **A click that returned.** WebView2's UIA tree hydrates over the first seconds, and an Invoke
#    against an element React re-rendered in between is a silent no-op. Every click is followed by
#    "did the expected thing actually appear", with a bounded retry.
# 3. **Chinese literals in this file.** It is BOM-less UTF-8 and Windows PowerShell 5.1 reads such
#    files as ANSI, so literals arrive mojibake - and a mojibake UIA name is indistinguishable from
#    "the button isn't there". All names are built from code points (verified against the .tsx).
#
# NOTE ON THE UIA API: `PropertyCondition`'s three-arg (MatchSubstring) constructor is NOT bindable
# from Windows PowerShell 5.1 - both `::new(...)` and `New-Object` fail with
# "Cannot find an overload ... argument count: 3". So the tree is enumerated per poll and names are
# matched client-side. (This is very likely why scripts/m3c-e2e-screenshot.ps1, which uses that
# 3-arg form, never produced any screenshots: it dies on its first substring lookup.)
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$DirA   = "D:\dc-license-dev",
    [string]$DirB   = "D:\dc-license-dev-b",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    [string]$Table  = "D:\DeepClean\src-tauri\crates\license\tests\data\codes.sha256",
    [string]$CodeA  = "DC-FIX-0001",
    [string]$CodeB  = "DC-FIX-0005",
    [switch]$SkipMismatch
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
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool share);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }

# UIA names, code points verified against the component sources
$N_SET      = U 0x8BBE,0x7F6E                          # 设置   settings nav label
$N_TITLE    = U 0x6388,0x6743                       # 卡片 h3 标题「授权」
# ⚠️ 这里曾经是「离线授权」，而 b41fdb7（10-11 23:28，比本脚本晚 9 小时）把标题改成了
# 「授权」—— 脚本从此在等一个界面从来没有过的词，静默红了四天没人跑。
# 「授权」在设置页别处的句子里也出现，所以判据按**整名相等**认那个 h3（见 Open-Settings）。
$N_CODE     = U 0x6FC0,0x6D3B,0x7801                  # 激活码  aria-label of the input
$N_ACTIVATE = U 0x6FC0,0x6D3B                          # 激活    button label
$S_LICENSED = U 0x5DF2,0x6FC0,0x6D3B                   # 已激活
$S_UNLIC    = U 0x672A,0x6FC0,0x6D3B                   # 未激活
$S_INVALID  = U 0x6388,0x6743,0x4E0D,0x53EF,0x4FE1    # 授权不可信
$S_DEVICE   = U 0x8BBE,0x5907                          # 设备   (inside the named reason)

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE    = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null

function Find-Window([int]$procId) {
    # 只挑类名 `Tauri Window` 那个顶层窗口：同进程还有一个 6x6 的 `Tao Thread Event Target`，
    # FindFirst 命中它时后面每一次"找不到元素"都是查错了地方（与"元素真的不在"同形）。
    $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $procId))
    foreach ($c in $cands) { if ($c.Current.ClassName -eq 'Tauri Window') { return $c } }
    return $null
}
function Get-Els($root) {
    # UIA throws "Unrecognized error" (a raw COM failure) when the tree mutates mid-enumeration,
    # which is normal right after a keystroke re-renders React. Retry, and if it keeps failing say
    # so - never let a swallowed error look like "the element isn't there".
    for ($i = 0; $i -lt 6; $i++) {
        try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 }
    }
    throw "UIA tree enumeration kept failing (COM) - cannot judge the UI at all"
}
function Find-Name($root, [string]$name) {
    foreach ($e in (Get-Els $root)) { if ($e.Current.Name -eq $name) { return $e } }
    return $null
}
function Find-Substr($root, [string]$sub) {
    foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
    return $null
}
function Wait-Name($root, [string]$name, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Name $root $name; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "no UIA element named '$name' within ${sec}s"
}
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "no element whose name contains '$sub' within ${sec}s"
}
function Invoke-ByName($root, [string]$name) {
    $el = Find-Name $root $name
    if (-not $el) { throw "click target missing: '$name'" }
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
# Click, then prove the effect showed up. A click that returns is not evidence.
function Click-Until($root, [string]$target, [string]$expect, [int]$tries) {
    for ($try = 1; $try -le $tries; $try++) {
        Invoke-ByName $root $target
        $end = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $end) {
            if (Find-Substr $root $expect) { return }
            Start-Sleep -Milliseconds 300
        }
        Write-Host "  click '$target' did not produce the expected result (try $try/$tries), retrying"
    }
    throw "clicking '$target' $tries times never produced '$expect'"
}
function Test-ActivateEnabled($root) {
    # The button is `disabled` exactly while the code is empty (LicenseCard.tsx), so its enabled
    # state is a DOM-side proof that React's state really holds the text - unlike the UIA Value,
    # which Chromium reports from the attribute and which stayed "" even after a successful set.
    $b = Find-Name $root $N_ACTIVATE
    return ($null -ne $b) -and $b.Current.IsEnabled
}
function Set-Text($root, [string]$name, [string]$text) {
    $el = Wait-Name $root $name 30
    # Path 1: UIA ValuePattern. Chromium's implementation raises input events, so this can drive a
    # React-controlled input; the earlier "reports ''" reading was the *probe* being wrong, not the
    # write - so success is judged off the button, not off `.Current.Value`.
    try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text) } catch {
        Write-Host "  ValuePattern unavailable: $($_.Exception.Message)"
    }
    $end = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $end) { if (Test-ActivateEnabled $root) { return }; Start-Sleep -Milliseconds 250 }

    # Path 2: real keystrokes. Note this needs the script to be ELEVATED when the app manifest
    # requires administrator - UIPI blocks synthetic input from a lower-integrity process, which is
    # what the first three attempts hit.
    Write-Host "  ValuePattern did not take; trying keyboard"
    try { $el.SetFocus() } catch { }
    Start-Sleep -Milliseconds 400
    $focused = Wait-Name $root $name 10
    if (-not $focused.Current.HasKeyboardFocus) {
        throw "the code input did not take keyboard focus - refusing to type anywhere else"
    }
    [System.Windows.Forms.SendKeys]::SendWait($text)
    $end = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $end) { if (Test-ActivateEnabled $root) { return }; Start-Sleep -Milliseconds 250 }
    throw "neither ValuePattern nor keyboard put '$text' into the input (activate button still disabled)"
}
function Shot([string]$file) {
    # 拍**整块桌面**存进版本库 = 把任务栏、别的窗口、桌面上任何正在显示的东西一起存档。
    # 改成共享的 DWM 帧裁图（只裁应用窗口），并且"不在最前就拒收这张图"。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "screenshot is $len bytes - too small to be a rendered window" }
    Write-Host "  shot -> $file ($len bytes)"
}
function Raise-Window([System.IntPtr]$h) {
    $script:Hwnd = $h
    # A background process is normally NOT allowed to take foreground (Windows lock), and
    # SetForegroundWindow then silently returns false - which is what made the first typed run
    # put its keystrokes somewhere else entirely. min->restore is the documented way a process
    # regains the right, and AttachThreadInput ties our queue to the target's for the swap.
    [void][Native.U32]::ShowWindow($h, 6)   # SW_MINIMIZE
    Start-Sleep -Milliseconds 400
    [void][Native.U32]::ShowWindow($h, 9)   # SW_RESTORE
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h)
    [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
    $fg = [Native.U32]::GetForegroundWindow()
    Write-Host "  foreground hwnd now $fg (target $h, match=$($fg -eq $h))"
}
function Start-App([string]$licenseDir, [string]$netForce) {
    $env:DC_LICENSE_DIR = $licenseDir
    # dev-only knob in the app: it can only make the network gate STRICTER (down / blocked).
    # There is no "online" value - a backdoor that passes the gate would turn the gate and its
    # tests into decoration, and the card's sentence into a lie.
    if ($netForce) { $env:DC_LICENSE_NET_FORCE = $netForce } else { Remove-Item Env:\DC_LICENSE_NET_FORCE -ErrorAction SilentlyContinue }
    $p = Start-Process -FilePath $App -PassThru
    $script:Own = $p.Id
    Write-Host "  pid=$($p.Id) DC_LICENSE_DIR=$licenseDir DC_LICENSE_NET_FORCE=$netForce"
    $w = $null
    for ($i = 0; $i -lt 60; $i++) { $w = Find-Window $p.Id; if ($w) { break }; Start-Sleep -Milliseconds 500 }
    if (-not $w) { throw "no window for pid $($p.Id)" }
    Raise-Window ([System.IntPtr]::new($w.Current.NativeWindowHandle))
    Start-Sleep -Seconds 3
    return @{ Proc = $p; Win = $w }
}
function Open-Settings($w) {
    # 点了要能证明页真的换了：认「授权」那个 h3 的**整名相等**，不用 Contains ——
    # 后者会被「正在读这份机器上的授权…」这类句子先命中，那等于什么都没验。
    for ($try = 1; $try -le 4; $try++) {
        Invoke-ByName $w $N_SET
        $end = (Get-Date).AddSeconds(10)
        while ((Get-Date) -lt $end) { if (Find-Name $w $N_TITLE) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  click '$N_SET' did not produce the '$N_TITLE' card title (try $try/4), retrying"
    }
    throw "clicking '$N_SET' 4 times never produced a UIA element named exactly '$N_TITLE'"
}
function Stop-App($h) {
    Stop-Process -Id $h.Proc.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
    Start-Sleep -Seconds 1
}
function Reset-Dir([string]$d) {
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    New-Item -ItemType Directory -Path $d | Out-Null
    Copy-Item $Table (Join-Path $d 'codes.sha256')
}
function Files([string]$d) { ((Get-ChildItem $d | Select-Object -ExpandProperty Name) -join ',') }

if (-not (Test-Path $App)) { throw "app not built: $App" }
if (-not (Test-Path $Table)) { throw "fixture manifest missing: $Table" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

try {
    # Scratch dirs created for THIS run only; device.key / license.dat must start absent so that
    # "unlicensed" is the real first state rather than a leftover.
    Reset-Dir $DirA
    Reset-Dir $DirB

    Write-Host "PHASE A: unlicensed -> activate -> licensed"
    $h = Start-App $DirA $null
    Open-Settings $h.Win
    if (-not (Find-Substr $h.Win $S_UNLIC)) { throw "card did not start unlicensed (dir holds: $(Files $DirA))" }
    Shot (Join-Path $OutDir 'm4-license-01-unlicensed.png')

    Set-Text $h.Win $N_CODE $CodeA
    Click-Until $h.Win $N_ACTIVATE $S_LICENSED 3
    # Disk coordinate: the UI saying "已激活" while these two files are absent is exactly the
    # over-claim this whole chain exists to prevent.
    foreach ($f in @('device.key', 'license.dat')) {
        if (-not (Test-Path (Join-Path $DirA $f))) { throw "phase A: $f missing after activate (dir holds: $(Files $DirA))" }
    }
    Shot (Join-Path $OutDir 'm4-license-02-licensed.png')
    Write-Host "  licensed, dir holds: $(Files $DirA)"
    Stop-App $h

    if (-not $SkipMismatch) {
        Write-Host "PHASE B: second 'machine' with its own device key"
        $h2 = Start-App $DirB $null
        Open-Settings $h2.Win
        Set-Text $h2.Win $N_CODE $CodeB
        Click-Until $h2.Win $N_ACTIVATE $S_LICENSED 3
        if (-not (Test-Path (Join-Path $DirB 'license.dat'))) { throw "phase B: license.dat missing (dir holds: $(Files $DirB))" }
        Stop-App $h2

        Write-Host "PHASE C: B's license.dat placed in A -> must read INVALID (device-mismatch)"
        Copy-Item (Join-Path $DirB 'license.dat') (Join-Path $DirA 'license.dat') -Force
        $h3 = Start-App $DirA $null
        Open-Settings $h3.Win
        [void](Wait-Substr $h3.Win $S_INVALID 40)
        $leaf = Wait-Substr $h3.Win $S_DEVICE 30
        Write-Host "  reason shown: $($leaf.Current.Name)"
        Shot (Join-Path $OutDir 'm4-license-03-device-mismatch.png')
        Stop-App $h3
    }
    # ---- 在线激活这一关的两相（dev-only 的 DC_LICENSE_NET_FORCE 只能把判定改严，不能放行）----
    foreach ($case in @(
            @{ tag = "D"; dir = "${DirA}-d"; force = "down";    code = $CodeA; expect = "E_LICENSE_NO_NETWORK";  shot = "m4-license-04-no-network.png";      host = $null },
            @{ tag = "E"; dir = "${DirA}-e"; force = "blocked"; code = $CodeB; expect = "E_LICENSE_NET_BLOCKED"; shot = "m4-license-05-net-blocked.png";     host = "www.baidu.com:443" })) {
        if ($case.tag -eq "E" -and $SkipMismatch) { continue }
        Write-Host ("PHASE {0}: net force={1} -> activation refused, nothing written" -f $case.tag, $case.force)
        $d = $case.dir
        Reset-Dir $d
        $hh = Start-App $d $case.force
        Open-Settings $hh.Win
        Set-Text $hh.Win $N_CODE $case.code
        Invoke-ByName $hh.Win $N_ACTIVATE
        $line = Wait-Substr $hh.Win $case.expect 25
        Write-Host ("  shown: {0}" -f $line.Current.Name)
        if ($case.host) {
            if (-not $line.Current.Name.Contains($case.host)) { throw "被拦这一相必须点名探测点 $($case.host)，实际那句是：$($line.Current.Name)" }
        }
        if ($line.Current.Name.Contains("E_LICENSE_INVALID_CODE")) { throw "网络这条失败不许拐到激活码上：$($line.Current.Name)" }
        foreach ($f in @("device.key", "license.dat")) {
            if (Test-Path (Join-Path $d $f)) { throw "phase $($case.tag): $f 被写出来了 —— 闸门没走在碰文件系统之前" }
        }
        Shot (Join-Path $OutDir $case.shot)
        Stop-App $hh
    }
    Write-Host "DONE"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  at line $($_.InvocationInfo.ScriptLineNumber)"
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
