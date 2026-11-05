# Drive a Claude desktop (Code tab) session through the app's own UI, exactly
# as if done by hand, so the turn runs in the desktop's existing session
# process and the conversation never forks.
#
#   -Mode send       paste images (optional) + text into the composer, Enter
#   -Mode interrupt  press Esc in the session to stop the running turn
#   -Mode open       just bring the session up on screen (e.g. to answer a prompt)
#   -Mode permission pick the permission mode named in the text file (the
#                    desktop's own label: Auto / Manual / Accept edits / Plan /
#                    Bypass permissions) from the composer's mode menu
#
# Text and stop go through UI Automation only (ValuePattern.SetValue on the
# composer, Invoke on its Send / Stop button), so they work while the window
# is behind other windows and nothing is typed anywhere. Only pasting images
# still needs the window in front plus Ctrl+V; that path checks the foreground
# and the keyboard focus first.
# Safety: `send` refuses when the composer already holds a draft (a half-typed
# desktop message is never sent) or when the window does not show the target
# session (the New session page has a composer of the same name), the clipboard is restored afterwards, a
# minimised window is restored for the action and minimised again, and the
# window can be switched back to the session the user was looking at.
# Output: one JSON line {ok, reason?}.
param(
  [Parameter(Mandatory = $true)][string]$SessionId,
  [string]$TextFile = '',
  [string]$ImageFiles = '',
  [string]$RestoreId = '',
  # The target session's title (UTF-8, Base64: a title starting with '-'
  # would read as a parameter name). Send writes nothing until the header shows it.
  [string]$TitleB64 = '',
  [ValidateSet('send', 'interrupt', 'open', 'permission')][string]$Mode = 'send',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'claude-desktop-native.ps1')
if (-not (Initialize-KhClaudeDesktopNative)) {
  [Console]::Out.WriteLine('{"ok":false,"reason":"adapter_init_failed","delivery":"not_sent","phase":"initialize"}')
  exit 0
}
. (Join-Path $PSScriptRoot 'claude-desktop-navigation.ps1')
function Out-Result($ok, $reason) { [Console]::Out.WriteLine((@{ ok = $ok; reason = $reason } | ConvertTo-Json -Compress)); exit 0 }
function Trace-Navigation($stage) {
  try { Add-Content -LiteralPath (Join-Path $env:TEMP 'khlink-claude-navigation.log') -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss} stage={1}' -f (Get-Date), $stage) } catch { }
}
if ($SessionId -notmatch '^local_[0-9a-f-]{36}$') { Out-Result $false 'bad_session_id' }
if ($RestoreId -and $RestoreId -notmatch '^local_[0-9a-f-]{36}$') { $RestoreId = '' }
$text = if ($TextFile) { [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8) } else { '' }
$images = @($ImageFiles -split '\|' | Where-Object { $_ })
if ($Mode -eq 'send' -and @($images | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) { Out-Result $false 'image_missing' }
if ($Mode -eq 'send' -and -not $text.Trim() -and $images.Count -eq 0) { Out-Result $false 'empty_text' }

function Get-ClaudeWindow {
  Get-KhClaudeDesktopWindow
}
function Get-Composer {
  $proc = Get-ClaudeWindow
  if (-not $proc) { return $null }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Prompt')))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
# Keystrokes are only ever sent when the Claude window is really in front and
# the keyboard focus is on its composer; otherwise nothing is typed at all, so
# text can never land in another application.
function Ensure-Foreground {
  $p = Get-ClaudeWindow; if (-not $p) { return $false }
  $h = $p.MainWindowHandle
  for ($try = 0; $try -lt 3; $try++) {
    if ([KhClaudeNative]::GetForegroundWindow() -eq $h -and -not [KhClaudeNative]::IsIconic($h)) { return $true }
    if ([KhClaudeNative]::IsIconic($h)) { [KhClaudeNative]::ShowWindow($h, 9) | Out-Null }
    # A synthetic key press lets a background process hand the foreground over.
    # F24 does nothing anywhere; Alt would open the Electron menu bar and Shift
    # would toggle a Chinese IME between Chinese and English.
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
function Get-Button($name) {
  $proc = Get-ClaudeWindow
  if (-not $proc) { return $null }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}
function Invoke-Button($name) {
  $b = Get-Button $name
  if (-not $b -or -not $b.Current.IsEnabled) { return $false }
  try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false }
}
# The title of the session the window shows: its header has a button named
# "<title>, rename session". Null while that button is not on screen.
function Get-SessionIdentity {
  $proc = Get-ClaudeWindow
  if (-not $proc) { return $null }
  $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $n = [string]$b.Current.Name
    if ($n.EndsWith(', rename session')) { return $n.Substring(0, $n.Length - ', rename session'.Length) }
  }
  return $null
}
function Set-ComposerText($value) {
  $el = Get-Composer; if (-not $el) { return $false }
  try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value) } catch { return $false }
  Start-Sleep -Milliseconds 300
  $norm = { param($t) ($t -replace "`r", '' -replace '\s+', ' ').Trim() }
  return ((& $norm (Get-ComposerText (Get-Composer))) -eq (& $norm $value))
}
function Get-ComposerText($el) {
  try { return $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) } catch { return '' }
}

# A minimised window has no live composer; restore it for the action.
$wasMinimized = $false
$proc = Get-ClaudeWindow
if ($proc -and [KhClaudeNative]::IsIconic($proc.MainWindowHandle)) {
  $wasMinimized = $true
  [KhClaudeNative]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  Start-Sleep -Milliseconds 500
}
function Finish($ok, $reason) {
  if ($Mode -ne 'open') {
    if ($RestoreId -and $RestoreId -ne $SessionId) { Start-Sleep -Milliseconds 400; Start-Process "claude://claude.ai/epitaxy/$RestoreId" }
    # The switch-back deep link re-activates the window asynchronously; minimise
    # only after it has landed (and once more in case it lands late).
    if ($wasMinimized) { foreach ($wait in 1500, 1200) { Start-Sleep -Milliseconds $wait; $p = Get-ClaudeWindow; if ($p -and -not [KhClaudeNative]::IsIconic($p.MainWindowHandle)) { [KhClaudeNative]::ShowWindow($p.MainWindowHandle, 6) | Out-Null } } }  # SW_MINIMIZE
  }
  Out-Result $ok $reason
}

# Open the target session in the desktop window. A permission change first notes
# the session shown now: the window must have moved on from it before its mode
# menu is read.
$shownBefore = if ($Mode -eq 'permission') { Get-SessionIdentity } else { $null }
Start-Process "claude://claude.ai/epitaxy/$SessionId"
$composer = $null
for ($i = 0; $i -lt 40 -and -not $composer; $i++) { Start-Sleep -Milliseconds 250; $composer = Get-Composer }
if ($Mode -eq 'open') {
  $p = Get-ClaudeWindow; if ($p) { [KhClaudeNative]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }
  Out-Result ([bool]$composer) $(if ($composer) { $null } else { 'composer_not_found' })
}
if (-not $composer) { Finish $false 'composer_not_found' }
Start-Sleep -Milliseconds 700   # let the session view settle before reading its draft
$composer = Get-Composer

# A deep link that did not land (the app busy, waiting to relaunch for an
# update, the session not loaded yet) leaves the New session page, whose
# composer has the same name: a message written there started a new session in
# the last folder (2026-10-29). Write nothing until the header names the target.
if ($Mode -eq 'send') {
  $norm = { param($t) ([string]$t -replace '\s+', ' ').Trim() }
  $want = ''
  if ($TitleB64) { try { $want = & $norm ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))) } catch { $want = '' } }
  $shown = $null
  # Without a title nothing proves which page is up: a deep link to a session
  # the app cannot open lands on whichever page it likes, some of them another
  # session's.
  for ($i = 0; $want -and $i -lt 24 -and -not $shown; $i++) {
    $now = Get-SessionIdentity
    if ($now -and (& $norm $now) -eq $want) { $shown = $now } else { Start-Sleep -Milliseconds 250 }
  }
  # Some desktop versions accept the deep link in their backend without
  # updating the visible page. A uniquely named sidebar row can repair that,
  # but title alone is not identity: verify the visible document's session ID.
  if (-not $shown -and $want) {
    Trace-Navigation 'sidebar-attempt'
    $stage = 'window'
    try {
      $p = Get-ClaudeWindow
      $win = if ($p) { [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle) } else { $null }
      $stage = 'sidebar'
      if ($win -and (Invoke-KhUniqueSidebarSession $win $want)) {
        Trace-Navigation 'sidebar-invoked'
        $stage = 'verify'
        $seenUrl = $false
        for ($i = 0; $i -lt 32 -and -not $shown; $i++) {
          Start-Sleep -Milliseconds 250
          $now = Get-SessionIdentity
          $url = Get-KhVisibleCodeUrl $win
          if ($url) { $seenUrl = $true }
          if (Test-KhSidebarIdentity $url $SessionId $now $want) { $shown = $now }
        }
        if ($shown) { Trace-Navigation 'identity-verified' }
        elseif ($seenUrl) { Trace-Navigation 'identity-mismatch' }
        else { Trace-Navigation 'document-url-unavailable' }
      }
    } catch {
      # No message has been typed yet. Keep diagnostic data free of chat text,
      # titles, file paths and account information.
      try { Add-Content -LiteralPath (Join-Path $env:TEMP 'khlink-claude-navigation.log') -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss} stage={1} error={2} line={3}' -f (Get-Date), $stage, $_.Exception.GetType().Name, $_.InvocationInfo.ScriptLineNumber) } catch { }
    }
  }
  if (-not $shown) { Finish $false 'session_not_shown' }
  $composer = Get-Composer
  if (-not $composer) { Finish $false 'composer_not_found' }
}

if ($Mode -eq 'permission') {
  # The deep link may still be loading the session. Wait until the header shows
  # a different session than the one shown before, or, when the header does not
  # change (the requested session was already on screen), until 3 seconds have
  # passed. Only then is the mode menu read.
  $since = Get-Date
  $settled = $false
  while (-not $settled -and ((Get-Date) - $since).TotalSeconds -lt 8) {
    Start-Sleep -Milliseconds 300
    if (-not (Get-Composer)) { continue }
    $shownNow = Get-SessionIdentity
    if ($shownNow -and $shownNow -ne $shownBefore) { $settled = $true }
    elseif (((Get-Date) - $since).TotalMilliseconds -ge 3000) { $settled = $true }
  }
  $composer = Get-Composer
  if (-not $composer) { Finish $false 'composer_not_found' }
  # The mode menu button sits under the composer and is named after the
  # current mode; its menu lists one radio item per mode, "<label> <hint>".
  $labels = @('Auto', 'Manual', 'Accept edits', 'Plan', 'Bypass permissions')
  $target = $text.Trim()
  if ($labels -notcontains $target) { Finish $false 'bad_permission_mode' }
  # The radio items drawn by the open menu; their names are reported when the
  # wanted one is missing, so a menu this script cannot read can be seen in the log.
  $script:seenModes = @()
  function Find-ModeOption($name) {
    $radio = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)
    $proc = Get-ClaudeWindow
    if (-not $proc) { return $null }
    $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    foreach ($r in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $radio)) {
      $n = [string]$r.Current.Name
      if ($n -and $script:seenModes -notcontains $n -and $script:seenModes.Count -lt 12) { $script:seenModes += $n }
      if ($n -eq $name -or $n.StartsWith("$name ")) { return $r }
    }
    return $null
  }
  function Get-ModeButton {
    $proc = Get-ClaudeWindow; $c = Get-Composer
    if (-not $proc -or -not $c) { return $null }
    $below = $c.Current.BoundingRectangle.Bottom
    $win = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
      $top = $b.Current.BoundingRectangle.Top
      if ($labels -contains $b.Current.Name -and $top -ge $below -and $top -lt $below + 80) { return $b }
    }
    return $null
  }
  # Read the button only when two reads 250 ms apart agree: while the view is
  # changing the button can still show the mode of the session before.
  $button = $null
  $deadline = (Get-Date).AddSeconds(4)
  while (-not $button -and (Get-Date) -lt $deadline) {
    $first = Get-ModeButton
    if ($first) {
      Start-Sleep -Milliseconds 250
      $second = Get-ModeButton
      if ($second -and $second.Current.Name -eq $first.Current.Name) { $button = $second }
    }
    if (-not $button) { Start-Sleep -Milliseconds 200 }
  }
  if (-not $button) { Finish $false 'mode_menu_not_found' }
  if ($button.Current.Name -eq $target) { Finish $true $null }
  if ($DryRun) { Finish $true 'dry_run' }
  try { $menu = $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch { Finish $false 'mode_menu_not_found' }
  # Expand only a closed menu: expanding an open one would close it.
  $state = $menu.Current.ExpandCollapseState
  if ($state -ne 'Expanded' -and $state -ne 'PartiallyExpanded') { try { $menu.Expand() } catch { Finish $false 'mode_menu_not_found' } }
  $item = $null
  $deadline = (Get-Date).AddSeconds(4)
  while (-not $item -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150; $item = Find-ModeOption $target }
  if (-not $item -and $script:seenModes.Count -eq 0) {
    # Nothing was drawn: the click may have come before the menu was ready. Open it once more.
    try { $menu.Collapse(); Start-Sleep -Milliseconds 300; $menu.Expand() } catch { }
    $deadline = (Get-Date).AddSeconds(3)
    while (-not $item -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150; $item = Find-ModeOption $target }
  }
  if (-not $item) {
    try { $menu.Collapse() } catch { }
    $shown = if ($script:seenModes.Count) { $script:seenModes -join ' | ' } else { 'no options visible' }
    Finish $false ('mode_option_not_found: ' + $shown.Substring(0, [Math]::Min(300, $shown.Length)))
  }
  try { $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { try { $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { try { $menu.Collapse() } catch { }; Finish $false 'mode_option_not_found' } }
  # The button takes the new name once the desktop has switched; a mode the
  # desktop refuses (e.g. bypass blocked on this machine) keeps the old name.
  $applied = $false
  for ($i = 0; $i -lt 15 -and -not $applied; $i++) { Start-Sleep -Milliseconds 200; $b = Get-ModeButton; $applied = $b -and $b.Current.Name -eq $target }
  $b = Get-ModeButton
  if ($b) { try { $p = $b.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($p.Current.ExpandCollapseState -ne 'Collapsed') { $p.Collapse() } } catch { } }
  if ($applied) { Finish $true $null } else { Finish $false 'mode_not_applied' }
}

if ($Mode -eq 'interrupt') {
  if ($DryRun) { Finish $true 'dry_run' }
  if (Invoke-Button 'Stop') { Start-Sleep -Milliseconds 400; Finish $true $null }
  if (-not (Focus-Composer $composer)) { Finish $false 'window_not_foreground' }
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 400
  Finish $true $null
}

$draft = (Get-ComposerText $composer).Trim()
if ($draft) { Finish $false 'desktop_draft_present' }
if ($DryRun) { Finish $true 'dry_run' }

# Text first, through UI Automation: no foreground, keystrokes or clipboard.
if ($text.Trim()) {
  if (-not (Set-ComposerText $text)) { Set-ComposerText '' | Out-Null; Finish $false 'paste_failed' }
}
# Images can only be pasted: that needs the window in front.
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
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 900   # the composer uploads/attaches the pasted image
    }
  } finally {
    try {
      if ($null -ne $savedText) { [System.Windows.Forms.Clipboard]::SetText($savedText) }
      elseif ($null -ne $savedImage) { [System.Windows.Forms.Clipboard]::SetImage($savedImage) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch { }
  }
}
Start-Sleep -Milliseconds 200
if (-not (Invoke-Button 'Send')) {
  # No Send button found: fall back to Enter, only with the composer focused.
  if (-not (Focus-Composer (Get-Composer))) { if (-not $images.Count) { Set-ComposerText '' | Out-Null }; Finish $false 'window_not_foreground' }
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
}
Start-Sleep -Milliseconds 700
$left = (Get-ComposerText (Get-Composer)).Trim()
if ($left) { Finish $false 'not_sent' }
Finish $true $null
