# ⚠️ 这一棒已经**假绿灯**：它扫的是 test-scan-dir 这个不存在的目录 ⇒ 扫描状态 failed，
# 而脚本只 Write-Warning 一句就照常存图、照常 exit 0（第 98 行）。2026-10-16 实测复现。
# 它 10-11 那两张历史图是真扫了 `%LOCALAPPDATA%\Temp` 的（图上写着「正在重新计价」），
# 所以**旧图仍是 M3-B 的证据，但这个脚本现在产不出证据** —— 要重拍得先给它一个真存在的根。
# 另：那两张历史图是**整块桌面**（2160x1440），属泄露面，见 2026-10-16 的盘点。
# M3-B 真机预览截图验收脚本
# 启动 Tauri 应用，扫描 %TEMP%，进入垃圾清理页，截图保存

param(
    [string]$App = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Drawing

function Find-Window($name) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    return $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Find-ByName($parent, $name, [switch]$first) {
    $cond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
    if ($first) { return $parent.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond) }
    return $parent.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Invoke-Element($el) {
    if (-not $el) { throw "Element not found" }
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($pattern) { $pattern.Invoke() }
    else { throw "Element is not invokable" }
}

function Set-Text($el, $text) {
    if (-not $el) { throw "Text element not found" }
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($pattern) { $pattern.SetValue($text) }
    else { throw "Element does not support ValuePattern" }
}

function Take-Screenshot($path) {
    # 原来这张存的是**整块桌面**（2160x1440）—— 任务栏与别的窗口一起进版本库。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $path
    if (-not $info.Foreground) { throw "拍 $path 时窗口不在最前 —— 这张不能当证据" }
}

Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

# 1. 启动应用
$proc = Start-Process -FilePath $App -PassThru
Write-Host "Started app PID=$($proc.Id)"
Start-Sleep -Seconds 5

# 2. 找到窗口
$win = $null
for ($i = 0; $i -lt 30; $i++) {
    $win = Find-Window "DeepClean"
    if ($win) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $win) { throw "DeepClean window not found" }
$script:Hwnd = [System.IntPtr]::new($win.Current.NativeWindowHandle)

# 激活窗口
$win.SetFocus()
Start-Sleep -Milliseconds 500

# 3. 点击"指定位置"单选按钮
$customRadio = Find-ByName $win "指定位置" -first
if (-not $customRadio) { throw "Custom location radio not found" }
Invoke-Element $customRadio
Start-Sleep -Milliseconds 800

# 4. 在文本框中输入一个极小的测试目录，确保扫描快速完成
$testDir = "D:\DeepClean\test-scan-dir"
# 找文本框：placeholder 可能不作为 Name，找编辑控件
$edit = $null
for ($i = 0; $i -lt 20; $i++) {
    $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))
    if ($edit) { break }
    Start-Sleep -Milliseconds 200
}
if (-not $edit) { throw "Text element not found" }
Set-Text $edit $testDir
Start-Sleep -Milliseconds 300

# 5. 点击"开始深度扫描"
$scanBtn = Find-ByName $win "开始深度扫描" -first
Invoke-Element $scanBtn
Write-Host "Scanning $temp ..."

# 6. 等待扫描完成：轮询"查看扫描结果"按钮（只在扫描完成后出现）
$completed = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    $done = Find-ByName $win "查看扫描结果" -first
    if ($done) { $completed = $true; break }
}
if (-not $completed) { Write-Warning "Scan did not complete in time; proceeding anyway" }

# 7. 点击"垃圾清理"导航按钮
$cleanNav = Find-ByName $win "垃圾清理" -first
Invoke-Element $cleanNav

# 8. 等待 preview 加载完成：Loading 消失
#
# 2026-10-21 起那一格的字样从「正在重新计价」改成了「Loading」（人类伙伴要求），
# 这一行必须同步改 —— 不改它这里会白等满 60 秒，然后拍一张"可能还在计价"的图，
# 而脚本不会报错（它只是等不到就走）。那种"慢一点点"的失败最容易被人当成没事。
# 两种字样都认：这一棒可能跑在旧产物上（改了渲染端不重新 cargo build，exe 里还是旧页面）。
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $loading = Find-ByName $win "Loading" -first
    if (-not $loading) { $loading = Find-ByName $win "正在重新计价" -first }
    if (-not $loading) { break }
}

# 9. 截图
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$path = Join-Path $OutDir "m3b-preview-$ts.png"
Take-Screenshot $path

# 10. 关闭应用
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
