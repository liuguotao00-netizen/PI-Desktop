# Sync the source of truth into PI-Desktop's installed copy.
#
# PI-Desktop import copies the whole package into
#   %USERPROFILE%\.pi-desktop\plugins\imported\<name>\src\
# as a plain SNAPSHOT (not a symlink), so editing this repository alone has no
# effect on the running app. This script copies the single source file
# extensions/deepseek-web/index.ts into the installed copy and verifies SHA256.
#
# Usage (from the repo root):
#   pwsh -File scripts\sync-to-pi-desktop.ps1            # apply
#   pwsh -File scripts\sync-to-pi-desktop.ps1 -DryRun    # compare only
#   pwsh -File scripts\sync-to-pi-desktop.ps1 -PluginDir <path>
#
# After a real sync: reload the plugin on PI-Desktop's Plugins page (or restart
# the app), then open a NEW session - tools are registered at session start.
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$PluginDir = (Join-Path $env:USERPROFILE '.pi-desktop\plugins\imported\pi-deepseek-web')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot 'extensions\deepseek-web\index.ts'
$dst = Join-Path $PluginDir 'src\extensions\deepseek-web\index.ts'

if (-not (Test-Path $src)) { throw "source file not found: $src" }
if (-not (Test-Path $dst)) {
    Write-Host "installed copy not found: $dst" -ForegroundColor Red
    Write-Host 'Import the package first: PI-Desktop -> Plugins -> Import pi extension -> select this repo directory.'
    exit 1
}

$srcHash = (Get-FileHash $src).Hash
$dstHash = (Get-FileHash $dst).Hash

if ($srcHash -eq $dstHash) {
    Write-Host "in sync  $srcHash" -ForegroundColor Green
    Write-Host "  src: $src"
    Write-Host "  dst: $dst"
    exit 0
}

Write-Host "OUT OF SYNC" -ForegroundColor Yellow
Write-Host "  src  $srcHash  $((Get-Item $src).Length) B  $((Get-Item $src).LastWriteTime)"
Write-Host "  dst  $dstHash  $((Get-Item $dst).Length) B  $((Get-Item $dst).LastWriteTime)"

if ($DryRun) { Write-Host 'DRY RUN - nothing written.' -ForegroundColor Yellow; exit 0 }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$dst.bak-$stamp"
Copy-Item $dst $backup
Write-Host "backup: $backup"

Copy-Item $src $dst -Force
$after = (Get-FileHash $dst).Hash
if ($after -ne $srcHash) { throw "verification failed: dst hash $after != src hash $srcHash (restore from $backup)" }

Write-Host "synced  $after" -ForegroundColor Green
Write-Host 'Now: PI-Desktop -> Plugins -> reload this plugin, then start a NEW session.'
