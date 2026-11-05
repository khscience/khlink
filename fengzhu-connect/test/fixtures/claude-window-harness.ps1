param([string]$Source, [string]$Fixture)
$ErrorActionPreference='Stop'
# Dot-source definitions only. Do not initialize UIA or enumerate real windows.
. $Source
$f=ConvertFrom-Json ([IO.File]::ReadAllText($Fixture,[Text.Encoding]::UTF8))
$window=Select-KhClaudeDesktopWindow @($f.processes) @($f.windows)
if($window){ @{pid=$window.Id;handle=$window.MainWindowHandle.ToInt64()} | ConvertTo-Json -Compress }else{'null'}
