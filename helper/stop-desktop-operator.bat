@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM Sentinel OS - Desktop Operator STOP (P0-R5 R1). ASCII-only, CRLF.
REM
REM Simple and robust: read PID from a BOM-less ASCII pid file via `set /p`,
REM validate it is purely digits, kill it, and remove the session artifacts.

set "PIDFILE=%LOCALAPPDATA%\SentinelOS\desktop-operator.pid"
set "SESSION=%LOCALAPPDATA%\SentinelOS\desktop-session.json"

if not exist "%PIDFILE%" (
  echo [stop-desktop-operator] no active session ^(pid file missing^).
  exit /b 0
)

set "TARGET_PID="
set /p TARGET_PID=<"%PIDFILE%"

if not defined TARGET_PID (
  echo [stop-desktop-operator] pid file empty.
  del /q "%PIDFILE%" 2>nul
  del /q "%SESSION%" 2>nul
  exit /b 0
)

REM Reject anything that is not purely numeric to defend against BOM/garbage.
echo %TARGET_PID%| findstr /R "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo [stop-desktop-operator] pid file contents invalid, cleaning up.
  del /q "%PIDFILE%" 2>nul
  del /q "%SESSION%" 2>nul
  exit /b 0
)

taskkill /PID %TARGET_PID% /F >nul 2>&1
del /q "%PIDFILE%" 2>nul
del /q "%SESSION%" 2>nul
echo [stop-desktop-operator] stopped pid %TARGET_PID%.

endlocal & exit /b 0
