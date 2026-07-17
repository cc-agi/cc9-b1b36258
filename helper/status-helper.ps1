# Sentinel OS Helper — rich status (P0-R2c)
$ErrorActionPreference = "SilentlyContinue"
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$cfg = Join-Path $cfgDir "worker.json"
$pidFile = Join-Path $cfgDir "helper.pid"
$logFile = Join-Path $cfgDir "helper.log"

$HELPER_VERSION = "0.3.1"
Write-Host "Helper version : $HELPER_VERSION"
Write-Host "Config dir     : $cfgDir"

if (-not (Test-Path $cfg)) {
  Write-Host "Paired         : no  — run start-helper.ps1 -PairingCode <CODE>"
  exit 0
}
$data = Get-Content $cfg -Raw | ConvertFrom-Json
Write-Host "Paired         : yes"
Write-Host "Worker ID      : $($data.worker_id)"
Write-Host "Cloud URL      : $($data.cloud_base_url)"

# Daemon PID
$daemon = "not running"
if (Test-Path $pidFile) {
  $targetPid = Get-Content $pidFile | Select-Object -First 1
  try {
    $p = Get-Process -Id [int]$targetPid -ErrorAction Stop
    $daemon = "PID $targetPid (up $([int]((Get-Date) - $p.StartTime).TotalSeconds)s)"
  } catch { $daemon = "PID $targetPid (not running — stale pid)" }
}
Write-Host "Daemon         : $daemon"

# CDP probe
$cdpUrl = if ($env:SENTINEL_CDP_URL) { $env:SENTINEL_CDP_URL } else { "http://127.0.0.1:9222/json/version" }
try {
  $r = Invoke-WebRequest -Uri $cdpUrl -TimeoutSec 5 -UseBasicParsing
  if ($r.StatusCode -eq 200) { Write-Host "CDP            : OK ($cdpUrl)" } else { Write-Host "CDP            : HTTP $($r.StatusCode)" }
} catch { Write-Host "CDP            : unreachable ($cdpUrl)" }

# Last heartbeat + current run from log tail
if (Test-Path $logFile) {
  $tail = Get-Content $logFile -Tail 15
  $lastRun = ($tail | Select-String "\[claim\] run=") | Select-Object -Last 1
  $lastErr = ($tail | Select-String "\[heartbeat\]|\[poll\]|\[run\]|\[next-intent\]") | Select-Object -Last 1
  if ($lastRun) { Write-Host "Last claim     : $lastRun" }
  if ($lastErr) { Write-Host "Recent event   : $lastErr" }
}

# Cloud heartbeat is server-side; we don't call authenticated endpoints from this script.
Write-Host ""
Write-Host "For Cloud-side heartbeat / run state, open the Sentinel Console."
