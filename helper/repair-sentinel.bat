@echo off
setlocal
chcp 65001 >nul
REM Sentinel — one-click repair (P0-R3).
REM Stops stuck Sentinel Chrome + Helper, then restarts both.
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%" >nul
if exist "..\helper\stop-helper.ps1" (cd ..) else if exist "helper\stop-helper.ps1" (cd .) else (
  echo [repair] Cannot find helper\ directory.
  popd & exit /b 2
)

echo [repair] Step 1/3 Stopping Helper + Sentinel Chrome...
call "helper\stop-sentinel.bat" >nul 2>&1

REM Clear stale automation profile lock (never touches user's normal Chrome profile)
if exist "%LocalAppData%\SentinelOS\chrome-profile\SingletonLock" del /f /q "%LocalAppData%\SentinelOS\chrome-profile\SingletonLock" >nul 2>&1
if exist "%LocalAppData%\SentinelOS\chrome-profile\SingletonCookie" del /f /q "%LocalAppData%\SentinelOS\chrome-profile\SingletonCookie" >nul 2>&1
if exist "%LocalAppData%\SentinelOS\chrome-profile\SingletonSocket" del /f /q "%LocalAppData%\SentinelOS\chrome-profile\SingletonSocket" >nul 2>&1

echo [repair] Step 2/3 Waiting 3s for shutdown...
timeout /t 3 /nobreak >nul

echo [repair] Step 3/3 Restarting via start-sentinel.bat...
call "helper\start-sentinel.bat"

popd
endlocal
