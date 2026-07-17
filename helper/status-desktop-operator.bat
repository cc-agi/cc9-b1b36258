@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM Sentinel OS - Desktop Operator STATUS (P0-R5). ASCII-only, CRLF.

set "SESSION=%LOCALAPPDATA%\SentinelOS\desktop-session.json"
if not exist "%SESSION%" (
  echo [status-desktop-operator] OFF (no session file at %SESSION%)
  exit /b 0
)
echo [status-desktop-operator] ACTIVE (session file present)
type "%SESSION%"
echo.
endlocal & exit /b 0
