# Sentinel OS Helper — stop (P0-R3.1)
$ErrorActionPreference = "SilentlyContinue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgDir = Join-Path $env:LOCALAPPDATA "SentinelOS"
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

# Verify this PID is the Sentinel Helper before killing (avoid nuking unrelated node.exe)
$cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue).CommandLine
if (-not $cmdLine) {
  Write-Host "PID $targetPid not running; clearing pid file."
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 0
}
if ($cmdLine -notmatch 'helper[\\/]src[\\/]index\.mjs' -and $cmdLine -notmatch 'index\.mjs') {
  Write-Host "PID $targetPid is not the Sentinel Helper (command line does not match); refusing to kill."
  Write-Host "Command line: $cmdLine"
  exit 1
}

try {
  Stop-Process -Id $targetPid -Force -ErrorAction Stop
} catch {
  Write-Host "Failed to stop PID ${targetPid}: $($_.Exception.Message)"
}

# Confirm process is gone
Start-Sleep -Milliseconds 500
$still = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if ($still) {
  Write-Host "Process $targetPid still running after Stop-Process."
  exit 2
}
Write-Host "✓ Stopped PID $targetPid"
Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
