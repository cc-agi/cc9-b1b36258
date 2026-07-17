# Sentinel OS Helper — start
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
    $pargs = @("src\pair.mjs", $PairingCode, "--cloud", $Cloud)
    if ($WorkerId) { $pargs += @("--worker-id", $WorkerId) }
    node @pargs
  } finally { Pop-Location }
  # Tighten ACL on the freshly written worker.json
  if (Test-Path $cfg) {
    $me = "$env:USERDOMAIN\$env:USERNAME"
    icacls $cfg /inheritance:r | Out-Null
    icacls $cfg /grant:r "${me}:F" | Out-Null
  }
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
