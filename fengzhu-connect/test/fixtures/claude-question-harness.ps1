# Execute the production question flow against UI snapshots, never a window.
param([string]$Source, [string]$Fixture)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$CT = [System.Windows.Automation.ControlType]
$f = ConvertFrom-Json ([IO.File]::ReadAllText($Fixture, [Text.Encoding]::UTF8))
$script:pageIndex = [int]$f.startPage
$script:pending = -not $f.stale
$script:mutations = 0
$script:answers = @($f.pages | ForEach-Object { @{ labels = @(); other = '' } })
$SessionId = 'local_test'; $RequestId = 'request_test'; $expectKey = 'test'
$Choice = $Fixture + '.pages'
[IO.File]::WriteAllText($Choice, (ConvertTo-Json -InputObject @($f.pages) -Depth 10), (New-Object Text.UTF8Encoding($false)))
$Ellipsis = [string][char]0x2026
$norm = { param($s) ([string]$s -replace '\s+', ' ').Trim() }
function New-Control($name, $type, $action = '', $toggle = $false) {
  $c = [pscustomobject]@{ Current = @{ Name = $name; IsEnabled = $true }; Type = $type; Action = $action; Toggle = $toggle; Children = @() }
  $c | Add-Member ScriptMethod GetCurrentPattern { param($pattern) throw 'No SelectionItemPattern' }
  return $c
}
function Root {
  $root = New-Control 'window' $CT::Window
  if (-not $script:pending) { return $root }
  $page = $f.pages[$script:pageIndex]
  $group = New-Control $page.question $CT::Group
  $n = 0
  foreach ($o in $page.options) {
    $n++
    $name = if ($f.legacy -and -not $page.multi) { $o.name + ' ' + $n } else { $o.name }
    $type = if ($page.multi) { $CT::CheckBox } else { $CT::Button }
    $group.Children += New-Control $name $type ('option:' + $o.name) (-not $f.legacy -or $page.multi)
  }
  $group.Children += New-Control $(if ($f.legacy -and -not $page.multi) { 'Other 9' } else { 'Other' }) $CT::Button 'other' (-not $f.legacy -or $page.multi)
  $group.Children += New-Control 'Skip' $CT::Button 'skip'
  $group.Children += New-Control $(if ($script:pageIndex -eq $f.pages.Count - 1) { 'Submit' } else { 'Next' }) $CT::Button 'next'
  if ($f.ambiguous) { $group.Children += $group.Children[0] }
  $root.Children += $group
  $previous = New-Control 'Show previous question' $CT::Button 'previous'
  $previous.Current.IsEnabled = $script:pageIndex -gt 0
  $root.Children += $previous
  # A completed historical card with the same caption must never be chosen.
  $root.Children += New-Control $page.question $CT::Group
  return $root
}
function Find-All($root, $type) {
  if (-not $root) { return }
  foreach ($child in $root.Children) {
    if ($child.Type -eq $type) { $child }
    Find-All $child $type
  }
}
function Focused-Session { if ($f.wrongSession) { 'local_other' } else { $SessionId } }
function Request-Pending { $script:pending }
function Start-Sleep { param($Milliseconds) }
function Finish($ok, $reason) { throw ('RESULT:' + (@{ok=$ok;reason=$reason} | ConvertTo-Json -Compress)) }
function Toggle-State($button) {
  if (-not $button.Toggle) { return $null }
  $a = $script:answers[$script:pageIndex]
  $on = if ($button.Action -eq 'other') { [bool]$a.other } else { $a.labels -contains $button.Action.Substring(7) }
  if ($on) { 'On' } else { 'Off' }
}
function Set-Toggle($button, $on) {
  $script:mutations++
  $a = $script:answers[$script:pageIndex]
  if ($button.Action -eq 'other') { if ($on -and -not $f.pages[$script:pageIndex].multi) { $a.labels = @() }; if (-not $on) { $a.other = '' }; return $true }
  $name = $button.Action.Substring(7)
  if ($on) {
    if (-not $f.pages[$script:pageIndex].multi) { $a.labels = @(); $a.other = '' }
    $a.labels = @($a.labels | Where-Object { $_ -ne $name }) + @($name)
  } else { $a.labels = @($a.labels | Where-Object { $_ -ne $name }) }
  return $true
}
function Invoke-Button($button) {
  $script:mutations++
  if ($button.Action -eq 'previous') { $script:pageIndex--; return }
  if ($button.Action -like 'option:*') { [void](Set-Toggle $button $true) }
  elseif ($button.Action -ne 'next') { throw ('Unexpected action: ' + $button.Action) }
  if ($script:pageIndex -eq $f.pages.Count - 1) { $script:pending = $false } else { $script:pageIndex++ }
}
function Set-EditText($name, $text) { $script:mutations++; $script:answers[$script:pageIndex].other = $text; return $true }
$code = [IO.File]::ReadAllText($Source)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Production script syntax error' }
foreach ($name in @('Name-Pattern', 'Wait-For', 'Button-Named', 'Buttons')) {
  $fn = $ast.Find({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }, $true)
  Invoke-Expression $fn.Extent.Text
}
$flow = $code.Substring($code.IndexOf('# ---- AskUserQuestion'))
try { Invoke-Expression $flow; throw 'Expected a structured result' }
catch {
  if (-not $_.Exception.Message.StartsWith('RESULT:')) { throw }
  $result = ConvertFrom-Json $_.Exception.Message.Substring(7)
  @{ result=$result; answers=$script:answers; mutations=$script:mutations; pending=$script:pending } | ConvertTo-Json -Depth 10 -Compress
}
