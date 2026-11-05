# Read-only classification of the official account-independent browser bridge.
# Desktop 2.37337.1.0 installs this signed resource in ChromeNativeHost. The
# native program serves browser MCP clients over stdio/named pipes; it is not
# a Code session or the desktop account process. Keep it running across a
# Junction swap, without touching Chrome, its settings, or any traffic.
function Get-KhProgramDigest([string]$Path) {
    # .NET avoids PSModulePath differences when Node starts Windows PowerShell
    # from a PowerShell 7 parent (Get-FileHash may not auto-load there).
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Test-KhIndependentBrowserHost {
    param([string]$ImagePath, [string]$OfficialBinary, [string]$ProfileRoot, [string[]]$UserDataRoots)
    try {
        if (-not $ImagePath -or -not $OfficialBinary) { return $false }
        $image = [IO.Path]::GetFullPath($ImagePath)
        $profilePattern = [regex]::Escape([IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\'))
        $allowed = $image -match ('(?i)^' + $profilePattern + '\\[a-z][a-z0-9-]{0,31}\\ChromeNativeHost\\chrome-native-host\.exe$')
        foreach ($dataRoot in $UserDataRoots) {
            if ($image -ieq (Join-Path $dataRoot 'ChromeNativeHost\chrome-native-host.exe')) { $allowed = $true }
        }
        if (-not $allowed) { return $false }
        # Exact current-package bytes are required. A name/publisher/path alone
        # never exempts an unknown helper. Neither file is an account file.
        return (Get-KhProgramDigest $image) -eq (Get-KhProgramDigest $OfficialBinary)
    } catch { return $false }
}
Export-ModuleMember -Function Test-KhIndependentBrowserHost
