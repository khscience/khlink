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
#   -Mode settings  open the conversation and read its model and agent
#                permission selectors (each menu is opened, read and closed)
#   -Mode set    choose a model and/or permission preset: -TextFile holds
#                {"model":"Gemini 3.8 Flash High","permission":"Auto"}; the
#                selector's label is read back to confirm the choice
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
  [ValidateSet('send', 'stop', 'probe', 'check', 'list', 'answer', 'open', 'settings', 'set')][string]$Mode = 'send',
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
# Shows or hides the sidebar. Older versions expose its toggle as a plain
# button (Invoke); since 2.32 it is an expand/collapse button.
function Set-Sidebar($toggle, $show) {
  try { $toggle.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch {}
  try { $pattern = $toggle.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern) } catch { return $false }
  try { if ($show) { $pattern.Expand() } else { $pattern.Collapse() } } catch { return $false }
  return $true
}
# Antigravity 2.32's accessibility tree only catches up when it is asked to
# do something (seen: links still missing seconds after the sidebar opened);
# scrolling the toggle into view, where it already is, is a no-op that does.
function Nudge-Tree($element) {
  try { $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
}
function Out-Result($ok, $reason, $extra) {
  if ($script:sidebarShown) { Set-Sidebar $script:sidebarShown $false | Out-Null; $script:sidebarShown = $null }
  # Hand the foreground back to the window the user had in front.
  if ($script:previous -ne [IntPtr]::Zero -and $script:previous -ne $proc.MainWindowHandle -and [KhAgWin]::GetForegroundWindow() -eq $proc.MainWindowHandle) {
    [KhAgWin]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhAgWin]::SetForegroundWindow($script:previous) | Out-Null; [KhAgWin]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
  }
  if ($script:wasMinimized) { Start-Sleep -Milliseconds 300; [KhAgWin]::ShowWindow($proc.MainWindowHandle, 6) | Out-Null }
  $o = @{ ok = $ok; reason = $reason; elapsedMs = $script:phaseClock.ElapsedMilliseconds; mayHaveSent = $script:sendAttempted }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); exit 0
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
  # 2.32 reports the new focus only after the tree is nudged: look a few times.
  for ($try = 0; $try -lt 6; $try++) {
    Start-Sleep -Milliseconds 200
    Nudge-Tree $box
    $focused = $ae::FocusedElement
    if (-not $focused -or [KhAgWin]::GetForegroundWindow() -ne $hwnd) { return $false }
    # Recent editors focus a child of the combobox. Only accept that editor's
    # own descendants, never a different control or another window.
    for ($depth = 0; $depth -lt 8 -and $focused; $depth++) {
      if ([System.Windows.Automation.Automation]::Compare($focused.GetRuntimeId(), $box.GetRuntimeId())) { return $true }
      $focused = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($focused)
    }
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

# With the sidebar hidden (its toggle in the title bar) no conversation link
# exists at all: show it for this run and hide it again in Out-Result.
function Any-ConversationLink {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  foreach ($l in $win.FindAll($scope, $c)) {
    try { if ($l.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -match '/c/[0-9a-f-]{36}$|/history$') { return $true } } catch {}
  }
  return $false
}
function Show-Sidebar {
  $toggle = Find-Named ([System.Windows.Automation.ControlType]::Button) 'Toggle Sidebar'
  if ($toggle) { Nudge-Tree $toggle; Start-Sleep -Milliseconds 150 }
  if (Any-ConversationLink) { return }
  if (-not $toggle) { return }
  if (-not (Set-Sidebar $toggle $true)) { return }
  $script:sidebarShown = $toggle
  for ($i = 0; $i -lt 20 -and -not (Any-ConversationLink); $i++) { Start-Sleep -Milliseconds 150; Nudge-Tree $toggle }
}
$link = Find-Link $ConversationId
if (-not $link -and $Mode -ne 'probe') { Show-Sidebar; $link = Find-Link $ConversationId }
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
    if ([KhAgWin]::IsIconic($hwnd)) { $script:wasMinimized = $true; [KhAgWin]::ShowWindow($hwnd, $(if ($Mode -in @('answer', 'open', 'stop', 'settings', 'set')) { 4 } else { 9 })) | Out-Null; Start-Sleep -Milliseconds 700 }
    $history.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    for ($i = 0; $i -lt 15 -and -not $link; $i++) { Start-Sleep -Milliseconds 200; $link = Find-Link $ConversationId }
  }
}
# The page's own address names the conversation shown, sidebar or not
# (2.32: https://127.0.0.1:<port>/c/<id>?project=...).
function Shown-ConversationId {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
  foreach ($d in $win.FindAll($scope, $c)) {
    try { if ($d.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -match '/c/([0-9a-f-]{36})(\?|$)') { return $Matches[1] } } catch {}
  }
  return ''
}
# A probe only asks about the conversation in front; with the sidebar hidden
# it is recognised by that address and the window title.
$shownTitle = ''
if (-not $link -and $Mode -eq 'probe' -and (Shown-ConversationId) -eq $ConversationId) {
  $name = [string]$win.Current.Name
  $cut = $name.IndexOf(' - ')
  if ($cut -gt 0) { $shownTitle = $name.Substring(0, $cut) }
}
if (-not $link -and -not $shownTitle) { Out-Result $false 'conversation_not_in_sidebar' }
if ($Mode -eq 'probe') {
  $box = Find-MessageBox
  $send = Find-Named ([System.Windows.Automation.ControlType]::Button) 'Send message'
  $title = if ($link) { [string]$link.Current.Name } else { $shownTitle }
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
if ([KhAgWin]::IsIconic($hwnd)) { $script:wasMinimized = $true; [KhAgWin]::ShowWindow($hwnd, $(if ($Mode -in @('answer', 'open', 'stop', 'settings', 'set')) { 4 } else { 9 })) | Out-Null; Start-Sleep -Milliseconds 700 }
$link.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$targetTitle = [string]$link.Current.Name
function Is-TargetOpen {
  # 2.32 shortens a long title in the window's name; its page address is exact.
  if ((Shown-ConversationId) -eq $ConversationId) { return $true }
  $name = [string]$win.Current.Name
  return $targetTitle.Length -gt 0 -and ($name -eq $targetTitle -or $name.StartsWith("$targetTitle - ", [System.StringComparison]::Ordinal))
}
$box = $null
$opened = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 150
  Nudge-Tree $link
  # While a question is showing, its panel takes the message box's place.
  $opened = Is-TargetOpen
  if ($Mode -in @('answer', 'open', 'stop', 'settings', 'set')) { if ($opened) { break } else { continue } }
  $box = Find-MessageBox
  if ($box -and $opened) { break }
}
if (-not $opened) { Out-Result $false 'conversation_not_opened' }
Write-ProgressState 'opened' @{}
if (-not $box -and $Mode -in @('send', 'check')) { Out-Result $false 'no_message_box' }
if ($Mode -eq 'open') { Out-Result $true 'opened' @{ title = $link.Current.Name } }

# The model and permission selectors under the message box are menu buttons
# (ExpandCollapse): "Select model, current: Gemini 3.8 Flash High" and
# "Agent permissions preset selector, current: Auto". Their menus list the
# choices as menu items; a model item may end in " Notice" or " Unavailable".
if ($Mode -in @('settings', 'set')) {
  $presets = @('Request Review', 'Default', 'Auto', 'Turbo')
  function Selector($prefix) {
    $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll($scope, $c)) { if ([string]$b.Current.Name -like "$prefix*") { return $b } }
    return $null
  }
  function Current-Of($button) { if ($button -and [string]$button.Current.Name -match 'current:\s*(.+)$') { return $Matches[1].Trim() } return '' }
  function Menu-Items($button) {
    Nudge-Tree $button
    try { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() } catch {}
    $items = @()
    for ($i = 0; $i -lt 20 -and -not $items.Count; $i++) {
      Start-Sleep -Milliseconds 150
      Nudge-Tree $button
      # The open menu bears its button's name; a menu just closed can linger in the tree.
      $label = [string]$button.Current.Name
      $menuCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Menu)
      $itemCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
      foreach ($menu in $win.FindAll($scope, $menuCondition)) {
        if ([string]$menu.Current.Name -ne $label) { continue }
        $items = @($menu.FindAll($scope, $itemCondition) | Where-Object { $_.Current.Name -and $_.Current.Name -ne 'View Usage' })
        if ($items.Count) { break }
      }
    }
    return $items
  }
  function Close-Menu($button) { try { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {} ; Start-Sleep -Milliseconds 200; Nudge-Tree $button }
  # A model with thinking levels (Gemini) is a submenu, labelled with the level
  # in use ("Gemini 3.8 Flash High"); its levels are radio buttons in a menu of
  # that same label. Only the keyboard opens it: focus the item, then Right.
  function Has-Levels($item) { return ($item.GetSupportedPatterns() -contains [System.Windows.Automation.ExpandCollapsePattern]::Pattern) }
  function Level-Buttons($item) {
    $label = [string]$item.Current.Name
    if (-not (Ensure-Foreground)) { return @() }
    try { $item.SetFocus() } catch { return @() }
    [System.Windows.Forms.SendKeys]::SendWait('{RIGHT}')
    $menuCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Menu)
    $radioCondition = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Milliseconds 150
      Nudge-Tree $item
      foreach ($menu in $win.FindAll($scope, $menuCondition)) {
        if ([string]$menu.Current.Name -ne $label) { continue }
        $radios = @($menu.FindAll($scope, $radioCondition))
        if ($radios.Count) { return $radios }
      }
    }
    return @()
  }
  function Model-Option($item, $withLevels) {
    $name = [string]$item.Current.Name
    $state = ''
    if ($name -match '^(.*?)\s+(Notice|Unavailable|New)$') { $name = $Matches[1]; $state = $Matches[2] }
    $option = @{ name = $name; available = ($state -ne 'Unavailable') }
    if ($withLevels -and (Has-Levels $item)) {
      $levels = @(Level-Buttons $item | ForEach-Object { [string]$_.Current.Name })
      # Back to the main menu (focus is still on it), so it can be closed as usual.
      if ($levels.Count) { [System.Windows.Forms.SendKeys]::SendWait('{LEFT}'); Start-Sleep -Milliseconds 150 }
      foreach ($level in $levels) {
        if ($name.EndsWith(" $level", [System.StringComparison]::Ordinal)) { $option.name = $name.Substring(0, $name.Length - $level.Length - 1); $option.level = $level }
      }
      if ($levels.Count) { $option.levels = $levels }
    }
    return $option
  }
  # A menu that was just closed can linger in the tree: keep each list to its own kind.
  function Is-Preset($item) {
    $name = [string]$item.Current.Name
    foreach ($p in $presets) { if ($name -eq $p -or $name.StartsWith("$p ", [System.StringComparison]::Ordinal)) { return $true } }
    return $false
  }
  function Preset-Option($item) {
    $name = [string]$item.Current.Name
    foreach ($p in $presets) {
      if ($name -eq $p -or $name.StartsWith("$p ", [System.StringComparison]::Ordinal)) {
        $detail = $name.Substring($p.Length).Trim() -replace '^Default\s+', ''
        return @{ name = $p; detail = $detail; isDefault = ($name.Substring($p.Length).Trim() -match '^Default\s') }
      }
    }
    @{ name = $name; detail = ''; isDefault = $false }
  }
  $modelButton = Selector 'Select model'
  $presetButton = Selector 'Agent permissions preset'
  if (-not $modelButton -and -not $presetButton) { Out-Result $false 'no_settings' }
  if ($Mode -eq 'settings') {
    $models = @(); $permissions = @()
    if ($modelButton) { $models = @(Menu-Items $modelButton | Where-Object { -not (Is-Preset $_) } | ForEach-Object { Model-Option $_ $true }); Close-Menu $modelButton }
    if ($presetButton) { $permissions = @(Menu-Items $presetButton | Where-Object { Is-Preset $_ } | ForEach-Object { Preset-Option $_ }); Close-Menu $presetButton }
    Out-Result $true 'settings' @{ model = (Current-Of $modelButton); permission = (Current-Of $presetButton); models = $models; permissions = $permissions }
  }
  $request = $null
  try { $request = ([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) } catch {}
  if (-not $request -or (-not $request.model -and -not $request.permission)) { Out-Result $false 'bad_settings' }
  function Wait-Current($button, $wanted) {
    for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Milliseconds 150; Nudge-Tree $button; if ((Current-Of $button) -eq $wanted) { return $true } }
    return $false
  }
  function Press($element) {
    try { $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true }
    catch { try { $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); return $true } catch { return $false } }
  }
  function Choose-Preset($wanted) {
    if ((Current-Of $presetButton) -eq $wanted) { return $true }
    $target = Menu-Items $presetButton | Where-Object { (Is-Preset $_) -and (Preset-Option $_).name -eq $wanted } | Select-Object -First 1
    if (-not $target -or -not (Press $target)) { Close-Menu $presetButton; return $false }
    return (Wait-Current $presetButton $wanted)
  }
  # $level only for a model with levels; without one it keeps the level shown.
  function Choose-Model($wanted, $level) {
    $current = Current-Of $modelButton
    if ($current -eq $wanted -or ($level -and $current -eq "$wanted $level")) { return 'ok' }
    $target = $null
    foreach ($item in (Menu-Items $modelButton | Where-Object { -not (Is-Preset $_) })) {
      $name = (Model-Option $item $false).name
      if ($name -eq $wanted -or ((Has-Levels $item) -and $name.StartsWith("$wanted ", [System.StringComparison]::Ordinal))) { $target = $item; break }
    }
    if (-not $target) { Close-Menu $modelButton; return 'model_not_set' }
    if (-not (Has-Levels $target)) {
      if (-not (Press $target)) { Close-Menu $modelButton; return 'model_not_set' }
      if (Wait-Current $modelButton $wanted) { return 'ok' } else { return 'model_not_set' }
    }
    $buttons = @(Level-Buttons $target)
    if (-not $level) { $shown = [string]$target.Current.Name; foreach ($b in $buttons) { if ($shown.EndsWith(" $($b.Current.Name)", [System.StringComparison]::Ordinal)) { $level = [string]$b.Current.Name } } }
    $pick = $buttons | Where-Object { [string]$_.Current.Name -eq $level } | Select-Object -First 1
    if (-not $pick -or -not (Press $pick)) { Close-Menu $modelButton; return 'level_not_set' }
    if (Wait-Current $modelButton "$wanted $level") { return 'ok' } else { return 'level_not_set' }
  }
  if ($request.model) {
    if (-not $modelButton) { Out-Result $false 'no_settings' }
    $outcome = Choose-Model ([string]$request.model) ([string]$request.level)
    if ($outcome -ne 'ok') { Out-Result $false $outcome @{ model = (Current-Of $modelButton) } }
  }
  if ($request.permission) {
    if (-not $presetButton) { Out-Result $false 'no_settings' }
    if (-not (Choose-Preset ([string]$request.permission))) { Out-Result $false 'permission_not_set' @{ permission = (Current-Of $presetButton) } }
  }
  Out-Result $true 'set' @{ model = (Current-Of $modelButton); permission = (Current-Of $presetButton) }
}

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
  # "Submit" / "Continue" (2.32 adds a hidden " ?" glyph), or an older UI's
  # "Next"; never 2.32's "Next question", which only turns the page.
  function Find-Submit {
    $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll($scope, $c)) {
      $name = [string]$b.Current.Name
      if ($name -match '^(?i)(submit|continue|next)\b' -and $name -notmatch '^(?i)next question$' -and $b.Current.IsEnabled) { return $b }
    }
    return $null
  }
  function Find-Button($name) {
    $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    foreach ($b in $win.FindAll($scope, $c)) { if ([string]$b.Current.Name -eq $name) { return $b } }
    return $null
  }
  # The page a choice belongs to: its id is "ask-opt-<page>-<n>".
  function Page-Of($choice) { if ([string]$choice.Current.AutomationId -match '^(ask-opt-.+)-[^-]+$') { return $Matches[1] } return '' }
  function Nudge-Choices { $anchor = Find-Button 'Cancel questionnaire'; if ($anchor) { Nudge-Tree $anchor } }
  # Antigravity 2.32 shows several questions one page at a time ("1 / 3",
  # Previous / Next question). Choosing an option of a single-choice question
  # turns the page by itself; the last page has the Submit button.
  $paged = [bool](Find-Button 'Next question')
  $norm = { param($t) (([string]$t) -replace '^\d+\s+', '' -replace '\s+', ' ').Trim() }
  $index = 0
  $page = ''
  $total = @($request.answers).Count
  foreach ($answer in $request.answers) {
    $choices = @()
    for ($i = 0; $i -lt 20 -and -not $choices.Count; $i++) {
      if ($i) { Start-Sleep -Milliseconds 200 }
      Nudge-Choices
      $choices = @(Choices)
      # Paged: wait until the page has turned (the previous one can linger).
      if ($paged -and $page) { $choices = @($choices | Where-Object { (Page-Of $_) -and (Page-Of $_) -ne $page }) }
    }
    if (-not $choices.Count) { Out-Result $false 'no_question' @{ question = $index } }
    if ($paged) { $here = Page-Of $choices[0]; $choices = @($choices | Where-Object { (Page-Of $_) -eq $here }) }
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
    if ($paged -and $index -lt $total - 1) {
      # Not the last page: it turns by itself after a single choice; after a
      # multiple choice or a written answer, turn it with Next question.
      $page = $here
      $turned = $false
      for ($i = 0; $i -lt 8 -and -not $turned; $i++) {
        Nudge-Choices
        $turned = [bool](@(Choices) | Where-Object { (Page-Of $_) -and (Page-Of $_) -ne $page } | Select-Object -First 1)
        if (-not $turned) { Start-Sleep -Milliseconds 150 }
      }
      if (-not $turned) {
        $next = Find-Button 'Next question'
        if (-not $next -or -not $next.Current.IsEnabled) { Out-Result $false 'submit_unavailable' @{ question = $index } }
        $next.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      }
      $index++
      continue
    }
    $submit = $null
    for ($i = 0; $i -lt 15 -and -not $submit; $i++) { Nudge-Choices; $submit = Find-Submit; if (-not $submit) { Start-Sleep -Milliseconds 150 } }
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
# The pasted text can take a moment to show in the tree (2.32); look again before giving up.
$taken = $false
for ($try = 0; $try -lt 6 -and -not $taken; $try++) {
  if ($try) { Start-Sleep -Milliseconds 200; Nudge-Tree $box }
  $taken = (& $norm (Box-Text $box)) -eq (& $norm $text)
}
if (-not $taken) { Clear-Box $box; Out-Result $false 'text_not_taken' }
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
