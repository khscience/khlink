# Filesystem-only transaction, shared with synthetic Junction regression tests.
# All deletes below are non-recursive and limited to verified Junction objects.
Set-StrictMode -Version Latest
function Get-KhLinkContext([string]$Root, [string]$Link, [string]$From, [string]$To) {
    if ($From -notmatch '^[a-z][a-z0-9-]{0,31}$' -or $To -notmatch '^[a-z][a-z0-9-]{0,31}$') { throw 'invalid aliases' }
    $base = [IO.Path]::GetFullPath($Root)
    $source = Join-Path $base ('profiles\' + $From)
    $target = Join-Path $base ('profiles\' + $To)
    foreach ($directory in @($source,$target)) {
        $d = Get-Item -LiteralPath $directory -Force
        if (-not $d.PSIsContainer -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid profile directory' }
    }
    return @{link=[IO.Path]::GetFullPath($Link); source=$source; target=$target; from=$From; to=$To; journal=(Join-Path $base 'shared\link-transaction.json')}
}
function Read-KhLink($Context, [string]$Name) {
    $v = Get-Item -LiteralPath $Name -Force -ErrorAction SilentlyContinue
    if (-not $v) { return $null }
    if ($v.LinkType -ne 'Junction' -or @($v.Target).Count -ne 1 -or @($v.Target)[0] -notin @($Context.source,$Context.target)) { throw 'unknown link' }
    return [string]@($v.Target)[0]
}
function Write-KhLinkPhase($Context, [string]$Phase) {
    $row = @{from=$Context.from;to=$Context.to;pid=$PID;at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();phase=$Phase}
    $temp=$Context.journal+'.tmp'
    [IO.File]::WriteAllText($temp, ($row | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $Context.journal -Force
}
function Remove-KhLink($Context, [string]$Name) {
    if (Read-KhLink $Context $Name) { [IO.Directory]::Delete($Name) }
}
function Switch-KhProfileLink {
    param([string]$Root,[string]$Link,[string]$From,[string]$To,[scriptblock]$AfterPhase)
    $c=Get-KhLinkContext $Root $Link $From $To
    if ($From -eq $To -or (Read-KhLink $c $c.link) -ne $c.source) { throw 'source mismatch' }
    $next=$c.link+'.khlink-next';$old=$c.link+'.khlink-previous'
    if ((Get-Item -LiteralPath $next -Force -ErrorAction SilentlyContinue) -or (Get-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue)) { throw 'unresolved links' }
    Write-KhLinkPhase $c 'preparing'
    New-Item -ItemType Junction -Path $next -Target $c.target | Out-Null
    if ((Read-KhLink $c $next) -ne $c.target) { throw 'prepared mismatch' }
    Write-KhLinkPhase $c 'prepared'
    try {
        [IO.Directory]::Move($c.link,$old)
        Write-KhLinkPhase $c 'original_preserved'
        if ($AfterPhase) { & $AfterPhase 'original_preserved' }
        [IO.Directory]::Move($next,$c.link)
        if ((Read-KhLink $c $c.link) -ne $c.target) { throw 'replacement mismatch' }
        if ($AfterPhase) { & $AfterPhase 'replacement_verified' }
    } catch {
        if (-not (Get-Item -LiteralPath $c.link -Force -ErrorAction SilentlyContinue)) {
            if ((Read-KhLink $c $old) -ne $c.source) { throw 'preserved mismatch' }
            [IO.Directory]::Move($old,$c.link)
            Remove-KhLink $c $next
            Write-KhLinkPhase $c 'rolled_back'
        }
        throw
    }
    if ((Read-KhLink $c $old) -ne $c.source) { throw 'preserved mismatch' }
    Remove-KhLink $c $old
    Write-KhLinkPhase $c 'done'
}
function Restore-KhProfileLink {
    param([string]$Root,[string]$Link,[string]$From,[string]$To)
    $c=Get-KhLinkContext $Root $Link $From $To
    $next=$c.link+'.khlink-next';$old=$c.link+'.khlink-previous'
    # Check all three before the first mutation. An unknown directory/link
    # remains untouched, even if one of the other entries looks recoverable.
    $active=Read-KhLink $c $c.link;$staged=Read-KhLink $c $next;$preserved=Read-KhLink $c $old
    if ($preserved -and $preserved -ne $c.source) { throw 'preserved mismatch' }
    if ($staged) { Remove-KhLink $c $next }
    if ($active -ne $c.source) {
        if (-not $preserved) { New-Item -ItemType Junction -Path $old -Target $c.source | Out-Null }
        if ($active) { [IO.Directory]::Move($c.link,$next) }
        [IO.Directory]::Move($old,$c.link)
    }
    if ((Read-KhLink $c $c.link) -ne $c.source) { throw 'restored mismatch' }
    Remove-KhLink $c $next;Remove-KhLink $c $old
    Write-KhLinkPhase $c 'rolled_back'
}
Export-ModuleMember -Function Switch-KhProfileLink,Restore-KhProfileLink
