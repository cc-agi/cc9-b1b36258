# Sentinel OS Helper — stop
$ErrorActionPreference = "SilentlyContinue"
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$pidFile = Join-Path $cfgDir "helper.pid"
if (-not (Test-Path $pidFile)) { Write-Host "Not running (no pid file)."; exit 0 }
$targetPid = Get-Content $pidFile | Select-Object -First 1
if ($targetPid) {
  try { Stop-Process -Id [int]$targetPid -Force; Write-Host "✓ Stopped PID $targetPid" } catch { Write-Host "Process $targetPid not running." }
}
Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
