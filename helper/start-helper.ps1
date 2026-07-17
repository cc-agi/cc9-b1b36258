# Sentinel OS Helper — start (P0-R5 R3)
#
# Refuses to launch when the pid file identifies a still-running Helper,
# including one running elevated. Duplicate Helpers alternate cloud
# heartbeats between versions and corrupt worker leases.
param(
  [string]$PairingCode,
  [string]$Cloud = "https://cc9.lovable.app",
  [string]$WorkerId
)
$ErrorActionPreference = "Stop"
$HelperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
$cfg = Join-Path $cfgDir "worker.json"
$pidFile = Join-Path $cfgDir "helper.pid"
$logFile = Join-Path $cfgDir "helper.log"

# ---------- Duplicate-launch guard (cross-elevation via tasklist) ----------
# Get-Process / Get-CimInstance return $null against an elevated PID from a
# non-elevated shell. tasklist is visible across elevation boundaries.
if (Test-Path $pidFile) {
  $existingRaw = (Get-Content $pidFile | Select-Object -First 1).Trim()
  if ($existingRaw -match '^\d+$') {
    $existingPid = [int]$existingRaw
    $tl = & tasklist /FI "PID eq $existingPid" /FO CSV /NH 2>$null
    $exists = $false
    if ($LASTEXITCODE -eq 0 -and $tl) {
      foreach ($line in $tl) {
        if ($line -and $line -notmatch '^INFO:') { $exists = $true; break }
      }
    }
    if ($exists) {
      Write-Host "Sentinel Helper appears to already be running as PID $existingPid."
      Write-Host "Refusing to launch a duplicate. If that PID is elevated, run"
      Write-Host "helper\stop-helper.ps1 from an Administrator PowerShell first."
      Write-Host "Pid file NOT overwritten."
      exit 4
    } else {
      Write-Host "Stale pid file for PID $existingPid (process gone); cleaning up."
      Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "Invalid pid file contents; removing."
    Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  }
}

if ($PairingCode) {
  Push-Location $HelperDir
  try {
    $pargs = @("src\pair.mjs", $PairingCode, "--cloud", $Cloud)
    if ($WorkerId) { $pargs += @("--worker-id", $WorkerId) }
    node @pargs
  } finally { Pop-Location }
  # Tighten ACL on the freshly written worker.json
  if (Test-Path $cfg) {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $cfg /inheritance:r | Out-Null
    icacls $cfg /grant:r "${me}:F" | Out-Null
  }
}
if (-not (Test-Path $cfg)) {
  Write-Error "No worker.json at $cfg. Run with -PairingCode <CODE> first."
  exit 2
}
Write-Host "Launching Sentinel Helper..."
$proc = Start-Process -FilePath "node" -ArgumentList @("src\index.mjs") `
  -WorkingDirectory $HelperDir -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err" `
  -WindowStyle Hidden -PassThru
$proc.Id | Out-File -FilePath $pidFile -Encoding ascii
Write-Host "Started PID $($proc.Id). Logs: $logFile"
