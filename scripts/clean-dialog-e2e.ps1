# 一键清理弹窗的真机验收（2026-10-24）。
#
# 走 **debug 构建**：release 拿不到 DC_ENV_ROOT（`#[cfg(debug_assertions)]`），
# 规则领地会指到真实用户路径 —— 那不是本棒要碰的。debug 版有同一套 DC_ENV_ROOT 口子，
# 把 TEMP 等五键指进靶场，windows-temp 只认领靶场里那几个种子文件。
#
# 判据四条，每条都独立可证：
#   ① 弹窗出现且列表逐条滚出来（CDP 采样行数从 0 涨到 >0）；
#   ② 「清理完成」出现，且那句说得出释放了多少字节；
#   ③ **独立口径**：进程退出后数靶场文件 —— 5 个种子该是 0；
#   ④ 记录页（账本）里有这一行（任务 id 前缀 `auto-`）。
param(
    [string]$App    = 'D:\DeepClean\src-tauri\target\debug\deepclean-app.exe',
    [int]$Port      = 9231
)
$ErrorActionPreference = 'Stop'

# 靶场路径含中文 —— 按码点拼（PS 5.1 无 BOM 时按 ANSI 读字面量）。
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_DEL = U 0x5220, 0x9664, 0x6D4B, 0x8BD5            # 删除测试
$target = Join-Path $env:USERPROFILE ("Desktop\DeepClean" + $T_DEL + "\target")
if (-not (Test-Path $target)) { throw "授权靶场不存在：$target" }
$envroot = Join-Path $target "envroot"
$scratch = Join-Path $envroot "TEMP"

# ---- 造种子：5 个 8 KiB 文件 ----
if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
1..5 | ForEach-Object {
    [System.IO.File]::WriteAllBytes((Join-Path $scratch ("clean-dialog-{0}.tmp" -f $_)), (New-Object byte[] 8192))
}
$before = @(Get-ChildItem $scratch -File).Count
Write-Host "seeded $before files -> $scratch"
if ($before -ne 5) { throw "种子没造齐（$before ≠ 5）" }

# ---- 起 debug 应用（DC_ENV_ROOT 重定向 + CDP 端口）----
if (-not (Test-Path $App)) { throw "应用产物不存在：$App（先 cargo build）" }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $envroot
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($proc.Id)"
$script:Proc = $proc

try {
    node (Join-Path $PSScriptRoot 'clean-dialog-e2e.mjs') --port $Port --root $envroot --out 'D:\dc-tmp\clean-dialog.json'
    if ($LASTEXITCODE -ne 0) { throw "驱动段失败（退出码 $LASTEXITCODE）" }
    Write-Host "DRIVER_OK"
}
finally {
    if (-not $proc.HasExited) {
        # 关掉应用：弹窗本身不拦截进程级关闭，这里直接停进程
        $proc.Kill()
        $proc.WaitForExit(5000) | Out-Null
    }
}

# ---- 独立口径：种子真的没了 ----
$after = @(Get-ChildItem $scratch -File -ErrorAction SilentlyContinue).Count
Write-Host "after: $after files"
if ($after -ne 0) { throw "清理后靶场还剩 $after 个文件 —— 删除链没走通" }
Write-Host "E2E_OK"
