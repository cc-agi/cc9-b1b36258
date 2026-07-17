@echo off
chcp 65001 >nul
setlocal EnableExtensions
REM Sentinel OS - Desktop Operator STOP (P0-R5). ASCII-only, CRLF.

set "PIDFILE=%LOCALAPPDATA%\SentinelOS\desktop-operator.pid"
if not exist "%PIDFILE%" (
  echo [stop-desktop-operator] no active session (pid file missing).
  exit /b 0
)
for /f "usebackq delims=" %%p in ("%PIDFILE%") do set "TARGET_PID=%%p"
if "%TARGET_PID%"=="" (
  echo [stop-desktop-operator] pid file empty.
  del /q "%PIDFILE%" 2>nul
  exit /b 0
)
tasklist /FI "PID eq %TARGET_PID%" /NH | findstr /I "powershell" >nul
if errorlevel 1 (
  echo [stop-desktop-operator] pid %TARGET_PID% not a running PowerShell; cleaning up.
  del /q "%PIDFILE%" 2>nul
  del /q "%LOCALAPPDATA%\SentinelOS\desktop-session.json" 2>nul
  exit /b 0
)
taskkill /PID %TARGET_PID% /F >nul 2>&1
del /q "%PIDFILE%" 2>nul
del /q "%LOCALAPPDATA%\SentinelOS\desktop-session.json" 2>nul
echo [stop-desktop-operator] stopped pid %TARGET_PID%.
endlocal & exit /b 0
