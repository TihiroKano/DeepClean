# M5-D2 真机验收：§3.6 开发环境页第一次接到真机上（探测层 + 扫描途中的模型计数）。
# **全程零删除**：这一趟只点侧栏一项、只看数字，不点任何执行入口，跑完逐名点名夹具文件还在盘上。
#
# 三个独立口径（不拿被验方自己证明被验方）：
#   ① 「装没装」→ PowerShell `Get-Command`（应用走的是 `where` 的退出码，两套不同的 API）；
#   ② 「几个权重 / 共多少字节」→ `Get-ChildItem -Include` 现走一遍盘（应用是扫描途中累加的）；
#   ③ 「分母：从多少个文件里数出来」→ `Get-ChildItem -File -Recurse | Measure-Object`。
#
# 坐标说明沿用 M5-C：WebView2 里 UIA 的 BoundingRectangle 不可信，所以「点中了没」不由像素判断，
# 由**点完之后界面必须出现的东西**判断（这里等那句「按生态分组」，它只在开发环境页出现）。
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

# 中文字面量一律由码点拼（.ps1 里的中文会被 PowerShell 5.1 按 ANSI 读成乱码）
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_PAGE_MARK      = U 0x6309,0x751F,0x6001,0x5206,0x7EC4                    # 按生态分组（只在开发环境页出现）
$T_NAV_DEVENV     = U 0x5F00,0x53D1,0x73AF,0x5883                          # 开发环境（侧栏那一项的文字）
$T_ASKING         = U 0x6B63,0x5728,0x95EE,0x8FD9,0x53F0,0x673A,0x5668      # 正在问这台机器
$T_ERR            = U 0x8BFB,0x4E0D,0x5230,0x63A2,0x6D4B,0x7ED3,0x8BA6      # 读不到探测结论
$T_MODEL_TALLY    = U 0x4E2A,0x5927,0x6A21,0x578B,0x6587,0x4EF6,0xFF08,0x5171  # 个大模型文件（共
$T_EXT_LIST       = U 0x53EA,0x6570,0x8FD9,0x4E9B,0x6269,0x5C55,0x540D,0xFF1A   # 只数这些扩展名：
$T_MEASURED_OF    = U 0x91CF,0x7684,0x662F                                  # 量的是
$T_FROM_FILES     = U 0x4E2A,0x6587,0x4EF6,0x91CC,0x6570,0x51FA,0x6765      # 个文件里数出来
$T_DETECTED       = U 0x5DF2,0x68C0,0x6D4B,0x5230                           # 已检测到
$T_NOT_DETECTED   = U 0x672A,0x68C0,0x6D4B,0x5230                           # 未检测到
$T_NEVER_PROBED   = U 0x6CA1,0x63A2,0x6D4B,0x8FC7                           # 没探测过
$T_NO_TOOL        = U 0x672A,0x68C0,0x6D4B,0x5230,0x8BE5,0x5DE5,0x5177      # 未检测到该工具
$T_NOT_SCANNED    = U 0x8FD9,0x68F5,0x6811,0x4E0A,0x6CA1,0x6709,0x5B83,0x7684,0x5730,0x76D8  # 这棵树上没有它的地盘
$T_DOCKER_RO      = U 0x53EA,0x8BFB,0x67E5,0x8BE2                            # 只读查询（Docker 行那句的开头）
$T_LEAD_DONE      = U 0x68C0,0x6D4B,0x5230                                    # 检测到（扫描状态 completed 那句的开头）
$T_CLOSE_PAREN    = U 0xFF09                                                  # ）全角右括号
$T_ROW_MAVEN      = U 0x004D,0x0061,0x0076,0x0065,0x006E,0x0020,0x4ED3,0x5E93,0x7F13,0x5B58   # Maven 仓库缓存
$T_ROW_NPM        = U 0x006E,0x0070,0x006D,0x0020,0x7F13,0x5B58             # npm 缓存

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
function Peek([string]$s, [int]$n) { if ([string]::IsNullOrEmpty($s)) { return '' }; if ($s.Length -le $n) { return $s }; return $s.Substring(0, $n) }
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "${sec}s 内没出现 '$sub'。整页文本：$(Peek (Joined-Text $root) 900)"
}
function Raise-Window([System.IntPtr]$h) {
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 400; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Ensure-OnTop([string]$why) {
    $ok = [Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    Raise-Window $script:Hwnd
    Start-Sleep -Milliseconds 350
    if (-not $ok) { throw "SetWindowPos(TOPMOST) 失败（$why）—— 不许在点不准的情况下继续" }
}
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
# 按**文字**点侧栏（不是比例坐标、更不是 dev 入口）：M5-C 那条教训 —— dev-only 的切视图入口
# 会让"真人其实进不去这一页"完全隐形。矩形不像话就直接失败，不许退化成猜一个坐标。
function Click-ByText([string]$text) {
    $el = $null
    $end = (Get-Date).AddSeconds(15)
    while (-not $el -and (Get-Date) -lt $end) {
        $el = Find-Substr $script:Win $text
        if (-not $el) { Start-Sleep -Milliseconds 300 }
    }
    if (-not $el) { throw "侧栏里没有写着「$text」的那一项" }
    $r = $el.Current.BoundingRectangle
    $w = $script:Win.Current.BoundingRectangle
    if ($r.Width -lt 20 -or $r.Height -lt 8) { throw "「$text」的矩形 $($r.Width)x$($r.Height) 不像一个能点的项" }
    if ($r.X -lt $w.X -or $r.Y -lt $w.Y -or ($r.X + $r.Width) -gt ($w.X + $w.Width)) { throw "「$text」的矩形不在这扇窗口里" }
    Ensure-OnTop "点「$text」"
    $sx = [int]($r.X + $r.Width / 2); $sy = [int]($r.Y + $r.Height / 2)
    if (-not [Native.U32]::SetCursorPos($sx, $sy)) { throw "SetCursorPos($sx,$sy) 失败" }
    Start-Sleep -Milliseconds 250
    [Native.U32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
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
# 行名后面那一段（表格单元在 DOM 序里就是 分类 / 检测 / 占用 / 动作 连着排）
function Cell-Window([string]$txt, [string]$rowName, [int]$len) {
    $i = $txt.IndexOf($rowName)
    if ($i -lt 0) { throw "页面上没有这一行：$rowName" }
    $s = $i + $rowName.Length
    if ($s -ge $txt.Length) { return '' }
    return $txt.Substring($s, [Math]::Min($len, $txt.Length - $s))
}
# 界面那个 `formatBytes`（shared/format.ts）的 PowerShell 复刻：1024 进制、非字节档一位小数。
# 用它**只为算出期望串**，比较仍拿界面文本比 —— 不是拿它替换被测方。
function Format-Dcb([long]$n) {
    if ($n -le 0) { return '0 B' }
    $units = @('B', 'KB', 'MB', 'GB', 'TB')
    $v = [double]$n; $i = 0
    while ($v -ge 1024 -and $i -lt ($units.Length - 1)) { $v = $v / 1024; $i++ }
    if ($i -eq 0) { return ([math]::Round($v)).ToString() + ' B' }
    return $v.ToString('F1') + ' ' + $units[$i]
}

try {
    # ---- 夹具：一棵小树，三个权重 + 一个 .bin 诱饵 + 两条被 redirected 的规则地盘 ----
    $R = 'D:\deepclean-fixture\m5d-scan'
    if (Test-Path $R) { Remove-Item -Recurse -Force $R }
    New-Item -ItemType Directory -Force -Path "$R\weights" | Out-Null
    New-Item -ItemType Directory -Force -Path "$R\USERPROFILE\.m2\repository\g" | Out-Null
    New-Item -ItemType Directory -Force -Path "$R\LOCALAPPDATA\npm-cache\_cacache" | Out-Null
    function Blank([int]$n) { $a = New-Object byte[] $n; for ($i = 0; $i -lt $n; $i++) { $a[$i] = [byte]($i -band 0xff) }; return $a }
    [System.IO.File]::WriteAllBytes("$R\weights\model.gguf",    (Blank 1048576))
    [System.IO.File]::WriteAllBytes("$R\weights\a.safetensors", (Blank 2097152))
    [System.IO.File]::WriteAllBytes("$R\weights\b.pt",          (Blank 524288))
    # 诱饵：`.bin` 被 V0.7 明确排除在口径外。它要是不小心被算进来，那一格就从 3.5 MB 变 7.5 MB
    [System.IO.File]::WriteAllBytes("$R\weights\data.bin",      (Blank 4194304))
    [System.IO.File]::WriteAllBytes("$R\weights\readme.txt",    (Blank 64))
    [System.IO.File]::WriteAllBytes("$R\USERPROFILE\.m2\repository\g\artifact.jar", (Blank 12288))
    [System.IO.File]::WriteAllBytes("$R\LOCALAPPDATA\npm-cache\_cacache\pack.dat",  (Blank 8192))
    # 两条被 `DC_ENV_ROOT` 指进夹具的规则地盘（npm 在 LOCALAPPDATA 下、maven 在 USERPROFILE 下）。
    # 占用那一格就该念这两个数 —— 数字的唯一来源是既有预估，不是壳层另算一遍。
    $npmTerrBytes = (Get-Item "$R\LOCALAPPDATA\npm-cache\_cacache\pack.dat").Length
    $mvnTerrBytes = (Get-Item "$R\USERPROFILE\.m2\repository\g\artifact.jar").Length
    Write-Host "  夹具：三个权重 + 一个 4 MB 的 data.bin 诱饵（期望值一律到独立口径那一段才算出来）"

    # ---- 独立口径①：这台机器上到底有哪些命令（PowerShell 的 Get-Command，不是应用的 where） ----
    $tools = [ordered]@{ npm = 'npm'; pip = 'pip'; pip3 = 'pip3'; mvn = 'mvn'; gradle = 'gradle'; docker = 'docker' }
    $oracle = @{}
    foreach ($k in $tools.Keys) {
        $hit = Get-Command -Name $tools[$k] -ErrorAction SilentlyContinue
        $oracle[$k] = [bool]$hit
    }
    Write-Host "  Get-Command 口径：$(($oracle.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')"

    # ---- 独立口径②③：这棵树上的权重与文件总数 ----
    $inc = @('*.safetensors', '*.gguf', '*.ckpt', '*.pt', '*.pth', '*.onnx', '*.h5', '*.tflite')
    $tally = Get-ChildItem -Path $R -Recurse -File -Include $inc | Measure-Object -Property Length -Sum
    $allFiles = (Get-ChildItem -Path $R -Recurse -File | Measure-Object).Count
    # 期望值**直接取独立口径那份**（不是把上面那几个 Blank 的字节数手加一遍）：
    # 但前提数要点名 —— 夹具摆错了（比如权重落到了 -Include 够不着的地方）必须当场失败，
    # 不能让"两边都数出 0"冒充一致。
    if ($tally.Count -ne 3) { throw "夹具该有 3 个权重，Get-ChildItem 数出 $($tally.Count) 个" }
    if ($allFiles -lt 7) { throw "夹具该有 7 个文件，实际 $allFiles 个" }
    Write-Host "  Get-ChildItem 口径：权重 $($tally.Count) 个 / $($tally.Sum) 字节；全树文件 $allFiles 个"

    # ---- 起应用：DC_ENV_ROOT 把规则领地指到夹具下（debug 构建独有），DC_AUTOSCAN 扫同一棵 ----
    $env:DC_ENV_ROOT = $R
    $env:DC_AUTOSCAN = $R
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
    [void](Wait-Substr $w $R 150)
    Write-Host "  扫描跑完（面包屑里有这棵根）"

    # ---- ① 按文字点侧栏「开发环境」，并证明视图真的换过去了 ----
    Click-ByText $T_NAV_DEVENV
    [void](Wait-Substr $w $T_PAGE_MARK 40)
    # 「按生态分组」是页头介绍，先于数据渲染；那一趟探测（11 次 `where` + 1 次 docker df）还没回来时
    # 界面念的是「正在问这台机器…」。所以这里**轮询到那句话消失**，不是抓到页面就算数 ——
    # 第一版直接在下一行判定，红在"还停在正在问"上（那是判据的时序错，不是应用的错）。
    $settled = $false
    $end2 = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $end2) {
        $txt = Joined-Text $w
        if ($txt.Contains($T_ERR)) { throw "界面念的是错误那一句：$(Peek $txt 900)" }
        if (-not $txt.Contains($T_ASKING)) { $settled = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $settled) { throw "40s 了还停在「$T_ASKING…」：命令没回或回得比超时慢 —— $(Peek $txt 900)" }
    Write-Host "  ① 侧栏点进去了（「$T_PAGE_MARK」这一句只在开发环境页出现），探测那一趟也回来了"

    # ---- ② 模型计数那一格：与 Get-ChildItem 口径逐项对 ----
    $tallyEl = Wait-Substr $w $T_MODEL_TALLY 20
    $txt = Joined-Text $w
    $wantModelBytes = [long]$tally.Sum
    $expectMB = Format-Dcb $wantModelBytes
    # 整句是「检测到 3 个大模型文件（共 3.5 MB）」：开头那个词**跟着扫描状态走**，扫完必须是「检测到」
    $want = "$T_LEAD_DONE $($tally.Count) $T_MODEL_TALLY $expectMB$T_CLOSE_PAREN"
    $line = $tallyEl.Current.Name
    if (-not $line.Contains($want)) { throw "模型计数那句对不上（要「$want」）：$line" }
    $i = $txt.IndexOf($T_EXT_LIST); if ($i -lt 0) { throw "没有「$T_EXT_LIST」那句口径声明" }
    $j = $txt.IndexOf($T_MEASURED_OF, $i); if ($j -lt 0) { throw "口径那句后面没有「$T_MEASURED_OF」" }
    $extSeg = $txt.Substring($i, $j - $i)
    if ($extSeg -match '\.bin') { throw "口径名单里出现了 .bin（V0.7 明令排除）：$extSeg" }
    if ($extSeg -notmatch '\.gguf') { throw "口径名单里没有 .gguf：$extSeg" }
    if ($txt -notmatch [regex]::Escape("量的是 $R")) { throw "没有点名「量的是 $R 这棵树」：$extSeg" }
    if ($txt -notmatch [regex]::Escape("$allFiles $T_FROM_FILES")) { throw "分母那句对不上（要 $allFiles 个文件）：$txt" }
    Write-Host "  ② 模型计数与独立口径一致：3 个 / $expectMB，分母 $allFiles 个，名单不含 .bin"

    # ---- ③ 装没装：逐行与 Get-Command 对照（两套不同 API） ----
    foreach ($pair in @(@( $T_ROW_MAVEN, 'mvn' ), @( $T_ROW_NPM, 'npm' ))) {
        $row = $pair[0]; $tool = $pair[1]
        $win2 = Cell-Window $txt $row 48
        $state = if ($oracle[$tool]) { 'detected' } else { 'not-detected' }
        if ($oracle[$tool]) {
            if ($win2 -notmatch $T_DETECTED) { throw "Get-Command 说 $tool 在，这一行却没念「$T_DETECTED」：$win2" }
            # 占用那一句必须等于夹具里那一条地盘的字节数（格式化成界面那一档）。
            # 这是 `bytes_by_rule` 那条运输线的真机证据：数字来自既有预估，不是壳层另算的。
            $wantBytes = if ($tool -eq 'npm') { $npmTerrBytes } else { $mvnTerrBytes }
            $wantTxt = Format-Dcb $wantBytes
            if ($win2 -notmatch [regex]::Escape($wantTxt)) { throw "$tool 行的占用格不是「$wantTxt」：$win2" }
            Write-Host "  ③ $row：两边都说装过，占用格 = $wantTxt（与夹具地盘一致）"
        } else {
            if ($win2 -notmatch $T_NOT_DETECTED -and $win2 -notmatch $T_NEVER_PROBED) {
                throw "Get-Command 说 $tool 不在，这一行既没念「$T_NOT_DETECTED」也没念「$T_NEVER_PROBED」：$win2"
            }
            # 未装那一格的占用必须是那句话，**不许是一个 0**
            if ($win2 -notmatch $T_NO_TOOL -and $win2 -notmatch $T_NOT_SCANNED) {
                throw "未装那行的占用格没有落到那两句话之一：$win2"
            }
            # 「0 B」必须单独挡一下：`formatBytes(0)` 交出的就是这两个字符，而 `12.0 KB` / `120 B`
            # 都不该被这条误伤，所以判据写成一个**独立的 0**后跟可选空格再跟 B
            if ($win2 -match '(^|\s)0\s?B(\s|$)') { throw "未装那行出现了 0 B（把没问过错报成没有）：$win2" }
            Write-Host "  ③ $row：两边都没检测到，占用格没塌成 0 B"
        }
    }

    # ---- ④ Docker 那一行：只读，且 DeepClean 不代它清理 ----
    if ($txt -notmatch $T_DOCKER_RO) { throw "页面上没有 Docker 行那句「$T_DOCKER_RO…」" }
    Write-Host "  ④ Docker 行是那句只读文案（这一格来自真起一次 docker df 的分类结果）"

    Shot (Join-Path $OutDir 'm5d-devenv-page.png')

    # ---- ⑤ 把口径那两行滚进视野再补一张（截图只拍得到视口，拍半截 = 一张没有结论的图） ----
    $ext = Find-Substr $w $T_EXT_LIST
    if ($ext) {
        try { $ext.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
        Start-Sleep -Milliseconds 700
        Shot (Join-Path $OutDir 'm5d-devenv-caliber.png')
    }

    # ---- 零删除的反证：六个夹具文件一个都没少，而且全程没点过任何执行入口 ----
    foreach ($f in @("$R\weights\model.gguf", "$R\weights\a.safetensors", "$R\weights\b.pt",
                     "$R\weights\data.bin", "$R\USERPROFILE\.m2\repository\g\artifact.jar",
                     "$R\LOCALAPPDATA\npm-cache\_cacache\pack.dat")) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "  六个夹具文件都还在盘上（这一棒一行删除代码都没加，也没点任何执行入口）"
    Write-Host "DONE（§3.6 接到真机：模型计数 + 装没装 + Docker 三格）"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Win) { Shot (Join-Path $OutDir 'm5d-FAIL.png') } } catch { }
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
