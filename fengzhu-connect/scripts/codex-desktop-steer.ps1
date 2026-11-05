# Hand a message to the turn that Codex Desktop is running in a task, the way
# a person would: put it in the task's composer, press Queue (while a turn
# runs the send button queues), then press that row's Steer button. When no
# turn is running, Send starts the next turn instead.
#
# Codex Desktop 26.1027 (ChatGPT.exe) no longer exposes its page to native
# IUIAutomation clients (the Rust desktop adapter sees only an empty D3D
# child), but .NET UI Automation still reads and drives it. Rows that another
# app-server put in the task's queue are not shown in the window, so a steer
# must go through the window's own queue (2026-10-31).
#
# Safety: nothing is written unless the window shows the requested task (its
# title) and its composer is empty, so a half-typed desktop draft is never
# sent or overwritten. The window is never brought to the front.
# Output: one JSON line {ok, code, delivery, message}; a {"phase":"write"}
# line comes first once the message may have reached Codex.
param(
  [Parameter(Mandatory = $true)][string]$ThreadId,
  # The task's title, UTF-8 Base64 (a title may start with '-').
  [Parameter(Mandatory = $true)][string]$TitleB64,
  [Parameter(Mandatory = $true)][string]$TextFile,
  [ValidateSet('steer', 'queue')][string]$Mode = 'steer'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
. (Join-Path $PSScriptRoot 'codex-desktop-steer-logic.ps1')
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]::Descendants

function Out-Result($ok, $code, $delivery, $message) {
  [Console]::Out.WriteLine((@{ ok = $ok; code = $code; delivery = $delivery; message = $message } | ConvertTo-Json -Compress))
  exit 0
}
if ($ThreadId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { Out-Result $false 'invalid_thread_id' 'not_sent' 'A valid Codex task id is required' }
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64)).Trim()
$text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
if (-not $title -or -not $text.Trim()) { Out-Result $false 'missing_input' 'not_sent' 'Task title and message are required' }

function Get-CodexWindow {
  $best = $null; $bestArea = -1
  foreach ($p in Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
    if ($p.MainWindowHandle -eq 0 -or $p.MainWindowTitle -ne 'ChatGPT') { continue }
    try { if ($p.Path -notlike '*\OpenAI.Codex_*') { continue } } catch { continue }
    $w = $AE::FromHandle($p.MainWindowHandle); $r = $w.Current.BoundingRectangle
    $area = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
    if ($area -gt $bestArea) { $best = $w; $bestArea = $area }
  }
  $best
}
function Get-ActiveTitle($w) {
  $doc = $w.FindFirst($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)))
  if ($doc) { $doc.Current.Name.Trim() }
}
function Get-Composer($w) {
  $candidates = @($w.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))) |
    Where-Object { $_.Current.ClassName -like 'ProseMirror*' -and -not $_.Current.IsOffscreen })
  $names = @($candidates | ForEach-Object { [string]$_.Current.Name })
  $index = Get-CodexComposerIndex $names
  if ($index -ge 0) { return $candidates[$index] }
}
function Get-Button($w, [string[]]$names) {
  foreach ($e in $w.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
    if ($names -contains $e.Current.Name -and -not $e.Current.IsOffscreen -and $e.Current.IsEnabled) { return $e }
  }
}
function Get-EditorChildNames($editor) {
  $textType = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  return @($editor.FindAll($Scope, $textType) | ForEach-Object { [string]$_.Current.Name })
}
function Test-EditorEmpty($editor, $pattern) {
  $children = @(Get-EditorChildNames $editor)
  return Test-CodexComposerEmpty $true $pattern.Current.Value $editor.Current.Name $children
}
function Invoke-Element($e) { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Get-QueueDialogNames($w) {
  $names = @()
  foreach ($name in @('发送消息？', '清空队列', '发送消息')) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    if (@($w.FindAll($Scope, $condition) | Where-Object { -not $_.Current.IsOffscreen }).Count -gt 0) { $names += $name }
  }
  $textCondition = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
  foreach ($node in $w.FindAll($Scope, $textCondition)) {
    if (-not $node.Current.IsOffscreen -and $node.Current.Name -like '*要清除之前已排队*消息*') { $names += $node.Current.Name }
  }
  $names
}
# The Steer button of the queued row that shows this message.
function Get-RowSteer($w, [string]$firstLine) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $hits = @()
  foreach ($actionName in (Get-CodexSteerButtonNames)) {
    foreach ($steer in $w.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $actionName)))) {
      if ($steer.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or $steer.Current.IsOffscreen) { continue }
      $row = $walker.GetParent($steer)
      for ($level = 0; $row -and $level -lt 4; $level++) {
        $names = @($row.FindAll($Scope, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { Plain $_.Current.Name })
        if (@($names | Where-Object { (Get-CodexSteerButtonNames) -contains $_ }).Count -gt 1) { break }
        if (Test-CodexQueueRow $names $firstLine) { $hits += $steer; break }
        $row = $walker.GetParent($row)
      }
    }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
}

# The running task's composer submit button when 后续消息 is set to 引导.
function Get-ComposerSteer($w) {
  $editor = Get-Composer $w
  if (-not $editor) { return }
  $box = $editor.Current.BoundingRectangle
  if ($box.IsEmpty) { return }
  $hits = @()
  foreach ($e in $w.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
    if ((Get-CodexSteerButtonNames) -notcontains $e.Current.Name -or $e.Current.IsOffscreen -or -not $e.Current.IsEnabled) { continue }
    $r = $e.Current.BoundingRectangle
    if (Test-CodexComposerSteerButton $r.X $r.Y $box.X $box.Y $box.Width) { $hits += $e }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
}

$w = Get-CodexWindow
if (-not $w) { Out-Result $false 'desktop_not_ready' 'not_sent' 'Codex Desktop was not found' }
if ((Get-ActiveTitle $w) -ne $title) {
  # The task id is the identity; the title only confirms the window shows it.
  Start-Process "codex://threads/$ThreadId"
  for ($i = 0; $i -lt 40 -and (Get-ActiveTitle $w) -ne $title; $i++) { Start-Sleep -Milliseconds 200; $w = Get-CodexWindow }
  if ((Get-ActiveTitle $w) -ne $title) { Out-Result $false 'task_identity_unconfirmed' 'not_sent' 'Codex Desktop did not show the requested task' }
}
$composer = $null
for ($i = 0; $i -lt 25 -and -not $composer; $i++) { $composer = Get-Composer $w; if (-not $composer) { Start-Sleep -Milliseconds 200 } }
if (-not $composer) { Out-Result $false 'composer_unavailable' 'not_sent' 'The task has no composer now (an approval may be waiting on the computer)' }
$pauseNames = @($w.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) | Where-Object { -not $_.Current.IsOffscreen } | ForEach-Object { $_.Current.Name })
if (Test-CodexQueuePaused $pauseNames) { Out-Result $false 'queue_paused' 'not_sent' 'The Codex Desktop queue is paused after an interruption' }
$value = $composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
if (-not (Test-EditorEmpty $composer $value)) { Out-Result $false 'draft_present' 'not_sent' 'The Codex Desktop composer already holds a draft' }

$writable = $false
for ($i = 0; $i -lt 5 -and -not $writable; $i++) {
  try {
    $w = Get-CodexWindow
    if ((Get-ActiveTitle $w) -ne $title) { Out-Result $false 'task_identity_unconfirmed' 'not_sent' 'Codex Desktop changed task before writing' }
    $composer = Get-Composer $w
    if (-not $composer) { Start-Sleep -Milliseconds 150; continue }
    $value = $composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if (-not (Test-EditorEmpty $composer $value)) { Out-Result $false 'draft_present' 'not_sent' 'The Codex Desktop composer already holds a draft' }
    $writable = $true
  } catch { Start-Sleep -Milliseconds 150 }
}
if (-not $writable) { Out-Result $false 'composer_unavailable' 'not_sent' 'Could not safely locate the Codex Desktop composer' }
# Once SetValue begins it can leave a draft even if UIA throws or returns a
# stale read. Record that boundary before the call and never write it twice.
[Console]::Out.WriteLine('{"phase":"editing"}')
try { $value.SetValue($text) } catch { }
$written = Wait-CodexComposerWritten {
  $window = Get-CodexWindow
  if (-not $window -or (Get-ActiveTitle $window) -ne $title) { return @{ identityChanged = $true } }
  $editor = Get-Composer $window
  if (-not $editor) { return @{ readable = $false } }
  $pattern = $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  return @{ readable = $true; value = $pattern.Current.Value; children = @(Get-EditorChildNames $editor) }
} $text
if (-not $written) { Out-Result $false 'composer_write_unconfirmed' 'uncertain' 'The input may remain as a Desktop draft; no automatic retry will be made' }
$w = Get-CodexWindow
if (-not $w -or (Get-ActiveTitle $w) -ne $title) { Out-Result $false 'delivery_uncertain' 'uncertain' 'Codex Desktop changed task after writing the draft' }
$queue = $null; $send = $null; $direct = $null
for ($i = 0; $i -lt 15 -and -not $queue -and -not $send -and -not $direct; $i++) {
  $queue = Get-Button $w (Get-CodexQueueButtonNames); if (-not $queue) { $send = Get-Button $w @('Send', '发送') }
  if (-not $queue -and -not $send) { $direct = Get-ComposerSteer $w }
  if (-not $queue -and -not $send -and -not $direct) { Start-Sleep -Milliseconds 100 }
}
if (-not $queue -and -not $send -and -not $direct) { Out-Result $false 'control_not_found' 'uncertain' 'The send control was not available; the Desktop draft needs checking' }

# A person may have edited or switched the draft while controls were loading.
# Do not submit anything unless the target and complete text still match.
try {
  $w = Get-CodexWindow
  if (-not $w -or (Get-ActiveTitle $w) -ne $title) { throw 'task changed' }
  $composer = Get-Composer $w
  if (-not $composer) { throw 'composer unavailable' }
  $value = $composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if (-not (Test-CodexComposerWritten $value.Current.Value $text @(Get-EditorChildNames $composer))) { throw 'draft changed' }
} catch { Out-Result $false 'composer_write_unconfirmed' 'uncertain' 'The Desktop draft changed before sending; no automatic retry will be made' }

[Console]::Out.WriteLine('{"phase":"write"}')
# 后续消息 = 引导: the composer's own button steers the running turn at once,
# which is what the person chose for follow-ups on this computer.
if ($direct) { $send = $direct }
if ($send) {
  # A paused queue may ask whether to clear it. Its effect on every existing
  # item is not reliably observable, so leave that decision to the person.
  Invoke-Element $send
  $emptyReads = 0
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 200
    $w = Get-CodexWindow
    if (-not $w -or (Get-ActiveTitle $w) -ne $title) { break }
    if (Test-CodexQueueSendDialog (Get-QueueDialogNames $w)) {
      Out-Result $false 'queue_confirmation_required' 'uncertain' 'Codex Desktop needs a queue decision; no automatic retry will be made'
    }
    $editor = Get-Composer $w
    $empty = $false
    if ($editor) { try { $current = $editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $empty = Test-EditorEmpty $editor $current } catch {} }
    if ($empty) { $emptyReads++ } else { $emptyReads = 0 }
    if ($emptyReads -ge 2) {
      if ($direct) { Out-Result $true 'steer_accepted' 'confirmed' 'Steered into the running Codex Desktop turn' }
      Out-Result $true 'sent' 'confirmed' 'Codex Desktop accepted the message'
    }
  }
  Out-Result $false 'delivery_uncertain' 'uncertain' 'Codex Desktop did not confirm the message; it will not be resent automatically'
}
Invoke-Element $queue
$firstLine = Plain (($text -split "\r?\n" | Where-Object { (Plain $_) } | Select-Object -First 1))
$steer = $null
for ($i = 0; $i -lt 30 -and -not $steer; $i++) { Start-Sleep -Milliseconds 200; $steer = Get-RowSteer $w $firstLine }
if (-not $steer) { Out-Result $false 'delivery_uncertain' 'uncertain' 'Could not verify the message in the Codex Desktop queue' }
if ($Mode -eq 'queue') { Out-Result $true 'queued' 'confirmed' 'Codex Desktop accepted the message into its own queue' }
# Queue deletion and the window's own queue update are asynchronous. Let the
# new row settle, then reacquire the exact unique row before invoking it once.
Start-Sleep -Milliseconds 1000
$w = Get-CodexWindow
if (-not $w -or (Get-ActiveTitle $w) -ne $title) { Out-Result $false 'delivery_uncertain' 'uncertain' 'Codex Desktop changed tasks before the queued message was steered' }
$steer = Get-RowSteer $w $firstLine
if (-not $steer) { Out-Result $false 'delivery_uncertain' 'uncertain' 'The queued message could not be verified before steering' }
Invoke-Element $steer
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 200
  $w = Get-CodexWindow
  if (-not $w -or (Get-ActiveTitle $w) -ne $title) { Out-Result $false 'delivery_uncertain' 'uncertain' 'Codex Desktop changed tasks while steering' }
  if (-not (Get-RowSteer $w $firstLine)) { Out-Result $true 'steer_accepted' 'confirmed' 'Sent to the running Codex Desktop turn' }
}
Out-Result $true 'steer_deferred' 'confirmed' 'Codex Desktop kept the message in the task queue'
