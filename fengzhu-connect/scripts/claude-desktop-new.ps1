# Create and start a Claude Code session through the Claude Desktop app.
#
# The Windows desktop build owns the signed-in session and injects its OAuth
# context into the Code process it starts.  Running the bundled claude.exe as
# an unrelated child cannot use that context (and correctly reports
# `loggedIn:false`), so new phone tasks use the app's official
# claude://code/new?folder=... deep link and the app's own Prompt/Send controls.
# Text is written with UI Automation; only image attachments need a foreground
# window because Windows clipboard paste is required for them.
# Output: one JSON line {ok, reason?}.
param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [string]$Folder = '',
  [string]$ImageFiles = '',
  [string]$RestoreId = '',
  [switch]$ConfirmTrust
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-desktop-native.ps1')
if (-not (Initialize-KhClaudeDesktopNative)) {
  [Console]::Out.WriteLine('{"ok":false,"reason":"adapter_init_failed","delivery":"not_sent","phase":"initialize"}')
  exit 0
}
function Out-Result($ok, $reason, $detail = $null) {
  $result = @{ ok = $ok; reason = $reason }
  if ($null -ne $detail) { $result.detail = $detail }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress)); exit 0
}
$text = if (Test-Path -LiteralPath $TextFile) { [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8) } else { '' }
$images = @($ImageFiles -split '\|' | Where-Object { $_ })
if (@($images | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) { Out-Result $false 'image_missing' }
if (-not $text.Trim() -and $images.Count -eq 0) { Out-Result $false 'empty_text' }
if ($Folder) {
  if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Out-Result $false 'folder_not_found' }
  try { $Folder = [IO.Path]::GetFullPath($Folder) } catch { Out-Result $false 'folder_not_found' }
}
if ($RestoreId -and $RestoreId -notmatch '^local_[0-9a-f-]{36}$') { $RestoreId = '' }

function Get-ClaudeWindow {
  Get-KhClaudeDesktopWindow
}
function Get-Composer {
  $proc = Get-ClaudeWindow; if (-not $proc) { return $null }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Prompt')))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
function Get-ComposerText($el) {
  try { return $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) } catch { return '' }
}
function Get-Button($name) {
  $proc = Get-ClaudeWindow; if (-not $proc) { return $null }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
function Ensure-Foreground {
  $p = Get-ClaudeWindow; if (-not $p) { return $false }
  $h = $p.MainWindowHandle
  for ($try = 0; $try -lt 3; $try++) {
    if ([KhClaudeNative]::GetForegroundWindow() -eq $h -and -not [KhClaudeNative]::IsIconic($h)) { return $true }
    if ([KhClaudeNative]::IsIconic($h)) { [KhClaudeNative]::ShowWindow($h, 9) | Out-Null }
    [KhClaudeNative]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhClaudeNative]::SetForegroundWindow($h) | Out-Null; [KhClaudeNative]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  return ([KhClaudeNative]::GetForegroundWindow() -eq $h -and -not [KhClaudeNative]::IsIconic($h))
}
function Focus-Composer($el) {
  if (-not (Ensure-Foreground)) { return $false }
  try { $el.SetFocus() } catch { return $false }
  Start-Sleep -Milliseconds 150
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $focused) { return $false }
  return [System.Windows.Automation.Automation]::Compare($focused.GetRuntimeId(), $el.GetRuntimeId()) -and ([KhClaudeNative]::GetForegroundWindow() -eq (Get-ClaudeWindow).MainWindowHandle)
}
function Set-ComposerText($value) {
  $el = Get-Composer; if (-not $el) { return $false }
  try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value) } catch { return $false }
  Start-Sleep -Milliseconds 300
  $norm = { param($t) ($t -replace "`r", '' -replace '\s+', ' ').Trim() }
  return ((& $norm (Get-ComposerText (Get-Composer))) -eq (& $norm $value))
}
function Trust-RequestedWorkspace {
  # A folder deep link can show Claude Desktop's first-use confirmation. The
  # folder in this modal is exactly the one passed by KH Link above; invoking
  # this named button is equivalent to the user pressing "Trust workspace" in
  # the new-task dialog and does not inspect credentials or project contents.
  $button = Get-Button 'Trust workspace'
  if (-not $button -or -not $button.Current.IsEnabled) { return $false }
  # Only answer the dialog that names the folder this task was asked for.
  if ($Folder -and -not (Test-TrustDialogFolder $Folder)) { return $false }
  try { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false }
}
function Test-TrustDialogFolder($wanted) {
  $proc = Get-ClaudeWindow; if (-not $proc) { return $false }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $key = { param($p) ([string]$p).Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
  $target = & $key $wanted
  foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ((& $key $el.Current.Name) -eq $target) { return $true }
  }
  return $false
}
function Get-TrustWorkspaceButton { Get-Button 'Trust workspace' }
function Get-Buttons($name) {
  $proc = Get-ClaudeWindow; if (-not $proc) { return @() }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)))
  return @($win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond))
}
function Get-FolderKey($path) { ([string]$path).Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant() }
# Claude Desktop 2.42304.2 keeps showing the trust prompt for a folder passed
# by the deep link even when it is trusted, and after it is confirmed the page
# still shows the folder but starts the session in a fresh scratch workspace
# (log: createScratchWorkspace, permission source presettle_failsafe; seen
# 2026-10-20). The sidebar's own "New session in <project>" button starts in
# the project folder (source folder_pick). Use it when the project is listed
# and the page then names exactly the requested folder.
function Open-FolderFromSidebar {
  if (-not $Folder) { return $false }
  $leaf = Split-Path -Leaf $Folder
  if (-not $leaf -or $leaf -eq 'This computer') { return $false }
  $want = Get-FolderKey $Folder
  # Two projects can share a leaf name; the folder chip tells them apart.
  foreach ($button in (Get-Buttons "New session in $leaf")) {
    try { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { continue }
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Milliseconds 250
      # An open session in the same folder shows the same chip: also require
      # the new-session page, so the text never goes into an existing session.
      if ((Get-FolderKey (Get-FolderChip)) -eq $want -and (Test-NewSessionPage)) { return $true }
    }
  }
  return $false
}
function Test-NewSessionPage {
  $proc = Get-ClaudeWindow; if (-not $proc) { return $false }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'New session')))
  return [bool]$win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
function Wait-NewSessionPage($wantKey) {
  for ($i = 0; $i -lt 16; $i++) {
    if ((Test-NewSessionPage) -and (-not $wantKey -or (Get-FolderKey (Get-FolderChip)) -eq $wantKey)) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}
function Get-FolderChip {
  $proc = Get-ClaudeWindow; if (-not $proc) { return '' }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ($el.Current.Name -like 'Folder: *') { return $el.Current.Name.Substring(8) }
  }
  return ''
}
. (Join-Path $PSScriptRoot 'claude-desktop-log-path.ps1')
# What the desktop has logged since $offset (from the start if the log rotated meanwhile).
function Read-LogSince($log, $offset) {
  if (-not $log -or -not (Test-Path $log)) { return '' }
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try {
    $start = if ($fs.Length -ge $offset) { $offset } else { 0 }
    [void]$fs.Seek($start, 'Begin'); $buf = New-Object byte[] ($fs.Length - $start); [void]$fs.Read($buf, 0, $buf.Length)
  } finally { $fs.Close() }
  return [Text.Encoding]::UTF8.GetString($buf)
}
function Finish($ok, $reason) {
  if ($RestoreId) {
    Start-Sleep -Milliseconds 600
    Start-Process "claude://claude.ai/epitaxy/$RestoreId"
    if ($wasMinimized) {
      foreach ($wait in 1500, 1200) {
        Start-Sleep -Milliseconds $wait
        $p = Get-ClaudeWindow
        if ($p -and -not [KhClaudeNative]::IsIconic($p.MainWindowHandle)) { [KhClaudeNative]::ShowWindow($p.MainWindowHandle, 6) | Out-Null }
      }
    }
  }
  Out-Result $ok $reason
}

$wasMinimized = $false
$proc = Get-ClaudeWindow
if (-not $proc) { Out-Result $false 'desktop_not_running' }
if ([KhClaudeNative]::IsIconic($proc.MainWindowHandle)) { $wasMinimized = $true; [KhClaudeNative]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null; Start-Sleep -Milliseconds 500 }

# `folder` is the documented Claude Desktop Code deep-link parameter. It keeps
# the task in the same local workspace the phone selected without touching the
# desktop app's account or credential store.
$query = if ($Folder) { "?folder=$([uri]::EscapeDataString($Folder))" } else { '?source=khlink' }
# The composer on screen before the link opens belongs to whatever session the
# user is looking at; the text must never go there. Remember it to tell the
# new-task page apart.
function Get-ComposerId($el) { if (-not $el) { return '' }; try { return ($el.GetRuntimeId() -join '.') } catch { return '' } }
$oldComposerId = Get-ComposerId (Get-Composer)
$sawTrustPrompt = $false
$trustMisses = 0
# A project already in the sidebar opens from there (no trust prompt, right
# folder); a first-time folder still goes through the deep link and its prompt.
$viaSidebar = (-not (Get-TrustWorkspaceButton)) -and (Open-FolderFromSidebar)
# Open the link unless its trust prompt is already up (an older phone build
# confirms a prompt the first pass left open).
if (-not $viaSidebar -and -not ($ConfirmTrust -and (Get-TrustWorkspaceButton))) {
  try { Start-Process "claude://code/new$query" } catch { Finish $false 'desktop_not_running' }
}

$composer = $null
for ($i = 0; $i -lt 120 -and -not $composer; $i++) {
  Start-Sleep -Milliseconds 250
  $trustButton = Get-TrustWorkspaceButton
  if ($trustButton) {
    $sawTrustPrompt = $true
    # The trust prompt grants Claude permission to load and execute project
    # configuration/hooks. KH Link answers it only with -ConfirmTrust and only
    # for the requested folder; otherwise the phone user is asked.
    if (-not $ConfirmTrust) { Out-Result $false 'trust_required' @{ folder = $Folder } }
    # The dialog renders its button and folder line over a few frames: keep
    # looking for up to 3 s before handing the decision to the phone.
    if (Trust-RequestedWorkspace) { Start-Sleep -Milliseconds 500 }
    elseif (++$trustMisses -ge 12) { Out-Result $false 'trust_required' @{ folder = $Folder } }
    else { continue }
  }
  $composer = Get-Composer
  # Still the old session's composer: the new-task page has not opened yet.
  # (The sidebar path already checked the new page's folder chip.)
  if ($composer -and -not $viaSidebar -and -not $sawTrustPrompt -and $oldComposerId -and (Get-ComposerId $composer) -eq $oldComposerId) { $composer = $null }
}
# The renderer can expose the underlying composer a moment before the modal
# is attached. Check again so timing cannot turn a trust prompt into a paste.
$trustButton = Get-TrustWorkspaceButton
if ($trustButton) {
  if (-not $ConfirmTrust) { Out-Result $false 'trust_required' @{ folder = $Folder } }
  if (Trust-RequestedWorkspace) { Start-Sleep -Milliseconds 500 } else { Out-Result $false 'trust_required' @{ folder = $Folder } }
  $composer = Get-Composer
}
if (-not $composer) { Finish $false 'composer_not_found' }
Start-Sleep -Milliseconds 500
$composer = Get-Composer
$trustButton = Get-TrustWorkspaceButton
if ($trustButton) {
  if (-not $ConfirmTrust) { Out-Result $false 'trust_required' @{ folder = $Folder } }
  if (Trust-RequestedWorkspace) { Start-Sleep -Milliseconds 500 } else { Out-Result $false 'trust_required' @{ folder = $Folder } }
  $composer = Get-Composer
}
# Last check before anything is typed: this must be the new-session page for
# the requested folder. A message once went into the session already open in
# that project instead (Claude Desktop 3.6556, 2026-10-27): after the trust
# prompt the old composer was still the one found.
$want = Get-FolderKey $Folder
$onNewPage = Wait-NewSessionPage $want
if (-not $onNewPage) { Finish $false 'new_page_not_open' }
$composer = Get-Composer
$draft = Get-ComposerText $composer
$normText = { param($t) ([string]$t -replace "`r", '' -replace '\s+', ' ').Trim() }
# The same text left by an earlier try of this very task (the desktop keeps the
# new-task draft) is sent as it is; anything else the user typed is left alone.
$sameDraft = $draft.Trim() -and $images.Count -eq 0 -and (& $normText $draft) -eq (& $normText $text)
if ($draft.Trim() -and -not $sameDraft) { Finish $false 'desktop_draft_present' }
if (-not $sameDraft -and $text.Trim() -and -not (Set-ComposerText $text)) { Set-ComposerText '' | Out-Null; Finish $false 'paste_failed' }

if ($images.Count -gt 0) {
  $savedText = $null; $savedImage = $null
  try {
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $savedText = [System.Windows.Forms.Clipboard]::GetText() }
    elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) { $savedImage = [System.Windows.Forms.Clipboard]::GetImage() }
  } catch { }
  try {
    foreach ($file in $images) {
      if (-not (Focus-Composer (Get-Composer))) { Set-ComposerText '' | Out-Null; Finish $false 'image_needs_foreground' }
      $img = [System.Drawing.Image]::FromFile($file)
      try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
      [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 900
    }
  } finally {
    try {
      if ($null -ne $savedText) { [System.Windows.Forms.Clipboard]::SetText($savedText) }
      elseif ($null -ne $savedImage) { [System.Windows.Forms.Clipboard]::SetImage($savedImage) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch { }
  }
}

$send = $null
for ($i = 0; $i -lt 20 -and (-not $send -or -not $send.Current.IsEnabled); $i++) { Start-Sleep -Milliseconds 250; $send = Get-Button 'Send' }
if (-not $send -or -not $send.Current.IsEnabled) { Finish $false 'send_not_ready' }
$log = Desktop-LogPath
$logMark = if ($log) { (Get-Item $log).Length } else { 0 }
try { $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { Finish $false 'not_sent' }
# Going back to the session the user was on before the desktop has opened the
# new one cancels it (seen on a busy computer: the draft was lost and no session
# made). Wait until the desktop shows a session other than that one.
$opened = $false
for ($i = 0; $i -lt 80 -and -not $opened; $i++) {
  Start-Sleep -Milliseconds 250
  $since = Read-LogSince $log $logMark
  $opened = @([regex]::Matches($since, 'setFocusedSession: sessionId=(local_[0-9a-f-]{36})') | Where-Object { $_.Groups[1].Value -ne $RestoreId }).Count -gt 0
}
if (-not $opened) {
  # Still on the new-task page with the text in it: nothing was sent.
  if ((Get-ComposerText (Get-Composer)).Trim()) { $RestoreId = ''; Finish $false 'not_sent' }
  # Unknown: stay on this page, where the user can see what happened.
  $RestoreId = ''
}
Finish $true $null
