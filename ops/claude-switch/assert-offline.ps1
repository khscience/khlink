param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$ActiveLink,
    [Parameter(Mandatory=$true)][string]$From,
    [Parameter(Mandatory=$true)][string]$DesktopVersion
)
$ErrorActionPreference = 'Stop'
# This local P0 tool deliberately supports only the reviewed owner setup.
if ([IO.Path]::GetFullPath($Root).TrimEnd('\') -ne 'G:\Apps\ClaudeSwitch') { throw 'Unexpected sharing root.' }
$expectedLink = Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude'
if ([IO.Path]::GetFullPath($ActiveLink) -ne $expectedLink) { throw 'Unexpected official data link.' }
if ($From -notmatch '^[a-z][a-z0-9-]{0,31}$') { throw 'Invalid profile alias.' }
$package = @(Get-AppxPackage -Name Claude)
if ($package.Count -ne 1 -or [string]$package[0].Version -ne $DesktopVersion) {
    throw 'Desktop version changed; review the Code storage format before continuing.'
}
$target = Join-Path (Join-Path $Root 'profiles') $From
$link = Get-Item -LiteralPath $ActiveLink -Force
$targets = @($link.Target) # Windows PowerShell returns an array; PowerShell 7 may return a string.
if ($link.LinkType -ne 'Junction' -or $targets.Count -ne 1 -or ([string]$targets[0]).TrimEnd('\') -ne $target) {
    throw 'Current profile does not match the requested source.'
}
$profilePrefix = (Join-Path $Root 'profiles') + '\'
$virtualPrefix = (Join-Path $env:APPDATA 'Claude') + '\'
$packagePrefix = $expectedLink + '\'
Import-Module (Join-Path $PSScriptRoot 'browser-host.psm1') -Force
$officialBridge = Join-Path $package[0].InstallLocation 'app\resources\chrome-native-host.exe'
$busy = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -like 'C:\Program Files\WindowsApps\Claude_*\app\Claude.exe' -or
    ($_.ExecutablePath -and (
        $_.ExecutablePath.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $_.ExecutablePath.StartsWith($virtualPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $_.ExecutablePath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)
    ))
} | Where-Object {
    -not (Test-KhIndependentBrowserHost -ImagePath $_.ExecutablePath -OfficialBinary $officialBridge -ProfileRoot $profilePrefix -UserDataRoots @($virtualPrefix.TrimEnd('\'),$packagePrefix.TrimEnd('\')))
})
if ($busy.Count -ne 0) { throw 'Desktop or profile helper is still running. Exit normally; never force-stop it.' }
Write-Output 'OFFLINE_OK'
