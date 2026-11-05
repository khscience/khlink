param([Parameter(Mandatory = $true)][string]$Helper)
$ErrorActionPreference = 'Stop'
. $Helper
$a = 'local_00000000-0000-4000-8000-000000000001'
$b = 'local_00000000-0000-4000-8000-000000000002'
$urlA = "https://claude.ai/epitaxy/$a"
$button = { param($name, $enabled, $id)
  $item = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $name; IsEnabled = $enabled }; Id = $id }
  $item | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return @($this.Id) }
  return $item
}
$one = @((& $button 'target' $true 1), (& $button 'another' $true 2))
$two = @((& $button 'target' $true 1), (& $button 'target' $true 3))
$nested = @($one[0], $one[0])
$disabled = @((& $button 'target' $false 4))
$unknown = @([pscustomobject]@{ Current = [pscustomobject]@{ Name = 'target'; IsEnabled = $true } })
$status = @((& $button 'target Unread response' $true 5))
$ambiguousStatus = @((& $button 'target Unread response' $true 5), (& $button 'target Awaiting input' $true 6))
$prefixOnly = @((& $button 'targeted' $true 7))
$result = @{
  unique = [bool](Select-KhSidebarButton $one 'target')
  duplicate = [bool](Select-KhSidebarButton $two 'target')
  nestedDuplicate = [bool](Select-KhSidebarButton $nested 'target')
  unknownRuntimeId = [bool](Select-KhSidebarButton $unknown 'target')
  statusSuffix = [bool](Select-KhSidebarButton $status 'target')
  ambiguousStatusSuffix = [bool](Select-KhSidebarButton $ambiguousStatus 'target')
  prefixWithoutBoundary = [bool](Select-KhSidebarButton $prefixOnly 'target')
  disabled = [bool](Select-KhSidebarButton $disabled 'target')
  missing = [bool](Select-KhSidebarButton $one 'absent')
  correctId = [bool](Test-KhSidebarIdentity $urlA $a 'target' 'target')
  wrongIdSameTitle = [bool](Test-KhSidebarIdentity $urlA $b 'target' 'target')
  wrongTitle = [bool](Test-KhSidebarIdentity $urlA $a 'another' 'target')
  missingUrl = [bool](Test-KhSidebarIdentity '' $a 'target' 'target')
  wrongHost = [bool](Test-KhSidebarIdentity "https://other.example/epitaxy/$a" $a 'target' 'target')
  lookalikeUrl = [bool](Test-KhSidebarIdentity "https://claude.ai/epitaxy/${a}extra" $a 'target' 'target')
}
ConvertTo-Json -InputObject $result -Compress
