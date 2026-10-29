# M5-E① 真机验收：设置那一格第一次接上（读 / 清洗 / 写 / 重启后还在）。
# **全程零删除**：这一趟只点侧栏「设置」与那个下拉，不扫盘、不点任何执行入口。
#
# 四相各自独立，缺一相就说明一件事：
#   ① 预置一个**出界**的值 99999 → 界面必须念「1.0 GB」（= 夹到 1024 MB）。
#      这条钉的是「夹住而不是偷偷换成默认值」：写成 4 的话，「我明明改了」与「没生效」在屏幕上同形。
#   ② 真点开下拉、真点一个选项 → 界面跟着**服务端回执**重画，且盘上那份就是它。
#      这条钉的是「回整份而不是回 ok:true」：界面拿返回值画那一格，不是拿自己刚发出去的请求画。
#   ③ 关掉再起一次 → 还念那个值。这条钉的是「真落盘了」，不是内存里改爽了。
#   ④ 预置一份**坏 JSON** → 界面念默认值，而不是白屏、也不是「读不到设置」。
#      这条钉的是「读的那一刻不抛」：那个文件不存在/坏了都是能跑的状态，而它必须**说得出口**。
#
# 设置目录走 `DC_SETTINGS_DIR`（debug 构建独有的验收口子，同 `DC_ENV_ROOT` 先例）——
# 真机验收不许把用户的真配置改成 32 MB。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_SETTINGS   = U 0x8BBE, 0x7F6E                                       # 设置
$T_CURRENT    = U 0x5F53, 0x524D, 0x6309                               # 当前按
$T_READ_FAIL  = U 0x8BFB, 0x4E0D, 0x5230, 0x8BBE, 0x7F6E               # 读不到设置
$T_SAVING     = U 0x6CA1, 0x80FD, 0x5B58, 0x4E0B, 0x6765               # 没能存下来
$MB1024       = '1.0 GB'
$MB32         = '32.0 MB'
$MB4          = '4.0 MB'

$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Win = $null
$script:Hwnd = [System.IntPtr]::Zero

function All { $script:Win.FindAll($SCOPE_D, $COND_TRUE) }
function PageText { ((All | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join '|') }
function Wait-Text([string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        if ((PageText).Contains($sub)) { return }
        Start-Sleep -Milliseconds 300
    }
    $t = PageText
    if ($t.Length -gt 700) { $t = $t.Substring(0, 700) }
    throw "${sec}s 内页面上没有「$sub」。整页：$t"
}
function Ensure-OnTop {
    [void][Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    [void][Native.U32]::ShowWindow($script:Hwnd, 9)
    Start-Sleep -Milliseconds 300
}
function Click-Rect($e) {
    Ensure-OnTop
    $r = $e.Current.BoundingRectangle
    if ($r.Width -lt 6 -or $r.Height -lt 6) { throw "元素矩形 $($r.Width)x$($r.Height) 不像能点的" }
    [void][Native.U32]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
    Start-Sleep -Milliseconds 250
    [Native.U32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
}
function Shot([string]$file) {
    Ensure-OnTop
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $r = $script:Win.Current.BoundingRectangle
    $x = [Math]::Max(0, [int]$r.X); $y = [Math]::Max(0, [int]$r.Y)
    $cw = [Math]::Min([int]$r.Width, $full.Width - $x); $ch = [Math]::Min([int]$r.Height, $full.Height - $y)
    $crop = New-Object System.Drawing.Bitmap($cw, $ch)
    $gc = [System.Drawing.Graphics]::FromImage($crop)
    $gc.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
    $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $gc.Dispose(); $crop.Dispose(); $g.Dispose(); $full.Dispose()
    Write-Host "  截图 -> $file ($((Get-Item $file).Length) 字节)"
}
function Launch([string]$settingsDir) {
    $env:DC_SETTINGS_DIR = $settingsDir
    $p = Start-Process -FilePath $App -PassThru
    $script:ProcId = $p.Id
    for ($i = 0; $i -lt 60; $i++) {
        $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $p.Id))
        $w = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($w) {
            $script:Win = $w
            $script:Hwnd = [System.IntPtr]::new($w.Current.NativeWindowHandle)
            Ensure-OnTop
            return $p
        }
        Start-Sleep -Milliseconds 500
    }
    throw "pid $($p.Id) 没有 'Tauri Window'"
}
function Open-Settings {
    $nav = $null
    $end = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $end -and -not $nav) {
        $nav = (All | Where-Object { $_.Current.Name -eq $T_SETTINGS } | Select-Object -First 1)
        if (-not $nav) { Start-Sleep -Milliseconds 400 }
    }
    if (-not $nav) { throw "侧栏里没有「$T_SETTINGS」那一项" }
    # 按文字点导航（不按 index、不用 dev 入口）：这一页要是哪天点不进去了，这里必须红
    $nav.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1500
}

$dir = 'D:\deepclean-fixture\m5e-settings'
$proc = $null
try {
    # ---- ① 出界的值：夹住，而不是偷偷换成默认 ----
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # **无 BOM**：带 BOM 的那份两侧都判「不是合法 JSON」（Node 的 JSON.parse 与 serde_json 一样），
    # 那是第④相要验的形状，别让它把①相带偏
    [System.IO.File]::WriteAllText((Join-Path $dir 'settings.json'), '{"dupMinSizeMb":99999}')
    $proc = Launch $dir
    Open-Settings
    Wait-Text $T_CURRENT 25
    $t = PageText
    if ($t.Contains($T_READ_FAIL)) { throw "第①相：界面念的是「$T_READ_FAIL」：$(($t -split '\|' | Where-Object { $_ -like "*$T_READ_FAIL*" }))" }
    if (-not $t.Contains($MB1024)) { throw "第①相：预置 99999 该夹到 1024 MB（界面念 $MB1024），实际那句不在页面上：$($t.Substring(0,[Math]::Min(500,$t.Length)))" }
    if ($t.Contains($MB4)) { throw "第①相：出界的值被换成了默认 4 —— 那就是「我明明改了」与「没生效」同形" }
    Write-Host "  ① 预置 99999 → 界面念 $MB1024（夹住，不回落默认）"

    # ---- ② 真点一个选项：回执驱动重画 + 真落盘 ----
    $cb = (All | Where-Object { $_.Current.ControlType -eq $CT::ComboBox } | Select-Object -First 1)
    if (-not $cb) { throw "第②相：页面上没有那个下拉（ComboBox）" }
    Click-Rect $cb
    Start-Sleep -Milliseconds 900
    $pick = (All | Where-Object { $_.Current.Name -eq '32 MB' } | Select-Object -First 1)
    if (-not $pick) { throw "第②相：点开之后弹层里没有 32 MB 那一项" }
    Click-Rect $pick
    Wait-Text $MB32 20
    Start-Sleep -Milliseconds 1200   # 等 IPC 那趟存完
    $t2 = PageText
    if ($t2.Contains($T_SAVING)) { throw "第②相：界面念「$T_SAVING…」：$($t2.Substring(0,[Math]::Min(400,$t2.Length)))" }
    $onDisk = [System.IO.File]::ReadAllText((Join-Path $dir 'settings.json'))
    if ($onDisk -notmatch '"dupMinSizeMb"\s*:\s*32') { throw "第②相：盘上那份不是 32：$onDisk" }
    Write-Host "  ② 点 32 MB → 界面按服务端回执念 $MB32，盘上那份也是 32"
    Shot (Join-Path $OutDir 'm5e-settings-32mb.png')

    # ---- ③ 重启还在（真落盘，不是内存里改爽了） ----
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc = $null
    Start-Sleep -Milliseconds 900
    $proc = Launch $dir
    Open-Settings
    Wait-Text $T_CURRENT 25
    if (-not (PageText).Contains($MB32)) { throw "第③相：重启后没读到 32（那一格念的是别的）" }
    Write-Host "  ③ 再起一次仍念 $MB32 —— 读的是那个文件"

    # ---- ④ 坏文件：默认值 + 说得出口，而不是白屏 ----
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    $proc = $null
    [System.IO.File]::WriteAllText((Join-Path $dir 'settings.json'), '{ 这不是 JSON')
    Start-Sleep -Milliseconds 900
    $proc = Launch $dir
    Open-Settings
    Wait-Text $T_CURRENT 25
    $t4 = PageText
    if (-not $t4.Contains($MB4)) { throw "第④相：坏文件该回默认 4.0 MB，实际那句不在页面上：$($t4.Substring(0,[Math]::Min(400,$t4.Length)))" }
    if ($t4.Contains($T_READ_FAIL)) { throw "第④相：读设置那一侧**不许抛**（文件坏了是能跑的状态）" }
    Write-Host "  ④ 坏 JSON → 界面念默认 $MB4，页面照常（点名走 stderr，这一侧还没有文件日志）"

    Write-Host "DONE（设置：读 / 清洗 / 写 / 重启 / 坏文件五件事都在真机上过了）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Win) { Shot (Join-Path $OutDir 'm5e-settings-FAIL.png') } } catch { }
    exit 1
} finally {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
