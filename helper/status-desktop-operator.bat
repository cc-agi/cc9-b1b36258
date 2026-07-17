@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM Sentinel OS - Desktop Operator STATUS (P0-R5 R1). ASCII-only, CRLF.
REM
REM SECURITY: NEVER prints raw desktop-session.json, the bearer secret, or
REM any token. Delegates JSON parsing to a small inline PowerShell snippet
REM that emits only safe whitelisted fields.

set "SESSION=%LOCALAPPDATA%\SentinelOS\desktop-session.json"
set "PIDFILE=%LOCALAPPDATA%\SentinelOS\desktop-operator.pid"

if not exist "%SESSION%" (
  echo [status-desktop-operator] OFF ^(no session file^)
  exit /b 0
)

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [status-desktop-operator] ACTIVE ^(session file present; powershell.exe missing, cannot parse safely^)
  exit /b 0
)

REM Single-quoted -Command payload avoids cmd token-splitting on `.`, `:`, `(`, `)`.
REM The script reads env vars ($env:SESSION / $env:PIDFILE) so no interpolation
REM happens inside cmd.exe.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $s = Get-Content -Raw -LiteralPath $env:SESSION | ConvertFrom-Json } catch { Write-Host '[status-desktop-operator] OFF (session file unreadable)'; exit 0 }; $now = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds; $last = [int64]$s.last_activity_at; $ttl = [int64]$s.idle_ttl_ms; $expiresIn = ($last + $ttl) - $now; if ($expiresIn -gt 0) { $state = 'ACTIVE' } else { $state = 'OFF (expired)' }; Write-Host ('[status-desktop-operator] ' + $state); Write-Host ('  session_id       : ' + $s.session_id); Write-Host ('  loopback         : 127.0.0.1:' + $s.port); if ($s.worker_id) { Write-Host ('  worker_id        : ' + $s.worker_id) }; Write-Host ('  started_at       : ' + $s.started_at); Write-Host ('  last_activity_at : ' + $s.last_activity_at); Write-Host ('  idle_ttl_ms      : ' + $s.idle_ttl_ms); Write-Host ('  expires_in_ms    : ' + [Math]::Max(0,$expiresIn)); if ($s.log_path) { Write-Host ('  log_path         : ' + $s.log_path) }; if (Test-Path -LiteralPath $env:PIDFILE) { Write-Host ('  pid              : ' + (Get-Content -Raw -LiteralPath $env:PIDFILE).Trim()) }"

endlocal & exit /b 0
