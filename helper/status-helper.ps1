# Sentinel OS Helper — rich status (P0-R3.1)
$ErrorActionPreference = "SilentlyContinue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$cfg = Join-Path $cfgDir "worker.json"
$pidFile = Join-Path $cfgDir "helper.pid"
$logFile = Join-Path $cfgDir "helper.log"

$HELPER_VERSION = "0.4.0"
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

# Daemon PID — verify process is ours (CommandLine references helper/src/index.mjs)
$daemon = "not running"
if (Test-Path $pidFile) {
  $rawPid = (Get-Content $pidFile | Select-Object -First 1).Trim()
  if ($rawPid -match '^\d+$') {
    $targetPid = [int]$rawPid
    try {
      $p = Get-Process -Id $targetPid -ErrorAction Stop
      $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue).CommandLine
      if ($cmdLine -and ($cmdLine -match 'helper[\\/]src[\\/]index\.mjs' -or $cmdLine -match 'index\.mjs')) {
        $uptime = [int]((Get-Date) - $p.StartTime).TotalSeconds
        $daemon = "PID $targetPid running (up ${uptime}s)"
      } else {
        $daemon = "PID $targetPid exists but not Sentinel Helper (stale pid)"
      }
    } catch {
      $daemon = "PID $targetPid not running (stale pid)"
    }
  } else {
    $daemon = "invalid pid file contents"
  }
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

Write-Host ""
Write-Host "For Cloud-side heartbeat / run state, open the Sentinel Console."
