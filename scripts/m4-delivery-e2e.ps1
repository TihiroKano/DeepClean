# M4 delivery chain end-to-end: a FRESH install can actually activate.
#
# WHY THIS SCRIPT EXISTS: everything before it handed the code table to the app by hand
# (`Reset-Dir` in scripts/m4-license-e2e.ps1 copies the FIXTURE manifest in). So the chain that
# was ever proven ended with "given a table, activation works" - and nothing in the repo placed
# codes.sha256 on a machine. A brand-new install therefore could not activate even holding a real
# code: it would get E_LICENSE_TABLE, an error code the user can do nothing about.
#
# This script proves the missing link, with the EMBEDDED table and a REAL code:
#
#   P1  an EMPTY license dir -> start the app
#   P2  the app materialized codes.sha256 itself, byte-identical to src-tauri/resources/codes.sha256,
#       1000 hash rows, and it did NOT create device.key / license.dat (status stays read-only)
#   P3  type a real code from the vault -> 已激活, and license.dat's codeHash equals
#       SHA256(that exact vault line) computed here in PowerShell - an independent re-derivation
#       of the normalization contract against the shipped table
#   P4  negative control: DC- + 32 zeros -> E_LICENSE_INVALID_CODE, nothing written
#   P5  restart on the same dir -> 已激活 with no further action (the persisted state survives)
#
# WHAT IT DOES NOT PROVE (say so instead of letting the reader infer it):
# - It does not prove anything about a server. There is none; the network gate is a local probe
#   (see netprobe.rs), so P3 really does need this machine online.
# - It does not prove the 1000 codes were *distributed*, only that the shipped table accepts one.
#
# THREE THINGS IT DELIBERATELY DOES NOT TRUST (same discipline as m4-license-e2e.ps1):
# 1. The UI text alone. Every phase also checks the filesystem; a screenshot of nothing looks
#    exactly like a screenshot of something. => ErrorActionPreference Stop, no swallowing trap.
# 2. A click that returned. WebView2's UIA tree hydrates for seconds; every click is followed by
#    "did the expected thing appear", with a bounded retry.
# 3. Chinese literals in this file. Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI, so UIA
#    names are built from code points. The app's card title is 授权 (renamed from 离线授权 on
#    2026-10-11 when activation became online-gated) - if that string ever reads stale here,
#    Wait-Name failing is the symptom, not a missing button.
# 4. **Its own screenshots.** Unlike every earlier license script, this one types a REAL code from
#    the vault, so the input box is a plaintext-secret surface and `CopyFromScreen` captures it.
#    The first run wrote exactly that into docs/acceptance/assets (vault line 3, readable in
#    m4-delivery-02) - caught by looking at the image, not by any assertion. Nothing of it reached
#    a commit. Hence Clear-Code before that shot, gated on the
#    activate button going disabled. Rule for the whole repo: **a phase that typed a real code may
#    only be screenshotted with the box proven empty.**
#
# The UIA helpers are copied from scripts/m4-license-e2e.ps1 rather than shared: this repo has no
# module for them, and each e2e script staying self-contained is the existing convention.
param(
    [string]$App       = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$Manifest  = "D:\DeepClean\src-tauri\resources\codes.sha256",
    [string]$Vault     = "D:\dc-license-vault\codes-2026-10-11-1000.txt",
    [string]$DirReal   = "D:\dc-delivery-real",
    [string]$DirBad    = "D:\dc-delivery-bad",
    [string]$OutDir    = "D:\DeepClean\docs\acceptance\assets",
    [int]   $CodeLine  = 3,
    [switch]$SkipRealCode
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

$N_SET      = U 0x8BBE,0x7F6E                    # 设置  settings nav label
$N_TITLE    = U 0x6388,0x6743                    # 授权  card title
$N_CODE     = U 0x6FC0,0x6D3B,0x7801             # 激活码 input aria-label
$N_ACTIVATE = U 0x6FC0,0x6D3B                    # 激活   button label
$S_LICENSED = U 0x5DF2,0x6FC0,0x6D3B             # 已激活
$S_UNLIC    = U 0x672A,0x6FC0,0x6D3B             # 未激活

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null

function Find-Window([int]$procId) {
    # Only the top-level window whose class is `Tauri Window`: the same process also owns a 6x6
    # `Tao Thread Event Target`, and querying that one makes every later "element not found"
    # indistinguishable from "the element really is not there".
    $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $procId))
    foreach ($c in $cands) { if ($c.Current.ClassName -eq 'Tauri Window') { return $c } }
    return $null
}
function Get-Els($root) {
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
function Click-Until($root, [string]$target, [string]$expect, [int]$tries) {
    for ($try = 1; $try -le $tries; $try++) {
        Invoke-ByName $root $target
        $end = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $end) { if (Find-Substr $root $expect) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  click '$target' did not produce '$expect' (try $try/$tries), retrying"
    }
    throw "clicking '$target' $tries times never produced '$expect'"
}
function Test-ActivateEnabled($root) {
    # The button is disabled exactly while the code is empty, so its enabled state is a DOM-side
    # proof that React's state holds the text - the UIA Value read-back is not trustworthy here.
    $b = Find-Name $root $N_ACTIVATE
    return ($null -ne $b) -and $b.Current.IsEnabled
}
function Clear-Code($root) {
    # **This is a leak gate, not cosmetics.** The input keeps whatever was typed, and this script
    # types a REAL code from the vault - so a screenshot taken while it still shows is a plaintext
    # activation code committed into docs/acceptance/assets. The first run of this script did
    # exactly that (line 3 of the vault was visible in m4-delivery-02), which is why the shot now
    # has to wait for proof that the box is empty.
    #
    # Proof = the activate button going *disabled*: React's `code` state is empty exactly then,
    # which is the same DOM-side signal Set-Text trusts. A UIA Value read-back of "" would be
    # weaker (Chromium reports the attribute, and it has been seen to lie in both directions).
    $el = Wait-Name $root $N_CODE 30
    $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')
    $end = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $end) { if (-not (Test-ActivateEnabled $root)) { return }; Start-Sleep -Milliseconds 250 }
    throw "refusing to screenshot: the code box still holds text (activate button is still enabled)"
}
function Set-Text($root, [string]$name, [string]$text) {
    $el = Wait-Name $root $name 30
    try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($text) } catch {
        Write-Host "  ValuePattern unavailable: $($_.Exception.Message)"
    }
    $end = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $end) { if (Test-ActivateEnabled $root) { return }; Start-Sleep -Milliseconds 250 }
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
    throw "neither ValuePattern nor keyboard put the code into the input (activate button still disabled)"
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
    [void][Native.U32]::ShowWindow($h, 6)
    Start-Sleep -Milliseconds 400
    [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h)
    [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Start-App([string]$licenseDir) {
    $env:DC_LICENSE_DIR = $licenseDir
    # No DC_LICENSE_NET_FORCE here on purpose: forcing down/blocked is tested elsewhere. This
    # script must show the path a real user takes, which means a real connection attempt.
    Remove-Item Env:\DC_LICENSE_NET_FORCE -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $App -PassThru
    $script:Own = $p.Id
    Write-Host "  pid=$($p.Id) DC_LICENSE_DIR=$licenseDir"
    $w = $null
    for ($i = 0; $i -lt 60; $i++) { $w = Find-Window $p.Id; if ($w) { break }; Start-Sleep -Milliseconds 500 }
    if (-not $w) { throw "no window for pid $($p.Id)" }
    Raise-Window ([System.IntPtr]::new($w.Current.NativeWindowHandle))
    Start-Sleep -Seconds 3
    return @{ Proc = $p; Win = $w }
}
function Open-Settings($w) { Click-Until $w $N_SET $N_TITLE 4 }
function Stop-App($h) {
    Stop-Process -Id $h.Proc.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
    Start-Sleep -Seconds 1
}
function New-EmptyDir([string]$d) {
    # Unlike Reset-Dir in the older script: NOTHING is copied in. An empty dir is the whole point -
    # if this script stages the table itself, it proves nothing about delivery.
    if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    New-Item -ItemType Directory -Path $d | Out-Null
    $n = (Get-ChildItem $d | Measure-Object).Count
    if ($n -ne 0) { throw "dir $d is supposed to start empty, holds $n items" }
}
function Files([string]$d) { ((Get-ChildItem $d | Select-Object -ExpandProperty Name) -join ',') }
function Sha256Hex([string]$s) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s)) | ForEach-Object { $_.ToString('x2') })
}

if (-not (Test-Path $App)) { throw "app not built: $App" }
if (-not (Test-Path $Manifest)) { throw "shipped manifest missing: $Manifest (this is the artifact the delivery chain is made of)" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$manifestHash = (Get-FileHash -LiteralPath $Manifest -Algorithm SHA256).Hash.ToLower()
$manifestRows = ((Get-Content -LiteralPath $Manifest) | Where-Object { $_ -match '^[0-9a-f]{64}$' }).Count
Write-Host "shipped manifest: $Manifest rows=$manifestRows sha256=$($manifestHash.Substring(0,12))..."
if ($manifestRows -ne 1000) { throw "shipped manifest has $manifestRows hash rows, spec says 1000" }

try {
    # ---------------- P1 + P2: the app places its own table ----------------
    Write-Host "P1: empty license dir -> start the app"
    New-EmptyDir $DirReal
    $h = Start-App $DirReal
    # The table is materialized in tauri's setup(), i.e. before the window answers anything, but the
    # write and the UI hydrate independently - poll with a bound instead of sleeping once.
    $tablePath = Join-Path $DirReal 'codes.sha256'
    $end = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $tablePath) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path $tablePath)) { throw "P2: the app never placed codes.sha256 (dir holds: $(Files $DirReal))" }

    Write-Host "P2: table delivered by the app itself"
    $deliveredHash = (Get-FileHash -LiteralPath $tablePath -Algorithm SHA256).Hash.ToLower()
    if ($deliveredHash -ne $manifestHash) {
        throw "P2: delivered table is not byte-identical to the embedded one ($deliveredHash vs $manifestHash)"
    }
    $deliveredRows = ((Get-Content -LiteralPath $tablePath) | Where-Object { $_ -match '^[0-9a-f]{64}$' }).Count
    if ($deliveredRows -ne 1000) { throw "P2: delivered table has $deliveredRows rows" }
    # A read must not look like a write: device.key / license.dat belong to activation only.
    foreach ($f in @('device.key', 'license.dat')) {
        if (Test-Path (Join-Path $DirReal $f)) { throw "P2: $f appeared before any activation - the status path stopped being read-only" }
    }
    Write-Host "  byte-identical, 1000 rows, no device.key/license.dat yet (dir holds: $(Files $DirReal))"

    Open-Settings $h.Win
    if (-not (Find-Substr $h.Win $S_UNLIC)) { throw "P2: card is not showing UNLICENSED with a fresh dir" }
    Shot (Join-Path $OutDir 'm4-delivery-01-fresh-unlicensed.png')

    # ---------------- P3: a REAL code against the shipped table ----------------
    if ($SkipRealCode) {
        Write-Host "P3: SKIPPED by -SkipRealCode (activation with a real code is unproven in this run)"
    } else {
        if (-not (Test-Path $Vault)) { throw "P3: vault missing ($Vault). The plaintext list lives outside the repo by design; pass -Vault or -SkipRealCode." }
        $code = (Get-Content -LiteralPath $Vault | Where-Object { $_ -match '^DC-[0-9A-F]{32}$' })[$CodeLine - 1]
        if (-not $code) { throw "P3: vault line $CodeLine is not a code" }
        $wantHash = Sha256Hex $code
        # Never echo the code: 35 characters of it are the deliverable. Print the hash prefix, which
        # is already public inside the shipped manifest.
        Write-Host ("P3: activating with vault line {0} (sha256={1}...)" -f $CodeLine, $wantHash.Substring(0, 12))
        if (-not ((Get-Content -LiteralPath $Manifest) -contains $wantHash)) {
            throw "P3: this vault code's hash is not in the shipped manifest - vault and table are two different generations"
        }
        Set-Text $h.Win $N_CODE $code
        Click-Until $h.Win $N_ACTIVATE $S_LICENSED 3
        foreach ($f in @('device.key', 'license.dat')) {
            if (-not (Test-Path (Join-Path $DirReal $f))) { throw "P3: $f missing after activate (dir holds: $(Files $DirReal))" }
        }
        # Independent re-derivation: PowerShell's SHA-256 over the vault line vs what the Rust crate
        # wrote. If the two normalizations diverged, this is where it shows - not in a fixture.
        $written = (Get-Content -LiteralPath (Join-Path $DirReal 'license.dat') -Raw | ConvertFrom-Json).codeHash
        if ($written.ToLower() -ne $wantHash) {
            throw "P3: license.dat codeHash=$written but PowerShell computes $wantHash for the same code"
        }
        Write-Host "  licensed, codeHash matches ($($written.Substring(0,12))...)"
        Clear-Code $h.Win
        Shot (Join-Path $OutDir 'm4-delivery-02-licensed-real-code.png')
    }
    Stop-App $h

    # ---------------- P4: negative control inside the running app ----------------
    Write-Host "P4: a shape-valid code that is NOT in the table -> refused, nothing written"
    New-EmptyDir $DirBad
    $h2 = Start-App $DirBad
    $t2 = Join-Path $DirBad 'codes.sha256'
    $end = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $t2) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path $t2)) { throw "P4: table not delivered on this second dir either" }
    Open-Settings $h2.Win
    $bogus = 'DC-' + ('0' * 32)
    if ((Get-Content -LiteralPath $Manifest) -contains (Sha256Hex $bogus)) { throw "P4: the control code is IN the shipped table - it is not a control" }
    Set-Text $h2.Win $N_CODE $bogus
    Invoke-ByName $h2.Win $N_ACTIVATE
    $line = Wait-Substr $h2.Win 'E_LICENSE_INVALID_CODE' 25
    Write-Host "  refused: $($line.Current.Name)"
    foreach ($f in @('device.key', 'license.dat')) {
        if (Test-Path (Join-Path $DirBad $f)) { throw "P4: $f was written for a code that is not in the table" }
    }
    Shot (Join-Path $OutDir 'm4-delivery-03-code-not-in-table.png')
    Stop-App $h2

    # ---------------- P5: persistence across a restart ----------------
    if ($SkipRealCode) {
        Write-Host "P5: SKIPPED (nothing was activated in this run)"
    } else {
        Write-Host "P5: restart on the same dir -> licensed with no further action"
        $h3 = Start-App $DirReal
        Open-Settings $h3.Win
        [void](Wait-Substr $h3.Win $S_LICENSED 40)
        if (Find-Substr $h3.Win $S_UNLIC) { throw "P5: a restarted licensed machine still offers UNLICENSED" }
        Write-Host "  still licensed"
        Shot (Join-Path $OutDir 'm4-delivery-04-licensed-after-restart.png')
        Stop-App $h3
    }
    Write-Host "DONE"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  at line $($_.InvocationInfo.ScriptLineNumber)"
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
