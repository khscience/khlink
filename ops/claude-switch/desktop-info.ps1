$ErrorActionPreference = 'Stop'
$package = @(Get-AppxPackage -Name Claude)
if ($package.Count -eq 0) { [Console]::Error.WriteLine('{"code":"claude_not_installed"}'); exit 1 }
if ($package.Count -ne 1) { throw 'Official Claude Desktop MSIX installation is ambiguous.' }
$exe = Join-Path $package[0].InstallLocation 'app\Claude.exe'
$root = 'G:\Apps\ClaudeSwitch\profiles\'
$virtual = (Join-Path $env:APPDATA 'Claude') + '\'
$msix = (Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude') + '\'
$processes = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq $exe -or ($_.ExecutablePath -and (
        $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
        $_.ExecutablePath.StartsWith($virtual, [StringComparison]::OrdinalIgnoreCase) -or
        $_.ExecutablePath.StartsWith($msix, [StringComparison]::OrdinalIgnoreCase)))
})
# Process identity and official program bytes only. No command line,
# environment, auth file, browser profile or native-messaging traffic.
Import-Module (Join-Path $PSScriptRoot 'browser-host.psm1') -Force
$officialBridge = Join-Path $package[0].InstallLocation 'app\resources\chrome-native-host.exe'
$browserHelpers = @($processes | Where-Object { $_.Name -ieq 'chrome-native-host.exe' })
$independent = @($browserHelpers | Where-Object {
    Test-KhIndependentBrowserHost -ImagePath $_.ExecutablePath -OfficialBinary $officialBridge -ProfileRoot $root -UserDataRoots @($virtual.TrimEnd('\'), $msix.TrimEnd('\'))
})
$independentIds = @($independent | ForEach-Object { $_.ProcessId })
[ordered]@{ version=[string]$package[0].Version; executable=$exe;
    desktopPids=@($processes | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object { [int]$_.ProcessId });
    # Older installed orchestrators read this field as a blocking count.
    browserHelperCount=($browserHelpers.Count - $independent.Count);
    browserHelperObservedCount=$browserHelpers.Count;
    browserHelperBlockingCount=($browserHelpers.Count - $independent.Count);
    independentBrowserHelperCount=$independent.Count;
    helperCount=@($processes | Where-Object { $_.ExecutablePath -ne $exe -and $_.ProcessId -notin $independentIds }).Count
} | ConvertTo-Json -Compress
