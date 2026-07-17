# Sentinel OS Helper — stop (P0-R5 R3)
#
# Elevation-aware: must distinguish
#   a. process absent (safe to clear pid file)
#   b. process exists but access is denied (elevated helper — do NOT delete
#      pid file, tell Owner to rerun as Administrator).
#
# Exit codes:
#   0 - stopped cleanly, or already absent
#   1 - pid file identifies a non-Helper process (refused)
#   2 - Stop-Process attempted but process still running
#   3 - PID exists but access denied (need Administrator)
$ErrorActionPreference = "SilentlyContinue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgDir  = Join-Path $env:LOCALAPPDATA "SentinelOS"
$pidFile = Join-Path $cfgDir "helper.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "Not running (no pid file)."
  exit 0
}

$rawPid = (Get-Content $pidFile | Select-Object -First 1).Trim()
if ($rawPid -notmatch '^\d+$') {
  Write-Host "Invalid pid file contents; removing."
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 0
}
$targetPid = [int]$rawPid

# Cross-elevation visibility check via tasklist (works even when the target
# process runs elevated and Get-CimInstance would return $null under a
# non-elevated shell). tasklist enumerates ALL sessions and returns exit 0
# with a data row when the PID exists, or exit 0 with an "INFO:" row when
# it does not.
$tl = & tasklist /FI "PID eq $targetPid" /FO CSV /NH 2>$null
$pidExists = $false
if ($LASTEXITCODE -eq 0 -and $tl) {
  foreach ($line in $tl) {
    if ($line -and $line -notmatch '^INFO:') { $pidExists = $true; break }
  }
}

if (-not $pidExists) {
  Write-Host "PID $targetPid not running; clearing pid file."
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 0
}

# PID exists. Try to read the CommandLine to confirm it is the Helper.
# Under a non-elevated shell against an elevated target, this call returns
# $null even though tasklist confirmed the PID exists -> access denied.
$cim = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
if (-not $cim) {
  Write-Host "PID $targetPid exists but cannot be inspected (access denied)."
  Write-Host "The Helper may be running elevated. Rerun this script from an Administrator PowerShell:"
  Write-Host "    Start-Process powershell -Verb RunAs -ArgumentList '-ExecutionPolicy','Bypass','-File','$PSCommandPath'"
  Write-Host "Refusing to clear pid file to avoid orphaning the elevated Helper."
  exit 3
}
$cmdLine = $cim.CommandLine
if ($cmdLine -and $cmdLine -notmatch 'helper[\\/]src[\\/]index\.mjs' -and $cmdLine -notmatch 'index\.mjs') {
  Write-Host "PID $targetPid is not the Sentinel Helper (command line does not match); refusing to kill."
  Write-Host "Command line: $cmdLine"
  exit 1
}

try {
  Stop-Process -Id $targetPid -Force -ErrorAction Stop
} catch {
  # Access-denied on Stop-Process against an elevated target.
  if ($_.Exception.Message -match 'Access is denied|requested operation requires elevation') {
    Write-Host "Access denied stopping PID $targetPid. The Helper is running elevated."
    Write-Host "Rerun this script from an Administrator PowerShell. Pid file NOT deleted."
    exit 3
  }
  Write-Host "Failed to stop PID ${targetPid}: $($_.Exception.Message)"
}

# Confirm process is gone (re-check via tasklist for cross-elevation truth).
Start-Sleep -Milliseconds 500
$tl2 = & tasklist /FI "PID eq $targetPid" /FO CSV /NH 2>$null
$stillExists = $false
if ($tl2) {
  foreach ($line in $tl2) {
    if ($line -and $line -notmatch '^INFO:') { $stillExists = $true; break }
  }
}
if ($stillExists) {
  Write-Host "Process $targetPid still running after Stop-Process."
  exit 2
}
Write-Host "Stopped PID $targetPid"
Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
