# Builds one NSIS installer that contains the desktop console and a self-contained
# connector (Node runtime + production dependencies + task script).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops\build-combined-installer.ps1
#   ... -ConnectorTgz releases\fengzhu-connect-0.2.75.tgz
#
# The connector payload is staged under .build\connector-payload (gitignored).
# The normal desktop build is unchanged; this script passes
# src-tauri\tauri.combined.conf.json so only the combined package gets the
# connector resources and the NSIS install/uninstall hooks.
# -CargoTargetDir defaults to $env:CARGO_TARGET_DIR, else .build\cargo-target.
param(
  [string]$ConnectorTgz = '',
  [string]$CargoTargetDir = '',
  [switch]$SkipNpmInstall
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $root '.build\connector-payload'
$desktop = Join-Path $root 'kh-link-desktop'
if (-not $CargoTargetDir) { $CargoTargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root '.build\cargo-target' } }

if (-not $ConnectorTgz) {
  $ConnectorTgz = Get-ChildItem (Join-Path $root 'releases\fengzhu-connect-*.tgz') |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $ConnectorTgz -or -not (Test-Path $ConnectorTgz)) { throw 'No connector tgz found. Publish or pass -ConnectorTgz.' }
$ConnectorTgz = (Resolve-Path $ConnectorTgz).Path

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Write-Host "Staging connector from $ConnectorTgz"
tar -xzf $ConnectorTgz -C $stage --strip-components=1
if (-not (Test-Path (Join-Path $stage 'src\cli.js'))) { throw 'Connector tgz is incomplete (no src/cli.js).' }

if (-not $SkipNpmInstall) {
  Push-Location $stage
  try { npm install --omit=dev --no-audit --no-fund | Out-Host } finally { Pop-Location }
}

$nodeSource = (Get-Command node.exe).Source
Copy-Item $nodeSource (Join-Path $stage 'node.exe') -Force
Copy-Item (Join-Path $root 'ops\connector-task.ps1') (Join-Path $stage 'connector-task.ps1') -Force
Copy-Item (Join-Path $root 'ops\run-program-hidden.vbs') (Join-Path $stage 'run-program-hidden.vbs') -Force

# Cross-network direct links run a Cloudflare quick tunnel (cloudflared,
# Apache-2.0). It ships with the installer so users need nothing else; only a
# pinned, Cloudflare-signed build is accepted. Put the official
# cloudflared-windows-amd64.exe of that release at the path below.
$cloudflaredVersion = '2026.5.0'
$cloudflaredSha256 = 'F141CDED099C239171AD2CEA6FB5DA0FDAA2BD36104C3074D883F9546519EBA7'
$cloudflared = Join-Path $root ".build\vendor\cloudflared-$cloudflaredVersion-windows-amd64.exe"
if (-not (Test-Path $cloudflared)) { throw "Missing $cloudflared (official cloudflared $cloudflaredVersion for Windows x64)." }
if ((Get-FileHash $cloudflared -Algorithm SHA256).Hash -ne $cloudflaredSha256) { throw "cloudflared $cloudflaredVersion does not match its pinned SHA-256." }
$signature = Get-AuthenticodeSignature $cloudflared
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O="Cloudflare, Inc\."') { throw "cloudflared is not signed by Cloudflare: $($signature.Status)" }
$tools = Join-Path $stage 'tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
Copy-Item $cloudflared (Join-Path $tools 'cloudflared.exe') -Force
Set-Content -Path (Join-Path $tools 'cloudflared-NOTICE.txt') -Encoding UTF8 -Value @"
cloudflared $cloudflaredVersion (https://github.com/cloudflare/cloudflared)
Copyright Cloudflare, Inc. Licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0
khLink runs it only for cross-network direct links (a Cloudflare quick tunnel).
"@
Write-Host "Bundled cloudflared $cloudflaredVersion (signed by Cloudflare)"

$node = Join-Path $stage 'node.exe'
$cli = Join-Path $stage 'src\cli.js'
# Resolve from the staged tree itself: "node -e" resolves from the current
# directory, which made the check depend on where the script was started.
Push-Location $stage
try { & $node -e "for (const m of ['ws','werift','@primno/dpapi','libsodium-wrappers-sumo']) require.resolve(m); console.log('connector dependencies ok')" } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'The staged connector cannot resolve its production dependencies.' }

$size = (Get-ChildItem $stage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("Connector payload: {0:N1} MB, node {1}" -f ($size / 1MB), (& $node --version))

$env:CARGO_TARGET_DIR = $CargoTargetDir
Push-Location $desktop
try {
  npx --yes @tauri-apps/cli@2.12.2 build --config src-tauri/tauri.combined.conf.json --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }
} finally { Pop-Location }

$version = (Get-Content (Join-Path $root 'kh-link-desktop\src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$setup = Join-Path $CargoTargetDir ("release\bundle\nsis\khLink_{0}_x64-setup.exe" -f $version)
if (-not (Test-Path $setup)) { throw "Installer not found: $setup" }
$hash = (Get-FileHash $setup -Algorithm SHA256).Hash
Write-Host ("Combined installer: {0}" -f $setup)
Write-Host ("{0:N0} bytes  SHA-256 {1}" -f (Get-Item $setup).Length, $hash)
