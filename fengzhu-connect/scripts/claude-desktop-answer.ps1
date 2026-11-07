# Answer a Claude desktop prompt the way a click would, through UI Automation
# on the app's own controls (Invoke / Toggle / SetValue). No keystrokes are
# sent, so nothing can land in another application.
#
#   -Kind permission -Choice allow|deny|allow_auto       -ExpectFile <command the phone showed>
#   -Kind question   -Choice <JSON file, one entry per question:
#                      {question, multi, options: [{name, chosen}], other}>
#                      -ExpectFile <first question text> -RequestId <native id>
#   -Kind plan       -Choice accept|accept_auto|reject|revise [-FeedbackFile <text>]
#   -Kind offer      -Choice new|here  -ExpectFile <the suggested session's title>
#
# Safety: the prompt on screen must be the one the phone showed, otherwise
# nothing is touched. Afterwards the prompt must be gone.
# Output: one JSON line {ok, reason?}.
param(
  [Parameter(Mandatory = $true)][string]$SessionId,
  [ValidateSet('permission', 'question', 'plan', 'offer', 'inspect')][string]$Kind = 'permission',
  [string]$Choice = '',
  [string]$ExpectFile = '',
  [string]$PromptFile = '',
  [string]$RequestId = '',
  [string]$FeedbackFile = '',
  [string]$RestoreId = '',
  [switch]$NoNavigate
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell otherwise encodes Chinese dialog names using the local
# console code page, while Node reads stdout as UTF-8.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'claude-desktop-native.ps1')
if (-not (Initialize-KhClaudeDesktopNative)) {
  [Console]::Out.WriteLine('{"ok":false,"reason":"adapter_init_failed","delivery":"not_sent","phase":"initialize"}')
  exit 0
}
function Out-Result($ok, $reason, $shown = $null, $prompt = $null) { [Console]::Out.WriteLine((@{ ok = $ok; reason = $reason; shown = $shown; prompt = $prompt } | ConvertTo-Json -Depth 6 -Compress)); exit 0 }
if ($SessionId -notmatch '^local_[0-9a-f-]{36}$') { Out-Result $false 'bad_session_id' }
if ($RestoreId -and $RestoreId -notmatch '^local_[0-9a-f-]{36}$') { $RestoreId = '' }
$Ellipsis = [string][char]0x2026
$norm = { param($s) ([string]$s -replace '\s+', ' ').Trim() }
function Clip-Key($text) {
  $key = & $norm $text
  # Text the phone received clipped ends in an ellipsis.
  if ($key.EndsWith($Ellipsis)) { $key = $key.Substring(0, $key.Length - 1).TrimEnd() }
  if ($key.Length -gt 160) { $key = $key.Substring(0, 160) }
  return $key
}
$expectKey = if ($ExpectFile) { Clip-Key ([IO.File]::ReadAllText($ExpectFile, [Text.Encoding]::UTF8)) } else { '' }
$permissionKey = if ($ExpectFile) { [IO.File]::ReadAllText($ExpectFile, [Text.Encoding]::UTF8) } else { '' }
$expectedPrompt = if ($PromptFile) { ConvertFrom-Json ([IO.File]::ReadAllText($PromptFile, [Text.Encoding]::UTF8)) } else { $null }

$UIA = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
function Get-Window { Get-KhClaudeDesktopWindow }
function Root { $p = Get-Window; if (-not $p) { return $null }; $UIA::FromHandle($p.MainWindowHandle) }
function Find-All($root, $type) {
  if (-not $root) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $type)
  @($root.FindAll($TS::Descendants, $cond) | Where-Object { -not $_.Current.IsOffscreen })
}
function Texts($root) { (Find-All $root $CT::Text | ForEach-Object { $_.Current.Name }) -join ' ' }
function Buttons($root) { Find-All $root $CT::Button }
function Permission-Groups {
  @(Find-All (Root) $CT::Group | Where-Object {
    $_.Current.Name -like 'Permission request*' -and
    (Button-Named $_ '^(?:Allow once\b|Always allow\b|More allow options$)') -and (Button-Named $_ '^Deny\b')
  })
}
# A question card: a named group with Submit (or Skip / Next) and option
# buttons whose texts are "label" and "description". Claude Desktop 3.x also
# asks this way when the model's safeguards flag a session ("Switch
# automatically" / "Stay on ..."), and that question is never written to the
# transcript, so the phone can only learn it from the window.
$QuestionSteps = '^(?:Submit|Skip|Next)$'
function Question-Options($group) {
  $skip = '^(?:Submit|Skip|Next|Back|Other(?: \d+)?|Show previous question|Show more|Copy)$'
  $controls = @(Buttons $group) + @(Find-All $group $CT::RadioButton) + @(Find-All $group $CT::CheckBox)
  foreach ($c in $controls) {
    $name = & $norm $c.Current.Name
    if (-not $name -or $name -match $skip) { continue }
    $texts = @(Find-All $c $CT::Text | ForEach-Object { & $norm $_.Current.Name } | Where-Object { $_ })
    $isChoice = $c.Current.ControlType -ne $CT::Button
    if (-not $texts.Count -and -not $isChoice) { continue }
    $label = if ($texts.Count) { $texts[0] } else { $name }
    $description = if ($texts.Count -gt 1) { ($texts[1..($texts.Count - 1)] -join ' ') } else { '' }
    [pscustomobject]@{ label = $label; description = $description; name = $name; multi = ($c.Current.ControlType -eq $CT::CheckBox) }
  }
}
function Question-Cards {
  $cards = @(Find-All (Root) $CT::Group | Where-Object {
    # Only a card that is not in the transcript: Submit without Skip (the
    # safeguard choice). An AskUserQuestion page has Skip and is read from the
    # transcript, with every page; reading its first page here replaced it.
    $_.Current.Name -and $_.Current.Name -notlike 'Permission request*' -and
    (Button-Named $_ '^Submit$') -and -not (Button-Named $_ '^Skip$') -and @(Question-Options $_).Count -ge 2
  })
  # Keep the innermost card: the message and list around it qualify too.
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $outer = @()
  foreach ($card in $cards) {
    $x = $walker.GetParent($card)
    while ($x) {
      foreach ($other in $cards) { if ([System.Windows.Automation.Automation]::Compare($x.GetRuntimeId(), $other.GetRuntimeId())) { $outer += , $other.GetRuntimeId() } }
      $x = $walker.GetParent($x)
    }
  }
  @($cards | Where-Object { $id = $_.GetRuntimeId(); -not @($outer | Where-Object { [System.Windows.Automation.Automation]::Compare($_, $id) }).Count })
}
function Question-Snapshot($card) {
  $options = @(Question-Options $card)
  return @{ desktopId = $SessionId; question = (& $norm $card.Current.Name); multi = [bool](@($options | Where-Object { $_.multi }).Count)
    options = @($options | ForEach-Object { @{ label = $_.label; description = $_.description; name = $_.name } }) }
}
function Permission-Snapshot($group) {
  if (-not $group) { return $null }
  # Include text below the fold too: scrolling must not change the operation
  # being verified. Button labels and unrelated conversation text are excluded.
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $CT::Text)
  $texts = @($group.FindAll($TS::Descendants, $cond) | ForEach-Object { [string]$_.Current.Name })
  # Whether the dialog offers "Allow and switch to Auto" at all (an MCP tool's
  # request has no allow menu): the phone then does not offer it.
  $auto = [bool](Button-Named $group '^(?:More allow options$|Allow and switch to Auto)')
  return @{ desktopId = $SessionId; name = $group.Current.Name; texts = $texts; auto = $auto }
}
function Same-Permission($actual, $expected) {
  if (-not $actual -or -not $expected -or $actual.desktopId -cne $expected.desktopId -or $actual.name -cne $expected.name) { return $false }
  $a = @($actual.texts); $b = @($expected.texts)
  if (-not $a.Count -or $a.Count -ne $b.Count) { return $false }
  for ($i = 0; $i -lt $a.Count; $i++) { if ([string]$a[$i] -cne [string]$b[$i]) { return $false } }
  return $true
}
function Button-Named($root, $pattern) { Buttons $root | Where-Object { (& $norm $_.Current.Name) -match $pattern } | Select-Object -First 1 }
function Invoke-Button($button) { $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Toggle-State($button) { try { [string]$button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState } catch { $null } }
function Set-Toggle($button, $on) {
  $want = if ($on) { 'On' } else { 'Off' }
  # Desktop 2.42304.2 re-renders a page after each change and reports the new
  # state late; a toggle checked after 150 ms looked unset ("option_not_set",
  # seen 2026-10-20). Wait for it before toggling again, never twice blind.
  for ($i = 0; $i -lt 3; $i++) {
    if ((Toggle-State $button) -eq $want) { return $true }
    $button.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    for ($w = 0; $w -lt 8; $w++) { Start-Sleep -Milliseconds 150; if ((Toggle-State $button) -eq $want) { return $true } }
  }
  return (Toggle-State $button) -eq $want
}
# The one control without an automation action (the menu button beside
# "Allow once") needs a real click: only with the Claude window in front and
# only when the point clicked is that very button.
function Bring-Forward {
  $h = (Get-Window).MainWindowHandle
  if ([KhClaudeNative]::GetForegroundWindow() -ne $h) {
    # F24 does nothing anywhere; it only lets this process bring the window forward.
    [KhClaudeNative]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhClaudeNative]::SetForegroundWindow($h) | Out-Null; [KhClaudeNative]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  return ([KhClaudeNative]::GetForegroundWindow() -eq $h)
}
# The element under the point is the button or one of its own parts (its icon).
function Is-Within($element, $button) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $id = $button.GetRuntimeId()
  $e = $element
  for ($i = 0; $e -and $i -lt 4; $i++) {
    if ([System.Windows.Automation.Automation]::Compare($e.GetRuntimeId(), $id)) { return $true }
    $e = $walker.GetParent($e)
  }
  return $false
}
function Click-Exactly($button) {
  if (-not (Bring-Forward)) { return $false }
  $r = $button.Current.BoundingRectangle
  $x = [int]($r.X + $r.Width / 2); $y = [int]($r.Y + $r.Height / 2)
  $at = $UIA::FromPoint((New-Object System.Windows.Point($x, $y)))
  if (-not $at -or -not (Is-Within $at $button)) { return $false }
  [KhClaudeNative]::SetCursorPos($x, $y) | Out-Null
  [KhClaudeNative]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [KhClaudeNative]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  return $true
}
function Wait-For($block, $tries = 20) { for ($i = 0; $i -lt $tries; $i++) { $v = & $block; if ($v) { return $v }; Start-Sleep -Milliseconds 250 }; return $null }
function Set-EditText($name, $text) {
  $edit = Wait-For { Find-All (Root) $CT::Edit | Where-Object { $_.Current.Name -eq $name } | Select-Object -First 1 } 12
  if (-not $edit) { return $false }
  $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($text); Start-Sleep -Milliseconds 250
  return ((& $norm $value.Current.Value) -eq (& $norm $text))
}
function Name-Pattern($label, $numbered) {
  # "label description" as the phone knows it; a clipped one matches as a prefix.
  $clipped = $label.EndsWith($Ellipsis)
  $text = if ($clipped) { $label.Substring(0, $label.Length - 1).TrimEnd() } else { $label }
  # Desktop 2.42304.0.0: single choices are toggles without numeric suffixes.
  # Keep the previous numbered form, while still matching the entire label.
  $tail = if ($numbered) { '(?: \d+)?$' } else { '$' }
  if ($clipped) { return '^' + [regex]::Escape($text) + '.*' + $tail }
  return '^' + [regex]::Escape($text) + $tail
}

$proc = Get-Window
if (-not $proc) { Out-Result $false 'desktop_not_running' }
$wasMinimized = [KhClaudeNative]::IsIconic($proc.MainWindowHandle)
if ($wasMinimized -and -not $NoNavigate) { [KhClaudeNative]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null; Start-Sleep -Milliseconds 500 }
function Finish($ok, $reason, $shown = $null, $prompt = $null) {
  # Which check refused, for troubleshooting a desktop update that changed
  # the dialog. Only the script line and kind; no prompt text or answers.
  if (-not $ok) {
    try {
      $line = (Get-PSCallStack)[1].ScriptLineNumber
      Add-Content -LiteralPath (Join-Path $env:TEMP 'khlink-claude-answer.log') -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss} {1} {2} line {3}' -f (Get-Date), $Kind, $reason, $line)
    } catch { }
  }
  if ($RestoreId -and $RestoreId -ne $SessionId) { Start-Sleep -Milliseconds 400; Start-Process "claude://claude.ai/epitaxy/$RestoreId" }
  if ($wasMinimized) { foreach ($wait in 1500, 1200) { Start-Sleep -Milliseconds $wait; $p = Get-Window; if ($p -and -not [KhClaudeNative]::IsIconic($p.MainWindowHandle)) { [KhClaudeNative]::ShowWindow($p.MainWindowHandle, 6) | Out-Null } } }
  Out-Result $ok $reason $shown $prompt
}

# The session the desktop shows, from its own log (written the moment it
# switches). A deep link can go unheeded while the app is busy: the prompt
# then on screen belongs to another session (seen: another session's
# "rm -rf *" prompt), so nothing is done until the right one is in view.
. (Join-Path $PSScriptRoot 'claude-desktop-log-path.ps1')
function Read-LogTail($log, $maxBytes) {
  if (-not $log -or -not (Test-Path $log)) { return @{ text = ''; length = 0; whole = $true } }
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try { $length = $fs.Length; $start = [Math]::Max(0, $length - $maxBytes); [void]$fs.Seek($start, 'Begin'); $buf = New-Object byte[] ($length - $start); [void]$fs.Read($buf, 0, $buf.Length) } finally { $fs.Close() }
  return @{ text = [Text.Encoding]::UTF8.GetString($buf); length = $length; whole = ($start -eq 0) }
}
function Read-DesktopLog($maxBytes = 262144) { (Read-LogTail (Desktop-LogPath) $maxBytes).text }
$FocusLine = 'setFocusedSession: sessionId=(local_[0-9a-f-]{36}|null)'
function Last-Focus($text) {
  $found = [regex]::Matches($text, $FocusLine)
  if (-not $found.Count) { return $null }
  # A switch logs "null" and then the new session; a final "null" means none is in view.
  return $found[$found.Count - 1].Groups[1].Value
}
# The desktop logs a line only when it switches. Opening the session already in
# view logs nothing, so its line can be far back in a busy log (seen: 450 KB,
# after the 256 KB this used to read, so a prompt in plain view was refused).
# Look further back when the recent part has none; remember what was found.
$script:focusCache = $null
function Focused-Session {
  $log = Desktop-LogPath
  if (-not $log) { return $null }
  $tail = Read-LogTail $log 262144
  $recent = Last-Focus $tail.text
  if ($recent) { $script:focusCache = @{ log = $log; length = $tail.length; value = $recent }; return $(if ($recent -eq 'null') { $null } else { $recent }) }
  $cache = $script:focusCache
  # Nothing in the last 256 KB: the cached answer holds while everything logged since it is in that window.
  if ($cache -and $cache.log -eq $log -and $cache.length -le $tail.length -and $cache.length -ge $tail.length - 262144) {
    return $(if ($cache.value -eq 'null') { $null } else { $cache.value })
  }
  $value = $null
  if (-not $tail.whole) { $value = Last-Focus (Read-LogTail $log 33554432).text }
  if (-not $value) {
    # Rotated at about 10 MB: the last switch may be in the previous file.
    $older = Join-Path (Split-Path $log) 'main1.log'
    if ((Test-Path $older) -and (Get-Item $older).LastWriteTime -ge (Get-Item $log).CreationTime.AddMinutes(-1)) { $value = Last-Focus (Read-LogTail $older 33554432).text }
  }
  if (-not $value) { return $null }
  $script:focusCache = @{ log = $log; length = $tail.length; value = $value }
  return $(if ($value -eq 'null') { $null } else { $value })
}
function Request-Pending {
  if (-not $RequestId) { return $false }
  $logText = Read-DesktopLog (3 * 1024 * 1024)
  $escaped = [regex]::Escape($RequestId)
  $emitted = [regex]::Matches($logText, "Emitted tool permission request $escaped for \S+ in session $([regex]::Escape($SessionId))\b")
  if (-not $emitted.Count) { return $false }
  $answered = [regex]::Matches($logText, "Received permission response for ${escaped}:")
  return -not $answered.Count -or $answered[$answered.Count - 1].Index -lt $emitted[$emitted.Count - 1].Index
}
if ($NoNavigate) {
  if ($Kind -ne 'inspect' -or $wasMinimized -or (Focused-Session) -ne $SessionId) { Out-Result $false 'session_not_visible' }
} else {
  Start-Process "claude://claude.ai/epitaxy/$SessionId"
  if (-not (Wait-For { (Focused-Session) -eq $SessionId } 32)) {
    Start-Process "claude://claude.ai/epitaxy/$SessionId"
    if (-not (Wait-For { (Focused-Session) -eq $SessionId } 48)) { Finish $false 'session_not_opened' }
  }
}
if ($Kind -eq 'inspect') {
  # Opened just now: give the card a few seconds to draw before reading.
  # Short: each look scans the whole window, and Finish must run before the
  # connector's 60 s timeout to return to the session that was in view.
  if (-not $NoNavigate) { [void](Wait-For { @(Permission-Groups).Count -or @(Question-Cards).Count } 14) }
  # Every exit after navigating goes through Finish, which returns to the
  # session that was in view (Out-Result would leave the desktop here).
  $done = { param($ok, $reason, $snap) if ($NoNavigate) { Out-Result $ok $reason $null $snap } else { Finish $ok $reason $null $snap } }
  $groups = @(Permission-Groups)
  if ((Focused-Session) -ne $SessionId) { & $done $false 'session_not_visible' $null }
  if ($groups.Count -gt 1) { & $done $false 'ambiguous_prompt' $null }
  $snapshot = if ($groups.Count -eq 1) { Permission-Snapshot $groups[0] } else { $null }
  if (-not $snapshot) {
    $cards = @(Question-Cards)
    if ($cards.Count -gt 1) { & $done $false 'ambiguous_prompt' $null }
    if ($cards.Count -eq 1) { $snapshot = @{ desktopId = $SessionId; questionCard = (Question-Snapshot $cards[0]) } }
  }
  & $done $true $null $snapshot
}

# ---- tool permission --------------------------------------------------------
function Menu-Expanded($button) {
  try { return [string]$button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState -eq 'Expanded' } catch { return $false }
}
function Open-PermissionMenu($button) {
  # Current Base UI split buttons expose ExpandCollapse (as the mode menu
  # does). Desktop 2.42304.2 only opens the menu while its window is in front:
  # in the background Expand() returns without error and nothing opens (seen
  # 2026-10-20, "button_not_found"). Bring it forward and check it opened.
  [void](Bring-Forward)
  # Right after the session is opened the window is still redrawing, and the
  # menu took 2-3 s to open: waiting only 2 s fell through to the click, whose
  # point check refuses this button (it hits the pane), so "Allow and switch
  # to Auto" failed most of the time (2026-11-05). Count the menu as open once
  # its items exist, wait up to 6 s, and ask once more before clicking.
  $menuOpen = { (Menu-Expanded $button) -or @(Find-All (Root) $CT::MenuItem).Count }
  for ($try = 0; $try -lt 2; $try++) {
    try { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() } catch { }
    if (Wait-For $menuOpen 24) { return $true }
    [void](Bring-Forward)
  }
  return (Click-Exactly $button)
}
function Check-PermissionRequest($group, $snapshot) {
  if ((Focused-Session) -ne $SessionId -or -not (Same-Permission (Permission-Snapshot $group) $snapshot)) { Finish $false 'prompt_mismatch' }
  if (-not (Request-Pending)) { Finish $false 'request_stale' $null $snapshot }
}
function Invoke-PermissionChoice($group, $snapshot, $choice) {
  Check-PermissionRequest $group $snapshot
  $direct = switch ($choice) { 'allow' { '^Allow once\b' } 'deny' { '^Deny\b' } default { $null } }
  $button = if ($direct) { Button-Named $group $direct } else { $null }
  if ($button) { Invoke-Button $button; return }
  if ($choice -eq 'deny') { Finish $false 'button_not_found' }
  # Desktop 2.42304 file writes default to "Always allow" (this session).
  # A phone's one-time approval must select Allow once in the menu, never
  # invoke that wider default. Existing Allow once main buttons still work.
  $pattern = if ($choice -eq 'allow') { '^Allow once$' } else { '^Allow and switch to Auto\b' }
  $findItem = { @(Find-All (Root) $CT::MenuItem | Where-Object { $_.Current.Name -match $pattern }) }
  $items = @(& $findItem)
  if (-not $items.Count) {
    $menu = Button-Named $group '^More allow options$'
    if (-not $menu) { Finish $false $(if ($choice -eq 'allow_auto') { 'auto_not_offered' } else { 'button_not_found' }) }
    if (-not (Open-PermissionMenu $menu)) { Finish $false 'window_not_foreground' }
    # The items can render a few seconds after the menu reports open (2026-11-05).
    $items = @(Wait-For $findItem 24)
  }
  $items = @($items | Where-Object { $null -ne $_ })
  # A scheduled task's dialog (2026-11-06) has a "More allow options" menu
  # holding only "Always allow - Saves to this scheduled task": no Auto there.
  # Close the menu (Escape, while the window is in front) and say so; the
  # connector then allows once and switches the session's mode itself.
  if ($choice -eq 'allow_auto' -and -not $items.Count) {
    try { $menuButton = Button-Named $group '^More allow options$'; if ($menuButton) { $menuButton.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } } catch { }
    if (@(Find-All (Root) $CT::MenuItem).Count) { try { [void](Bring-Forward); [KhClaudeNative]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero); [KhClaudeNative]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 300 } catch { } }
    Finish $false 'auto_not_offered'
  }
  if ($items.Count -ne 1) {
    try { Add-Content -LiteralPath (Join-Path $env:TEMP 'khlink-claude-answer.log') -Encoding UTF8 -Value ('{0:yyyy-MM-dd HH:mm:ss} menu items matching={1} all=[{2}]' -f (Get-Date), $items.Count, ((@(Find-All (Root) $CT::MenuItem) | ForEach-Object { $_.Current.Name.Substring(0, [Math]::Min(40, $_.Current.Name.Length)) }) -join ' | ')) } catch { }
    Finish $false 'button_not_found'
  }
  Check-PermissionRequest $group $snapshot
  Invoke-Button $items[0]
}
# ---- offer: "Start this in its own session?" (New session / Do it here) ----
# A session that suggests a side session waits on this card (Claude Desktop
# 3.x). Only the card whose title is the one the phone showed is answered; with
# several suggested tasks, the buttons next to that title are the ones used.
if ($Kind -eq 'offer') {
  if ($Choice -notin @('new', 'here')) { Finish $false 'bad_choice' }
  $want = & $norm $permissionKey
  if (-not $want) { Finish $false 'nothing_to_verify' }
  $label = if ($Choice -eq 'new') { '^New session$' } else { '^Do it here$' }
  $findCard = {
    foreach ($card in @(Find-All (Root) $CT::Group | Where-Object { $_.Current.Name -match '^\d+ suggested tasks?$' })) {
      foreach ($title in @(Find-All $card $CT::Text | Where-Object { (& $norm $_.Current.Name) -ceq $want })) {
        # The nearest container of this title that holds exactly one such button.
        $x = $title
        for ($i = 0; $i -lt 6 -and $x; $i++) {
          $x = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($x)
          if (-not $x) { break }
          $buttons = @(Buttons $x | Where-Object { (& $norm $_.Current.Name) -match $label })
          if ($buttons.Count -eq 1) { return @{ card = $card; button = $buttons[0] } }
          if ($buttons.Count -gt 1) { break }
        }
      }
    }
    return $null
  }
  $found = Wait-For $findCard 40
  if (-not $found) { Finish $false 'prompt_not_found' }
  $cardId = $found.card.GetRuntimeId()
  Invoke-Button $found.button
  $same = { Find-All (Root) $CT::Group | Where-Object { [System.Windows.Automation.Automation]::Compare($_.GetRuntimeId(), $cardId) } | Select-Object -First 1 }
  $gone = Wait-For { -not (& $same) } 40
  if ($gone) { Finish $true $null } else { Finish $false 'prompt_still_open' }
}

if ($Kind -eq 'permission') {
  if (-not $permissionKey -and -not $expectedPrompt) { Finish $false 'nothing_to_verify' }
  if ($Choice -notin @('allow', 'deny', 'allow_auto')) { Finish $false 'bad_choice' }
  $groups = @(Wait-For { Permission-Groups } 40)
  if (-not $groups.Count) { Finish $false 'prompt_not_found' }
  if ($groups.Count -ne 1) { Finish $false 'ambiguous_prompt' }
  $group = $groups[0]; $snapshot = Permission-Snapshot $group
  $matches = if ($expectedPrompt) { Same-Permission $snapshot $expectedPrompt } else {
    # Legacy phone cards contain transcript text. Match a whole text element,
    # never a clipped prefix that another operation might share.
    -not $permissionKey.EndsWith($Ellipsis) -and @($snapshot.texts | Where-Object { $_ -ceq $permissionKey }).Count -gt 0
  }
  if (-not $matches) { Finish $false 'prompt_mismatch' (($snapshot.texts | Where-Object { $_ -and $_ -notmatch '^(Allow Claude to|run|\?)$' } | Select-Object -First 1)) $snapshot }
  Invoke-PermissionChoice $group $snapshot $Choice
  # This very prompt: a new one for the same command is a new element.
  $promptId = $group.GetRuntimeId()
  $same = { Find-All (Root) $CT::Group | Where-Object { $_.Current.Name -like 'Permission request*' -and [System.Windows.Automation.Automation]::Compare($_.GetRuntimeId(), $promptId) } | Select-Object -First 1 }
  $gone = Wait-For { -not (& $same) }
  # A session idle for 30 minutes is put to sleep by the desktop app: its
  # prompt stays on screen, but a click does nothing until opening the session
  # has woken it (seconds, longer on a busy computer). Click it again meanwhile.
  for ($retry = 0; -not $gone -and $retry -lt 4 -and $Choice -ne 'allow_auto'; $retry++) {
    $prompt = & $same
    if (-not $prompt) { $gone = $true; break }
    Invoke-PermissionChoice $prompt $snapshot $Choice
    $gone = Wait-For { -not (& $same) }
  }
  if ($gone) { Finish $true $null } else { Finish $false 'prompt_still_open' }
}

# ---- plan (ExitPlanMode) ------------------------------------------------------
if ($Kind -eq 'plan') {
  $open = { $root = Root; ((Texts $root) -match 'Claude proposed a plan') -and ((Button-Named $root '^Accept$') -or (Button-Named $root '^Revise$')) }
  if (-not (Wait-For $open 40)) { Finish $false 'prompt_not_found' }
  $root = Root
  switch ($Choice) {
    'accept' { $b = Button-Named $root '^Accept$'; if (-not $b) { Finish $false 'button_not_found' }; Invoke-Button $b }
    'accept_auto' { $b = Button-Named $root '^Accept and auto mode$'; if (-not $b) { Finish $false 'button_not_found' }; Invoke-Button $b }
    'reject' { $b = Button-Named $root '^Reject$'; if (-not $b) { Finish $false 'button_not_found' }; Invoke-Button $b }
    'revise' {
      $feedback = if ($FeedbackFile) { [IO.File]::ReadAllText($FeedbackFile, [Text.Encoding]::UTF8).Trim() } else { '' }
      if (-not $feedback) { Finish $false 'bad_choice' }
      # "Revise..." opens the feedback box; "Revise" then sends it.
      if (-not (Find-All $root $CT::Edit | Where-Object { $_.Current.Name -eq 'Plan feedback' })) {
        $b = Button-Named $root '^Revise.+$'; if (-not $b) { Finish $false 'button_not_found' }; Invoke-Button $b
      }
      if (-not (Set-EditText 'Plan feedback' $feedback)) { Finish $false 'text_not_set' }
      $send = Wait-For { Button-Named (Root) '^Revise$' } 8
      if (-not $send) { Finish $false 'button_not_found' }
      Invoke-Button $send
    }
    default { Finish $false 'bad_choice' }
  }
  $gone = Wait-For { -not ((Texts (Root)) -match 'Claude proposed a plan') }
  if ($gone) { Finish $true $null } else { Finish $false 'prompt_still_open' }
}

# ---- AskUserQuestion ------------------------------------------------------------
# One entry per question: {question, multi, options: [{name, chosen}], other}.
# Match the visible question group, not similarly named controls elsewhere.
# Both current toggle controls and older numbered buttons are supported.
# Windows PowerShell 5 returns a parsed JSON array as one object; unroll it.
$parsed = ConvertFrom-Json ([IO.File]::ReadAllText($Choice, [Text.Encoding]::UTF8))
$pages = @(); foreach ($entry in $parsed) { $pages += , $entry }
if (-not $pages.Count) { Finish $false 'bad_choice' }
function Question-Open { [bool](Button-Named (Root) '^Skip$') -or [bool](@(Question-Cards).Count) }
function Question-Root($page) {
  $wanted = & $norm ([string]$page.question)
  if (-not $wanted) { return $null }
  $groups = @(Find-All (Root) $CT::Group | Where-Object {
    $actual = & $norm $_.Current.Name
    $matches = if ($wanted.EndsWith($Ellipsis)) { $actual.StartsWith($wanted.Substring(0, $wanted.Length - 1)) } else { $actual -ceq $wanted }
    # Skip on AskUserQuestion pages; only Submit on the safeguard card.
    $matches -and (Button-Named $_ '^(?:Skip|Submit)$')
  })
  if ($groups.Count -eq 1) { return $groups[0] }
  return $null
}
function Question-Control($root, $pattern) {
  $all = @((Find-All $root $CT::Button)) + @((Find-All $root $CT::CheckBox)) + @((Find-All $root $CT::RadioButton))
  $matches = @($all | Where-Object { (& $norm $_.Current.Name) -cmatch $pattern })
  if ($matches.Count -eq 1) { return $matches[0] }
  return $null
}
function Select-QuestionOption($button) {
  if ($null -ne (Toggle-State $button)) { return (Set-Toggle $button $true) }
  try { $button.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return $true } catch { }
  Invoke-Button $button
  return $true
}
function Check-QuestionRequest {
  if ((Focused-Session) -ne $SessionId) { Finish $false 'prompt_mismatch' }
  if (-not (Request-Pending)) { Finish $false 'request_stale' }
}
if (-not $expectKey -or -not $RequestId) { Finish $false 'nothing_to_verify' }
Check-QuestionRequest
# If a previous attempt stopped on a later page, return to page one without
# submitting. Then set all choices to the phone's exact desired state.
for ($back = 0; $back -lt $pages.Count -and -not (Question-Root $pages[0]); $back++) {
  Check-QuestionRequest
  $previous = Button-Named (Root) '^Show previous question$'
  if (-not $previous -or -not $previous.Current.IsEnabled) { break }
  Invoke-Button $previous
  Start-Sleep -Milliseconds 350
}
if (-not (Wait-For { Question-Root $pages[0] } 24)) { Finish $false 'prompt_not_found' }
for ($index = 0; $index -lt $pages.Count; $index++) {
  $page = $pages[$index]
  $last = $index -eq $pages.Count - 1
  $options = @($page.options | Where-Object { $_ -and $_.name })
  $chosen = @($options | Where-Object { $_.chosen })
  $other = [string]$page.other
  $multi = [bool]$page.multi
  if (-not $options.Count) { Finish $false 'bad_choice' }
  Check-QuestionRequest
  $root = Wait-For { Question-Root $page } 24
  if (-not $root) { Finish $false 'prompt_mismatch' }
  $advanced = $false
  if ($multi) {
    foreach ($option in $options) {
      $button = Question-Control $root (Name-Pattern ([string]$option.name) $false)
      if (-not $button) { Finish $false 'option_not_found' }
      if (-not (Set-Toggle $button ([bool]$option.chosen))) { Finish $false 'option_not_set' }
    }
    $otherButton = Question-Control $root '^Other$'
    if ($other -and -not $otherButton) { Finish $false 'option_not_found' }
    if ($otherButton -and -not (Set-Toggle $otherButton ([bool]$other))) { Finish $false 'option_not_set' }
    if ($other -and -not (Set-EditText 'Other option' $other)) { Finish $false 'text_not_set' }
  } elseif ($other) {
    $b = Question-Control $root '^Other(?: \d+)?$'; if (-not $b) { Finish $false 'option_not_found' }
    if (-not (Select-QuestionOption $b)) { Finish $false 'option_not_set' }
    if (-not (Set-EditText 'Other option' $other)) { Finish $false 'text_not_set' }
  } else {
    if ($chosen.Count -ne 1) { Finish $false 'bad_choice' }
    $b = Question-Control $root (Name-Pattern ([string]$chosen[0].name) $true)
    if (-not $b) { Finish $false 'option_not_found' }
    if (-not (Select-QuestionOption $b)) { Finish $false 'option_not_set' }
    Start-Sleep -Milliseconds 600
    # Older single-choice buttons advance; current toggles require Next.
    # Use the question identity: the next page may have identical options.
    # Desktop 2.42304.2 re-renders the page right after a choice, so one
    # missed lookup is not an advance (it skipped Next, seen 2026-10-20): wait
    # until the next page shows, or this one is seen again.
    $nextPage = if ($last) { $null } else { $pages[$index + 1] }
    $advanced = $null
    for ($look = 0; $look -lt 20 -and $null -eq $advanced; $look++) {
      if ($nextPage -and (Question-Root $nextPage)) { $advanced = $true }
      elseif (Question-Root $page) { $advanced = $false }
      elseif ($last -and -not (Request-Pending)) { $advanced = $true }
      else { Start-Sleep -Milliseconds 250 }
    }
    if ($null -eq $advanced) { Finish $false 'prompt_mismatch' }
  }
  if (-not $advanced) {
    Check-QuestionRequest
    $step = if ($last) { '^Submit$' } else { '^Next$' }
    $b = Wait-For { Button-Named (Question-Root $page) $step } 8
    if (-not $b) { Finish $false 'button_not_found' }
    Invoke-Button $b
    Start-Sleep -Milliseconds 500
    # Just after the answer opened the session, the desktop app can ignore the
    # click: the page stayed for 9 s (seen 2026-10-25, every first try from a
    # different session). Click again while this same page is still shown.
    $nextPage = if ($last) { $null } else { $pages[$index + 1] }
    for ($wake = 0; $wake -lt 4; $wake++) {
      $moved = Wait-For { if ($nextPage) { Question-Root $nextPage } elseif (-not (Question-Root $page)) { $true } } 12
      if ($moved) { break }
      Check-QuestionRequest
      $b = Button-Named (Question-Root $page) $step
      if (-not $b) { break }
      if (-not $b.Current.IsEnabled -and -not $multi -and -not $other) {
        $choiceButton = Question-Control (Question-Root $page) (Name-Pattern ([string]$chosen[0].name) $true)
        if ($choiceButton) { Select-QuestionOption $choiceButton | Out-Null; Start-Sleep -Milliseconds 600 }
      }
      if ($b.Current.IsEnabled) { Invoke-Button $b; Start-Sleep -Milliseconds 500 }
    }
  }
}
if (Wait-For { -not (Request-Pending) } 40) { Finish $true $null } else { Finish $false 'prompt_still_open' }
