# Run the production approval selector against controls, never a real window.
param([string]$Source, [string]$Fixture)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$CT = [System.Windows.Automation.ControlType]
$f = ConvertFrom-Json ([IO.File]::ReadAllText($Fixture, [Text.Encoding]::UTF8))
$SessionId = 'test-session'; $script:menuOpen = $false; $script:invoked = @()
$norm = { param($s) ([string]$s -replace '\s+', ' ').Trim() }
function Control($name, $type) {
  $c=[pscustomobject]@{Current=@{Name=$name};Type=$type;Children=@()}
  $c | Add-Member ScriptMethod GetCurrentPattern {
    param($pattern)
    if (-not $f.expand -or $this.Current.Name -ne 'More allow options') { throw 'No ExpandCollapse' }
    $p=[pscustomobject]@{}
    # expandIgnored: Desktop 2.42304.2 in the background, Expand() returns and nothing opens.
    $p | Add-Member ScriptMethod Expand { if(-not $f.expandIgnored){$script:menuOpen=$true} }
    $p | Add-Member ScriptProperty Current { @{ExpandCollapseState=$(if($script:menuOpen){'Expanded'}else{'Collapsed'})} }
    return $p
  }
  return $c
}
$group = Control 'Permission request: write' $CT::Group
$group.Children = @((Control 'Deny' $CT::Button), (Control $(if($f.direct -or $f.noMenu){'Allow once'}else{'Always allow , Applies to this session only'}) $CT::Button))
if (-not $f.noMenu) { $group.Children += @(Control 'More allow options' $CT::Button) }
function Root {
  $root = Control 'window' $CT::Window; $root.Children = @($group)
  if ($script:menuOpen) { $root.Children += @((Control 'Allow once' $CT::MenuItem), (Control 'Allow and switch to Auto Auto reviews the rest of this session.' $CT::MenuItem)) }
  return $root
}
function Find-All($root, $type) { foreach($child in $root.Children){ if($child.Type -eq $type){$child}; Find-All $child $type } }
function Focused-Session { $SessionId }
function Request-Pending { -not ($f.staleAfterMenu -and $script:menuOpen) }
function Permission-Snapshot($group) { if($f.changedAfterMenu -and $script:menuOpen){'different'}else{'expected'} }
function Same-Permission($a, $b) { $a -ceq $b }
function Bring-Forward { $true }
function Click-Exactly($button) { if($button.Current.Name -ne 'More allow options'){throw 'Unexpected menu'}; $script:menuOpen=$true; return $true }
function Invoke-Button($button) { if($button.Current.Name -eq 'More allow options'){throw 'No Invoke'}; $script:invoked += $button.Current.Name }
function Start-Sleep { param($Milliseconds) }
function Finish($ok, $reason, $shown=$null, $prompt=$null) { throw ('RESULT:' + $reason) }
$code=[IO.File]::ReadAllText($Source); $tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production script syntax error'}
foreach($name in @('Buttons','Button-Named','Wait-For','Permission-Groups','Menu-Expanded','Open-PermissionMenu','Check-PermissionRequest','Invoke-PermissionChoice')){
  $fn=$ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name},$true)
  Invoke-Expression $fn.Extent.Text
}
$reason=$null; $groups=@(Permission-Groups)
try { Invoke-PermissionChoice $group 'expected' $f.choice }
catch { if(-not $_.Exception.Message.StartsWith('RESULT:')){throw}; $reason=$_.Exception.Message.Substring(7) }
@{groups=$groups.Count;invoked=@($script:invoked);menuOpen=$script:menuOpen;reason=$reason} | ConvertTo-Json -Compress
