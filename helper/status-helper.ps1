# Sentinel OS Helper — status
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$cfg = Join-Path $cfgDir "worker.json"
$pidFile = Join-Path $cfgDir "helper.pid"
Write-Host "Config dir : $cfgDir"
if (Test-Path $cfg) {
  $data = Get-Content $cfg -Raw | ConvertFrom-Json
  Write-Host "Paired     : yes"
  Write-Host "worker_id  : $($data.worker_id)"
  Write-Host "cloud_url  : $($data.cloud_base_url)"
} else { Write-Host "Paired     : no  — run start-helper.ps1 -PairingCode <CODE>" }
if (Test-Path $pidFile) {
  $targetPid = Get-Content $pidFile | Select-Object -First 1
  try { $p = Get-Process -Id [int]$targetPid -ErrorAction Stop; Write-Host "Daemon PID : $targetPid (running, $([int]((Get-Date) - $p.StartTime).TotalSeconds)s)" }
  catch { Write-Host "Daemon PID : $targetPid (not running — stale pid file)" }
} else { Write-Host "Daemon     : not started" }
