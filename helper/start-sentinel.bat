@echo off
setlocal
REM Sentinel — universal start script (P0-R3).
REM Auto-detects project root and Chrome path. No hardcoded usernames.
REM Usage: start-sentinel.bat [PAIRING_CODE]

set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%" >nul
if exist "..\helper\start-helper.ps1" (cd ..) else if exist "helper\start-helper.ps1" (cd .) else (
  echo [start-sentinel] Cannot find helper\ directory relative to %SCRIPT_DIR%
  popd & exit /b 2
)

REM --- Locate Chrome ---
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist "%%~P" if not defined CHROME set "CHROME=%%~P"
)
if not defined CHROME (
  echo [start-sentinel] Chrome not found in standard locations. Install Google Chrome first.
  popd & exit /b 3
)

REM --- Launch dedicated Sentinel Chrome with CDP port ---
set "SENTINEL_PROFILE=%LocalAppData%\SentinelOS\chrome-profile"
if not exist "%SENTINEL_PROFILE%" mkdir "%SENTINEL_PROFILE%"

tasklist /FI "IMAGENAME eq chrome.exe" | find /I "chrome.exe" >nul
if not errorlevel 1 (
  REM Best-effort check: is 9222 already responding?
  powershell -NoProfile -Command "try{$r=Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -TimeoutSec 2 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
  if not errorlevel 1 (
    echo [start-sentinel] Sentinel Chrome already listening on 127.0.0.1:9222
    goto :launch_helper
  )
)

echo [start-sentinel] Launching dedicated Sentinel Chrome...
start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%SENTINEL_PROFILE%" --no-first-run --no-default-browser-check about:blank

REM Wait for CDP up to 15s
for /L %%i in (1,1,15) do (
  powershell -NoProfile -Command "try{$r=Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -TimeoutSec 1 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
  if not errorlevel 1 goto :launch_helper
  timeout /t 1 /nobreak >nul
)
echo [start-sentinel] Chrome did not open CDP within 15s. Continuing anyway; run diagnose-sentinel.bat to inspect.

:launch_helper
echo [start-sentinel] Starting Helper daemon...
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\start-helper.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\start-helper.ps1" -PairingCode %1
)
popd
endlocal
