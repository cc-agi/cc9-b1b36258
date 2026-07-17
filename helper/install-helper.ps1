# Sentinel OS Helper — install
# Installs dependencies. No admin required.
$ErrorActionPreference = "Stop"
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $HelperDir
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 20+ is required. Install from https://nodejs.org and re-run."
    exit 1
  }
  Write-Host "Installing dependencies in $HelperDir ..."
  npm install --omit=dev
  $cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
  if (-not (Test-Path $cfgDir)) { New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null }
  Write-Host "✓ Installed. Config directory: $cfgDir"
  Write-Host "Next: .\start-helper.ps1 -PairingCode <CODE>"
} finally { Pop-Location }
