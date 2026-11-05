param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$From,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$To,
    [switch]$OwnerConfirmedExit
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
function Invoke-TrackedNode([string[]]$arguments) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $start.Arguments = ($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $child = [Diagnostics.Process]::Start($start)
    $record = @{pid=$PID;childPid=$child.Id;startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress))
    $switchLock.Position=0; $switchLock.SetLength(0); $switchLock.Write($bytes,0,$bytes.Length); $switchLock.Flush($true)
    $out=$child.StandardOutput.ReadToEndAsync(); $err=$child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    if ($child.ExitCode -ne 0) { throw 'Profile component failed.' }
    return $out.GetAwaiter().GetResult()
}
if (-not $OwnerConfirmedExit) { throw 'Obtain owner confirmation separately for this normal exit.' }
if ($From -eq $To) { throw 'Source and destination must differ.' }
function Invoke-CodeProfileSwitch {
$root = 'G:\Apps\ClaudeSwitch'
$configPath = Join-Path $root 'shared\config.json'
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.root -ne $root -or -not $config.profiles.$From -or -not $config.profiles.$To) {
    throw 'Sharing is not initialized for both profiles.'
}
$guard = Join-Path $PSScriptRoot 'assert-offline.ps1'
& $guard -Root $root -ActiveLink $config.activeLink -From $From -DesktopVersion $config.desktopVersion | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $root 'backup\20261014-2303\Claude') -PathType Container)) {
    throw 'Original backup is missing.'
}
$target = Join-Path (Join-Path $root 'profiles') $To
$targetItem = Get-Item -LiteralPath $target -Force
if (-not $targetItem.PSIsContainer -or $targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Destination profile must be an ordinary directory.'
}
# A failure here leaves the active Junction unchanged; no partially shared state
# is allowed to launch. This script never closes or launches Desktop by itself.
$node = (Get-Command node.exe -ErrorAction Stop).Source
$sync = Invoke-TrackedNode @((Join-Path $PSScriptRoot 'session-share.cjs'), 'sync', '--config', $configPath, '--from', $From, '--owner-confirmed-exit')
$syncResult = $sync | ConvertFrom-Json
$sidebar = Invoke-TrackedNode @((Join-Path $PSScriptRoot 'console.cjs'), 'sidebar-sync', $From)
$sidebarResult = $sidebar | ConvertFrom-Json
& $guard -Root $root -ActiveLink $config.activeLink -From $From -DesktopVersion $config.desktopVersion | Out-Null
Import-Module (Join-Path $PSScriptRoot 'profile-links.psm1') -Force
Switch-KhProfileLink -Root $root -Link $config.activeLink -From $From -To $To
$entry = [ordered]@{
    ChangedAt=(Get-Date -Format o); DesktopVersion=$config.desktopVersion; From=$From; To=$To
    OwnerConfirmedThisExit=$true; AllAccountProcessesExited=$true; IndependentBrowserBridgeMayRemain=$true
    PinnedSessions=$sidebarResult.pinned; SharedSessions=$syncResult.sessions; SharedTransaction=$syncResult.transaction
    TargetVerified=$true; AccountAndHistoryVerification='profile switched; see UI for current state'
}
$entry | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $root 'p0\20261014-2303\switch-history.jsonl') -Encoding UTF8
$entry | ConvertTo-Json -Compress
}
$switchLockPath = 'G:\Apps\ClaudeSwitch\shared\switch.lock'
# A stale lock is not auto-removed: first confirm no other switch is running.
$switchLock = [IO.File]::Open($switchLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$lockBytes = [Text.UTF8Encoding]::new($false).GetBytes((@{pid=$PID;startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress))
$switchLock.Write($lockBytes, 0, $lockBytes.Length)
$switchLock.Flush($true)
try { Invoke-CodeProfileSwitch }
catch { [Console]::Error.WriteLine('{"code":"component_failed"}'); exit 1 }
finally {
    $switchLock.Dispose()
    Remove-Item -LiteralPath $switchLockPath
}
