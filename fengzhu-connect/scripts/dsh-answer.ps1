param(
    [Parameter(Mandatory = $true)][ValidateSet('list', 'answer')][string]$Action,
    [string]$SessionTitle = '',
    [string]$Option = '',
    [int]$TimeoutSeconds = 15,
    # JSON list, one entry per question page: the label chosen on it (UTF-8 file).
    [string]$AnswersFile = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KhDshNative {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@ | Out-Null

function Get-DshWindow {
    $proc = Get-Process | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.ProcessName -ne 'chrome' -and $_.MainWindowTitle -like '*DeepSeek Harness*'
    } | Select-Object -First 1
    if (-not $proc) { throw 'DSH desktop window not found' }
    $handle = [IntPtr]$proc.MainWindowHandle
    # The approval/answer card only exists in a realized window. Bring a
    # minimized or background DSH window back before UIA reads its tree;
    # otherwise FindAll can return an empty tree and the phone sees a
    # "没有响应" error even though the card is still waiting on the desktop.
    if ([KhDshNative]::IsIconic($handle)) { [KhDshNative]::ShowWindow($handle, 9) | Out-Null }
    [KhDshNative]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds 180
    [System.Windows.Automation.AutomationElement]::FromHandle($handle)
}

function Get-Elements($root, $type) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
    $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Invoke-Element($element) {
    if ($null -eq $element) { return $false }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        return $true
    }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select()
        return $true
    }
    return $false
}

# The sidebar list renders only rows near its view: a session far from it
# (a new one at the bottom) is not in the UI tree until scrolled to.
function Find-SessionRows($root, $title) {
    $rows = { @(Get-Elements $root ([System.Windows.Automation.ControlType]::TreeItem) | Where-Object { $_.Current.Name -like "*$title*" }) }
    $found = & $rows
    if ($found.Count) { return $found }
    $tree = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Tree)))
    $scroll = $null
    if (-not $tree -or -not $tree.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$scroll)) { return @() }
    $start = $scroll.Current.VerticalScrollPercent
    $step = [Math]::Max(5, [Math]::Floor($scroll.Current.VerticalViewSize / 2))
    for ($at = 0; $at -le 100; $at += $step) {
        try { $scroll.SetScrollPercent(-1, [Math]::Min(100, $at)) } catch { break }
        Start-Sleep -Milliseconds 250
        $found = & $rows
        if ($found.Count) { return $found }
    }
    try { $scroll.SetScrollPercent(-1, [Math]::Min(100, [Math]::Max(0, $start))) } catch { }
    return @()
}

function Select-Session($root, $title) {
    $items = @(Get-Elements $root ([System.Windows.Automation.ControlType]::TreeItem) | Where-Object { $_.Current.Name })
    if ($title -ne '') {
        $matches = @(Find-SessionRows $root $title)
        if ($matches.Count -eq 0) { throw "DSH session not found: $title" }
        # Prefer the row that is actually showing a question or approval. A
        # session can keep its old title while a card is open, and there can
        # be several rows whose visible title starts with the same text.
        $target = $matches | Where-Object { $_.Current.Name -match '等待(回答|审批)' } | Select-Object -First 1
        if (-not $target) { $target = $matches | Select-Object -First 1 }
    } else {
        $target = $items | Where-Object { $_.Current.Name -match '等待(回答|审批)' } | Select-Object -First 1
        if (-not $target) { throw 'DSH 桌面端没有等待回答的问题或审批' }
    }
    if (-not (Invoke-Element $target)) { throw 'DSH session could not be selected' }
    Start-Sleep -Milliseconds 450
}

function Get-Card($root) {
    $radios = @(Get-Elements $root ([System.Windows.Automation.ControlType]::RadioButton) | Where-Object { $_.Current.Name })
    $buttons = @(Get-Elements $root ([System.Windows.Automation.ControlType]::Button) | Where-Object { $_.Current.Name })
    $texts = @(Get-Elements $root ([System.Windows.Automation.ControlType]::Text) | Where-Object { $_.Current.Name })
    $groups = @(Get-Elements $root ([System.Windows.Automation.ControlType]::Group) | Where-Object { $_.Current.Name })
    $submit = $buttons | Where-Object { $_.Current.Name -in @('提交', 'Submit') } | Select-Object -First 1
    $allow = $buttons | Where-Object { $_.Current.Name -match '允许一次|允许本次|允许|Allow once|Approve' } | Select-Object -First 1
    $deny = $buttons | Where-Object { $_.Current.Name -match '^(拒绝|Deny|Reject)$' } | Select-Object -First 1
    # Newer DSH renders the question prompt as the card header Button/Group,
    # while older builds used a Text. Accept all three so the phone can show
    # the actual question instead of an empty card.
    $promptCandidates = @($texts + $buttons + $groups)
    $prompt = $promptCandidates | Where-Object {
        $_.Current.Name.Length -gt 8 -and $_.Current.Name -ne $SessionTitle -and
        $_.Current.Name -notmatch 'DeepSeek Harness|等待回答|等待审批|电脑在线|^(复制|用量|等待你的操作)$'
    } | Where-Object { $_.Current.Name -match '[?？]|权限|允许|文件|file|工作区|操作' } | Select-Object -First 1
    if (-not $prompt) {
        $prompt = $promptCandidates | Where-Object {
            $_.Current.Name.Length -gt 8 -and $_.Current.Name -ne $SessionTitle -and
            $_.Current.Name -notmatch 'DeepSeek Harness|等待回答|等待审批|电脑在线|^(复制|用量|等待你的操作)$'
        } | Select-Object -First 1
    }
    [pscustomobject]@{
        RadioElements = @($radios)
        RadioNames = @($radios | ForEach-Object { $_.Current.Name })
        Submit = $submit
        Allow = $allow
        Deny = $deny
        Prompt = if ($prompt) { $prompt.Current.Name } else { '' }
    }
}

function Wait-Card($root, $timeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        $card = Get-Card $root
        if ($card.RadioElements.Count -gt 0 -or $card.Allow -or $card.Deny) { return $card }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw 'no pending DSH question or approval card found'
}

# A card with several questions shows one per page (上一题 / 下一题 / 提交).
# Start from the first page, choose each page's answer, then submit.
function Find-Radio($card, $label) {
    $radio = $card.RadioElements | Where-Object { $_.Current.Name -eq $label } | Select-Object -First 1
    $normalized = ($label -replace 's*[（(][^）)]*[）)]s*$', '').Trim()
    if (-not $radio -and $normalized) { $radio = $card.RadioElements | Where-Object { $_.Current.Name -eq $normalized } | Select-Object -First 1 }
    if (-not $radio -and $normalized) { $radio = $card.RadioElements | Where-Object { $_.Current.Name -and ($normalized.StartsWith($_.Current.Name) -or $_.Current.Name.StartsWith($normalized)) } | Select-Object -First 1 }
    return $radio
}
# The question shown on the current page (its header group ends with a question mark).
function Page-Question($root) { (Get-Elements $root ([System.Windows.Automation.ControlType]::Group) | Where-Object { $_.Current.Name -match '[?？]s*$' } | Select-Object -First 1).Current.Name }
function Page-Button($root, $names) { Get-Elements $root ([System.Windows.Automation.ControlType]::Button) | Where-Object { $_.Current.Name -in $names } | Select-Object -First 1 }
function Answer-Pages($root, $labels) {
    for ($i = 0; $i -lt 8; $i++) {
        $back = Page-Button $root @('上一题', 'Previous', 'Back')
        if (-not $back -or -not $back.Current.IsEnabled) { break }
        [void](Invoke-Element $back); Start-Sleep -Milliseconds 350
    }
    for ($page = 0; $page -lt $labels.Count; $page++) {
        $card = Wait-Card $root 5
        $before = Page-Question $root
        $radio = Find-Radio $card ([string]$labels[$page])
        if (-not $radio) { throw "option not found on page $($page + 1): $($labels[$page])" }
        if (-not (Invoke-Element $radio)) { throw 'option could not be selected' }
        Start-Sleep -Milliseconds 300
        if ($page -lt $labels.Count - 1) {
            # DSH moves on by itself once a single-choice page is answered.
            $moved = $false
            for ($w = 0; $w -lt 6 -and -not $moved; $w++) { Start-Sleep -Milliseconds 250; $moved = (Page-Question $root) -ne $before }
            if (-not $moved) {
                $next = Page-Button $root @('下一题', 'Next')
                if (-not $next -or -not $next.Current.IsEnabled -or -not (Invoke-Element $next)) { throw "next question not found after page $($page + 1)" }
                Start-Sleep -Milliseconds 450
            }
        }
    }
    $submit = Page-Button $root @('提交', 'Submit')
    if (-not $submit -or -not (Invoke-Element $submit)) { throw 'question submit not found' }
}

try {
    $root = Get-DshWindow
    Select-Session $root $SessionTitle
    $card = Wait-Card $root $TimeoutSeconds

    if ($Action -eq 'list') {
        if ($card.RadioElements.Count -gt 0) {
            [pscustomobject]@{
                ok = $true
                kind = 'question'
                prompt = $card.Prompt
                options = @($card.RadioNames)
                sessionTitle = $SessionTitle
            } | ConvertTo-Json -Compress
        } else {
            $options = @()
            if ($card.Allow) { $options += $card.Allow.Current.Name }
            if ($card.Deny) { $options += $card.Deny.Current.Name }
            [pscustomobject]@{
                ok = $true
                kind = 'approval'
                prompt = $card.Prompt
                options = $options
                sessionTitle = $SessionTitle
            } | ConvertTo-Json -Compress
        }
    } else {
        $clicked = ''
        if ($AnswersFile) {
            $labels = @((Get-Content -LiteralPath $AnswersFile -Raw -Encoding UTF8) | ConvertFrom-Json)
            if (-not $labels.Count) { throw 'no answers given' }
            Answer-Pages $root $labels
            Start-Sleep -Milliseconds 500
            [pscustomobject]@{ ok = $true; clicked = ($labels -join ' / ') } | ConvertTo-Json -Compress
            return
        }
        if ($card.RadioElements.Count -gt 0) {
            $radio = $card.RadioElements | Where-Object { $_.Current.Name -eq $Option } | Select-Object -First 1
            if (-not $radio) {
                # DSH often omits a display-only suffix such as "（推荐）" from
                # the radio's accessible name. Match the label without a trailing
                # parenthetical before falling back to prefix matching.
                $normalized = ($Option -replace '\s*[（(][^）)]*[）)]\s*$', '').Trim()
                if ($normalized) {
                    $radio = $card.RadioElements | Where-Object { $_.Current.Name -eq $normalized } | Select-Object -First 1
                }
            }
            if (-not $radio) {
                $normalized = ($Option -replace '\s*[（(][^）)]*[）)]\s*$', '').Trim()
                $radio = $card.RadioElements | Where-Object {
                    $_.Current.Name -and ($normalized.StartsWith($_.Current.Name) -or $_.Current.Name.StartsWith($normalized))
                } | Select-Object -First 1
            }
            if (-not $radio) { throw "option not found: $Option" }
            if (-not (Invoke-Element $radio)) { throw 'option could not be selected' }
            Start-Sleep -Milliseconds 250
            if (-not $card.Submit -or -not (Invoke-Element $card.Submit)) { throw 'question submit not found' }
            $clicked = $Option
        } elseif ($Option -match '^(拒绝|Deny|Reject)$' -and $card.Deny) {
            if (-not (Invoke-Element $card.Deny)) { throw 'deny could not be clicked' }
            $clicked = $card.Deny.Current.Name
        } elseif ($card.Allow) {
            if (-not (Invoke-Element $card.Allow)) { throw 'allow could not be clicked' }
            $clicked = $card.Allow.Current.Name
        } else {
            throw 'approval controls not found'
        }
        Start-Sleep -Milliseconds 500
        [pscustomobject]@{ ok = $true; clicked = $clicked } | ConvertTo-Json -Compress
    }
} catch {
    [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
