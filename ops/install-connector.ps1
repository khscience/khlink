param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  # Automatic logon/watchdog recovery is opt-in.  A demand-startable task is
  # still registered so the desktop "重新连接" action can launch it, but a
  # fresh install no longer starts a hidden connector behind the user's back.
  [switch]$EnableAutoStart
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe).Source
$cli = Join-Path $ProjectRoot 'fengzhu-connect\src\cli.js'
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" start --codex-host' -f $cli) -WorkingDirectory $ProjectRoot
# Priority 5 = normal CPU, disk and memory priority. The scheduler's default
# 7 runs below normal on all three; while the PC was busy (a video render,
# a build) the connector then waited 25+ minutes for CPU and disk.
# Automatic startup/recovery is intentionally opt-in.  With the default
# demand-only mode there are no triggers and no scheduler restart policy;
# schtasks /Run (used by the explicit UI button) still works.
$settings = if ($EnableAutoStart) {
  New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew -Priority 5
} else {
  New-ScheduledTaskSettingsSet -RestartCount 0 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Priority 5
}
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$registerArgs = @{
  TaskName = 'FengzhuAgentBridge'
  Action = $action
  Settings = $settings
  Principal = $principal
  Description = 'Hidden per-user Codex mobile connector'
  Force = $true
}
if ($EnableAutoStart) {
  # Keep the historical opt-in behavior available for dedicated machines.
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
  $registerArgs.Trigger = @($logonTrigger, $watchdogTrigger)
}
Register-ScheduledTask @registerArgs | Out-Null
& $node $cli 'mcp-install'
if ($EnableAutoStart) {
  Start-ScheduledTask -TaskName 'FengzhuAgentBridge'
  Write-Output 'FengzhuAgentBridge scheduled task installed and started with a 2-minute watchdog trigger.'
} else {
  Write-Output 'FengzhuAgentBridge scheduled task installed in demand-only mode; use the desktop button to start it.'
}
