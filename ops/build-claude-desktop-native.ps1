# Compile at build time using the .NET Framework compiler, for Windows
# PowerShell 5.1 compatibility. Never compile inside a live send operation.
# After reviewing a rebuilt assembly, update the pinned SHA-256 in
# fengzhu-connect/scripts/claude-desktop-native.ps1 together with the binary.
param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -OutputPath $OutputPath
  exit $LASTEXITCODE
}
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'fengzhu-connect\native\claude-desktop-native.cs'
if (-not $OutputPath) { $OutputPath = Join-Path $root 'fengzhu-connect\bin\khlink-claude-desktop-native-v1.dll' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'Output exists; choose a new output path and compare before replacing the packaged assembly.' }
Add-Type -Path $source -OutputAssembly $OutputPath -OutputType Library
Write-Output ('Built: ' + $OutputPath)
Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256 | Select-Object Hash
