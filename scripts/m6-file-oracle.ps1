#Requires -Version 5.1
<#
  M6 出包前置第 2 道闸的独立口径（files / dirs / bytes 三轴）。

  为什么不用 scripts/oracle.mjs：闸的原文点名禁止（它与被验方同口径，见
  docs 里 project-scan-total-caliber-trap 那条）。这里走 .NET 的 DirectoryInfo 枚举器，
  与被验方（Rust NtQueryDirectoryFile / FileIdBothDirectoryInformation，
  crates/scanner/src/enumerate.rs:100）和 Get-ChildItem 是三条不同的 walk。

  三条纪律，都是被实测咬过之后写在这里的：
   1. 必须带 \\?\ 前缀。本机 LongPathsEnabled=0，同一棵 f100k\longpath 子树实测
      不带前缀 Recurse 只报 10 条、带前缀报 2044 条。少了 2034 条是不出声的，
      于是「被验方多计」会被判成双计缺陷 —— 量具反过来咬一口。
   2. 工具故障与读不到必须分桶。上一版把 [IO.Directory]::GetAttributes（这方法不存在，
      抛的是 PS 绑定错误）记进 denied，于是 files=0 dirs=1 denied=15 看着像
      「15 条被拒」的合法台账。非 IO 异常一律立刻 exit 2，不许继续吐数。
   3. PathTooLongException 算工具故障不算读不到 —— 它出现就证明第 1 条失效了。

  约定（写死，不当旋钮）：dirs **含** 根自身。Rust 侧 counters.dirs 只对子目录 +1
  （scan.rs:275，根从不计入），所以比对用 scanner.dirs == oracle.dirs - 1。

  跑法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/m6-file-oracle.ps1 -Root 'D:\deepclean-fixture\f100k'
  退出码：0 完整 / 2 量具坏了（数字作废）/ 3 有读不到的桶，本次是残缺枚举。
#>
param(
    [string]$Root = 'D:\deepclean-fixture\f100k',
    [switch]$AllowDenied
)

$ErrorActionPreference = 'Stop'

function Stop-Broken {
    param([string]$Where, [string]$Detail)
    Write-Output "ORACLE root=$Root VERDICT=TOOL_BROKEN at=$Where detail=$Detail"
    exit 2
}

$r = $Root.TrimEnd('\')
if ($r -notmatch '^[A-Za-z]:\\.') { Stop-Broken 'param' "root 必须是盘符开头的绝对路径，收到 $Root" }
if (-not [IO.Directory]::Exists($r)) { Stop-Broken 'param' "根目录不存在：$r" }
$ext = if ($r.StartsWith('\\?\')) { $r } else { '\\?\' + $r }

$F_REPARSE = [IO.FileAttributes]::ReparsePoint
$F_DIR = [IO.FileAttributes]::Directory

$sw = [Diagnostics.Stopwatch]::StartNew()
$stack = New-Object 'System.Collections.Generic.Stack[string]'
$stack.Push($ext)

$files = 0
$dirs = 0
[int64]$bytes = 0
$reparseSkipped = 0
$denied = 0
$deepest = 0

while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    $dirs++
    if ($d.Length -gt $deepest) { $deepest = $d.Length }

    $kids = @()
    try { $kids = @((New-Object 'System.IO.DirectoryInfo' ($d)).EnumerateFileSystemInfos()) }
    catch [System.UnauthorizedAccessException] { $denied++; continue }
    catch [System.IO.DirectoryNotFoundException] { $denied++; continue }
    # PathTooLongException 派生自 IOException，必须排在它前面，否则会被下面那条
    # catch 当成「读不到」收进 denied —— 那正是第 1 条前缀纪律失效的样子，只能当故障。
    catch [System.IO.PathTooLongException] { Stop-Broken 'enumerate-tooLong' "$d :: $($_.Exception.Message)" }
    catch [System.IO.IOException] { $denied++; continue }
    catch { Stop-Broken 'enumerate' "$d :: $($_.Exception.GetType().FullName) :: $($_.Exception.Message)" }

    foreach ($i in $kids) {
        try {
            $at = $i.Attributes
            if (($at -band $F_REPARSE) -ne 0) { $reparseSkipped++; continue }
            if ($i.FullName.Length -gt $deepest) { $deepest = $i.FullName.Length }
            if (($at -band $F_DIR) -ne 0) {
                $stack.Push($i.FullName)
            } else {
                $files++
                $bytes += [int64]([IO.FileInfo]$i).Length
            }
        }
        catch [System.UnauthorizedAccessException] { $denied++ }
        catch [System.IO.PathTooLongException] { Stop-Broken 'entry-tooLong' "$($i.FullName) :: $($_.Exception.Message)" }
        catch [System.IO.IOException] { $denied++ }
        catch { Stop-Broken 'entry' "$($i.FullName) :: $($_.Exception.GetType().FullName) :: $($_.Exception.Message)" }
    }
}

$verdict = 'OK'
$code = 0
if ($denied -gt 0) {
    if ($AllowDenied) { $verdict = 'PARTIAL_ALLOWED' } else { $verdict = 'INCOMPLETE'; $code = 3 }
}

Write-Output ("ORACLE root=$Root VERDICT=$verdict files=$files dirs=$dirs bytes=$bytes" +
    " reparseSkipped=$reparseSkipped denied=$denied deepestPathLen=$deepest secs=$([int]$sw.Elapsed.TotalSeconds)")
if ($code -ne 0) {
    Write-Output 'ORACLE: 有目录/条目读不到 —— 残缺的口径没有资格当事实源，数字是下界。'
}
exit $code
