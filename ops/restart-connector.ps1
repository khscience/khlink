# Restarts the KH Link connector (scheduled task FengzhuAgentBridge) and
# waits until it is back on the relay.
#
# Soft (default when the connector runs under its supervisor, 0.2.30+): only
# the connector process is replaced. The supervisor keeps the task running,
# so the Codex host and a turn started from the phone carry on, and the new
# connector takes the host over. Afterwards Codex hosts left over from
# earlier (not the one in use, running nothing) are stopped.
#
# -Full (or no supervisor yet): the whole process tree goes: the connector,
# its Codex host and the host's codex app-server, which ends a phone turn.
# Killing only the node processes leaves the app-server holding Codex's state
# database for a while, and the next one then fails with "failed to
# initialize sqlite state runtime".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\restart-connector.ps1 [-Full]
param([int]$TimeoutSeconds = 120, [switch]$Full)
$ErrorActionPreference = 'Stop'
$task = 'FengzhuAgentBridge'
$dataDir = Join-Path $env:APPDATA 'FengzhuAgentBridge'
$log = Join-Path $dataDir ("logs\connector-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Connector-Processes {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'fengzhu-connect' }
}

function Restart-Once {
  $before = if (Test-Path $log) { (Get-Content $log -Encoding UTF8).Count } else { 0 }
  try { Stop-ScheduledTask -TaskName $task -ErrorAction Stop } catch {}
  $pids = @(Connector-Processes | ForEach-Object { $_.ProcessId })
  # A child may already be gone with its parent; taskkill then just complains.
  foreach ($p in $pids) { & cmd.exe /c "taskkill /PID $p /T /F >nul 2>&1" }
  # Let the app-servers release their files before the next one starts.
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and @(Connector-Processes).Count) { Start-Sleep -Milliseconds 300 }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path $log)) { continue }
    $new = @(Get-Content $log -Encoding UTF8 | Select-Object -Skip $before)
    $connected = $new | Where-Object { $_ -match 'relay connected' } | Select-Object -Last 1
    if ($connected) { return "online: $connected" }
    $failed = $new | Where-Object { $_ -match 'exit code=|did not become ready' } | Select-Object -Last 1
    if ($failed) { return "failed: $failed" }
  }
  return "timed out after $TimeoutSeconds s waiting for the relay"
}

# Soft: the old connector leaving says "exit code=0" by design; only a
# non-zero exit (or a host that never came up) is a failure.
function Wait-Online($before, [switch]$Soft) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Test-Path $log)) { continue }
    $new = @(Get-Content $log -Encoding UTF8 | Select-Object -Skip $before)
    $connected = $new | Where-Object { $_ -match 'relay connected' } | Select-Object -Last 1
    if ($connected) { return "online: $connected" }
    $pattern = if ($Soft) { 'exit code=[1-9]|did not become ready' } else { 'exit code=|did not become ready' }
    $failed = $new | Where-Object { $_ -match $pattern } | Select-Object -Last 1
    if ($failed) { return "failed: $failed" }
  }
  return "timed out after $TimeoutSeconds s waiting for the relay"
}

# The supervisor is the connector process Task Scheduler started (its parent
# is the launcher); the connector proper is its child.
function Supervisor {
  $all = @(Connector-Processes | Where-Object { $_.CommandLine -match 'cli\.js' -and $_.CommandLine -match '\bstart\b' })
  foreach ($p in $all) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    $child = $all | Where-Object { $_.ParentProcessId -eq $p.ProcessId } | Select-Object -First 1
    if ($parent -and $parent.Name -in @('wscript.exe', 'conhost.exe') -and $child) { return $p }
  }
  return $null
}

function Host-Pid { try { (Get-Content (Join-Path $dataDir 'codex-host.json') -Raw | ConvertFrom-Json).pid } catch { $null } }

# Codex hosts other than the one in use, whose app-server runs nothing (only
# its own helpers): left over by an earlier replacement. Stopped with their tree.
function Remove-StrayHosts {
  $current = Host-Pid
  $all = @(Get-CimInstance Win32_Process)
  $helpers = @('conhost.exe', 'codex.exe', 'node_repl.exe', 'codex-code-mode-host.exe')
  foreach ($h in @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'codex-host\.js' -and $_.ProcessId -ne $current })) {
    $queue = @($h.ProcessId); $busy = $false
    while ($queue.Count) {
      $id = $queue[0]; $queue = @($queue | Select-Object -Skip 1)
      foreach ($k in @($all | Where-Object { $_.ParentProcessId -eq $id })) { if ($helpers -notcontains $k.Name) { $busy = $true }; $queue += $k.ProcessId }
    }
    if ($busy) { Write-Output "left running: Codex host $($h.ProcessId) (not the current one, but it is running something)"; continue }
    & cmd.exe /c "taskkill /PID $($h.ProcessId) /T /F >nul 2>&1"
    Write-Output "stopped a stray Codex host: $($h.ProcessId)"
  }
}

if (-not $Full -and (Supervisor)) {
  $hostBefore = Host-Pid
  $before = if (Test-Path $log) { (Get-Content $log -Encoding UTF8).Count } else { 0 }
  New-Item -ItemType File -Force -Path (Join-Path $dataDir 'reload.request') | Out-Null
  $result = Wait-Online $before -Soft
  Write-Output "soft reload: $result"
  if ($result -like 'online:*') {
    $hostAfter = Host-Pid
    Write-Output ("Codex host: " + $(if ($hostBefore -and $hostBefore -eq $hostAfter) { "kept ($hostAfter)" } else { "$hostBefore -> $hostAfter" }))
    Remove-StrayHosts
    exit 0
  }
  exit 1
}

# A start can stall without a word (seen once); one more clean try usually does it.
$result = Restart-Once
if ($result -notlike 'online:*') { Write-Output "first try: $result; trying again"; $result = Restart-Once }
Write-Output $result
if ($result -like 'online:*') { Remove-StrayHosts; exit 0 } else { exit 1 }
