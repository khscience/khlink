# Pure checks shared by the window driver and its regression tests.
function Plain([string]$value) { ($value -replace '[\u200B-\u200D\u2060\u2063\uFEFF]', '').Trim() }

# UIA can report Windows line endings even when the submitted text used LF.
# Do not collapse other whitespace: the complete question envelope matters.
function Test-CodexComposerWritten([string]$value, [string]$expected, [string[]]$children = @()) {
  $wanted = (Plain $expected) -replace "`r`n?", "`n"
  if (((Plain $value) -replace "`r`n?", "`n") -ceq $wanted) { return $true }
  # When a question card is visible Chromium's ValuePattern can interleave
  # truncated copies of text. Its Text descendants still expose each actual
  # segment and an empty Text for each line break. Compare every character,
  # including blank lines; any missing/extra segment fails closed.
  if (-not $children.Count) { return $false }
  $text = ''
  foreach ($child in $children) { if ($child -ceq '') { $text += "`n" } else { $text += $child } }
  return (((Plain $text) -replace "`r`n?", "`n") -ceq $wanted)
}

function Wait-CodexComposerWritten([scriptblock]$read, [string]$expected, [int]$attempts = 15, [int]$delayMs = 200) {
  for ($i = 0; $i -lt $attempts; $i++) {
    if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
    try {
      $observation = & $read
      if ($observation.identityChanged) { return $false }
      if ($observation.readable -and (Test-CodexComposerWritten $observation.value $expected @($observation.children))) { return $true }
    } catch { }
  }
  return $false
}

function Get-CodexQueueButtonNames { @('Queue', '加入队列', '排队') }
function Get-CodexSteerButtonNames { @('Steer', '引导', '调整方向') }

# With 后续消息 set to 引导 (26.1029), a running task's composer submit button
# is itself named 引导. It sits on the composer's toolbar, at or below the
# editor's top and within its width; a queued row's 引导 sits above it.
function Test-CodexComposerSteerButton([double]$buttonX, [double]$buttonY, [double]$editorX, [double]$editorY, [double]$editorWidth) {
  return ($buttonY -ge $editorY) -and ($buttonX -ge $editorX - 40) -and ($buttonX -le $editorX + $editorWidth + 120)
}

function Get-CodexComposerIndex([string[]]$names) {
  $mainNames = @('和 Codex 一起工作', '可向 Codex 询问任何问题', 'Ask Codex anything', 'Work with Codex', 'Message Codex', '描述你的任务以生成计划…', 'Describe your task to generate a plan...', 'Describe your task to generate a plan…')
  $preferred = @(); $other = @()
  for ($i = 0; $i -lt $names.Count; $i++) {
    $name = $names[$i].Trim()
    if ($mainNames -contains $name) { $preferred += $i; continue }
    if ($name -like '*自行撰写回复*' -or $name -like '*自行填写*' -or $name -like '*write your own answer*' -or $name -like '*type your own answer*') { continue }
    $other += $i
  }
  if ($preferred.Count -eq 1) { return $preferred[0] }
  if ($preferred.Count -gt 1) { return -1 }
  if ($other.Count -eq 1) { return $other[0] }
  return -1
}

function Test-CodexQueueSendDialog([string[]]$names) {
  ($names -contains '发送消息？') -and
    [bool]($names | Where-Object { $_ -like '*要清除之前已排队*消息*' } | Select-Object -First 1) -and
    ($names -contains '清空队列') -and ($names -contains '发送消息')
}

function Test-CodexQueuePaused([string[]]$names) {
  [bool]($names | Where-Object { $_ -like '*中断了当前响应*队列已暂停*' -or $_ -like '*queue*paused*interrupted*' } | Select-Object -First 1)
}

function Test-CodexQueueRow([string[]]$names, [string]$firstLine) {
  $expected = Plain $firstLine
  if (-not $expected) { return $false }
  foreach ($name in $names) {
    $candidate = Plain (($name -split "\r?\n")[0])
    if ($candidate -eq $expected -or $candidate.EndsWith(": $expected") -or $candidate.EndsWith("：$expected")) { return $true }
  }
  return $false
}

function Test-CodexComposerEmpty([bool]$readable, [string]$value, [string]$name, [string[]]$children = @()) {
  if (-not $readable) { return $false }
  $value = Plain $value; $name = Plain $name
  if (-not $value) { return $true }
  # Chromium sometimes exposes the placeholder twice (and truncates its
  # second copy) when an async question is visible. Its empty editor has a
  # placeholder Text child followed by an empty Text child. A real draft,
  # even one exactly equal to the placeholder, lacks that empty structure.
  if (-not $name -or $children.Count -ne 2 -or (Plain $children[0]) -cne $name -or (Plain $children[1])) { return $false }
  if ($value -ceq $name) { return $true }
  if (-not $value.StartsWith($name, [StringComparison]::Ordinal)) { return $false }
  $tail = $value.Substring($name.Length)
  if ($tail.EndsWith('…')) { $tail = $tail.Substring(0, $tail.Length - 1) }
  return $tail.Length -gt 0 -and $name.StartsWith($tail, [StringComparison]::Ordinal)
}
