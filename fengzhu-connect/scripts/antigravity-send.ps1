# Drive a Google Antigravity conversation through the app's own window, as if
# done by hand: open the conversation (from the sidebar, or from the
# Conversation History page when the sidebar does not list it), put the text
# in its message box, press its Send button (or its Stop button).
#
#   -Mode send   switch to the conversation, put the message in, press Send
#   -Mode stop   press Stop in the conversation
#   -Mode probe  only look: is the conversation, message box and Send there
#   -Mode check  like send, but clear the box again instead of pressing Send
#   -Mode list   only look: the conversation ids in the sidebar
#   -Mode open   only open the conversation (window left as it was)
#   -Mode answer answer the question Antigravity is asking (ask_question):
#                -TextFile holds {"answers":[{"labels":[...],"other":"..."}]};
#                the options are radio buttons / check boxes ("1 Apple") and
#                Submit, all pressed through UI Automation. The panel is only
#                drawn while the window is not minimized, so a minimized
#                window is shown without activating it and minimized again.
#   -IdleSeconds N  (send) do nothing and answer user_active when the keyboard
#                or mouse was used in the last N seconds, so a send does not
#                pull the window out from under someone at the computer
#
# It does not use Antigravity's local server, its debugging port or any
# sign-in token: every request to Google is made by Antigravity itself,
# exactly as when the button is pressed by hand. Opening the conversation and
# pressing buttons is UI Automation (Invoke). Its message editor does not take
# text through UI Automation, so the text is pasted: the window is brought to
# the front, the keyboard focus is checked to be in the message box (nothing is
# pasted anywhere else), the clipboard is restored afterwards and the window
# that was in front before gets the foreground back.
# Safety: `send` refuses when the message box already holds a draft, so a
# half-typed message on the computer is never sent or overwritten.
# Output: one JSON line {ok, reason?}.
param(
  [string]$ConversationId = '',
  [string]$TextFile = '',
  [string]$ProgressFile = '',
  [ValidateSet('send', 'stop', 'probe', 'check', 'list', 'answer', 'open')][string]$Mode = 'send',
  [int]$IdleSeconds = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KhAgWin {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  // Milliseconds since the last keyboard or mouse input in this session.
  public static uint IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO(); info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return uint.MaxValue;
    return (uint)Environment.TickCount - info.dwTime;
  }
}
'@
$script:previous = [IntPtr]::Zero
$script:wasMinimized = $false
$script:sendAttempted = $false
$script:phaseClock = [Diagnostics.Stopwatch]::StartNew()
function Write-ProgressState($phase, $extra) {
  if (-not $ProgressFile) { return }
  $state = @{ phase = $phase; elapsedMs = $script:phaseClock.ElapsedMilliseconds; mayHaveSent = $script:sendAttempted }
  if ($extra) { foreach ($key in $extra.Keys) { $state[$key] = $extra[$key] } }
  [System.IO.File]::WriteAllText($ProgressFile, ($state | ConvertTo-Json -Compress))
}
function Out-Result($ok, $reason, $extra) {
  # Hand the foreground back to the window the user had in front.
  if ($script:previous -ne [IntPtr]::Zero -and $script:previous -ne $proc.MainWindowHandle -and [KhAgWin]::GetForegroundWindow() -eq $proc.MainWindowHandle) {
    [KhAgWin]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhAgWin]::SetForegroundWindow($script:previous) | Out-Null; [KhAgWin]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
  }
  if ($script:wasMinimized) { Start-Sleep -Milliseconds 300; [KhAgWin]::ShowWindow($proc.MainWindowHandle, 6) | Out-Null }
  $o = @{ ok = $ok; reason = $reason; elapsedMs = $script:phaseClock.ElapsedMilliseconds; mayHaveSent = $script:sendAttempted }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); exit 0
}
trap { Out-Result $false 'automation_error' @{ mayHaveSent = $script:sendAttempted } }
if ($Mode -ne 'list' -and $ConversationId -notmatch '^[0-9a-f-]{36}$') { Out-Result $false 'bad_conversation_id' }

$proc = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Out-Result $false 'not_running' }
$hwnd = $proc.MainWindowHandle
$win = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
Write-ProgressState 'finding' @{}
$ae = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]::Descendants

function Find-Named($type, $name) {
  $c1 = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, $type)
  $c2 = New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, $name)
  return $win.FindFirst($scope, (New-Object System.Windows.Automation.AndCondition($c1, $c2)))
}
function Find-Link($id) {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  foreach ($link in $win.FindAll($scope, $c)) {
    try { $v = $link.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { continue }
    if ($v -match "/c/$id$") { return $link }
  }
  return $null
}
# A project in the sidebar lists only its latest conversations behind a
# "See all (N)" button; pressing it shows the rest.
function SeeAll-Buttons {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  return @($win.FindAll($scope, $c) | Where-Object { [string]$_.Current.Name -match '^See all \(\d+\)$' })
}
function Find-MessageBox { return Find-Named ([System.Windows.Automation.ControlType]::ComboBox) 'Message input' }
# The editor reports its placeholder ("Message input") while empty.
function Box-Text($box) {
  try { $t = [string]$box.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) } catch { return '' }
  $t = ($t -replace "`r", '').Trim()
  if ($t -eq 'Message input') { return '' }
  return $t
}
function Ensure-Foreground {
  for ($try = 0; $try -lt 3; $try++) {
    if ([KhAgWin]::GetForegroundWindow() -eq $hwnd -and -not [KhAgWin]::IsIconic($hwnd)) { return $true }
    if ([KhAgWin]::IsIconic($hwnd)) { [KhAgWin]::ShowWindow($hwnd, 9) | Out-Null }
    # A synthetic F24 lets a background process hand over the foreground; it does nothing anywhere.
    [KhAgWin]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhAgWin]::SetForegroundWindow($hwnd) | Out-Null; [KhAgWin]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  return ([KhAgWin]::GetForegroundWindow() -eq $hwnd -and -not [KhAgWin]::IsIconic($hwnd))
}
# Keystrokes only ever go out with Antigravity in front and the focus in its message box.
function Focus-Box($box) {
  $script:focusIssue = 'foreground_unavailable'
  if (-not (Ensure-Foreground)) { return $false }
  $script:focusIssue = 'focus_unavailable'
  try { $box.SetFocus() } catch { return $false }
  Start-Sleep -Milliseconds 200
  $focused = $ae::FocusedElement
  if (-not $focused -or [KhAgWin]::GetForegroundWindow() -ne $hwnd) { return $false }
  # Recent editors focus a child of the combobox. Only accept that editor's
  # own descendants, never a different control or another window.
  for ($depth = 0; $depth -lt 8 -and $focused; $depth++) {
    if ([System.Windows.Automation.Automation]::Compare($focused.GetRuntimeId(), $box.GetRuntimeId())) { return $true }
    $focused = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($focused)
  }
  $script:focusIssue = 'focus_outside_editor'
  return $false
}
function Paste-Into($box, $value) {
  $saved = $null
  try { $saved = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
  try {
    if (-not (Focus-Box $box)) { return $false }
    [System.Windows.Forms.Clipboard]::SetText($value)
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 350
    return $true
  } finally {
    try { if ($null -ne $saved) { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}
  }
}
function Clear-Box($box) {
  if (-not (Focus-Box $box)) { return }
  [System.Windows.Forms.SendKeys]::SendWait('^a'); [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
}

if ($Mode -eq 'list') {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  $ids = @()
  foreach ($l in $win.FindAll($scope, $c)) {
    try { $v = $l.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { continue }
    if ($v -match '/c/([0-9a-f-]{36})$') { $ids += $Matches[1] }
  }
  Out-Result $true 'list' @{ ids = @($ids | Select-Object -Unique); collapsed = [bool](SeeAll-Buttons).Count }
}
if ($Mode -eq 'send' -and $IdleSeconds -gt 0) {
  $idle = [KhAgWin]::IdleMs()
  if ($idle -lt $IdleSeconds * 1000) { Out-Result $false 'user_active' @{ idleMs = $idle } }
}

$link = Find-Link $ConversationId
if (-not $link -and $Mode -ne 'probe') {
  $more = SeeAll-Buttons
  foreach ($b in $more) { try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {} }
  if ($more.Count) { Start-Sleep -Milliseconds 600; $link = Find-Link $ConversationId }
}
# Conversations outside pinned and projects are on the Conversation History
# page. That page is only drawn while the window is not minimized.
if (-not $link -and $Mode -ne 'probe') {
  $history = $null
  $hc = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  foreach ($l in $win.FindAll($scope, $hc)) {
    try { if ($l.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -match '/history$') { $history = $l; break } } catch {}
  }
  if ($history) {
    $script:previous = [KhAgWin]::GetForegroundWindow()
    if ([KhAgWin]::IsIconic($hwnd)) { $script:wasMinimized = $true; [KhAgWin]::ShowWindow($hwnd, $(if ($Mode -in @('answer', 'open', 'stop')) { 4 } else { 9 })) | Out-Null; Start-Sleep -Milliseconds 700 }
    $history.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 15 -and -not $link; $i++) { Start-Sleep -Milliseconds 200; $link = Find-Link $ConversationId }
  }
}
if (-not $link) { Out-Result $false 'conversation_not_in_sidebar' }
if ($Mode -eq 'probe') {
  $box = Find-MessageBox
  $send = Find-Named ([System.Windows.Automation.ControlType]::Button) 'Send message'
  $title = [string]$link.Current.Name
  $current = $title.Length -gt 0 -and ([string]$win.Current.Name).StartsWith("$title - ", [System.StringComparison]::Ordinal)
  $active = $false
  $buttonCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($button in $win.FindAll($scope, $buttonCondition)) {
    if ($button.Current.IsEnabled -and [string]$button.Current.Name -match '^(?i)(stop task|(stop|cancel)( generation| response)?( \(ctrl\+\w\))?)$') { $active = $true; break }
  }
  Out-Result $true 'probe' @{ link = [bool]$link; box = [bool]$box; send = [bool]($send -and $send.Current.IsEnabled); title = $title; current = $current; active = $active; foreground = ([KhAgWin]::GetForegroundWindow() -eq $hwnd -and -not [KhAgWin]::IsIconic($hwnd)); observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
}

if ($script:previous -eq [IntPtr]::Zero) { $script:previous = [KhAgWin]::GetForegroundWindow() }
# answer: shown without activation (SW_SHOWNOACTIVATE); send needs it in front anyway.
if ([KhAgWin]::IsIconic($hwnd)) { $script:wasMinimized = $true; [KhAgWin]::ShowWindow($hwnd, $(if ($Mode -in @('answer', 'open', 'stop')) { 4 } else { 9 })) | Out-Null; Start-Sleep -Milliseconds 700 }
$link.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$targetTitle = [string]$link.Current.Name
function Is-TargetOpen {
  $name = [string]$win.Current.Name
  return $targetTitle.Length -gt 0 -and ($name -eq $targetTitle -or $name.StartsWith("$targetTitle - ", [System.StringComparison]::Ordinal))
}
$box = $null
$opened = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 150
  # While a question is showing, its panel takes the message box's place.
  $opened = Is-TargetOpen
  if ($Mode -in @('answer', 'open', 'stop')) { if ($opened) { break } else { continue } }
  $box = Find-MessageBox
  if ($box -and $opened) { break }
}
if (-not $opened) { Out-Result $false 'conversation_not_opened' }
Write-ProgressState 'opened' @{}
if (-not $box -and $Mode -in @('send', 'check')) { Out-Result $false 'no_message_box' }
if ($Mode -eq 'open') { Out-Result $true 'opened' @{ title = $link.Current.Name } }

if ($Mode -eq 'answer') {
  $request = $null
  try { $request = ([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) } catch {}
  if (-not $request -or -not $request.answers) { Out-Result $false 'bad_answer' }
  $choiceTypes = @([System.Windows.Automation.ControlType]::RadioButton, [System.Windows.Automation.ControlType]::CheckBox)
  function Choices {
    $found = @()
    foreach ($t in $choiceTypes) {
      $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, $t)
      foreach ($e in $win.FindAll($scope, $c)) { if ([string]$e.Current.Name -match '^\d+\s') { $found += $e } }
    }
    return $found
  }
  function Pick($el) {
    try { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return } catch {}
    try { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); return } catch {}
    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  function Find-Submit {
    $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll($scope, $c)) { if ([string]$b.Current.Name -match '^(?i)(submit|next)\b' -and $b.Current.IsEnabled) { return $b } }
    return $null
  }
  $norm = { param($t) (([string]$t) -replace '^\d+\s+', '' -replace '\s+', ' ').Trim() }
  $index = 0
  foreach ($answer in $request.answers) {
    $choices = @()
    for ($i = 0; $i -lt 20 -and -not $choices.Count; $i++) { $choices = @(Choices); if (-not $choices.Count) { Start-Sleep -Milliseconds 200 } }
    if (-not $choices.Count) { Out-Result $false 'no_question' @{ question = $index } }
    foreach ($label in @($answer.labels)) {
      $want = & $norm $label
      $hit = $choices | Where-Object { (& $norm $_.Current.Name) -eq $want } | Select-Object -First 1
      if (-not $hit) { Out-Result $false 'option_not_found' @{ question = $index; label = $label } }
      Pick $hit
    }
    if ($answer.other) {
      $other = $choices | Where-Object { $_.Current.Name -match '(?i)^\d+\s+other' } | Select-Object -First 1
      if (-not $other) { Out-Result $false 'option_not_found' @{ question = $index; label = 'Other' } }
      Pick $other; Start-Sleep -Milliseconds 200
      $ec = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $edit = $null; foreach ($e in $win.FindAll($scope, $ec)) { if ([string]$e.Current.Name -match '(?i)^other') { $edit = $e; break } }
      if (-not $edit) { Out-Result $false 'other_not_taken' }
      try { $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$answer.other) } catch { Out-Result $false 'other_not_taken' }
      Start-Sleep -Milliseconds 200
      $got = try { $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { '' }
      if ((& $norm $got) -ne (& $norm $answer.other)) { Out-Result $false 'other_not_taken' }
    }
    Start-Sleep -Milliseconds 200
    $submit = $null
    for ($i = 0; $i -lt 10 -and -not $submit; $i++) { $submit = Find-Submit; if (-not $submit) { Start-Sleep -Milliseconds 150 } }
    if (-not $submit) { Out-Result $false 'submit_unavailable' @{ question = $index } }
    $submit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 600
    $index++
  }
  Out-Result $true 'answered' @{ questions = $index; left = @(Choices).Count }
}

if ($Mode -eq 'stop') {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = @($win.FindAll($scope, $c) | Where-Object { $_.Current.IsEnabled })
  # ask_question replaces the composer and its generation Cancel button.
  # Cancel only this conversation's questionnaire; "Stop execution" in the
  # sidebar belongs to a separate task and must never match this path.
  $question = $buttons | Where-Object { $_.Current.Name -match '^(?i)cancel questionnaire$' } | Select-Object -First 1
  if ($question) {
    $question.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 600
    $buttons = @($win.FindAll($scope, $c) | Where-Object { $_.Current.IsEnabled })
  }
  # A reply being written: "Cancel (Ctrl+D)" ends the turn.
  foreach ($b in $buttons) {
    if ($b.Current.Name -match '^(?i)(stop|cancel)( generation| response)?( \(ctrl\+\w\))?$') {
      $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Out-Result $true 'stopped'
    }
  }
  # Commands left running in the background ("1 task running"): each has "Stop Task".
  $tasks = @($buttons | Where-Object { $_.Current.Name -match '^(?i)stop task$' })
  foreach ($b in $tasks) { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 200 }
  if ($tasks.Count) { Out-Result $true 'stopped' @{ tasks = $tasks.Count } }
  if ($question) { Out-Result $true 'stopped' @{ questionCancelled = $true } }
  Out-Result $false 'no_stop_button'
}

$text = if ($TextFile -and (Test-Path $TextFile)) { [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8) } else { '' }
if ([string]::IsNullOrWhiteSpace($text)) { Out-Result $false 'empty_message' }
if (Box-Text $box) { Out-Result $false 'draft_in_box' }
$norm = { param($t) ($t -replace "`r", '' -replace '\s+', ' ').Trim() }
# The new user message appears in the window before the SQLite checkpoint.
# Count exact matching text nodes before pasting; an older identical message
# cannot acknowledge this send. The editor must also clear after invocation.
function Matching-MessageCount {
  $condition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  $count = 0
  foreach ($element in $win.FindAll($scope, $condition)) {
    if ((& $norm ([string]$element.Current.Name)) -eq (& $norm $text)) { $count++ }
  }
  return $count
}
$beforeMatches = Matching-MessageCount
if (-not (Paste-Into $box $text)) { Out-Result $false 'needs_foreground' @{ focusIssue = $script:focusIssue } }
if ((& $norm (Box-Text $box)) -ne (& $norm $text)) { Clear-Box $box; Out-Result $false 'text_not_taken' }
if ($Mode -eq 'check') {
  $send = Find-Named ([System.Windows.Automation.ControlType]::Button) 'Send message'
  $enabled = [bool]($send -and $send.Current.IsEnabled)
  Clear-Box $box; Start-Sleep -Milliseconds 200
  Out-Result $true 'checked' @{ sendEnabled = $enabled; clearedTo = (Box-Text $box) }
}
$send = $null
for ($i = 0; $i -lt 10; $i++) {
  $send = Find-Named ([System.Windows.Automation.ControlType]::Button) 'Send message'
  if ($send -and $send.Current.IsEnabled) { break }
  Start-Sleep -Milliseconds 150
}
if (-not $send -or -not $send.Current.IsEnabled) { Clear-Box $box; Out-Result $false 'send_unavailable' }
$invoke = $send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$script:sendAttempted = $true
Write-ProgressState 'clicking' @{}
$invoke.Invoke()
Write-ProgressState 'clicked' @{}
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 200
  if (-not (Is-TargetOpen)) { break }
  $currentBox = Find-MessageBox
  if ($currentBox -and -not (Box-Text $currentBox) -and (Matching-MessageCount) -gt $beforeMatches) {
    $receipt = @{ receiptSource = 'window'; confirmedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    Write-ProgressState 'confirmed' $receipt
    Out-Result $true 'confirmed' $receipt
  }
}
Out-Result $true 'clicked' @{ mayHaveSent = $true }
