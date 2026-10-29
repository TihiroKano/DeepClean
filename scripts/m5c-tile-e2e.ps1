# M5-C 真机验收：地图右键「加入清理列表」→ §17 预览按逐路径计价 → 再点一个不属于任何地盘的文件 → 点名退回。
# **全程零删除**（不点任何执行入口，跑完逐名点名两个夹具文件还在盘上）。
#
# 这一相是怎么来的（重要，别当成"接上就绿"）：
#   第一版跑出来「计入预估 —」，而 `cargo test --workspace` 与 `npm test` 全绿。
#   根因不在 §12 的代码，在 M2-A 就埋下的 `tree_index.rs` —— **文件子项的 `path` 一直是空串**，
#   于是地图右键的四项（打开 / 打开所在位置 / 复制路径 / 加入清理列表）对文件全拿到 ""，
#   服务端收到 `[""]`，归属反查自然什么都查不到，界面只是"点了没反应"。
#   单测为什么绿：它自己拼的是真路径（`temp_path()`），从没经过那条载荷 —— 夹具的形状不是生产的形状。
#
# 坐标说明：右键与菜单项是**按比例算的窗口内坐标**（canvas 自绘，UIA 树里没有格子可点；
# UIA 元素的 BoundingRectangle 在 WebView2 里不可信 —— 拿它点会点到画布上把菜单关掉）。
# 所以"点中了没"不由像素判断，由**点完之后界面必须出现的东西**判断：菜单文本、计入 1 项、点名退回那句。
# 窗口尺寸变了会点偏，那时脚本会红在断言上，而不是静默拍到一张没操作的图。
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
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool share);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$S_MAP_TILE_HINT = U 0x5355,0x51FB,0x65B9,0x5757,0x770B,0x8BE6,0x60C5   # 单击方块看详情；双击目录进入
$N_ADD_TO_CLEAN  = U 0x52A0,0x5165,0x6E05,0x7406,0x5217,0x8868            # 加入清理列表
$S_FROM_MAP      = U 0x4ECE,0x7A7A,0x95F4,0x5730,0x56FE,0x52A0,0x5165,0x7684  # 从空间地图加入的
$S_NOT_IN_TERR   = U 0x4E0D,0x5C5E,0x4E8E,0x4EFB,0x4F55                  # 不属于任何
$S_CLEAN_PAGE     = U 0x6E05,0x7406,0x9884,0x89C8                        # 清理预览（览 = U+89C8；写成 U+4F30「估」就永远等不到）
$S_REFUSED        = U 0x88AB,0x62D2                                      # 被拒

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null
$script:Hwnd = [System.IntPtr]::Zero
$script:Win = $null

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA 树枚举一直失败（COM）"
}
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Joined-Text($root) { ((Get-Els $root) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Out-String).Replace("`r`n", "").Trim() }
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "${sec}s 内没出现 '$sub'。整页文本：$((Joined-Text $root).Substring(0,260))"
}
function Raise-Window([System.IntPtr]$h) {
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 400; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
# 把我们压到 z-order 顶上。为什么不再要求"键盘前台"：这台机器上脚本进程抢不到前台锁
# （`SetForegroundWindow` 六次都不生效，实测），而**鼠标事件是按屏幕坐标投递的**，
# 要的是"那一点上最上面的窗口是我们"，`HWND_TOPMOST` 给的就是这个。
# 顶不动就直接失败；抢到之后所有判定仍由界面文本负责（点偏了会红在断言上，不会静默拍到别人的窗口）。
function Ensure-OnTop([string]$why) {
    $ok = [Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)  # TOPMOST + NOMOVE|NOSIZE
    Raise-Window $script:Hwnd
    Start-Sleep -Milliseconds 350
    if (-not $ok) { throw "SetWindowPos(TOPMOST) 失败（$why）—— 不许在点不准的情况下继续" }
    if ([Native.U32]::GetForegroundWindow() -ne $script:Hwnd) {
        Write-Host "  （注：键盘前台仍在别处；鼠标按坐标投递，TOPMOST 已保证这一点上我们最上面）"
    }
}
# 窗口内比例坐标 → 屏幕坐标 → 真实鼠标事件（LEFTDOWN/UP、RIGHTDOWN/UP）
function Click-At([double]$fx, [double]$fy, [bool]$right = $false, [int]$clicks = 1) {
    Ensure-OnTop "点击"
    $r = $script:Win.Current.BoundingRectangle
    $sx = [int]($r.X + $r.Width * $fx)
    $sy = [int]($r.Y + $r.Height * $fy)
    if (-not [Native.U32]::SetCursorPos($sx, $sy)) { throw "SetCursorPos($sx,$sy) 失败" }
    Start-Sleep -Milliseconds 250
    $down = if ($right) { 0x0008 } else { 0x0002 }
    $up   = if ($right) { 0x0010 } else { 0x0004 }
    for ($i = 0; $i -lt $clicks; $i++) {
        [Native.U32]::mouse_event($down, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [Native.U32]::mouse_event($up, 0, 0, 0, [System.UIntPtr]::Zero)
        Start-Sleep -Milliseconds 120
    }
}
function Shot([string]$file) {
    Ensure-OnTop "拍照"
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $r = $script:Win.Current.BoundingRectangle
    $x = [Math]::Max(0, [int]$r.X); $y = [Math]::Max(0, [int]$r.Y)
    $cw = [Math]::Min([int]$r.Width, $full.Width - $x); $ch = [Math]::Min([int]$r.Height, $full.Height - $y)
    if ($cw -lt 400 -or $ch -lt 300) { $g.Dispose(); $full.Dispose(); throw "窗口矩形 $cw x $ch 不像一扇真窗口" }
    $crop = New-Object System.Drawing.Bitmap($cw, $ch)
    $gc = [System.Drawing.Graphics]::FromImage($crop)
    $gc.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
    $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $gc.Dispose(); $crop.Dispose(); $g.Dispose(); $full.Dispose()
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节" }
    Write-Host "  截图 -> $file ($len 字节)"
}

try {
    # ---- 夹具：靶场里两棵树，一个在 windows-temp 的地盘内、一个在地盘外 ----
    $envroot = Join-Path $env:USERPROFILE 'Desktop\DeepClean删除测试\target\envroot'
    if (-not (Test-Path (Split-Path $envroot))) { throw "授权靶场不存在：$envroot" }
    if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
    New-Item -ItemType Directory -Force -Path "$envroot\TEMP" | Out-Null
    New-Item -ItemType Directory -Force -Path "$envroot\outside" | Out-Null
    $b = New-Object byte[] 4096; for ($i = 0; $i -lt 4096; $i++) { $b[$i] = [byte]($i -band 0xff) }
    $claimed = "$envroot\TEMP\m5c-tile.tmp"
    $stray   = "$envroot\outside\m5c-stray.bin"
    [System.IO.File]::WriteAllBytes($claimed, $b)
    [System.IO.File]::WriteAllBytes($stray, $b)
    Write-Host "  夹具：地盘内 $claimed / 地盘外 $stray"

    $env:DC_ENV_ROOT = $envroot
    $env:DC_AUTOSCAN = $envroot
    $p = Start-Process -FilePath $App -PassThru
    $script:Own = $p.Id
    $w = $null
    for ($i = 0; $i -lt 60; $i++) {
        $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $p.Id))
        $w = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($w) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $w) { throw "pid $($p.Id) 没有 'Tauri Window'" }
    $script:Win = $w
    $script:Hwnd = [System.IntPtr]::new($w.Current.NativeWindowHandle)
    Raise-Window $script:Hwnd
    [void](Wait-Substr $w $envroot 150)
    Write-Host "  扫描跑完（面包屑里有这棵根）"

    # ---- ① 钻进 TEMP（下层只有一个文件格子），右键它，点「加入清理列表」 ----
    Click-At 0.45 0.78 $false 2          # 双击根层里靠下的那块（TEMP）
    Start-Sleep -Milliseconds 1200
    [void](Wait-Substr $w 'm5c-tile.tmp' 20)
    Click-At 0.42 0.32 $true 1           # 右键文件格子
    [void](Wait-Substr $w $N_ADD_TO_CLEAN 15)
    Write-Host "  菜单出来了（含「$N_ADD_TO_CLEAN」）"
    Click-At 0.27 0.40 $false 1          # 点菜单第五项
    [void](Wait-Substr $w $S_CLEAN_PAGE 25)
    Start-Sleep -Milliseconds 2500

    # ---- 断言①：那一个文件真按逐路径计价进了预估 ----
    $txt = Joined-Text $w
    if ($txt -notmatch "$S_FROM_MAP") { throw "清理页没出现「从空间地图加入的」那块：$($txt.Substring(0,260))" }
    if ($txt -notmatch "4\.0 KB") { throw "预估里没出现 4.0 KB：$txt" }
    if ($txt -match $S_REFUSED) { throw "出现了「被拒」—— 这个文件在 windows-temp 的地盘里，不该被拒：$txt" }
    if ($txt -match $S_NOT_IN_TERR) { throw "它被当成不属于任何地盘了（归属反查没通）：$txt" }
    Write-Host "  ① 地盘内文件：进了预估、没被拒、也没被误报成无地盘"
    Shot (Join-Path $OutDir 'm5c-tile-counted.png')

    # ---- ② 换到 outside 那棵树，对地盘外的文件做同一件事 ----
    # 上一相结束时界面在「垃圾清理」页，那里没有面包屑 —— 先回空间地图（点侧栏那颗），
    # 再点面包屑第一格回到根。第一版直接把这一点打在 (0.10,0.085)，命中的是侧栏「首页」，
    # 于是后面所有等待都红在"没出现 m5c-stray.bin"上（截图里是首页，不是地图）。
    Click-At 0.07 0.142 $false 1         # 侧栏：空间地图
    Start-Sleep -Milliseconds 1200
    Click-At 0.34 0.083 $false 1         # 面包屑第一格 = 扫描根
    Start-Sleep -Milliseconds 1500
    [void](Wait-Substr $w 'outside' 20)
    Click-At 0.45 0.25 $false 2          # 双击 outside（根层靠上那块）
    Start-Sleep -Milliseconds 1200
    [void](Wait-Substr $w 'm5c-stray.bin' 20)
    Click-At 0.42 0.32 $true 1
    [void](Wait-Substr $w $N_ADD_TO_CLEAN 15)
    Click-At 0.27 0.40 $false 1
    Start-Sleep -Milliseconds 2500
    $txt = Joined-Text $w
    if ($txt -notmatch $S_NOT_IN_TERR) { throw "地盘外的文件没被点名退回（应该出现「不属于任何」）：$($txt.Substring(0,260))" }
    Write-Host "  ② 地盘外文件：界面念出了「不属于任何清理规则的地盘，没有进勾选」"
    # 那句排在表格下方，不滚进视野就拍照 = 拍到一张没有结论的图（本仓为这事加过"同字节即红"的闸）
    $un = Find-Substr $w $S_NOT_IN_TERR
    try { $un.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
    Start-Sleep -Milliseconds 700
    Shot (Join-Path $OutDir 'm5c-tile-unclaimed.png')

    # ---- 零删除的反证：两个文件都还在 ----
    foreach ($f in @($claimed, $stray)) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "  两个夹具文件都还在盘上（没点任何执行入口）"
    Write-Host "DONE（§12 两条分支：归属命中 + 点名退回）"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Win) { Shot (Join-Path $OutDir 'm5c-FAIL.png') } } catch { }
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
