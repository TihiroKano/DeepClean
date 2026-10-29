# M1-C 的独立口径。**不许 import 被验方的任何东西**，只用 Win32 的另一条调用路径：
#   GetFileInformationByHandleEx(FileStandardInfo) -> AllocationSize   占用大小
#   GetFileInformationByHandle                     -> 卷序列号/文件索引/硬链接数
# 于是"占用合计"与"硬链接去重"各有了第二份实现。
#
# ⚠️ 不要用 GetCompressedFileSizeW 量占用 —— 本机实测它对本夹具返回的是**逻辑大小**
#    （a.bin 5000 B 的文件返回 5000，而 NTFS 4096 簇下应报 8192），拿它当口径会得到
#    一个"看起来很对"的错数。这是本次踩到的真坑，留在这里省下一个人半天。
#
# 用法：powershell -NoProfile -File scripts/oracle-alloc.ps1 "D:\deepclean-fixture\m1-accept"
param([Parameter(Mandatory=$true)][string]$Root)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Ora {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [StructLayout(LayoutKind.Sequential)]
  public struct INFO {
    public uint FileAttributes; public long CreationTime; public long LastAccessTime; public long LastWriteTime;
    public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow;
    public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct STD {
    public long AllocationSize; public long EndOfFile; public uint NumberOfLinks;
    public byte DeletePending; public byte Directory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandle(IntPtr h, out INFO i);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, out STD s, uint sz);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}
"@

$files = 0; $dirs = 0
$logical = [uint64]0; $alloc = [uint64]0; $counted = [uint64]0
$deduped = 0; $reparse = 0; $unreadable = 0
$seen = New-Object System.Collections.Generic.HashSet[string]

# ── 自己递归，**不用 `Get-ChildItem -Recurse`** ──────────────────────────────
# 理由（2026-10-10 实测纠正）：`-Recurse` **会跟着 junction 走**，于是把目标目录的内容
# 又算了一遍 —— 而规格书第一条就是「junction / 符号链接一律不进入」（防的正是 Users /
# ProgramData 被重复计入）。C:\Program Files 实测：跟着走会多算 **1.6 GB（25%）**，
# 差异全部来自 Office App-V 的 vfs、NVIDIA 插件、Nutstore bin 这些 junction。
# 所以这里自己走，遇到带 0x400（REPARSE_POINT）位的条目**直接跳过**，与 Rust 侧同口径。
$script:reparse = 0
$script:dirs = 0
$script:files = 0
$script:logical = [uint64]0
$script:alloc = [uint64]0
$script:counted = [uint64]0
$script:deduped = 0
$script:unreadable = 0
$script:seen = New-Object System.Collections.Generic.HashSet[string]

function Walk([string]$dir) {
  # `-ErrorAction Stop` + 分桶。原来这句是 SilentlyContinue，于是 >260 那一支的枚举失败被
  # 吞成「这个目录是空的」—— 2026-10-14 实测 f100k\longpath 报 files=0 dirs=10 unreadable=0
  # 且退出码 0：一个看起来完全干净的残缺口径，比一个报错的口径危险得多。
  $items = @()
  try { $items = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop) }
  catch [System.UnauthorizedAccessException] { $script:unreadable++; return }
  catch {
    Write-Output ("ALLOC_BROKEN at=$dir :: " + $_.Exception.GetType().FullName + ' :: ' + $_.Exception.Message)
    exit 2
  }
  foreach ($i in $items) {
    if (($i.Attributes -band 0x400) -ne 0) { $script:reparse++; continue }
    if ($i.PSIsContainer) {
      $script:dirs++
      Walk $i.FullName
      continue
    }
    $h = [Ora]::CreateFileW($i.FullName, 0, 7, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
    if ($h -eq [IntPtr](-1)) { $script:unreadable++; continue }
    $info = New-Object Ora+INFO
    $std = New-Object Ora+STD
    $okI = [Ora]::GetFileInformationByHandle($h, [ref]$info)
    $okS = [Ora]::GetFileInformationByHandleEx($h, 1, [ref]$std, 24)
    [void][Ora]::CloseHandle($h)
    if (-not $okS) { $script:unreadable++; continue }

    $script:files++
    $script:logical += [uint64]$std.EndOfFile
    $a = [uint64]$std.AllocationSize
    $script:alloc += $a

    if (-not $okI) { $script:counted += $a; continue }
    $key = "$($info.VolumeSerialNumber):$($info.FileIndexHigh):$($info.FileIndexLow)"
    if ($key -eq '0:0:0') { $script:counted += $a; continue }
    if ($script:seen.Add($key)) { $script:counted += $a } else { $script:deduped++ }
  }
}

# \\?\ 前缀：本机 LongPathsEnabled=0，不带前缀这条口径会在 260 字符处**静默**停下
# （与 scripts/m6-file-oracle.ps1 同一条纪律；两边各自实现，不共享代码）。
$rootExt = $Root.TrimEnd('\')
if ($rootExt -notmatch '^[A-Za-z]:\\' -and -not $rootExt.StartsWith('\\?\')) {
  Write-Output "ALLOC_BROKEN: root 必须是盘符开头的绝对路径，收到 $Root"
  exit 2
}
if (-not $rootExt.StartsWith('\\?\')) { $rootExt = '\\?\' + $rootExt }

Walk $rootExt

$files = $script:files; $dirs = $script:dirs; $logical = $script:logical
$alloc = $script:alloc; $counted = $script:counted; $deduped = $script:deduped
$reparse = $script:reparse; $unreadable = $script:unreadable

[pscustomobject]@{
  root = (Get-Item -LiteralPath $rootExt -Force).FullName
  files = $files
  dirs = $dirs
  bytes_logical = $logical
  bytes_alloc = $alloc
  bytes_counted = $counted
  deduped_hardlinks = $deduped
  reparse_seen = $reparse
  unreadable = $unreadable
} | ConvertTo-Json -Compress
