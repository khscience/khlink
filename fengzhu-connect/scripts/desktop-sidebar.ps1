# Pin, unpin or rename a task in the Codex or Claude desktop sidebar, the way a
# click would, through UI Automation on the app's own controls.
#
#   -App codex  -Action pin|unpin           -TitleFile <the task's title>
#   -App codex  -Action rename -ThreadId <id> -TitleFile <its title> -NameFile <new title>
#   -App claude -Action pin|unpin|rename    -TitleFile <the session's title> [-NameFile <new title>]
#   -App claude -Action archive|unarchive   -TitleFile <the session's title>
#   -App claude -Action rename|archive -SessionId <local_id> -ViaToolbar ...
#       for a title several sessions share (a scheduled task's daily runs):
#       opens that very session and uses the menu in the toolbar above it.
#
# The row is found by its exact title; the caller makes sure no other task has
# that title. A window hidden behind others does not repaint its sidebar (its
# buttons keep their old labels), so the app is brought in front for the
# moment it takes and the previous window is put back afterwards.
# A Codex rename opens the task (codex://threads/<id>), uses the chat's own
# 重命名 menu item, then goes back to the task that was open before.
# A Claude unarchive switches the sidebar's Filter > Status to Archived for the
# moment it takes (archived sessions are listed only there), then puts the
# status the user had back.
# Output: one JSON line {ok, reason?, state?}.
param(
  [ValidateSet('codex', 'claude')][string]$App = 'codex',
  [ValidateSet('pin', 'unpin', 'rename', 'archive', 'unarchive')][string]$Action = 'pin',
  [string]$SessionId = '',
  [switch]$ViaToolbar,
  [Parameter(Mandatory = $true)][string]$TitleFile,
  [string]$NameFile = '',
  [string]$ThreadId = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KhSidebar {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
}
'@
function Out-Result($ok, $reason, $state = $null) {
  if ($script:inOperation) { $script:result = @{ok=$ok;reason=$reason;state=$state}; throw 'KH_SIDEBAR_RESULT' }
  [Console]::Out.WriteLine((@{ ok = $ok; reason = $reason; state = $state } | ConvertTo-Json -Compress)); exit 0
}
$UIA = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$norm = { param($s) ([string]$s -replace '\s+', ' ').Trim() }
$title = & $norm ([IO.File]::ReadAllText($TitleFile, [Text.Encoding]::UTF8))
$newName = if ($NameFile) { & $norm ([IO.File]::ReadAllText($NameFile, [Text.Encoding]::UTF8)) } else { '' }
if (-not $title) { Out-Result $false 'bad_title' }
if ($Action -eq 'rename' -and -not $newName) { Out-Result $false 'bad_choice' }
if ($App -eq 'codex' -and $Action -in @('archive', 'unarchive')) { Out-Result $false 'bad_choice' }
if ($App -eq 'codex' -and $Action -eq 'rename' -and $ThreadId -notmatch '^[0-9a-f-]{36}$') { Out-Result $false 'bad_choice' }

function Get-Window {
  $windows = if ($App -eq 'codex') { @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*\OpenAI.Codex_*' }) }
  else { @(Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*\WindowsApps\*' }) }
  if ($windows.Count -gt 1) { Out-Result $false 'ambiguous_title' }
  if ($windows.Count -eq 1) { return $windows[0] }
}
function Focused-Now {
  . (Join-Path $PSScriptRoot 'claude-desktop-log-path.ps1')
  $log = Desktop-LogPath; if (-not $log) { return $null }
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
  try { $start = [Math]::Max(0, $fs.Length - 4MB); [void]$fs.Seek($start, 'Begin'); $buf = New-Object byte[] ($fs.Length - $start); [void]$fs.Read($buf, 0, $buf.Length) } finally { $fs.Close() }
  $found = [regex]::Matches([Text.Encoding]::UTF8.GetString($buf), 'setFocusedSession: sessionId=(local_[0-9a-f-]{36}|null)')
  if ($found.Count) { return $found[$found.Count - 1].Groups[1].Value }
  return $null
}
function Find-All($root, $type) {
  if (-not $root) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, $type)
  @($root.FindAll($TS::Descendants, $cond))
}
# Claude Desktop draws its menus inside its own window (checked 3.6556). The
# whole desktop is searched only for Codex: that waits on every other app's
# window, 74 s on 2026-10-28 with a slow one open, and every archive timed out.
function Menu-Scope { if ($App -eq 'claude') { $UIA::FromHandle($h) } else { $UIA::RootElement } }
function Menu-Snapshot {
  @(Find-All (Menu-Scope) $CT::Menu | Where-Object { $_.Current.ProcessId -eq $proc.Id -and -not $_.Current.IsOffscreen } | ForEach-Object { ($_.GetRuntimeId() -join ':') })
}
function New-Popup($before) {
  $found = @(Find-All (Menu-Scope) $CT::Menu | Where-Object { $_.Current.ProcessId -eq $proc.Id -and -not $_.Current.IsOffscreen -and ($_.GetRuntimeId() -join ':') -notin $before })
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
function Unique-Named($rows, $names) {
  $found = @($rows | Where-Object { $names -contains $_.Current.Name })
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
function Invoke-Element($e) { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Wait-For($block, $tries = 16) { for ($i = 0; $i -lt $tries; $i++) { $v = & $block; if ($v) { return $v }; Start-Sleep -Milliseconds 250 }; return $null }
function Front($h) {
  # F24 does nothing anywhere; it only lets this process bring a window forward.
  for ($i = 0; $i -lt 3 -and [KhSidebar]::GetForegroundWindow() -ne $h; $i++) {
    [KhSidebar]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero); [KhSidebar]::SetForegroundWindow($h) | Out-Null; [KhSidebar]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
  }
  # Seen 2026-10-13: with the input panel (TextInputHost) in front that is not
  # always enough; sharing its input queue for a moment is.
  if ([KhSidebar]::GetForegroundWindow() -ne $h) {
    $other = [KhSidebar]::GetWindowThreadProcessId([KhSidebar]::GetForegroundWindow(), [IntPtr]::Zero); $me = [KhSidebar]::GetCurrentThreadId()
    if ($other -and [KhSidebar]::AttachThreadInput($me, $other, $true)) {
      [KhSidebar]::BringWindowToTop($h) | Out-Null; [KhSidebar]::SetForegroundWindow($h) | Out-Null
      [KhSidebar]::AttachThreadInput($me, $other, $false) | Out-Null
    }
  }
}
function Press($vk) { [KhSidebar]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [KhSidebar]::keybd_event($vk, 0, 2, [UIntPtr]::Zero) }

$script:inOperation = $true
$script:result = @{ok=$false;reason='script_failed';state=$null}
$script:restoreStatus = $null
$script:actionInvoked = $false
try {
$proc = Get-Window
if (-not $proc) { Out-Result $false 'desktop_not_running' }
$h = $proc.MainWindowHandle
$previous = [KhSidebar]::GetForegroundWindow()
$wasMinimized = [KhSidebar]::IsIconic($h)
if ($wasMinimized) { [KhSidebar]::ShowWindow($h, 9) | Out-Null }
Front $h
Start-Sleep -Milliseconds 900
$script:restoreStatus = $null
function Finish($ok, $reason, $state = $null) {
  if ($ok -and $state -eq 'done') { $script:actionInvoked = $true }
  Out-Result $ok $reason $state
}
$root = $UIA::FromHandle($h)

# ---- Codex: each sidebar row carries its own pin / unpin button ---------------
function Set-NewName($edit) {
  $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($newName); Start-Sleep -Milliseconds 200
  if ((& $norm $value.Current.Value) -ne $newName) { Press 0x1B; return 'text_not_set' }
  # Enter saves; only while this very box has the keyboard.
  if ([KhSidebar]::GetForegroundWindow() -ne $h -or -not $edit.Current.HasKeyboardFocus) { return 'window_not_foreground' }
  Press 0x0D
  return $null
}
function Codex-Header {
  $bar = Find-All $root $CT::ToolBar | Where-Object { $_.Current.Name -eq '聊天工具栏' -or $_.Current.Name -eq 'Chat toolbar' } | Select-Object -First 1
  if (-not $bar) { return $null }
  Find-All $bar $CT::Text | Where-Object { $_.Current.Name } | Select-Object -First 1 | ForEach-Object { & $norm $_.Current.Name }
}
if ($App -eq 'codex' -and $Action -eq 'rename') {
  $before = Codex-Header
  Start-Process "codex://threads/$ThreadId"
  # The task is open once the header shows its title (the desktop's own, which may differ from ours).
  if (-not (Wait-For { $t = Codex-Header; $t -and ($t -eq $title -or $t -ne $before) } 24)) { Finish $false 'row_not_found' }
  $shown = Codex-Header
  if ($shown -ne $newName) {
    $actions = Wait-For { Find-All $root $CT::Button | Where-Object { $_.Current.Name -eq '聊天操作' -or $_.Current.Name -eq 'Chat actions' } | Select-Object -First 1 } 8
    if (-not $actions) { Finish $false 'menu_not_found' }
    $beforeMenus = Menu-Snapshot
    $actions.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
    $popup = Wait-For { New-Popup $beforeMenus } 12
    $item = if ($popup) { Unique-Named (Find-All $popup $CT::MenuItem) @('重命名','Rename') } else { $null }
    if (-not $item) { Press 0x1B; Finish $false 'button_not_found' }
    Invoke-Element $item
    $edit = Wait-For { Find-All $root $CT::Edit | Where-Object { $_.Current.HasKeyboardFocus -and (& $norm $_.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value) -eq $shown } | Select-Object -First 1 } 12
    if (-not $edit) { Press 0x1B; Finish $false 'text_not_set' }
    $failed = Set-NewName $edit
    if ($failed) { Finish $false $failed }
    if (-not (Wait-For { (Codex-Header) -eq $newName } 16)) { Finish $false 'not_applied' }
    $script:actionInvoked = $true
  }
  # Back to the task that was open before, through its sidebar row (the
  # sidebar is still redrawing the renamed row just after the save: retry).
  if ($before -and $before -ne $shown) {
    for ($try = 0; $try -lt 3 -and (Codex-Header) -ne $before; $try++) {
      Start-Sleep -Milliseconds 600
      $rows = @(Find-All $root $CT::ListItem | Where-Object { (& $norm $_.Current.Name) -eq $before })
      if ($rows.Count -ne 1) { continue }
      $open = Find-All $rows[0] $CT::Button | Where-Object { (& $norm $_.Current.Name) -eq $before } | Select-Object -First 1
      if ($open) { Invoke-Element $open; Wait-For { (Codex-Header) -eq $before } 8 | Out-Null }
    }
  }
  Finish $true $null 'done'
}

if ($App -eq 'codex') {
  $pinNames = @('置顶聊天', '置顶任务', 'Pin chat', 'Pin task', 'Pin')
  $unpinNames = @('取消置顶聊天', '取消置顶任务', 'Unpin chat', 'Unpin task', 'Unpin')
  $rows = @(Find-All $root $CT::ListItem | Where-Object { (& $norm $_.Current.Name) -eq $title })
  if (-not $rows.Count) { Finish $false 'row_not_found' }
  $buttons = @(); foreach ($row in $rows) { $buttons += @(Find-All $row $CT::Button) }
  $pin = $buttons | Where-Object { $pinNames -contains $_.Current.Name } | Select-Object -First 1
  $unpin = $buttons | Where-Object { $unpinNames -contains $_.Current.Name } | Select-Object -First 1
  if ($Action -eq 'pin') {
    if ($unpin) { Finish $true $null 'already' }
    if (-not $pin) { Finish $false 'button_not_found' }
    Invoke-Element $pin; $script:actionInvoked = $true
  } else {
    if (-not $unpin) { if ($pin) { Finish $true $null 'already' }; Finish $false 'button_not_found' }
    Invoke-Element $unpin; $script:actionInvoked = $true
  }
  Finish $true $null 'done'
}

# ---- Claude: the row's "More options" menu (Pin / Unpin / Rename / Archive) ----
# Filter > Status (Active / Archived / All) decides which sessions the sidebar
# lists. Returns the status that was selected before, or $null if it could not
# be set. The submenu opens from the keyboard only (Right on its focused item).
# The button reads "Filter (active)" while any filter is not the default.
function Open-Filter {
  $filters = @(Find-All $root $CT::Button | Where-Object { $_.Current.Name -match '^Filter( \(.+\))?$' })
  $filter = if ($filters.Count -eq 1) { $filters[0] } else { $null }
  if (-not $filter) { return $null }
  $beforeMenus = Menu-Snapshot
  $filter.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
  $popup = Wait-For { New-Popup $beforeMenus } 12
  $matches = @(Find-All $popup $CT::MenuItem | Where-Object { $_.Current.Name -like 'Status *' })
  if ($matches.Count -eq 1) { $matches[0] }
}
function Close-Filter {
  $filter = Find-All $root $CT::Button | Where-Object { $_.Current.Name -match '^Filter( \(.+\))?$' } | Select-Object -First 1
  if ($filter -and @(Find-All $root $CT::MenuItem).Count) { try { $filter.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}; Start-Sleep -Milliseconds 250 }
  for ($i = 0; $i -lt 3 -and [KhSidebar]::GetForegroundWindow() -eq $h -and @(Find-All $root $CT::MenuItem).Count; $i++) { Press 0x1B; Start-Sleep -Milliseconds 200 }
}
function Get-Status { $s = Open-Filter; $v = if ($s) { ($s.Current.Name -replace '^Status\s+', '').Trim() } else { $null }; Close-Filter; $v }
# The first menu opened just after the window comes forward sometimes does
# not take the submenu: one more try.
function Set-Status($wanted) {
  # The Claude / Code tab switch is also made of radio buttons: only these three are ours.
  if ($wanted -notin @('Active', 'Archived', 'All')) { return $null }
  # What it was before the first try, in case that one switched it but could not read it back.
  $script:statusSeen = $null
  for ($try = 0; $try -lt 2; $try++) {
    if (Set-StatusOnce $wanted) { return $script:statusSeen }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Set-StatusOnce($wanted) {
  $status = Open-Filter
  if (-not $status) { Close-Filter; return $null }
  $before = ($status.Current.Name -replace '^Status\s+', '').Trim()
  if (-not $script:statusSeen) { $script:statusSeen = $before }
  if ($before -eq $wanted) { Close-Filter; return $before }
  if (-not $script:restoring -and -not $script:restoreStatus) { $script:restoreStatus = $before }
  $status.SetFocus(); Start-Sleep -Milliseconds 200
  if ([KhSidebar]::GetForegroundWindow() -ne $h -or -not $status.Current.HasKeyboardFocus) { Close-Filter; return $null }
  $beforeMenus = Menu-Snapshot
  Press 0x27
  $popup = Wait-For { New-Popup $beforeMenus } 12
  $radio = if ($popup) { Unique-Named (Find-All $popup $CT::RadioButton) @($wanted) } else { $null }
  if (-not $radio) { Close-Filter; return $null }
  Invoke-Element $radio
  Start-Sleep -Milliseconds 300
  Close-Filter
  # Read it back from the menu's own label.
  if ((Get-Status) -ne $wanted) { return $null }
  return $before
}
if ($Action -eq 'unarchive') {
  $before = Set-Status 'Archived'
  if (-not $before) { Finish $false 'status_not_set' }
  if ($before -ne 'Archived') { $script:restoreStatus = $before }
}
# The archived list draws a moment after the switch.
$menuButtons = @(Wait-For { $found = @(Find-All $root $CT::Button | Where-Object { (& $norm $_.Current.Name) -eq "More options for $title" }); if ($found.Count) { , $found } } $(if ($Action -eq 'unarchive') { 12 } else { 1 }) | Where-Object { $_ })
# Claude Desktop 3.x repeats the open session's "More options" button in the
# toolbar above the conversation ("Session tools"), so the session open on the
# computer counted twice and was refused as a duplicate title (2026-10-27).
# Only the sidebar's own rows count.
if ($ViaToolbar) {
  # The title is shared, so the row cannot be told apart by it. Open this
  # session by its id, make sure the desktop logged it as the one in view,
  # and use the toolbar's own menu, which always belongs to the open session.
  if ($App -ne 'claude' -or $SessionId -notmatch '^local_[0-9a-f-]{36}$' -or $Action -notin @('rename', 'archive')) { Finish $false 'bad_choice' }
  . (Join-Path $PSScriptRoot 'claude-desktop-log-path.ps1')
  $openedAt = (Get-Item (Desktop-LogPath)).Length
  Start-Process "claude://claude.ai/epitaxy/$SessionId"
  $inView = {
    $log = Desktop-LogPath; if (-not $log) { return $false }
    $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
    try { $start = [Math]::Max(0, [Math]::Min($openedAt, $fs.Length) - 4096); [void]$fs.Seek($start, 'Begin'); $buf = New-Object byte[] ($fs.Length - $start); [void]$fs.Read($buf, 0, $buf.Length) } finally { $fs.Close() }
    $found = [regex]::Matches([Text.Encoding]::UTF8.GetString($buf), 'setFocusedSession: sessionId=(local_[0-9a-f-]{36}|null)')
    $focused = $found.Count -and $found[$found.Count - 1].Groups[1].Value -eq $SessionId
    $bar = Find-All $root $CT::ToolBar | Where-Object { $_.Current.Name -eq 'Session tools' } | Select-Object -First 1
    $focused -and $bar -and @(Find-All $bar $CT::Text | Where-Object { (& $norm $_.Current.Name) -eq $title }).Count
  }
  # Opening the session already in view logs nothing new: accept the toolbar then.
  $already = { $bar = Find-All $root $CT::ToolBar | Where-Object { $_.Current.Name -eq 'Session tools' } | Select-Object -First 1; $bar -and @(Find-All $bar $CT::Text | Where-Object { (& $norm $_.Current.Name) -eq $title }).Count }
  if (-not (Wait-For $inView 32)) {
    if (-not ((& $already) -and (Focused-Now) -eq $SessionId)) { Finish $false 'row_not_found' }
  }
  # The title shows before the toolbar's menu button (seen 2026-10-28: a
  # session just opened from the phone had no button yet, row_not_found).
  $menuButtons = @(Wait-For {
    $bar = Find-All $root $CT::ToolBar | Where-Object { $_.Current.Name -eq 'Session tools' } | Select-Object -First 1
    @(Find-All $bar $CT::Button | Where-Object { (& $norm $_.Current.Name) -eq "More options for $title" })
  } 20)
} elseif ($menuButtons.Count -gt 1) {
  $inSidebar = @($menuButtons | Where-Object {
    $x = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($_); $hit = $false
    for ($i = 0; $i -lt 8 -and $x -and -not $hit; $i++) {
      if ($x.Current.Name -eq 'Session tools') { break }
      if ($x.Current.Name -eq 'Sidebar') { $hit = $true }
      $x = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($x)
    }
    $hit
  })
  if ($inSidebar.Count) { $menuButtons = $inSidebar }
}
if (-not $menuButtons.Count) { Finish $false 'row_not_found' }
if ($menuButtons.Count -gt 1) { Finish $false 'ambiguous_title' }
$beforeMenus = Menu-Snapshot
$menuButtons[0].GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
$popup = Wait-For { New-Popup $beforeMenus } 12
$items = @(Find-All $popup $CT::MenuItem)
if (-not $items) { Finish $false 'menu_not_found' }
function Close-Menu { if ([KhSidebar]::GetForegroundWindow() -eq $h -and @(Find-All $root $CT::MenuItem).Count) { Press 0x1B; Start-Sleep -Milliseconds 200 } }
$item = { param($name) Unique-Named $items @($name) }
if ($Action -eq 'archive' -or $Action -eq 'unarchive') {
  $wanted = if ($Action -eq 'archive') { 'Archive' } else { 'Unarchive' }
  $other = if ($Action -eq 'archive') { 'Unarchive' } else { 'Archive' }
  $target = & $item $wanted
  if (-not $target) { $done = & $item $other; Close-Menu; if ($done) { Finish $true $null 'already' }; Finish $false 'button_not_found' }
  Invoke-Element $target; $script:actionInvoked = $true
  Finish $true $null 'done'
}
if ($Action -eq 'pin' -or $Action -eq 'unpin') {
  $wanted = if ($Action -eq 'pin') { 'Pin' } else { 'Unpin' }
  $other = if ($Action -eq 'pin') { 'Unpin' } else { 'Pin' }
  $target = & $item $wanted
  if (-not $target) { $done = & $item $other; Close-Menu; if ($done) { Finish $true $null 'already' }; Finish $false 'button_not_found' }
  Invoke-Element $target; $script:actionInvoked = $true
  Finish $true $null 'done'
}
# Rename: the menu turns the row into a text box holding the current title.
$rename = & $item 'Rename'
if (-not $rename) { Close-Menu; Finish $false 'button_not_found' }
Invoke-Element $rename
# The sidebar row turns into a "Rename" box; the toolbar's menu opens a "Session name" box.
$renameBox = if ($ViaToolbar) { 'Session name' } else { 'Rename' }
$edit = Wait-For { Find-All $root $CT::Edit | Where-Object { $_.Current.Name -eq $renameBox -and $_.Current.HasKeyboardFocus } | Select-Object -First 1 } 12
if (-not $edit) { Finish $false 'text_not_set' }
if ((& $norm $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value) -ne $title) { Press 0x1B; Finish $false 'prompt_mismatch' }
$failed = Set-NewName $edit
if ($failed) { Finish $false $failed }
$gone = Wait-For { -not (Find-All $root $CT::Edit | Where-Object { $_.Current.Name -eq $renameBox -and ($renameBox -eq 'Rename' -or $_.Current.HasKeyboardFocus) }) } 12
if ($gone) { Finish $true $null 'done' } else { Press 0x1B; Finish $false 'text_not_set' }
} catch {
  if ($_.Exception.Message -ne 'KH_SIDEBAR_RESULT') { $script:result = @{ok=$false;reason='script_failed';state=$null} }
} finally {
  $script:restoring = $true
  if ($script:restoreStatus) {
    $back = $script:restoreStatus; $script:restoreStatus = $null
    try {
      if (-not (Set-Status $back)) { throw 'restore_failed' }
    } catch {
      $script:result = @{ok=$false;reason=$(if ($script:actionInvoked) {'status_not_restored'} else {'cleanup_failed'});state=$(if ($script:actionInvoked) {'applied'} else {'not_applied'})}
    }
  }
  try {
    if ($wasMinimized) { [KhSidebar]::ShowWindow($h, 6) | Out-Null }
    if ($previous -and $previous -ne [IntPtr]::Zero -and $previous -ne $h) { Front $previous }
  } catch { $script:result = @{ok=$false;reason='cleanup_failed';state=$(if ($script:actionInvoked) {'applied'} else {'not_applied'})} }
}
[Console]::Out.WriteLine(($script:result | ConvertTo-Json -Compress))
