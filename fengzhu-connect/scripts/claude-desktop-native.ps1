# Initialisation only. No navigation, input, credential access or compilation.
# All callers load this before touching a window, so failure is safely not_sent.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Initialize-KhClaudeDesktopNative {
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing -ErrorAction Stop
    # Load the bundled bytes without CodeDOM or a compiler subprocess. This
    # also avoids .NET Framework assigning a network zone to a local install
    # path (observed on this machine's fixed I: drive, without Zone.Identifier).
    $assemblyPath = Join-Path $PSScriptRoot '..\bin\khlink-claude-desktop-native-v1.dll'
    $bytes = [IO.File]::ReadAllBytes($assemblyPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($hash -ne 'b66933297a150f60a5b8bf2dbe2811110cd710fdce3a7152f65bcc96fc1402b9') { return $false }
    [Reflection.Assembly]::Load($bytes) | Out-Null
    return $true
  } catch {
    return $false
  }
}

# Get-Process.MainWindowHandle can point at Electron's untitled tooltip after
# hovering a file/approval (reproduced on Desktop 2.42304). Match the official
# app process and its named top-level window instead; never type into a popup.
function Select-KhClaudeDesktopWindow($processes, $windows) {
  $ids = @($processes | Where-Object { $_.Path -like '*\WindowsApps\Claude_*\*' } | ForEach-Object { $_.Id })
  $matches = @($windows | Where-Object {
    try { $c=$_.Current; $ids -contains $c.ProcessId -and $c.Name -eq 'Claude' -and $c.NativeWindowHandle -ne 0 } catch { $false }
  })
  if ($matches.Count -ne 1) { return $null }
  $current = $matches[0].Current
  return [pscustomobject]@{ Id=$current.ProcessId; MainWindowHandle=[IntPtr]$current.NativeWindowHandle }
}
function Get-KhClaudeDesktopWindow {
  $processes = @(Get-Process -Name claude -ErrorAction SilentlyContinue)
  if (-not $processes.Count) { return $null }
  # Ask Claude's own windows first. Listing every top-level window waits on
  # each one, and one slow window elsewhere (seen 2026-10-28: an editor taking
  # 5 s per property, 18-26 s per lookup) timed out every send and answer.
  $own = @($processes | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | ForEach-Object {
    try { [System.Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) } catch { $null }
  } | Where-Object { $_ })
  $picked = Select-KhClaudeDesktopWindow $processes $own
  if ($picked) { return $picked }
  # MainWindowHandle can be an Electron tooltip instead: look at them all.
  $cond =New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  return (Select-KhClaudeDesktopWindow $processes @($windows))
}
