# Sentinel OS Helper — uninstall
$ErrorActionPreference = "SilentlyContinue"
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
& "$PSScriptRoot\stop-helper.ps1" | Out-Null
if (Test-Path $cfgDir) {
  Remove-Item -Recurse -Force $cfgDir
  Write-Host "✓ Removed $cfgDir"
} else { Write-Host "Nothing to remove." }
Write-Host "Note: Worker Token remains valid on the server until you revoke it in the Sentinel OS Console."
