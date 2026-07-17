# Sentinel OS Helper — start
# Pairs (if -PairingCode given) then launches the daemon in a new window.
param(
  [string]$PairingCode,
  [string]$Cloud = "https://cc9.lovable.app",
  [string]$WorkerId
)
$ErrorActionPreference = "Stop"
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$cfg = Join-Path $cfgDir "worker.json"

if ($PairingCode) {
  Push-Location $HelperDir
  try {
    $args = @("src\pair.mjs", $PairingCode, "--cloud", $Cloud)
    if ($WorkerId) { $args += @("--worker-id", $WorkerId) }
    node @args
  } finally { Pop-Location }
}
if (-not (Test-Path $cfg)) {
  Write-Error "No worker.json at $cfg. Run with -PairingCode <CODE> first."
  exit 2
}
Write-Host "Launching Sentinel Helper..."
$pidFile = Join-Path $cfgDir "helper.pid"
$logFile = Join-Path $cfgDir "helper.log"
$proc = Start-Process -FilePath "node" -ArgumentList @("src\index.mjs") `
  -WorkingDirectory $HelperDir -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
  -WindowStyle Hidden -PassThru
$proc.Id | Out-File -FilePath $pidFile -Encoding ascii
Write-Host "✓ Started PID $($proc.Id). Logs: $logFile"
