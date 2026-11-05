# Restore only a registered, interrupted Junction transaction. Never closes
# processes, reads login material, or copies profile contents.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$repairLock = $null
$repairLockPath = 'G:\Apps\ClaudeSwitch\shared\switch.lock'
try {
    $repairLock = [IO.File]::Open($repairLockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $lockBytes = [Text.UTF8Encoding]::new($false).GetBytes((@{pid=$PID;startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()} | ConvertTo-Json -Compress))
    $repairLock.Write($lockBytes,0,$lockBytes.Length);$repairLock.Flush($true)
    $root = 'G:\Apps\ClaudeSwitch'
    $config = Get-Content -LiteralPath (Join-Path $root 'shared\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $journal = Join-Path $root 'shared\link-transaction.json'
    $tx = Get-Content -LiteralPath $journal -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude'
    if ($config.root -ne $root -or $config.activeLink -ne $expected -or $tx.from -notmatch '^[a-z][a-z0-9-]{0,31}$' -or $tx.to -notmatch '^[a-z][a-z0-9-]{0,31}$' -or -not $config.profiles.($tx.from) -or -not $config.profiles.($tx.to)) { throw 'invalid' }
    $installed = (& (Join-Path $PSScriptRoot 'desktop-info.ps1')) | ConvertFrom-Json
    if ($installed.version -ne $config.desktopVersion -or @($installed.desktopPids).Count -ne 0 -or $installed.helperCount -ne 0) { throw 'busy' }
    Import-Module (Join-Path $PSScriptRoot 'profile-links.psm1') -Force
    Restore-KhProfileLink -Root $root -Link $expected -From $tx.from -To $tx.to
    & (Join-Path $PSScriptRoot 'assert-offline.ps1') -Root $root -ActiveLink $expected -From $tx.from -DesktopVersion $config.desktopVersion | Out-Null
    [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Error.WriteLine('{"code":"link_unknown"}'); exit 1 }
finally { if ($repairLock) { $repairLock.Dispose(); Remove-Item -LiteralPath $repairLockPath } }
