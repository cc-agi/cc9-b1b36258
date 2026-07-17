@echo off
setlocal
chcp 65001 >nul
REM Sentinel — one-click diagnostics (P0-R3).
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%" >nul
if exist "..\helper\status-helper.ps1" (cd ..) else if exist "helper\status-helper.ps1" (cd .) else (
  echo [diagnose] Cannot find helper\ directory.
  popd & exit /b 2
)

echo ================================================================
echo Sentinel OS — Runtime Diagnostics
echo ================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\status-helper.ps1"

echo.
echo --- CDP /json/version ---
powershell -NoProfile -Command "try{$r=Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -TimeoutSec 3 -UseBasicParsing;Write-Host 'OK:' $r.Content}catch{Write-Host 'CDP unreachable — run repair-sentinel.bat'}"

echo.
echo --- Node / Helper package ---
where node 2>nul
if errorlevel 1 (echo Node not on PATH.) else (node --version)
if exist "helper\package.json" (
  echo helper\package.json: OK
) else (
  echo helper\package.json: MISSING
)

echo.
echo --- Chrome detection ---
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist "%%~P" echo   Found: %%~P
)

echo.
echo --- Recent Helper log tail ---
if exist "%LocalAppData%\SentinelOS\helper.log" (
  powershell -NoProfile -Command "Get-Content '%LocalAppData%\SentinelOS\helper.log' -Tail 15"
) else (
  echo   No helper.log yet.
)

echo.
echo Suggested next steps:
echo   * Chrome offline    -> repair-sentinel.bat
echo   * Helper offline    -> start-sentinel.bat
echo   * Full reset        -> stop-sentinel.bat then start-sentinel.bat
popd
endlocal
