# Claude Desktop's "Trust this workspace?" dialog, through UI Automation on the
# app's own controls. It comes up when a session (often one Claude starts
# itself) opens a folder Claude has not trusted yet, and waits on the computer.
#
#   -Action inspect                      -> {ok, folder} while the dialog is up
#   -Action trust|cancel -ExpectFile <the folder the phone showed>
#
# Safety: the dialog must name exactly the folder the phone showed, otherwise
# nothing is touched. Afterwards the dialog must be gone. No keystrokes.
# Output: one JSON line {ok, reason?, folder?}.
param(
  [ValidateSet('inspect', 'trust', 'cancel')][string]$Action = 'inspect',
  [string]$ExpectFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$UIA = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
function Out-Result($ok, $reason, $folder = $null) { [Console]::Out.WriteLine((@{ ok = $ok; reason = $reason; folder = $folder } | ConvertTo-Json -Compress)); exit 0 }
$key = { param($p) ([string]$p).Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant() }

function Get-Dialog {
  $proc = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $proc) { return $null }
  $win = $UIA::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $CT::Window)),
    (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, 'Trust this workspace?')))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
# The folder line: the dialog's one text that is a Windows path.
function Get-Folder($dialog) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $CT::Text)
  $paths = @($dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -match '^[A-Za-z]:\\|^\\\\' })
  if ($paths.Count -eq 1) { return $paths[0] } else { return $null }
}
function Get-Button($dialog, $name) {
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $CT::Button)),
    (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $name)))
  return $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

try {
  $dialog = Get-Dialog
  if (-not $dialog) { Out-Result $false 'prompt_not_found' }
  $folder = Get-Folder $dialog
  if (-not $folder) { Out-Result $false 'folder_not_found' }
  if ($Action -eq 'inspect') { Out-Result $true $null $folder }

  $expected = if ($ExpectFile) { [IO.File]::ReadAllText($ExpectFile, [Text.Encoding]::UTF8) } else { '' }
  if (-not $expected) { Out-Result $false 'nothing_to_verify' }
  if ((& $key $folder) -ne (& $key $expected)) { Out-Result $false 'prompt_mismatch' $folder }
  $button = Get-Button $dialog $(if ($Action -eq 'trust') { 'Trust workspace' } else { 'Cancel' })
  if (-not $button -or -not $button.Current.IsEnabled) { Out-Result $false 'button_not_found' $folder }
  $id = $dialog.GetRuntimeId()
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $now = Get-Dialog
    if (-not $now -or -not [System.Windows.Automation.Automation]::Compare($now.GetRuntimeId(), $id)) { Out-Result $true $null $folder }
  }
  Out-Result $false 'prompt_still_open' $folder
} catch {
  Out-Result $false 'script_failed'
}
