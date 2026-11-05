# Answers one exact Codex Desktop request_user_input through its own controls.
# No input is sent unless the thread, question, choices and empty custom draft
# are all verified. The Node caller checks the original call_id in the rollout.
param([Parameter(Mandatory = $true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]::Descendants
$data = [IO.File]::ReadAllText($InputFile, [Text.Encoding]::UTF8) | ConvertFrom-Json

function Result($code, $delivery, $message) {
  [Console]::Out.WriteLine((@{ code = $code; delivery = $delivery; message = $message } | ConvertTo-Json -Compress))
  exit 0
}
if ($data.threadId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
    -not $data.title -or -not $data.question -or -not $data.answer -or @($data.labels).Count -lt 2) {
  Result 'invalid_input' 'not_sent' 'The question is not supported'
}
function Get-Window {
  $best = $null; $area = -1
  foreach ($p in Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) {
    if ($p.MainWindowHandle -eq 0 -or $p.MainWindowTitle -ne 'ChatGPT') { continue }
    try { if ($p.Path -notlike '*\OpenAI.Codex_*') { continue } } catch { continue }
    $w = $AE::FromHandle($p.MainWindowHandle); $r = $w.Current.BoundingRectangle
    $n = if ($r.IsEmpty) { 0 } else { $r.Width * $r.Height }
    if ($n -gt $area) { $best = $w; $area = $n }
  }
  return $best
}
function Get-Title($window) {
  $doc = $window.FindFirst($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)))
  if ($doc) { return $doc.Current.Name.Trim() }
}
function Elements($parent, $type) {
  return @($parent.FindAll($Scope, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type))) |
    Where-Object { -not $_.Current.IsOffscreen })
}
function Get-Card($window) {
  if (-not $window -or (Get-Title $window) -ne $data.title) { return $null }
  $texts = @(Elements $window ([System.Windows.Automation.ControlType]::Text) | Where-Object { $_.Current.Name -ceq $data.question })
  if ($texts.Count -ne 1) { return $null }
  $card = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($texts[0])
  if (-not $card) { return $null }
  $radios = @(Elements $card ([System.Windows.Automation.ControlType]::RadioButton))
  if ($radios.Count -ne @($data.labels).Count) { return $null }
  foreach ($label in $data.labels) {
    if (@($radios | Where-Object { $_.Current.Name -ceq $label -and $_.Current.IsEnabled }).Count -ne 1) { return $null }
  }
  return $card
}
function Buttons($card, $names) {
  return @(Elements $card ([System.Windows.Automation.ControlType]::Button) | Where-Object { $_.Current.IsEnabled -and $names -ccontains $_.Current.Name })
}
function Empty-Draft($card) {
  # In Codex Desktop an empty custom reply shows Skip, an edited one Submit.
  # Do not infer emptiness from the UIA Value, which contains placeholder text.
  $skip = @(Buttons $card $data.skip); $submit = @(Buttons $card $data.submit)
  if ($skip.Count -ne 1 -or $submit.Count -ne 0) { return $false }
  # Desktop may mark its suggested radio as selected on opening even though
  # no answer was submitted; a real text draft changes Skip to Submit.
  return $true
}

$w = Get-Window
if (-not $w) { Result 'desktop_not_ready' 'not_sent' 'Codex Desktop was not found' }
if ((Get-Title $w) -cne $data.title) {
  Start-Process "codex://threads/$($data.threadId)"
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 200; $w = Get-Window; if ($w -and (Get-Title $w) -ceq $data.title) { break } }
}
$card = $null
for ($i = 0; $i -lt 25 -and -not $card; $i++) { $w = Get-Window; $card = Get-Card $w; if (-not $card) { Start-Sleep -Milliseconds 200 } }
if (-not $card) { Result 'question_unavailable' 'not_sent' 'The exact Desktop question was not found' }
if (-not (Empty-Draft $card)) { Result 'draft_present' 'not_sent' 'The Desktop question already has a reply in progress' }

if (-not $data.custom) {
  if (-not (@($data.labels) -ccontains $data.answer)) { Result 'choice_mismatch' 'not_sent' 'The selected choice no longer exists' }
  $w = Get-Window; $card = Get-Card $w
  if (-not $card -or -not (Empty-Draft $card)) { Result 'question_changed' 'not_sent' 'The Desktop question changed' }
  $radio = @(Elements $card ([System.Windows.Automation.ControlType]::RadioButton) | Where-Object { $_.Current.Name -ceq $data.answer })
  if ($radio.Count -ne 1) { Result 'choice_mismatch' 'not_sent' 'The choice could not be identified' }
  [Console]::Out.WriteLine('{"phase":"write"}')
  try { $radio[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { Result 'delivery_uncertain' 'uncertain' 'The choice may have been submitted' }
  Result 'invoked' 'confirmed' 'Desktop choice invoked; checking the original result'
}

$edit = @(Elements $card ([System.Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.ClassName -like 'ProseMirror*' })
if ($edit.Count -ne 1) { Result 'editor_unavailable' 'not_sent' 'The custom reply field was not found' }
[Console]::Out.WriteLine('{"phase":"editing"}')
try { $edit[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$data.answer) } catch {}
$written = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 120; $w = Get-Window; $card = Get-Card $w
  if (-not $card) { break }
  $edit = @(Elements $card ([System.Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.ClassName -like 'ProseMirror*' })
  if ($edit.Count -eq 1) { try { if ($edit[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ceq $data.answer) { $written = $true; break } } catch {} }
}
if (-not $written) { Result 'draft_uncertain' 'uncertain' 'The reply may remain in the Desktop field' }
$submit = @(Buttons $card $data.submit)
if ($submit.Count -ne 1) { Result 'submit_unavailable' 'uncertain' 'The Desktop reply needs checking' }
$w = Get-Window; $card = Get-Card $w
if (-not $card) { Result 'question_changed' 'uncertain' 'The Desktop question changed after editing' }
$edit = @(Elements $card ([System.Windows.Automation.ControlType]::Edit) | Where-Object { $_.Current.ClassName -like 'ProseMirror*' })
$submit = @(Buttons $card $data.submit)
try { $same = $edit.Count -eq 1 -and $edit[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -ceq $data.answer } catch { $same = $false }
if (-not $same -or $submit.Count -ne 1) { Result 'draft_uncertain' 'uncertain' 'The Desktop reply changed before submission' }
[Console]::Out.WriteLine('{"phase":"write"}')
try { $submit[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
catch { Result 'delivery_uncertain' 'uncertain' 'The reply may have been submitted' }
Result 'invoked' 'confirmed' 'Desktop reply invoked; checking the original result'
