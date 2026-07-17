# Sentinel OS Helper — install (P0-R2c)
# No admin required. Applies icacls so worker.json is readable only by the current Windows user.
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
  # Lock down to current user only
  $me = "$env:USERDOMAIN\$env:USERNAME"
  Write-Host "Applying ACL: $cfgDir owned by $me, inherited perms removed."
  icacls $cfgDir /inheritance:r | Out-Null
  icacls $cfgDir /grant:r "${me}:(OI)(CI)F" | Out-Null
  # If worker.json already exists (re-install), tighten it explicitly.
  $cfg = Join-Path $cfgDir "worker.json"
  if (Test-Path $cfg) {
    icacls $cfg /inheritance:r | Out-Null
    icacls $cfg /grant:r "${me}:F" | Out-Null
  }
  Write-Host "✓ Installed. Config directory: $cfgDir"
  Write-Host "Next: .\start-helper.ps1 -PairingCode <CODE>"
} finally { Pop-Location }
