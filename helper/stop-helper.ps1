# Sentinel OS Helper — stop (P0-R5 R4, locale-safe PID guard)
#
# Elevation-aware AND locale-independent. Uses the shared tasklist parser
# in helper/lib/tasklist-pid.ps1 so Chinese Windows (信息: 没有运行的任务...)
# is not classified as "still running".
#
# Distinguishes:
#   a. process absent           -> safe to clear pid file (exit 0)
#   b. process exists, denied   -> DO NOT delete pid file; instruct Administrator (exit 3)
#   c. tasklist itself failed   -> DO NOT delete pid file; diagnostic (exit 5)
#
# Exit codes:
#   0 - stopped cleanly, or already absent
#   1 - pid file identifies a non-Helper process (refused)
#   2 - Stop-Process attempted but process still running
#   3 - PID exists but access denied (need Administrator)
#   5 - tasklist probe failed; refusing to guess
$ErrorActionPreference = "SilentlyContinue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgDir  = Join-Path $env:LOCALAPPDATA "SentinelOS"
$pidFile = Join-Path $cfgDir "helper.pid"

. (Join-Path $scriptDir "lib\tasklist-pid.ps1")

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

# Locale-independent cross-elevation existence probe.
$probe = Test-TasklistPidAlive -TargetPid $targetPid
if (-not $probe.ok) {
  Write-Host "tasklist probe FAILED (exit $($probe.exit)) for PID $targetPid."
  Write-Host "Cannot determine Helper state; pid file preserved."
  exit 5
}

if (-not $probe.alive) {
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

# Confirm process is gone (locale-independent recheck).
Start-Sleep -Milliseconds 500
$probe2 = Test-TasklistPidAlive -TargetPid $targetPid
if (-not $probe2.ok) {
  Write-Host "tasklist verification FAILED (exit $($probe2.exit)) for PID $targetPid."
  Write-Host "Pid file preserved."
  exit 5
}
if ($probe2.alive) {
  Write-Host "Process $targetPid still running after Stop-Process."
  exit 2
}
Write-Host "Stopped PID $targetPid"
Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
