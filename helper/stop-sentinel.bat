@echo off
chcp 65001 >nul
setlocal
REM Sentinel — universal stop script (P0-R3.1).
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%" >nul
if exist "..\helper\stop-helper.ps1" (cd ..) else if exist "helper\stop-helper.ps1" (cd .) else (
  echo [stop-sentinel] Cannot find helper\ directory.
  popd ^& exit /b 2
)

echo [stop-sentinel] Stopping Helper daemon...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\helper\stop-helper.ps1"

echo [stop-sentinel] Closing dedicated Sentinel Chrome (profile-scoped only)...
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'SentinelOS\\\\chrome-profile' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [stop-sentinel] Done.
popd
endlocal
