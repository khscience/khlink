$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw 'Official Codex Desktop is not installed.' }
$exe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$cli = Join-Path $package.InstallLocation 'app\resources\codex.exe'
if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $cli)) { throw 'Official Codex installation layout changed.' }
# Verified MSIX 26.1007.2314.0 / 26.1007.9446.0: main window is ChatGPT.exe, not the
# connector's codex.exe app-server. Return only PID and the explicit profile
# directory, never a whole process command line or environment.
$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object {
    $_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '--type='
} | ForEach-Object {
    $dir = $null
    if ($_.CommandLine -match '--user-data-dir=(?:"([^"]+)"|(\S+))') { $dir = if ($matches[1]) { $matches[1] } else { $matches[2] } }
    [pscustomobject]@{ pid = $_.ProcessId; userData = $dir }
})
[pscustomobject]@{ version = $package.Version.ToString(); executable = $exe; cli = $cli; processes = $rows } | ConvertTo-Json -Depth 4 -Compress
