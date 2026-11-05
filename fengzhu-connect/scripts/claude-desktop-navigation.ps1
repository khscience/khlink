# Safe, read-only identity checks used by Claude Desktop send navigation.
# Never accept a title alone after clicking the sidebar: two sessions can share
# a title. The actual Code document URL must name the requested local session.
function Get-KhSessionIdFromUrl([string]$url) {
  if ($url -match '^https://claude\.ai/epitaxy/(local_[0-9a-f-]{36})(?:[/?#]|$)') { return $Matches[1] }
  return $null
}
function Test-KhSidebarIdentity([string]$visibleUrl, [string]$sessionId, [string]$shown, [string]$expected) {
  $norm = { param($value) ([string]$value -replace '\s+', ' ').Trim() }
  return ((Get-KhSessionIdFromUrl $visibleUrl) -ceq $sessionId -and $expected -and (& $norm $shown) -ceq (& $norm $expected))
}
function Get-KhUniqueAutomationElements($elements) {
  # Claude can expose nested accessibility nodes both named Sidebar. Walking
  # both returns the very same session button twice; only distinct UIA runtime
  # IDs count as different sessions. Fail closed if an ID is unavailable.
  $seen = @{}
  foreach ($element in $elements) {
    try {
      $id = @($element.GetRuntimeId())
      if (-not $id.Count) { return @() }
      $key = $id -join ','
      if (-not $seen.ContainsKey($key)) { $seen[$key] = $element }
    } catch { return @() }
  }
  return @($seen.Values)
}
function Select-KhSidebarButton($buttons, [string]$title) {
  $norm = { param($value) ([string]$value -replace '\s+', ' ').Trim() }
  $wanted = & $norm $title
  if (-not $wanted) { return $null }
  $enabled = @($buttons | Where-Object { try { $_.Current.IsEnabled } catch { $false } })
  $matches = @($enabled | Where-Object { try { (& $norm $_.Current.Name) -ceq $wanted } catch { $false } })
  if (-not $matches.Count) {
    # Electron can append accessibility status text such as "Unread response"
    # to the session button name. This only locates a candidate: the caller
    # must still check the actual document URL and header before sending.
    $prefix = $wanted + ' '
    $matches = @($enabled | Where-Object {
      try { (& $norm $_.Current.Name).StartsWith($prefix, [StringComparison]::Ordinal) } catch { $false }
    })
  }
  $matches = @(Get-KhUniqueAutomationElements $matches)
  if ($matches.Count -ne 1) { return $null }
  return $matches[0]
}

function Get-KhVisibleCodeUrl($window) {
  $uia = [System.Windows.Automation.AutomationElement]
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)),
    (New-Object System.Windows.Automation.PropertyCondition($uia::AutomationIdProperty, 'RootWebArea')))
  $values = @()
  foreach ($doc in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    try {
      $value = [string]$doc.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
      if (Get-KhSessionIdFromUrl $value) { $values += $value }
    } catch { }
  }
  $unique = @($values | Select-Object -Unique)
  if ($unique.Count -eq 1) { return $unique[0] }
  return $null
}

function Invoke-KhUniqueSidebarSession($window, [string]$title) {
  $uia = [System.Windows.Automation.AutomationElement]
  $bySidebarName = New-Object System.Windows.Automation.PropertyCondition($uia::NameProperty, 'Sidebar')
  $buttonsOnly = New-Object System.Windows.Automation.PropertyCondition($uia::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = @()
  $sidebars = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bySidebarName))
  foreach ($sidebar in $sidebars) {
    foreach ($button in $sidebar.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonsOnly)) { $buttons += $button }
  }
  $target = Select-KhSidebarButton $buttons $title
  if (-not $target) { return $false }
  try { $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch {
    if (Get-Command Trace-Navigation -ErrorAction SilentlyContinue) { Trace-Navigation ('sidebar-invoke-failed-{0}' -f $_.Exception.GetType().Name) }
    return $false
  }
}
