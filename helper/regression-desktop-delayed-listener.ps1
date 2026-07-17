# Sentinel OS - Desktop Operator delayed-listener regression (Windows-only).
#
# Purpose: prove the persistent $ctxTask single-task loop in
# helper/desktop-operator.ps1 processes a request that arrives ONLY after
# several 5s poll intervals have elapsed. Under the pre-0.4.1 code, every
# poll timeout leaked a fresh GetContextAsync task; a real request arriving
# later could be consumed by an abandoned task while the "current" task
# never completed, producing DESKTOP_BRIDGE_TIMEOUT after 20s.
#
# This script MUST be run on Windows. Linux CI cannot exercise HttpListener.
# verify-release enforces the FILE'S EXISTENCE and REQUIRED-TOKEN CONTRACT.
#
# Safety:
#  - Refuses to run if an Owner-started Desktop Operator is already active.
#    Consuming a live session would leak the Owner's live bearer secret and
#    mint conflicting journal writes into the real session directory.
#  - Does not read/parse a pre-existing session file.
#  - Cleans %LOCALAPPDATA%\SentinelOS\desktop-session.json and
#    desktop-operator.pid on exit (only the test operator's state).
#
# Exit codes: 0 success, non-zero failure. No fail-open.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    Write-Error "regression-desktop-delayed-listener.ps1 only runs on Windows."
    exit 3
}

$sentinelDir = Join-Path $env:LOCALAPPDATA 'SentinelOS'
$sessionFile = Join-Path $sentinelDir 'desktop-session.json'
$pidFile     = Join-Path $sentinelDir 'desktop-operator.pid'

# Refuse if a Desktop Operator is already active on this box. Do NOT read the
# session file (would leak the live bearer secret into this script's scope
# and journal).
if (Test-Path $pidFile) {
    $existingPid = ((Get-Content $pidFile -ErrorAction SilentlyContinue) | Select-Object -First 1).Trim()
    $alive = $false
    if ($existingPid -match '^\d+$') {
        $tl = & tasklist /FI "PID eq $existingPid" /FO CSV /NH 2>$null
        if ($LASTEXITCODE -eq 0 -and $tl) {
            foreach ($line in $tl) {
                if ($line -and $line -notmatch '^INFO:') { $alive = $true; break }
            }
        }
    }
    if ($alive) {
        Write-Error "Desktop Operator already active (pid $existingPid). Stop it first: helper\stop-desktop-operator.bat"
        exit 4
    }
}
# Ignore a stale session file (do not parse it, do not reuse it). Remove
# residual state so this test starts from a clean slate.
if (Test-Path $sessionFile) { Remove-Item -Force $sessionFile -ErrorAction SilentlyContinue }
if (Test-Path $pidFile)     { Remove-Item -Force $pidFile     -ErrorAction SilentlyContinue }

Write-Host "[delayed-listener] starting Desktop Operator with 60s idle TTL..."
$op = Start-Process -PassThru -WindowStyle Hidden -FilePath "powershell.exe" `
    -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',
        (Join-Path $PSScriptRoot 'desktop-operator.ps1'), '-IdleTtlSeconds', '60')

try {
    # Wait up to 15s for the fresh session file to appear.
    $deadline = (Get-Date).AddSeconds(15)
    while (-not (Test-Path $sessionFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    if (-not (Test-Path $sessionFile)) { throw "session file never appeared" }

    $sess = Get-Content $sessionFile -Raw | ConvertFrom-Json
    if (-not $sess.port -or -not $sess.secret) { throw "session file incomplete" }
    Write-Host "[delayed-listener] bridge ACTIVE on port $($sess.port), sleeping past 2 poll intervals..."

    # Sleep ~13s: LONGER than 2 x 5s poll intervals of $ctxTask.Wait(5000),
    # SHORTER than the 60s idle TTL. Any abandoned-task regression manifests
    # as the bridge failing to respond on the FIRST request after the sleep.
    Start-Sleep -Seconds 13

    # Fire exactly ONE authenticated snapshot request. Expect ok=true within 20s.
    $body = @{ tool = 'desktop_snapshot'; args = @{}; envelope = @{ run_id='rg-delayed'; intent_id='int-1'; idempotency_key='att1:seq1' } } | ConvertTo-Json -Compress
    $t0 = Get-Date
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$($sess.port)/v1/execute" `
        -Method Post -ContentType 'application/json; charset=utf-8' `
        -Headers @{ Authorization = "Bearer $($sess.secret)" } `
        -Body $body -TimeoutSec 20
    $ms = ((Get-Date) - $t0).TotalMilliseconds
    Write-Host "[delayed-listener] first request completed in ${ms}ms, ok=$($resp.ok)"

    if (-not $resp.ok) { throw "first delayed request returned ok=false: $($resp | ConvertTo-Json -Depth 5)" }
    if ($ms -gt 5000) { throw "first delayed request took ${ms}ms (>5000ms) - suggests abandoned-task regression" }

    # Retry the SAME envelope -> journal replay, exactly one logical dispatch.
    $resp2 = Invoke-RestMethod -Uri "http://127.0.0.1:$($sess.port)/v1/execute" `
        -Method Post -ContentType 'application/json; charset=utf-8' `
        -Headers @{ Authorization = "Bearer $($sess.secret)" } `
        -Body $body -TimeoutSec 20
    if (-not $resp2.ok) { throw "replay returned ok=false" }
    if ($resp2.result.path -ne $resp.result.path) {
        throw "replay produced a NEW snapshot path - journal replay is broken"
    }

    Write-Host "[delayed-listener] PASS: delayed request processed, replay stable."
    exit 0
} finally {
    try { Stop-Process -Id $op.Id -Force -ErrorAction SilentlyContinue } catch {}
    # Clean the test operator's session + pid state. The operator's own
    # finally already tries this, but taskkill-on-force may skip it.
    Start-Sleep -Milliseconds 300
    if (Test-Path $sessionFile) { Remove-Item -Force $sessionFile -ErrorAction SilentlyContinue }
    if (Test-Path $pidFile)     { Remove-Item -Force $pidFile     -ErrorAction SilentlyContinue }
}
