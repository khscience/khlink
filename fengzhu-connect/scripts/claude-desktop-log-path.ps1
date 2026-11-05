# Read-side discovery only; no session/login file contents are opened here.
function Desktop-LogPath {
  $logs = @("$env:APPDATA\Claude\logs\main.log", "$env:LOCALAPPDATA\Claude\logs\main.log")
  # Claude Desktop 2.42304 moved out of MSIX LocalCache on 2026-10-19.
  $logs += @(Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\Claude-Data" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^claude_[\w.-]+$' } |
    ForEach-Object { Join-Path $_.FullName 'logs\main.log' })
  $logs += @(Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\Packages" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^Claude_[\w.-]+$' } |
    ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\logs\main.log' })
  @($logs | Where-Object { Test-Path -LiteralPath $_ } |
    Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending) | Select-Object -First 1
}
