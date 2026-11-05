param(
    [Parameter(Mandatory=$true)][ValidateSet('open','complete','return')][string]$Action,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9-]{0,31}$')][string]$Profile
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$root='G:\Apps\ClaudeSwitch'
$lockPath=Join-Path $root 'shared\desktop-switch.lock'
$lockStream=$null
function Assert-EnrollmentOffline {
    & powershell.exe -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'assert-enroll-offline.ps1') | Out-Null
    if($LASTEXITCODE -ne 0){throw 'onboarding_exit_required'}
}
function Write-EnrollmentLock([string]$Phase,[int]$Child=0){
    $record.phase=$Phase;$record.helperPid=$Child;$record.at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress))
    $lockStream.Position=0;$lockStream.SetLength(0);$lockStream.Write($bytes,0,$bytes.Length);$lockStream.Flush($true)
}
function Invoke-EnrollmentNode([string[]]$Arguments){
    $start=New-Object Diagnostics.ProcessStartInfo
    $start.FileName=(Get-Command node.exe -ErrorAction Stop).Source
    $start.Arguments=(@((Join-Path $PSScriptRoot 'console.cjs'))+$Arguments|ForEach-Object{'"'+$_.Replace('"','\"')+'"'}) -join ' '
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $child=[Diagnostics.Process]::Start($start)
    if($lockStream){Write-EnrollmentLock 'syncing' $child.Id}
    $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync();$child.WaitForExit()
    if($lockStream){Write-EnrollmentLock 'syncing' 0}
    if($child.ExitCode -ne 0){
        $code='component_failed'
        try{$parsed=$stderr.GetAwaiter().GetResult()|ConvertFrom-Json;if($parsed.code -match '^(onboarding_[a-z_]+|component_failed)$'){$code=$parsed.code}}catch{}
        throw $code
    }
    return $stdout.GetAwaiter().GetResult()|ConvertFrom-Json
}
try{
    Assert-EnrollmentOffline
    $config=Get-Content -LiteralPath (Join-Path $root 'shared\config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $store=Get-Content -LiteralPath (Join-Path $root 'shared\onboarding.json') -Raw -Encoding UTF8|ConvertFrom-Json
    if(-not $store.profiles.$Profile -or $store.profiles.$Profile.phase -eq 'removed'){throw 'onboarding_missing'}
    $known=@($config.profiles.PSObject.Properties.Name)+@($store.profiles.PSObject.Properties.Name)
    if($config.unavailableProfiles){$known+=@($config.unavailableProfiles.PSObject.Properties.Name)}
    $known=@($known|Where-Object {$_}|Select-Object -Unique)
    Import-Module (Join-Path $PSScriptRoot 'onboarding-links.psm1') -Force
    # Only our own dead enrollment owner may be recovered; live helpers and all
    # ordinary switches remain protected by the native mutex and Node checks.
    Invoke-EnrollmentNode @('onboard','recover',$Profile) | Out-Null
    $lockStream=[IO.File]::Open($lockPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    $record=@{kind='onboarding';requestId=('enroll-'+[guid]::NewGuid().ToString('N'));pid=$PID;helperPid=0;from='unconfigured';to=$Profile;origin='desktop';action='switch';phase='checking';busy=$true;startedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();at=0;message='Preparing new Claude account'}
    Write-EnrollmentLock 'checking'
    if($Action -eq 'open'){
        $prepared=Invoke-EnrollmentNode @('onboard','prepare',$Profile,[string]$PID)
        if($prepared.from){$record.from=$prepared.from}
        Assert-EnrollmentOffline
        Set-KhEnrollmentLink -Root $root -Link $config.activeLink -To $Profile -KnownAliases $known | Out-Null
        Write-EnrollmentLock 'opening'
        @{launch=$true;profile=$Profile;pending=$true}|ConvertTo-Json -Compress
    }elseif($Action -eq 'complete'){
        Invoke-EnrollmentNode @('onboard','complete',$Profile,[string]$PID) | Out-Null
        Assert-EnrollmentOffline
        Complete-KhEnrollmentLink -Root $root -Link $config.activeLink -To $Profile -KnownAliases $known
        Invoke-EnrollmentNode @('onboard','commit',$Profile,[string]$PID) | Out-Null
        @{launch=$true;profile=$Profile;completed=$true}|ConvertTo-Json -Compress
    }else{
        Assert-EnrollmentOffline
        $restored=Restore-KhEnrollmentLink -Root $root -Link $config.activeLink -To $Profile -KnownAliases $known
        Invoke-EnrollmentNode @('onboard','returned',$Profile,[string]$PID) | Out-Null
        $launch=($restored.from -and $config.profiles.$($restored.from) -and (Test-Path -LiteralPath (Join-Path $root ('profiles\'+$restored.from)) -PathType Container))
        @{launch=[bool]$launch;profile=$restored.from;returned=$true}|ConvertTo-Json -Compress
    }
}catch{
    $code=[string]$_.Exception.Message
    if($code -notmatch '^(onboarding_[a-z_]+|component_failed)$'){$code='onboarding_directory'}
    [Console]::Error.WriteLine((@{code=$code}|ConvertTo-Json -Compress));exit 1
}finally{if($lockStream){$lockStream.Dispose();Remove-Item -LiteralPath $lockPath -ErrorAction SilentlyContinue}}
