Set-StrictMode -Version Latest
# Only verified Junction objects are renamed/deleted. Account data is never moved.
function Get-KhEnrollmentContext([string]$Root,[string]$Link,[string]$To,[string[]]$KnownAliases) {
    if ($To -notmatch '^[a-z][a-z0-9-]{0,31}$') { throw 'invalid enrollment alias' }
    $rootPath=[IO.Path]::GetFullPath($Root)
    $target=Join-Path $rootPath ('profiles\'+$To)
    $item=Get-Item -LiteralPath $target -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid enrollment target' }
    return @{root=$rootPath;link=[IO.Path]::GetFullPath($Link);target=$target;to=$To;known=@($KnownAliases);next=($Link+'.khlink-enroll-next');old=($Link+'.khlink-enroll-previous');journal=(Join-Path $rootPath 'shared\enrollment-link.json')}
}
function Read-KhEnrollmentLink($Context,[string]$File) {
    $item=Get-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    if ($item.LinkType -ne 'Junction' -or @($item.Target).Count -ne 1) { throw 'unknown enrollment path' }
    $target=[IO.Path]::GetFullPath([string]@($item.Target)[0]).TrimEnd('\')
    foreach($alias in $Context.known){
        if ($alias -notmatch '^[a-z][a-z0-9-]{0,31}$') { throw 'invalid known alias' }
        if ($target -eq (Join-Path $Context.root ('profiles\'+$alias))) { return $alias }
    }
    throw 'unknown enrollment link'
}
function Write-KhEnrollmentPhase($Context,$Record,[string]$Phase) {
    $Record.phase=$Phase;$Record.pid=$PID;$Record.at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $temporary=$Context.journal+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    [IO.File]::WriteAllText($temporary,($Record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Context.journal -Force
}
function Read-KhEnrollmentJournal($Context) {
    if (-not (Test-Path -LiteralPath $Context.journal)) { return $null }
    $record=Get-Content -LiteralPath $Context.journal -Raw -Encoding UTF8|ConvertFrom-Json
    if ($record.version -ne 1) { throw 'unknown enrollment transaction' }
    if ($record.to -ne $Context.to -and $record.phase -in @('done','rolled_back')) { return $null }
    if ($record.to -ne $Context.to -or $record.to -notin $Context.known -or ($record.from -and $record.from -notin $Context.known)) { throw 'unknown enrollment transaction' }
    return $record
}
function Remove-KhEnrollmentLink($Context,[string]$File) {
    if (Read-KhEnrollmentLink $Context $File) { [IO.Directory]::Delete($File) }
}
function Set-KhEnrollmentLink {
    param([string]$Root,[string]$Link,[string]$To,[string[]]$KnownAliases,[scriptblock]$AfterPhase)
    $c=Get-KhEnrollmentContext $Root $Link $To $KnownAliases
    $active=Read-KhEnrollmentLink $c $c.link;$old=Read-KhEnrollmentLink $c $c.old;$next=Read-KhEnrollmentLink $c $c.next
    $record=Read-KhEnrollmentJournal $c
    if($record -and $record.phase -in @('preparing','prepared','original_preserved','login')){
        if($active -eq $To -and (-not $record.existed -or $old -eq $record.from)) { Write-KhEnrollmentPhase $c $record 'login';return $record }
        if(-not $active -and $old -eq $record.from -and $next -eq $To){[IO.Directory]::Move($c.next,$c.link);Write-KhEnrollmentPhase $c $record 'login';return $record}
        if($active -ne $record.from -or $old -or ($next -and $next -ne $To)){throw 'enrollment recovery requires inspection'}
        if($next){Remove-KhEnrollmentLink $c $c.next}
    } elseif($old -or $next){throw 'unresolved enrollment links'}
    if($active -eq $To){throw 'enrollment source not recorded'}
    $record=@{version=1;from=$active;to=$To;existed=([bool]$active);phase='preparing';pid=$PID;at=0}
    Write-KhEnrollmentPhase $c $record 'preparing'
    New-Item -ItemType Junction -Path $c.next -Target $c.target | Out-Null
    if((Read-KhEnrollmentLink $c $c.next) -ne $To){throw 'enrollment preparation mismatch'}
    Write-KhEnrollmentPhase $c $record 'prepared'
    try{
        if($active){[IO.Directory]::Move($c.link,$c.old)}
        Write-KhEnrollmentPhase $c $record 'original_preserved'
        if($AfterPhase){& $AfterPhase 'original_preserved'}
        [IO.Directory]::Move($c.next,$c.link)
        if((Read-KhEnrollmentLink $c $c.link) -ne $To){throw 'enrollment replacement mismatch'}
        if($AfterPhase){& $AfterPhase 'replacement_verified'}
        Write-KhEnrollmentPhase $c $record 'login'
    }catch{
        if(-not (Read-KhEnrollmentLink $c $c.link)){
            if($active){if((Read-KhEnrollmentLink $c $c.old) -ne $active){throw 'enrollment original mismatch'};[IO.Directory]::Move($c.old,$c.link)}
            Remove-KhEnrollmentLink $c $c.next
            Write-KhEnrollmentPhase $c $record 'rolled_back'
        }
        throw
    }
    return $record
}
function Complete-KhEnrollmentLink {
    param([string]$Root,[string]$Link,[string]$To,[string[]]$KnownAliases)
    $c=Get-KhEnrollmentContext $Root $Link $To $KnownAliases;$record=Read-KhEnrollmentJournal $c
    if(-not $record -or (Read-KhEnrollmentLink $c $c.link) -ne $To){throw 'enrollment active link mismatch'}
    $old=Read-KhEnrollmentLink $c $c.old;$next=Read-KhEnrollmentLink $c $c.next
    if(($old -and $old -ne $record.from) -or ($next -and $next -ne $To)){throw 'unknown retained enrollment link'}
    if($record.existed -and $record.phase -ne 'done' -and -not $old){throw 'enrollment original link missing'}
    Remove-KhEnrollmentLink $c $c.old;Remove-KhEnrollmentLink $c $c.next
    Write-KhEnrollmentPhase $c $record 'done'
}
function Restore-KhEnrollmentLink {
    param([string]$Root,[string]$Link,[string]$To,[string[]]$KnownAliases)
    $c=Get-KhEnrollmentContext $Root $Link $To $KnownAliases;$record=Read-KhEnrollmentJournal $c
    if(-not $record -or $record.phase -notin @('login','original_preserved','prepared','rolled_back')){throw 'enrollment cannot be returned'}
    $active=Read-KhEnrollmentLink $c $c.link;$old=Read-KhEnrollmentLink $c $c.old;$next=Read-KhEnrollmentLink $c $c.next
    if(($active -and $active -notin @($To,$record.from)) -or ($old -and $old -ne $record.from) -or ($next -and $next -ne $To)){throw 'unknown enrollment return path'}
    if($active -eq $record.from -and -not $old){Remove-KhEnrollmentLink $c $c.next;Write-KhEnrollmentPhase $c $record 'rolled_back';return $record}
    if($record.existed -and -not $old){throw 'enrollment original is not available'}
    if($active -eq $To){[IO.Directory]::Move($c.link,$c.next)}
    try{if($record.existed){[IO.Directory]::Move($c.old,$c.link)}}catch{if(-not (Get-Item -LiteralPath $c.link -Force -ErrorAction SilentlyContinue)){[IO.Directory]::Move($c.next,$c.link)};throw}
    Remove-KhEnrollmentLink $c $c.next
    Write-KhEnrollmentPhase $c $record 'rolled_back';return $record
}
Export-ModuleMember -Function Set-KhEnrollmentLink,Complete-KhEnrollmentLink,Restore-KhEnrollmentLink
