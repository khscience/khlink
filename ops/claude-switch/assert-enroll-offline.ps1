$ErrorActionPreference='Stop'
try {
    $root='G:\Apps\ClaudeSwitch'
    $config=Get-Content -LiteralPath (Join-Path $root 'shared\config.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $expected=Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude'
    if($config.root -ne $root -or [IO.Path]::GetFullPath($config.activeLink) -ne $expected){throw 'unknown profile location'}
    $info=(& (Join-Path $PSScriptRoot 'desktop-info.ps1'))|ConvertFrom-Json
    if($info.version -ne $config.desktopVersion -or @($info.desktopPids).Count -ne 0 -or $info.helperCount -ne 0 -or $info.browserHelperBlockingCount -ne 0){throw 'official processes still running'}
    [Console]::WriteLine('OFFLINE_OK')
}catch{[Console]::Error.WriteLine('{"code":"onboarding_exit_required"}');exit 1}
