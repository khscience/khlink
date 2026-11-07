# Registers, starts, stops or removes the bundled khLink connector task.
#
# The combined desktop installer copies this script next to the bundled Node
# runtime and connector, then calls it from NSIS. It is also usable by hand:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File connector-task.ps1 -Action install
#   powershell -NoProfile -ExecutionPolicy Bypass -File connector-task.ps1 -Action remove
#
# The connector runs as the current user in an interactive scheduled task, with
# normal priority (5). Auto-start is enabled by the combined installer; pass
# -NoAutoStart to register a demand-only task.
param(
  [ValidateSet('install', 'start', 'stop', 'remove')][string]$Action = 'install',
  [string]$TaskName = 'FengzhuAgentBridge',
  [string]$ConnectorDir = $PSScriptRoot,
  [switch]$NoAutoStart,
  [switch]$NoStart,
  [switch]$NoMcpInstall
)
$ErrorActionPreference = 'Stop'
$ConnectorDir = [System.IO.Path]::GetFullPath($ConnectorDir)
$node = Join-Path $ConnectorDir 'node.exe'
$cli = Join-Path $ConnectorDir 'src\cli.js'
$log = Join-Path $env:TEMP 'khlink-connector-task.log'

function Write-Log([string]$message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $message
  Write-Output $line
  Add-Content -Path $log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Get-NodeProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ConnectorDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
}

function Stop-Processes([object[]]$processes) {
  foreach ($process in $processes) {
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop; Write-Log ("stopped pid {0}" -f $process.ProcessId) }
    catch { Write-Log ("could not stop pid {0}: {1}" -f $process.ProcessId, $_.Exception.Message) }
  }
}

# VBScript actually runs here: the engine can be missing even where
# wscript.exe exists (a Windows feature that newer installs no longer have).
function Test-VbScript {
  $probe = Join-Path $env:TEMP ("khlink-vbs-{0}.vbs" -f [guid]::NewGuid().ToString('N'))
  try {
    Set-Content -Path $probe -Value 'WScript.Quit 7' -Encoding ASCII
    $p = Start-Process (Join-Path $env:SystemRoot 'System32\cscript.exe') -ArgumentList '//NoLogo', '//B', "`"$probe`"" -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
    return $p.ExitCode -eq 7
  } catch { return $false } finally { Remove-Item $probe -Force -ErrorAction SilentlyContinue }
}

function Stop-Bundled {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  Stop-Processes @(Get-NodeProcesses)
  Start-Sleep -Milliseconds 800
  # A supervisor can restart its child immediately after the first pass.
  Stop-Processes @(Get-NodeProcesses)
  # Helpers started from the connector folder (the desktop adapter) would keep
  # their files locked while the connector code is replaced.
  $prefix = $ConnectorDir.TrimEnd('\') + '\'
  Stop-Processes @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

# Stop the previous separate connector (its task points at a source checkout or
# an older install path) before the bundled task takes over. This is what makes
# an in-place upgrade from the two-install setup work.
function Stop-Legacy {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { return }
  $paths = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
  foreach ($taskAction in @($task.Actions)) {
    $arguments = [string]$taskAction.Arguments
    $match = [regex]::Match($arguments, '"([^"]*cli\.js)"')
    if (-not $match.Success) { $match = [regex]::Match($arguments, '(\S*cli\.js)') }
    if ($match.Success) {
      $path = $match.Groups[1].Value
      [void]$paths.Add($path)
      $dir = Split-Path (Split-Path $path -Parent) -Parent
      if ($dir) { [void]$paths.Add($dir) }
    }
  }
  if ($paths.Count -eq 0) { return }
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null } catch {}
  $candidates = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $line = [string]$_.CommandLine
      if (-not $line) { return $false }
      foreach ($path in $paths) { if ($line.IndexOf($path, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }
      return $false
    }
  Stop-Processes @($candidates)
  Start-Sleep -Milliseconds 800
  Write-Log ("stopped previous connector paths: {0}" -f (($paths | Sort-Object) -join '; '))
}

switch ($Action) {
  'stop' {
    Stop-Bundled
    Write-Log 'connector stopped'
  }
  'remove' {
    Stop-Bundled
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Write-Log 'scheduled task removed' }
    catch { Write-Log ("scheduled task was not registered: {0}" -f $_.Exception.Message) }
  }
  'start' {
    if (-not (Test-Path $node)) { throw "bundled node.exe is missing: $node" }
    if (-not (Test-Path $cli)) { throw "connector cli.js is missing: $cli" }
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Log 'connector task started'
  }
  'install' {
    if (-not (Test-Path $node)) { throw "bundled node.exe is missing: $node" }
    if (-not (Test-Path $cli)) { throw "connector cli.js is missing: $cli" }
    Stop-Legacy
    Stop-Bundled
    # node.exe is a console program: started straight from an interactive task
    # it opens a console window at every logon. The launcher runs it hidden and
    # passes its exit code back, so restart-on-failure still works.
    $launcher = Join-Path $ConnectorDir 'run-program-hidden.vbs'
    $conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
    # The installer (32-bit NSIS) runs a 32-bit PowerShell, whose System32 is
    # redirected to SysWOW64, where conhost.exe does not exist. Check the real
    # 64-bit folder; the task itself runs 64-bit and uses the System32 path.
    $conhostCheck = $conhost
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
      $conhostCheck = Join-Path $env:SystemRoot 'Sysnative\conhost.exe'
    }
    if ((Test-Path $launcher) -and (Test-VbScript)) {
      $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
      $taskAction = New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}" "{1}" "{2}" "{3}" start --codex-host' -f $launcher, $ConnectorDir, $node, $cli) -WorkingDirectory $ConnectorDir
    } elseif (Test-Path $conhostCheck) {
      # Windows without VBScript (it is being removed from Windows 11): a
      # headless console host hides node's window instead. wscript showed
      # "no script engine for .vbs" and the connector never started.
      $taskAction = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "{0}" "{1}" start --codex-host' -f $node, $cli) -WorkingDirectory $ConnectorDir
    } else {
      $taskAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" start --codex-host' -f $cli) -WorkingDirectory $ConnectorDir
    }
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    if ($NoAutoStart) {
      $settings = New-ScheduledTaskSettingsSet -RestartCount 0 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 5
      $triggers = @()
    } else {
      $settings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Priority 5
      $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650))
      )
    }
    $register = @{ TaskName = $TaskName; Action = $taskAction; Settings = $settings; Principal = $principal; Description = 'khLink background connector'; Force = $true }
    if (@($triggers).Count -gt 0) { $register.Trigger = $triggers }
    Register-ScheduledTask @register | Out-Null
    Write-Log ("scheduled task registered: {0} -> {1}" -f $TaskName, $cli)
    # The Codex MCP entry is optional; keep a missing Codex from failing install.
    if (-not $NoMcpInstall) {
      # Node prints warnings on stderr; with 'Stop' Windows PowerShell turns the
      # first one into an exception and the entry was never written.
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & $node $cli mcp-install 2>&1 | ForEach-Object { Write-Log ("mcp-install: {0}" -f $_) }
        if ($LASTEXITCODE -ne 0) { Write-Log ("mcp-install skipped: exit code {0}" -f $LASTEXITCODE) }
      } catch { Write-Log ("mcp-install skipped: {0}" -f $_.Exception.Message) }
      finally { $ErrorActionPreference = $previousPreference }
    }
    if (-not $NoStart) {
      Start-ScheduledTask -TaskName $TaskName
      Write-Log 'connector task started'
    }
  }
}
