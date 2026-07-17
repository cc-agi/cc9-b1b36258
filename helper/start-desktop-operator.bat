@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
REM ==========================================================================
REM  Sentinel OS - Desktop Operator: one-click START (P0-R5)
REM  ASCII-only source, CRLF-enforced via .gitattributes.
REM
REM  Usage:
REM    start-desktop-operator.bat            (interactive, 30 min idle TTL)
REM    start-desktop-operator.bat --ci-check (non-mutating preflight; no listener)
REM ==========================================================================

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" >nul || (echo [start-desktop-operator] cannot cd to script dir & exit /b 2)

REM Locate repo root (parent of helper\).
if exist "..\helper\desktop-operator.ps1" (
  cd ..
) else if exist ".\helper\desktop-operator.ps1" (
  rem already at repo root
) else (
  echo [start-desktop-operator] cannot find helper\desktop-operator.ps1
  popd
  exit /b 2
)

REM ==========================================================================
REM  STEP 1 (MUST BE FIRST): CI / preflight mode.
REM  In CI mode we MUST NOT: install anything, start a listener, contact the
REM  network, mint a session secret, or launch UI. Only:
REM    - check PowerShell exists
REM    - check helper\desktop-operator.ps1 exists
REM    - forward --CiCheck to the PowerShell script (which returns exit 0
REM      after loading .NET types; never binds a port).
REM ==========================================================================
set "CI_MODE=0"
if /I "%~1"=="--ci-check"  set "CI_MODE=1"
if /I "%~1"=="--preflight" set "CI_MODE=1"

if "%CI_MODE%"=="1" goto :ci_preflight

REM ==========================================================================
REM  NORMAL MODE below. Owner-invoked local start.
REM ==========================================================================
where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [start-desktop-operator] powershell.exe not found on PATH.
  popd & exit /b 4
)
if not exist "helper\desktop-operator.ps1" (
  echo [start-desktop-operator] missing helper\desktop-operator.ps1
  popd & exit /b 6
)

REM Idle TTL argument (seconds); default 1800 (30 min).
set "TTL=1800"
if not "%~1"=="" set "TTL=%~1"

echo [start-desktop-operator] launching bridge (idle TTL %TTL%s)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\helper\desktop-operator.ps1" -IdleTtlSeconds %TTL%
set "PS_EC=%ERRORLEVEL%"
popd
endlocal & exit /b %PS_EC%

REM ==========================================================================
REM  CI PREFLIGHT: reached ONLY when %~1 is --ci-check or --preflight.
REM  Read-only. Does not touch network, filesystem state, or the desktop.
REM ==========================================================================
:ci_preflight
echo [start-desktop-operator] CI mode: read-only preflight. No listener, no state writes, no remote calls.

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [start-desktop-operator] powershell.exe not found on PATH.
  popd & exit /b 4
)
if not exist "helper\desktop-operator.ps1" ( echo [start-desktop-operator] missing helper\desktop-operator.ps1 & popd & exit /b 6 )
if not exist "helper\stop-desktop-operator.bat" ( echo [start-desktop-operator] missing helper\stop-desktop-operator.bat & popd & exit /b 6 )
if not exist "helper\status-desktop-operator.bat" ( echo [start-desktop-operator] missing helper\status-desktop-operator.bat & popd & exit /b 6 )

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\helper\desktop-operator.ps1" -CiCheck
set "PS_EC=%ERRORLEVEL%"
echo [start-desktop-operator] preflight exit=%PS_EC%
popd
endlocal & exit /b %PS_EC%
