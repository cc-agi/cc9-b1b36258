@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
REM ==========================================================================
REM  Sentinel OS Helper — Windows one-click entry point (P0-R4 B1/B2/B3/B4/B5/B6)
REM  ASCII / CRLF-safe. Works from PowerShell, CMD, Explorer double-click, and
REM  arbitrary repo paths. Preserves default cloud URL and worker config location.
REM
REM  Usage:
REM    start-sentinel.bat [PAIRING_CODE]
REM    start-sentinel.bat --ci-check       (non-interactive preflight)
REM    start-sentinel.bat --preflight      (alias of --ci-check)
REM ==========================================================================

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul || (echo [start-sentinel] cannot cd to script dir & exit /b 2)

REM Locate repo root (parent of helper\)
if exist "..\helper\start-helper.ps1" (
  cd ..
) else if exist ".\helper\start-helper.ps1" (
  rem already at repo root
) else (
  echo [start-sentinel] cannot find helper\start-helper.ps1 relative to "%SCRIPT_DIR%"
  popd
  exit /b 2
)

REM ---- CI / preflight mode: no Chrome, no network, no pairing, no state ----
set "CI_MODE=0"
if /I "%~1"=="--ci-check" set "CI_MODE=1"
if /I "%~1"=="--preflight" set "CI_MODE=1"

REM ---- Preflight: Node + npm ----
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [start-sentinel] node.exe not found. Install Node.js 20+ from https://nodejs.org
  popd & exit /b 4
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [start-sentinel] npm.cmd not found. Install Node.js LTS from https://nodejs.org
  popd & exit /b 4
)

REM ---- Ensure Helper deps (undici) present; install only if missing ----
if not exist "helper\node_modules\undici" (
  echo [start-sentinel] Installing helper dependencies via npm...
  pushd "helper" >nul
  call npm.cmd install --omit=dev
  REM P0-R4 B2 fix: do NOT read %ERRORLEVEL% inside a parenthesized block.
  REM Use immediate `if errorlevel N` instead.
  if errorlevel 1 (
    popd >nul
    echo [start-sentinel] npm install failed. Check network connection and try again.
    popd
    exit /b 5
  )
  popd >nul
  if not exist "helper\node_modules\undici" (
    echo [start-sentinel] dependency 'undici' still missing after npm install. Inspect helper\package.json.
    popd & exit /b 5
  )
  echo [start-sentinel] helper dependencies OK.
) else (
  echo [start-sentinel] helper dependencies already installed.
)

REM ---- Verify entry files present ----
if not exist "helper\src\index.mjs"   ( echo [start-sentinel] missing helper\src\index.mjs & popd & exit /b 6 )
if not exist "helper\src\browser.mjs" ( echo [start-sentinel] missing helper\src\browser.mjs & popd & exit /b 6 )
if not exist "helper\src\pair.mjs"    ( echo [start-sentinel] missing helper\src\pair.mjs & popd & exit /b 6 )
if not exist "helper\start-helper.ps1" ( echo [start-sentinel] missing helper\start-helper.ps1 & popd & exit /b 6 )

REM ---- CI mode stops here: no Chrome, no network, no pairing, no state mutation ----
if "%CI_MODE%"=="1" (
  echo [start-sentinel] preflight OK ^(Node + npm + helper deps + entry files verified^)
  echo [start-sentinel] CI mode: skipping Chrome, pairing, and daemon start.
  popd & exit /b 0
)

REM ---- Locate Chrome ----
set "CHROME="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist "%%~P" if not defined CHROME set "CHROME=%%~P"
)
if not defined CHROME (
  echo [start-sentinel] Google Chrome not found in standard locations. Install Chrome first.
  popd & exit /b 3
)

set "SENTINEL_PROFILE=%LocalAppData%\SentinelOS\chrome-profile"
if not exist "%SENTINEL_PROFILE%" mkdir "%SENTINEL_PROFILE%"

REM ---- Detect existing CDP on 9222 ----
powershell -NoProfile -Command "try{Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
  echo [start-sentinel] CDP Chrome already listening on 127.0.0.1:9222 - reusing.
  goto :launch_helper
)

echo [start-sentinel] launching dedicated Sentinel Chrome...
start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%SENTINEL_PROFILE%" --no-first-run --no-default-browser-check about:blank

REM Wait up to 20s for CDP with a hard deadline.
set "CDP_UP=0"
for /L %%i in (1,1,20) do (
  powershell -NoProfile -Command "try{Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -TimeoutSec 1 -UseBasicParsing | Out-Null; exit 0}catch{exit 1}" >nul 2>&1
  if not errorlevel 1 (
    set "CDP_UP=1"
    goto :cdp_ready
  )
  timeout /t 1 /nobreak >nul
)
:cdp_ready
if not "%CDP_UP%"=="1" (
  echo [start-sentinel] Chrome did not open CDP within 20s. Run diagnose-sentinel.bat.
  popd & exit /b 7
)
echo [start-sentinel] CDP reachable on 127.0.0.1:9222.

:launch_helper
echo [start-sentinel] starting Helper daemon...
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\start-helper.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\start-helper.ps1" -PairingCode "%~1"
)
set "PS_EC=%ERRORLEVEL%"
popd
endlocal & exit /b %PS_EC%
