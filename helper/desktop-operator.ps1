# Sentinel OS - Desktop Operator local bridge (P0-R5)
# ASCII-only source, CRLF-enforced via .gitattributes.
#
# Runs an HTTP listener bound STRICTLY to 127.0.0.1:<random port> that
# authenticates every request with an ephemeral session bearer secret.
# Never binds a LAN interface. Never accepts arbitrary shell commands or
# eval; the tool switch is a closed whitelist that maps directly to
# user32 SendInput, .NET UIAutomation, and Windows.Forms clipboard.
#
# Session lifetime is capped by an idle TTL. The bridge exits when the
# TTL elapses without activity, or when stop-desktop-operator.bat requests it.
#
# NEVER bypasses UAC or the secure desktop. All actions run in the current
# interactive session with the current user's privileges.

param(
    [int]$IdleTtlSeconds = 1800,      # 30 minutes default
    [switch]$CiCheck                  # non-mutating preflight for CI
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($CiCheck) {
    # Static, non-network, non-mutating preflight only.
    # Verify PowerShell version, .NET types are loadable, whitelist compiles.
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Write-Error "PowerShell 5.0+ required (found $($PSVersionTable.PSVersion))"
        exit 4
    }
    try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {
        Write-Error "System.Windows.Forms unavailable: $($_.Exception.Message)"
        exit 4
    }
    Write-Host "[desktop-operator] preflight OK (PowerShell $($PSVersionTable.PSVersion), .NET Forms loaded)."
    exit 0
}

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
    Write-Error "Desktop Operator only runs on Windows."
    exit 3
}

# ---------- Paths & session state ----------
$appDataRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:APPDATA }
$sentinelDir = Join-Path $appDataRoot 'SentinelOS'
$logDir      = Join-Path $sentinelDir 'desktop-logs'
$sessionFile = Join-Path $sentinelDir 'desktop-session.json'
$pidFile     = Join-Path $sentinelDir 'desktop-operator.pid'
if (-not (Test-Path $sentinelDir)) { New-Item -ItemType Directory -Path $sentinelDir | Out-Null }
if (-not (Test-Path $logDir))      { New-Item -ItemType Directory -Path $logDir      | Out-Null }

# 0.4.14 — session_id MUST be a canonical 36-char UUID ("D" format:
# 8-4-4-4-12 lowercase hex). Historically `.ToString()` (no arg) was used;
# although .NET documents "D" as the default, some PowerShell hosts / broken
# .NET Framework builds have surfaced malformed values (e.g. an extra hex
# digit in the final segment) that fail the MCP Zod uuid check downstream.
# We now (1) request "D" explicitly, and (2) validate with [guid]::TryParse
# + a strict 36-char regex; on any deviation we FAIL CLOSED before advertising
# ACTIVE, so a bad id can never reach the session file or the terminal banner.
$sessionId = [guid]::NewGuid().ToString("D")
$__uuidRe = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$__parsed = [guid]::Empty
if (-not [guid]::TryParse($sessionId, [ref]$__parsed) -or
    $sessionId.Length -ne 36 -or
    $sessionId -notmatch $__uuidRe) {
    Write-Error "Desktop Operator: generated session_id is not a valid 36-char UUID ('$sessionId'). Refusing to start."
    exit 5
}
$logPath   = Join-Path $logDir ("session-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

function Log([string]$msg) {
    $line = "$([DateTime]::UtcNow.ToString('o')) $msg"
    Add-Content -Path $logPath -Value $line
    # Never mirror request-path logging to the interactive console. In the
    # legacy Windows console, QuickEdit/Mark mode (title prefixed with
    # "Select") blocks synchronous console writes. The HTTP response
    # may already have been sent, but console mirroring used to wedge the only
    # bridge thread before it could accept the next request. The startup
    # banner below remains visible; operational logs are durable in $logPath.
}

# Ephemeral 32-byte bearer secret (base64url), never logged.
$secretBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
$secret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

# Read worker_id if pairing exists (for advertising).
$workerId = ''
$workerCfg = Join-Path $sentinelDir 'worker.json'
if (Test-Path $workerCfg) {
    try { $workerId = (Get-Content $workerCfg -Raw | ConvertFrom-Json).worker_id } catch {}
}

# ---------- Owner ACL principal (P0-R5 0.4.1 hotfix) ----------
# Unqualified $env:USERNAME (e.g. "JASON") does not always resolve on
# domain-joined or multi-user Windows boxes, producing an ACL that Helper
# cannot read (Access Denied). Use the fully qualified WindowsIdentity name
# (e.g. "DOMAIN\JASON" or "MACHINE\JASON") which icacls always accepts.
$ownerPrincipal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($ownerPrincipal)) {
    throw "Desktop Operator: could not resolve current WindowsIdentity for owner-only ACL."
}

function Set-OwnerOnlyAcl([string]$path) {
    # icacls is a native command; PowerShell try/catch does NOT catch nonzero
    # exit codes. Check $LASTEXITCODE explicitly and FAIL CLOSED. Never log
    # the file contents (only the path is passed, so the bearer secret is
    # never touched here).
    & icacls $path /inheritance:r /grant:r "${ownerPrincipal}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop Operator: icacls failed with exit code $LASTEXITCODE on $path"
    }
}

# ---------- .NET SendInput / Screen capture / UIA ----------
$typeSig = @"
using System;
using System.Runtime.InteropServices;
public static class SI {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] public struct INPUT_U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUT_U u; }
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder t, int c);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder t, int c);
    // 0.4.20 Action Verification Engine — WindowFromPoint + GetAncestor(GA_ROOT)
    // let Tool-Drag identify the top-level window under the drag origin so the
    // predicate can compare pre/post GetWindowRect() and fail with
    // DRAG_NO_EFFECT when the bounds never actually changed.
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
    // 0.4.21 Click Target Verification — GetGUIThreadInfo lets Tool-Click
    // read the caret rect for the focused thread so a click that moves the
    // caret inside an already-focused RichEditD2DPT Document verifies with
    // verification_kind='caret_changed' instead of the 0.4.20 false-negative
    // CLICK_NO_EFFECT.
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
        public uint cbSize; public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}

"@
try { Add-Type -TypeDefinition $typeSig -Language CSharp | Out-Null } catch { Log "[warn] SendInput bindings unavailable: $($_.Exception.Message)" }

# P0-R8 desktop_focus_window Windows-foreground rules:
# SetForegroundWindow silently no-ops when the calling process is not the
# current foreground unless we (a) call AllowSetForegroundWindow(ASFW_ANY),
# (b) briefly AttachThreadInput to the target's UI thread, and/or (c)
# synthesize an Alt keystroke to release the foreground lock. Kept in a
# separate P/Invoke class so unit-test SI shims that replace `SI` do not
# hide these entry points; the tool guards calls in try/catch so a missing
# type at test time is treated as best-effort.
$fgSig = @"
using System;
using System.Runtime.InteropServices;
public static class SI_FG {
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool AllowSetForegroundWindow(uint dwProcessId);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);
}
"@
try { Add-Type -TypeDefinition $fgSig -Language CSharp | Out-Null } catch { Log "[warn] foreground helper bindings unavailable: $($_.Exception.Message)" }

# 0.4.22-C2 desktop_focus_window / desktop_launch snapshot P/Invokes.
# Kept isolated from SI_FG so the focus tool's terminate/attach surface stays
# minimal and so unit-test shims of SI / SI_FG do not have to also shim these
# enumeration entry points.
$enumSig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SI_ENUM {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
try { Add-Type -TypeDefinition $enumSig -Language CSharp | Out-Null } catch { Log "[warn] enumeration helper bindings unavailable: $($_.Exception.Message)" }

try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {}
try { Add-Type -AssemblyName System.Drawing | Out-Null } catch {}
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null } catch { Log "[warn] UIA unavailable" }

function Get-VisibleWindowSnapshot {
    # Enumerate visible top-level windows; return an array of ordered maps
    # keyed by handle/process id/class. Never throws — always returns [].
    $items = New-Object 'System.Collections.Generic.List[object]'
    try {
        $cb = [SI_ENUM+EnumWindowsProc]{
            param([IntPtr]$h, [IntPtr]$_p)
            if (-not [SI_ENUM]::IsWindowVisible($h)) { return $true }
            $pid_out = 0
            [void][SI_ENUM]::GetWindowThreadProcessId($h, [ref]$pid_out)
            $sb = New-Object System.Text.StringBuilder 256
            [void][SI_ENUM]::GetClassName($h, $sb, $sb.Capacity)
            $items.Add([pscustomobject]@{
                handle = "$([int64]$h.ToInt64())"
                process_id = [int]$pid_out
                visible = $true
                window_class = $sb.ToString()
            })
            return $true
        }
        [void][SI_ENUM]::EnumWindows($cb, [IntPtr]::Zero)
    } catch { Log "[warn] EnumWindows failed: $($_.Exception.Message)" }
    return ,$items.ToArray()
}

function Get-ProcessSnapshot {
    $items = New-Object 'System.Collections.Generic.List[object]'
    try {
        foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
            try {
                $items.Add([pscustomobject]@{ pid = [int]$p.Id; process_name = [string]$p.ProcessName })
            } catch {}
            finally { try { $p.Dispose() } catch {} }
        }
    } catch { Log "[warn] Process enumeration failed: $($_.Exception.Message)" }
    return ,$items.ToArray()
}

function Get-FocusWindowSnapshot([IntPtr]$handle) {
    $exists = $false; $visible = $false; $iconic = $false; $zoomed = $false
    $pid_out = 0; $className = $null; $rect = $null
    try { $exists = [SI_ENUM]::IsWindow($handle) } catch {}
    if ($exists) {
        try { $visible = [SI_ENUM]::IsWindowVisible($handle) } catch {}
        try { $iconic = [SI_ENUM]::IsIconic($handle) } catch {}
        try { $zoomed = [SI_ENUM]::IsZoomed($handle) } catch {}
        try { [void][SI_ENUM]::GetWindowThreadProcessId($handle, [ref]$pid_out) } catch {}
        try {
            $sb = New-Object System.Text.StringBuilder 256
            [void][SI_ENUM]::GetClassName($handle, $sb, $sb.Capacity)
            $className = $sb.ToString()
        } catch {}
        try {
            $r = New-Object 'SI_ENUM+RECT'
            if ([SI_ENUM]::GetWindowRect($handle, [ref]$r)) {
                $rect = [pscustomobject]@{ L=$r.Left; T=$r.Top; R=$r.Right; B=$r.Bottom }
            }
        } catch {}
    }
    $fgHandle = [IntPtr]::Zero
    try { $fgHandle = [SI_ENUM]::GetForegroundWindow() } catch {}
    return [pscustomobject]@{
        window_handle              = "$([int64]$handle.ToInt64())"
        requested_window_handle    = "$([int64]$handle.ToInt64())"
        window_exists              = [bool]$exists
        window_visible             = [bool]$visible
        is_iconic                  = [bool]$iconic
        is_zoomed                  = [bool]$zoomed
        window_state               = if ($iconic) { 'minimized' } elseif ($zoomed) { 'maximized' } else { 'restored' }
        foreground_window_handle   = "$([int64]$fgHandle.ToInt64())"
        process_id                 = [int]$pid_out
        window_class               = $className
        window_rect                = $rect
    }
}

# ---------- Tool implementations ----------
function Tool-Wait($a) {
    # P0-R6 desktop_wait millisecond fix:
    # Historic bug: parameter was named `$args`, which is a PowerShell
    # AUTOMATIC variable. The formal parameter was silently shadowed by the
    # empty automatic-args array, so `$args.duration_ms` returned $null,
    # `[int]$null` = 0, clamp -> 1, waited_ms = 1. Renamed to `$a` and now
    # report the STOPWATCH-measured elapsed ms (not the requested value)
    # so any future regression is visibly wrong.
    if ($null -eq $a -or -not $a.PSObject.Properties['duration_ms']) {
        return @{ ok = $false; error_code = 'DURATION_MS_MISSING'; error_message = 'duration_ms is required' }
    }
    $ms = [int]$a.duration_ms
    if ($ms -lt 1 -or $ms -gt 30000) {
        return @{ ok = $false; error_code = 'DURATION_MS_OUT_OF_RANGE'; error_message = "duration_ms must be 1..30000 (got $ms)" }
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds $ms
    $sw.Stop()
    $elapsed = [int]$sw.ElapsedMilliseconds
    return @{ ok = $true; result = @{ waited_ms = $elapsed; requested_ms = $ms } }
}
function Tool-Snapshot($a) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $out = Join-Path $logDir "snapshot-$stamp.png"
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return @{ ok = $true; result = @{ path = $out; bounds = @{ x = $bounds.X; y = $bounds.Y; w = $bounds.Width; h = $bounds.Height } } }
}
function Tool-ListWindows($a) {
    $max = if ($a.max_results) { [int]$a.max_results } else { 200 }
    $processFilter = if ($a.process_name) { [string]$a.process_name } else { $null }
    $includeMinimized = if ($a.PSObject.Properties['include_minimized']) { [bool]$a.include_minimized } else { $true }
    # MainWindowTitle is not a window-state signal: minimized Win32 windows
    # retain their titles and are commonly parked at (-32000,-32000). Use the
    # authoritative user32 IsIconic flag instead. Keep the title requirement
    # for both modes so include_minimized does not accidentally include
    # title-less shell/background handles.
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle }
    if ($processFilter) { $procs = $procs | Where-Object { $_.ProcessName -like $processFilter } }
    $out = @()
    foreach ($p in $procs) {
        $rect = New-Object SI+RECT
        [void][SI]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
        $isIconic = [SI]::IsIconic($p.MainWindowHandle)
        # Some frameworks briefly report IsIconic=false while retaining the
        # legacy Win32 minimized placement. Treat the exact sentinel as a
        # fallback so the field-observed (-32000,-32000) windows stay out.
        $hasMinimizedPlacement = ($rect.L -eq -32000 -and $rect.T -eq -32000)
        $isMinimized = ($isIconic -or $hasMinimizedPlacement)
        if (-not $includeMinimized -and $isMinimized) { continue }
        $out += @{
            window_handle = "$($p.MainWindowHandle.ToInt64())"
            title         = $p.MainWindowTitle
            process_name  = $p.ProcessName
            pid           = $p.Id
            is_minimized  = $isMinimized
            window_state  = if ($isMinimized) { 'minimized' } else { 'normal' }
            bounds        = @{ x = $rect.L; y = $rect.T; w = ($rect.R - $rect.L); h = ($rect.B - $rect.T) }
        }
        # Apply the result limit after state filtering. Otherwise a run of
        # minimized processes at the start of Get-Process can consume the
        # whole limit and hide eligible visible windows.
        if ($out.Count -ge $max) { break }
    }
    return @{ ok = $true; result = @{ windows = $out; count = $out.Count } }
}
function Invoke-FocusStage([string]$stage, $request, [int]$timeoutMs = 1600) {
    # Foreground APIs execute in a disposable child process. UseShellExecute
    # is deliberately disabled and CreateNoWindow is enabled: the previous
    # launcher could attach child powershell.exe to the interactive console,
    # where QuickEdit/Mark mode can suspend it (and, historically, the parent
    # bridge while it waited). Polling plus TerminateProcess keeps every wait
    # bounded without relying on Process.WaitForExit/Kill behavior.
    $token = $PID.ToString() + '.' + ([guid]::NewGuid().ToString('N'))
    $requestPath = Join-Path $sentinelDir "focus-$token.request.json"
    $outputPath = Join-Path $sentinelDir "focus-$token.output.json"
    $checkpointPath = Join-Path $sentinelDir "focus-$token.checkpoint.json"
    $workerPath = Join-Path $PSScriptRoot 'focus-window-worker.ps1'
    $proc = $null
    try {
        [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
        Log "[focus-stage] stage=$stage phase=launching timeout_ms=$timeoutMs"

        # Encode the invocation so paths containing spaces or apostrophes do
        # not depend on native command-line quoting rules in Windows PS 5.1.
        $quote = {
            param([string]$value)
            return "'" + $value.Replace("'", "''") + "'"
        }
        $childCommand = "& $(& $quote $workerPath) -Stage $(& $quote $stage) -RequestPath $(& $quote $requestPath) -OutputPath $(& $quote $outputPath) -CheckpointPath $(& $quote $checkpointPath)"
        $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($childCommand))
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = Join-Path $PSHOME 'powershell.exe'
        $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $proc = [System.Diagnostics.Process]::Start($psi)
        if ($null -eq $proc) { throw "powershell.exe did not return a Process instance" }

        $wait = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $proc.HasExited -and $wait.ElapsedMilliseconds -lt $timeoutMs) {
            Start-Sleep -Milliseconds 20
        }
        $wait.Stop()
        if (-not $proc.HasExited) {
            $checkpoint = $null
            if (Test-Path $checkpointPath) {
                try {
                    $checkpointJson = [System.IO.File]::ReadAllText($checkpointPath, [System.Text.Encoding]::UTF8)
                    $checkpoint = $checkpointJson | ConvertFrom-Json
                } catch {}
            }
            Log "[focus-stage] stage=$stage phase=timeout child_pid=$($proc.Id)"
            $terminateRequested = $false
            try { $terminateRequested = [bool][SI_FG]::TerminateProcess($proc.Handle, 0xE001) } catch {}
            $terminateWait = [System.Diagnostics.Stopwatch]::StartNew()
            while (-not $proc.HasExited -and $terminateWait.ElapsedMilliseconds -lt 500) {
                Start-Sleep -Milliseconds 20
            }
            $terminateWait.Stop()
            return @{
                ok = $false
                error_code = 'FOCUS_STAGE_TIMEOUT'
                error_message = "Foreground stage '$stage' exceeded ${timeoutMs}ms; isolated execution process was terminated."
                result = @{
                    timed_out_stage = $stage
                    stage_timeout_ms = $timeoutMs
                    execution_pid = [int64]$proc.Id
                    terminate_requested = [bool]$terminateRequested
                    execution_terminated = [bool]$proc.HasExited
                    execution_restarted = $true
                    last_checkpoint = $checkpoint
                }
            }
        }
        if (-not (Test-Path $outputPath)) {
            return @{ ok=$false; error_code='FOCUS_STAGE_NO_RESULT'; error_message="Foreground stage '$stage' exited without a result."; result=@{ stage=$stage; execution_pid=[int64]$proc.Id } }
        }
        # Worker files are BOM-less UTF-8. Windows PowerShell 5.1 Get-Content
        # otherwise uses the active ANSI code page, which can corrupt a
        # localized exception and make otherwise-valid JSON unparsable.
        $resultJson = [System.IO.File]::ReadAllText($outputPath, [System.Text.Encoding]::UTF8)
        $result = $resultJson | ConvertFrom-Json
        Log "[focus-stage] stage=$stage phase=completed child_pid=$($proc.Id)"
        return $result
    } catch {
        if ($null -ne $proc -and -not $proc.HasExited) {
            try { [void][SI_FG]::TerminateProcess($proc.Handle, 0xE002) } catch {}
        }
        return @{ ok=$false; error_code='FOCUS_STAGE_EXCEPTION'; error_message=$_.Exception.Message; result=@{ stage=$stage; execution_restarted=$true } }
    } finally {
        foreach ($p in @($requestPath,$outputPath,$checkpointPath)) {
            if (Test-Path $p) { try { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } catch {} }
        }
        if ($null -ne $proc) { try { $proc.Dispose() } catch {} }
    }
}

function Merge-FocusDiagnostics($target, $source) {
    if ($null -eq $source) { return }
    foreach ($p in $source.PSObject.Properties) { $target[$p.Name] = $p.Value }
}

function Tool-FocusWindow($a) {
    if ($null -eq $a -or -not $a.PSObject.Properties['window_handle']) {
        return @{ ok=$false; error_code='WINDOW_HANDLE_MISSING'; error_message='window_handle is required' }
    }
    $act = if ($a.PSObject.Properties['action']) { [string]$a.action } else { 'focus' }
    if ($act -notin @('focus','restore','minimize','maximize')) {
        return @{ ok=$false; error_code='ACTION_INVALID'; error_message="action must be focus|restore|minimize|maximize (got $act)" }
    }
    $reqHandle = [string]$a.window_handle
    $handleInt = 0L
    if (-not [int64]::TryParse($reqHandle, [ref]$handleInt) -or $handleInt -eq 0) {
        return @{ ok=$false; error_code='WINDOW_HANDLE_INVALID'; error_message="window_handle is not a valid integer handle: $reqHandle" }
    }

    $request = [ordered]@{ window_handle=$reqHandle; action=$act }
    $diag = [ordered]@{
        requested_window_handle=$reqHandle; window_handle=$reqHandle; action=$act;
        verified=$false; isolated_execution=$true; stage_timeout_ms=1600
    }
    $prepare = Invoke-FocusStage 'prepare' $request
    Merge-FocusDiagnostics $diag $prepare.result
    if (-not $prepare.ok) { return @{ ok=$false; error_code=$prepare.error_code; error_message=$prepare.error_message; result=$diag } }

    if ($act -eq 'minimize') {
        $verifyMin = Invoke-FocusStage 'verify' $request
        Merge-FocusDiagnostics $diag $verifyMin.result
        $diag.verified = [bool]($verifyMin.ok -and $verifyMin.result.acquired -and $verifyMin.result.state_ok)
        if (-not $diag.verified) { return @{ ok=$false; error_code='FOCUS_NOT_ACQUIRED'; error_message="Windows did not confirm minimize on $reqHandle"; result=$diag } }
        return @{ ok=$true; result=$diag }
    }

    $direct = Invoke-FocusStage 'direct' $request
    Merge-FocusDiagnostics $diag $direct.result
    if (-not $direct.ok) { return @{ ok=$false; error_code=$direct.error_code; error_message=$direct.error_message; result=$diag } }
    $acquired = [bool]$direct.result.acquired

    if (-not $acquired) {
        $alt = Invoke-FocusStage 'alt_tap' $request
        Merge-FocusDiagnostics $diag $alt.result
        if (-not $alt.ok) { return @{ ok=$false; error_code=$alt.error_code; error_message=$alt.error_message; result=$diag } }
        $afterAlt = Invoke-FocusStage 'direct' $request
        Merge-FocusDiagnostics $diag $afterAlt.result
        if (-not $afterAlt.ok) { return @{ ok=$false; error_code=$afterAlt.error_code; error_message=$afterAlt.error_message; result=$diag } }
        $acquired = [bool]$afterAlt.result.acquired
    }
    if (-not $acquired) {
        $attached = Invoke-FocusStage 'attached_focus' $request
        Merge-FocusDiagnostics $diag $attached.result
        if (-not $attached.ok) { return @{ ok=$false; error_code=$attached.error_code; error_message=$attached.error_message; result=$diag } }
        $acquired = [bool]$attached.result.acquired
    }
    if (-not $acquired) {
        $managed = Invoke-FocusStage 'managed_focus' $request
        Merge-FocusDiagnostics $diag $managed.result
        if (-not $managed.ok) { return @{ ok=$false; error_code=$managed.error_code; error_message=$managed.error_message; result=$diag } }
        $acquired = [bool]$managed.result.acquired
    }
    if (-not $acquired) {
        $switch = Invoke-FocusStage 'switch_window' $request
        Merge-FocusDiagnostics $diag $switch.result
        if (-not $switch.ok) { return @{ ok=$false; error_code=$switch.error_code; error_message=$switch.error_message; result=$diag } }
    }

    $verify = Invoke-FocusStage 'verify' $request
    Merge-FocusDiagnostics $diag $verify.result
    if (-not $verify.ok) { return @{ ok=$false; error_code=$verify.error_code; error_message=$verify.error_message; result=$diag } }
    $diag.verified = [bool]($verify.result.acquired -and $verify.result.state_ok)
    if (-not $diag.verified) {
        return @{ ok=$false; error_code='FOCUS_NOT_ACQUIRED'; error_message="Windows did not confirm action '$act' on window $reqHandle"; result=$diag }
    }
    return @{ ok=$true; result=$diag }
}
function Send-MouseAt($x, $y, $flags) {
    [void][SI]::SetCursorPos([int]$x, [int]$y)
    $inp = New-Object 'SI+INPUT[]' 1
    $inp[0].type = 0
    $inp[0].u.mi.dx = [int]$x; $inp[0].u.mi.dy = [int]$y
    $inp[0].u.mi.dwFlags = [uint32]$flags
    [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Get-ClickTargetInfo([int]$x, [int]$y) {
    # 0.4.21 — resolve the UIA element under (x,y) so Tool-Click can verify
    # the click landed on its intended target even when nothing in the
    # legacy foreground/focus/text/bounds predicate changed.
    $info = @{
        resolved = $false; runtime_id = $null; control_type = $null; class_name = $null;
        bounds = $null; top_level_handle = $null; is_document_or_edit = $false;
    }
    try {
        $pt = New-Object System.Windows.Point $x, $y
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        if ($null -ne $el) {
            $cur = $el.Current
            $info.resolved = $true
            $info.control_type = $cur.ControlType.ProgrammaticName
            $info.class_name = $cur.ClassName
            try {
                $rid = $el.GetRuntimeId()
                if ($null -ne $rid) { $info.runtime_id = ($rid -join '.') }
            } catch {}
            try {
                $r = $cur.BoundingRectangle
                $info.bounds = @{ L = [int]$r.Left; T = [int]$r.Top; R = [int]$r.Right; B = [int]$r.Bottom }
            } catch {}
            try {
                $hnd = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
                    [System.Windows.Automation.TreeScope]::Children,
                    (New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty,
                        $cur.NativeWindowHandle)))
            } catch {}
            if ($cur.NativeWindowHandle) {
                try {
                    $top = [SI]::GetAncestor([IntPtr]::new([int64]$cur.NativeWindowHandle), [uint32]2)
                    $info.top_level_handle = "$($top.ToInt64())"
                } catch {}
            }
            if ($info.control_type) {
                $info.is_document_or_edit = ($info.control_type -match '\.Document$' -or $info.control_type -match '\.Edit$')
            }
        }
    } catch {}
    return $info
}
function Get-CaretPosition() {
    # GetGUIThreadInfo — Win32 caret rect for the foreground thread. Returns
    # $null when the control does not expose a Win32 caret (some XAML edits).
    try {
        $fg = [SI]::GetForegroundWindow()
        if ($fg -eq [IntPtr]::Zero) { return $null }
        $pid_out = 0
        $tid = [SI_FG]::GetWindowThreadProcessId($fg, [ref]$pid_out)
        $gti = New-Object 'SI+GUITHREADINFO'
        $gti.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+GUITHREADINFO')
        if ([SI]::GetGUIThreadInfo([uint32]$tid, [ref]$gti)) {
            return @{ X = [int]$gti.rcCaret.L; Y = [int]$gti.rcCaret.T }
        }
    } catch {}
    return $null
}
function Get-FocusedRuntimeId() {
    try {
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $el) {
            $rid = $el.GetRuntimeId()
            if ($null -ne $rid) { return ($rid -join '.') }
        }
    } catch {}
    return $null
}
function Tool-Click($a) {
    # 0.4.21 Click Target Verification — fixes the 0.4.20 false-negative
    # where clicking an already-focused RichEditD2DPT Document at (400,300)
    # reported CLICK_NO_EFFECT because nothing in the foreground/focus/text/
    # bounds predicate changed. We now (1) resolve the UIA target via
    # AutomationElement.FromPoint at the click coords, (2) capture caret and
    # semantic snapshots pre-click, and (3) after the click compute a
    # multi-signal verdict via computeClickVerdict semantics: target still
    # focused inside its bounds, caret moved, toggle/selection changed, or
    # legacy foreground/focus/text change. Strict CLICK_NO_EFFECT is
    # preserved for non-text targets whose expected effect never fires.
    $btn = [string]$a.button; $clicks = if ($a.clicks) { [int]$a.clicks } else { 1 }
    $requireVerified = $true
    if ($a.PSObject.Properties['require_verified'] -and $null -ne $a.require_verified) {
        $requireVerified = [bool]$a.require_verified
    }
    $down = switch ($btn) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up   = switch ($btn) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    $x = [int]$a.x; $y = [int]$a.y

    $target = Get-ClickTargetInfo $x $y
    $preFg = [SI]::GetForegroundWindow()
    $preFocusedRid = Get-FocusedRuntimeId
    $preCaret = Get-CaretPosition
    $preEvidence = Get-ActionEvidence

    for ($i = 0; $i -lt $clicks; $i++) {
        Send-MouseAt $x $y $down
        Send-MouseAt $x $y $up
        Start-Sleep -Milliseconds 40
    }

    # Poll on the standard ladder until any effect appears.
    $delays = @(50, 100, 200, 400, 800, 1600)
    $attempts = 0; $post = $null; $postCaret = $null; $postFocusedRid = $null
    $postHitRid = $null; $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $verdictReady = $false
    foreach ($d in $delays) {
        Start-Sleep -Milliseconds $d
        $attempts++
        $post = Get-ActionEvidence
        $postCaret = Get-CaretPosition
        $postFocusedRid = Get-FocusedRuntimeId
        $postHit = Get-ClickTargetInfo $x $y
        $postHitRid = $postHit.runtime_id
        # Break as soon as any obviously observable signal fires.
        if ($post.foreground_window_handle -ne $preEvidence.foreground_window_handle) { $verdictReady = $true; break }
        if ($post.focused_text_hash -ne $preEvidence.focused_text_hash) { $verdictReady = $true; break }
        if ($preCaret -and $postCaret -and ($preCaret.X -ne $postCaret.X -or $preCaret.Y -ne $postCaret.Y)) { $verdictReady = $true; break }
        if ($target.runtime_id -and $postFocusedRid -eq $target.runtime_id) { $verdictReady = $true; break }
    }
    $sw.Stop()
    if ($null -eq $post) { $post = Get-ActionEvidence }

    $foregroundChanged = ($preEvidence.foreground_window_handle -ne $post.foreground_window_handle)
    $descendant = $false
    if ($target.runtime_id -and $postFocusedRid) {
        $descendant = ($postFocusedRid -eq $target.runtime_id -or $postFocusedRid.StartsWith("$($target.runtime_id)."))
    }
    $inBounds = $false
    if ($target.bounds) {
        $b = $target.bounds
        $inBounds = ($x -ge $b.L -and $x -lt $b.R -and $y -ge $b.T -and $y -lt $b.B)
    }
    $caretMoved = ($preCaret -and $postCaret -and ($preCaret.X -ne $postCaret.X -or $preCaret.Y -ne $postCaret.Y))

    $verified = $false; $verificationKind = 'foreground_or_focus_change'; $failureReason = $null; $errorCode = $null
    if ($caretMoved) {
        $verified = $true; $verificationKind = 'caret_changed'; $failureReason = 'gui_thread_info_caret_moved'
    }
    elseif ($target.resolved -and $target.is_document_or_edit -and -not $foregroundChanged -and $inBounds -and ($descendant -or ($target.runtime_id -and $postHitRid -eq $target.runtime_id))) {
        $verified = $true; $verificationKind = 'target_focus_verified'; $failureReason = 'document_or_edit_target_still_focused'
    }
    elseif ($post.focused_text_hash -ne $preEvidence.focused_text_hash -or
            $post.focused_class -ne $preEvidence.focused_class -or
            $foregroundChanged) {
        $verified = $true; $verificationKind = 'foreground_or_focus_change'; $failureReason = 'focus_or_bounds_or_text_changed'
    }
    elseif (-not $target.resolved) {
        $verificationKind = 'unverifiable'; $failureReason = 'uia_target_unresolved_at_click_point'; $errorCode = 'CLICK_NO_EFFECT'
    }
    else {
        $verificationKind = 'foreground_or_focus_change'; $failureReason = 'no_focus_or_text_or_bounds_or_caret_change'; $errorCode = 'CLICK_NO_EFFECT'
    }

    $diag = @{
        x = $x; y = $y; button = $btn; clicks = $clicks
        require_verified        = $requireVerified
        verified                = $verified
        verification_kind       = $verificationKind
        verification_attempts   = $attempts
        verification_elapsed_ms = [int]$sw.ElapsedMilliseconds
        pre                     = $preEvidence
        post                    = $post
        target                  = $target
        pre_focused_runtime_id  = $preFocusedRid
        post_focused_runtime_id = $postFocusedRid
        post_hit_runtime_id     = $postHitRid
        pre_caret               = $preCaret
        post_caret              = $postCaret
        caret_moved             = $caretMoved
        focused_is_descendant   = $descendant
        click_point_in_target   = $inBounds
        target_still_foreground = -not $foregroundChanged
        failure_reason          = $failureReason
    }
    if ($requireVerified -and -not $verified) {
        $ec = if ($errorCode) { $errorCode } else { 'CLICK_NO_EFFECT' }
        return @{ ok = $false; error_code = $ec; error_message = "Click at ($x,$y) unverified: $failureReason"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}

function Send-KeyChar([char]$c) {
    $vk = [SI]::VkKeyScan($c); $low = $vk -band 0xff
    $inp = New-Object 'SI+INPUT[]' 2
    $inp[0].type = 1; $inp[0].u.ki.wVk = [uint16]$low
    $inp[1].type = 1; $inp[1].u.ki.wVk = [uint16]$low; $inp[1].u.ki.dwFlags = 2
    [void][SI]::SendInput(2, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Get-FocusedControlInfo() {
    # Snapshot the current UIA-focused element + Win32 foreground handle. Used
    # by Tool-Type / Tool-Hotkey pre/post evidence, and by the target-focus
    # guard that refuses to type into a non-Document/Edit control. Every field
    # is best-effort: we return $null-valued keys rather than throwing so
    # callers can always attach evidence.
    $fg = [IntPtr]::Zero
    try { $fg = [SI]::GetForegroundWindow() } catch {}
    $fgClass = $null
    try {
        $sb = New-Object System.Text.StringBuilder 256
        [void][SI]::GetClassName($fg, $sb, 256)
        $fgClass = $sb.ToString()
    } catch {}
    $ctrlClass = $null; $ctrlType = $null; $text = $null; $value = $null
    try {
        $auto = [System.Windows.Automation.AutomationElement]
        $el = $auto::FocusedElement
        if ($null -ne $el) {
            $cur = $el.Current
            $ctrlClass = $cur.ClassName
            $ctrlType  = $cur.ControlType.ProgrammaticName
            # TextPattern first (Win11 Notepad RichEditD2DPT exposes this).
            try {
                $tpId = [System.Windows.Automation.TextPattern]::Pattern
                $tp = $null
                if ($el.TryGetCurrentPattern($tpId, [ref]$tp)) {
                    $rng = $tp.DocumentRange
                    $text = $rng.GetText(-1)
                }
            } catch {}
            try {
                $vpId = [System.Windows.Automation.ValuePattern]::Pattern
                $vp = $null
                if ($el.TryGetCurrentPattern($vpId, [ref]$vp)) {
                    $value = $vp.Current.Value
                }
            } catch {}
        }
    } catch {}
    $isDocOrEdit = $false
    if ($ctrlType) {
        $isDocOrEdit = ($ctrlType -match '\.Document$' -or $ctrlType -match '\.Edit$')
    }
    return @{
        foreground_window_handle = "$($fg.ToInt64())"
        foreground_class         = $fgClass
        focused_class            = $ctrlClass
        focused_control_type     = $ctrlType
        focused_text             = $text
        focused_value            = $value
        focused_text_length      = if ($text)  { $text.Length }  else { 0 }
        focused_value_length     = if ($value) { $value.Length } else { 0 }
        is_document_or_edit      = $isDocOrEdit
    }
}

# ------------------- 0.4.20 Action Verification Engine -------------------
# 0.4.19 wrongly claimed click/drag/hotkey succeeded whenever SendInput
# returned — the desktop showed nothing changed. The engine wraps every
# effect-bearing action with an explicit pre/post capture, executes the
# action, then polls at 50/100/200/400/800/1600 ms cumulative delays for
# an effect predicate to fire. Verified actions return the poll counts
# and elapsed ms as diagnostics; unverified effect-bearing actions return
# CLICK_NO_EFFECT / DRAG_NO_EFFECT / HOTKEY_NO_EFFECT with the same
# pre/post evidence. Actions whose semantics we cannot infer are marked
# verification_kind='input_only' and MUST NOT be treated as verified.
function Get-WindowRect([IntPtr]$hWnd) {
    if ($hWnd -eq [IntPtr]::Zero) { return $null }
    $r = New-Object 'SI+RECT'
    try {
        if (-not [SI]::GetWindowRect($hWnd, [ref]$r)) { return $null }
    } catch { return $null }
    return @{ L = $r.L; T = $r.T; R = $r.R; B = $r.B; W = ($r.R - $r.L); H = ($r.B - $r.T) }
}

function Get-ActionEvidence() {
    $focus = Get-FocusedControlInfo
    $fg = [IntPtr]::Zero
    try { $fg = [SI]::GetForegroundWindow() } catch {}
    $rect = Get-WindowRect $fg
    $title = $null
    try {
        $sb = New-Object System.Text.StringBuilder 256
        [void][SI]::GetWindowText($fg, $sb, 256)
        $title = $sb.ToString()
    } catch {}
    $seq = 0; try { $seq = [SI]::GetClipboardSequenceNumber() } catch {}
    $textHash  = Get-TextSha256 ([string]$focus.focused_text)
    $valueHash = Get-TextSha256 ([string]$focus.focused_value)
    return @{
        foreground_window_handle = "$($fg.ToInt64())"
        foreground_class         = $focus.foreground_class
        foreground_title         = $title
        foreground_rect          = $rect
        focused_class            = $focus.focused_class
        focused_control_type     = $focus.focused_control_type
        focused_text             = $focus.focused_text
        focused_value            = $focus.focused_value
        focused_text_length      = $focus.focused_text_length
        focused_value_length     = $focus.focused_value_length
        focused_text_hash        = $textHash
        focused_value_hash       = $valueHash
        is_document_or_edit      = $focus.is_document_or_edit
        clipboard_sequence       = [int64]$seq
        captured_at_ms           = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    }
}

function New-VerificationPredicate([string]$kind) {
    switch ($kind) {
        'clipboard_change' {
            return {
                param($pre, $post)
                if ($post.clipboard_sequence -ne $pre.clipboard_sequence) {
                    return @{ observed = $true;  reason = 'clipboard_sequence_changed' }
                }
                return         @{ observed = $false; reason = 'clipboard_sequence_unchanged' }
            }
        }
        'focused_text_change' {
            return {
                param($pre, $post)
                if ($post.focused_text_hash  -ne $pre.focused_text_hash -or
                    $post.focused_value_hash -ne $pre.focused_value_hash) {
                    return @{ observed = $true;  reason = 'focused_text_hash_changed' }
                }
                return         @{ observed = $false; reason = 'focused_text_hash_unchanged' }
            }
        }
        'foreground_change' {
            return {
                param($pre, $post)
                if ($post.foreground_window_handle -ne $pre.foreground_window_handle) {
                    return @{ observed = $true;  reason = 'foreground_window_handle_changed' }
                }
                return         @{ observed = $false; reason = 'foreground_window_unchanged' }
            }
        }
        'foreground_or_focus_change' {
            return {
                param($pre, $post)
                if ($post.foreground_window_handle -ne $pre.foreground_window_handle) {
                    return @{ observed = $true; reason = 'foreground_window_handle_changed' }
                }
                if ($post.focused_class        -ne $pre.focused_class -or
                    $post.focused_control_type -ne $pre.focused_control_type) {
                    return @{ observed = $true; reason = 'focused_control_changed' }
                }
                if ($post.focused_text_hash  -ne $pre.focused_text_hash -or
                    $post.focused_value_hash -ne $pre.focused_value_hash) {
                    return @{ observed = $true; reason = 'focused_text_hash_changed' }
                }
                $a = $pre.foreground_rect; $b = $post.foreground_rect
                if ($a -and $b -and ($a.L -ne $b.L -or $a.T -ne $b.T -or $a.R -ne $b.R -or $a.B -ne $b.B)) {
                    return @{ observed = $true; reason = 'foreground_rect_changed' }
                }
                return @{ observed = $false; reason = 'no_focus_or_text_or_bounds_change' }
            }
        }
        'selection_change' {
            return {
                param($pre, $post)
                # Ctrl+A: prefer real selection evidence when available; fall
                # back to focused text/value hash change; otherwise unobserved.
                if ($post.selection_length -ne $null -and $pre.selection_length -ne $null -and $post.selection_length -ne $pre.selection_length) {
                    return @{ observed = $true; reason = 'selection_length_changed' }
                }
                if ($post.selection_snapshot -ne $null -and $post.selection_snapshot -ne $pre.selection_snapshot) {
                    return @{ observed = $true; reason = 'selection_snapshot_changed' }
                }
                return @{ observed = $false; reason = 'no_selection_evidence' }
            }
        }
        'window_closed' {
            return {
                param($pre, $post)
                if ($post.target_window_exists -eq $false -and $pre.target_window_exists -ne $false) {
                    return @{ observed = $true; reason = 'target_window_closed' }
                }
                if ($post.foreground_window_handle -ne $pre.foreground_window_handle) {
                    return @{ observed = $true; reason = 'close_dialog_present' }
                }
                return @{ observed = $false; reason = 'window_still_open_and_foreground_unchanged' }
            }
        }
        'input_only' {
            return {
                param($pre, $post)
                return @{ observed = $false; reason = 'input_only_semantics' }
            }
        }
        default {
            return {
                param($pre, $post)
                return @{ observed = $false; reason = "unknown_kind:$kind" }
            }
        }
    }
}

function Invoke-VerifiedAction {
    param(
        [Parameter(Mandatory)][scriptblock]$Action,
        [Parameter(Mandatory)][scriptblock]$Predicate,
        [Parameter(Mandatory)][string]$Kind
    )
    # Cumulative delays MUST be 50/100/200/400/800/1600 ms per 0.4.20 spec.
    $delays = @(50, 100, 200, 400, 800, 1600)
    $pre = Get-ActionEvidence
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $actionError = $null
    try { & $Action } catch { $actionError = $_.Exception.Message }
    $post = $null; $verified = $false; $attempts = 0
    $effect = @{ observed = $false; reason = 'no_poll' }
    foreach ($d in $delays) {
        Start-Sleep -Milliseconds $d
        $attempts++
        $post = Get-ActionEvidence
        $effect = & $Predicate $pre $post
        if ($effect -and $effect.observed) { $verified = $true; break }
    }
    $sw.Stop()
    if ($null -eq $post) { $post = Get-ActionEvidence }
    $stillFg = ($pre.foreground_window_handle -eq $post.foreground_window_handle)
    return @{
        verified                = [bool]$verified
        verification_kind       = $Kind
        verification_attempts   = [int]$attempts
        verification_elapsed_ms = [int]$sw.ElapsedMilliseconds
        pre                     = $pre
        post                    = $post
        target_still_foreground = [bool]$stillFg
        effect_observed         = [bool]$effect.observed
        failure_reason          = if ($verified) { $null } else { [string]$effect.reason }
        action_error            = $actionError
    }
}

function Resolve-HotkeyVerification([string[]]$modNames, [string]$key) {
    # Classify well-known hotkeys into verification kinds. Requires=$true means
    # verification failure MUST surface HOTKEY_NO_EFFECT (or CLIPBOARD_UNCHANGED_AFTER_COPY
    # for Ctrl+C / Ctrl+X). Requires=$false means we cannot pin the semantics
    # tightly (e.g. Ctrl+A only mutates selection, no observable text change)
    # and MUST NOT report input_sent as a real effect.
    $hasCtrl = ($modNames -contains 'ctrl')
    $hasAlt  = ($modNames -contains 'alt')
    $hasWin  = ($modNames -contains 'win')
    $k = $key.ToLowerInvariant()
    if ($hasCtrl -and ($k -eq 'c' -or $k -eq 'x')) { return @{ kind = 'clipboard_change';           requires = $true  } }
    if ($hasCtrl -and ($k -eq 'v' -or $k -eq 'z' -or $k -eq 'y')) { return @{ kind = 'focused_text_change'; requires = $true  } }
    if ($hasCtrl -and $k -eq 'a')                  { return @{ kind = 'selection_change';            requires = $true  } }
    if ($hasAlt  -and $k -eq 'f4')                 { return @{ kind = 'window_closed';               requires = $true  } }
    if ($hasAlt  -and ($k -eq 'tab' -or $k -eq 'escape')) { return @{ kind = 'foreground_change';    requires = $true  } }
    if ($hasWin  -and ($k -eq 'd' -or $k -eq 'e' -or $k -eq 'r' -or $k -eq 'tab')) { return @{ kind = 'foreground_change'; requires = $true } }
    if ($hasCtrl -and ($k -eq 'n' -or $k -eq 'o' -or $k -eq 'w' -or $k -eq 's' -or $k -eq 't')) {
        return @{ kind = 'foreground_or_focus_change'; requires = $true }
    }
    return @{ kind = 'input_only'; requires = $false }
}



function Send-UnicodeText([string]$text) {
    # 0.4.21: SendInput per-character injection returning full diagnostics so
    # Tool-Type can gate acceptance on returned == requested INPUT count and
    # (utf16_code_units * 2) matched keydown/keyup pairs. SendKeys/VkKeyScan
    # remain unsupported on RichEditD2DPT / XAML surfaces; KEYEVENTF_UNICODE
    # bypasses the keyboard-layout translation entirely.
    $diag = @{
        requested_input_count = 0
        returned_input_count  = 0
        last_error            = 0
        keydown_count         = 0
        keyup_count           = 0
        utf16_code_units      = 0
    }
    if ($null -eq $text -or $text.Length -eq 0) { return $diag }
    $KEYEVENTF_KEYUP   = [uint32]0x0002
    $KEYEVENTF_UNICODE = [uint32]0x0004
    $count = $text.Length * 2
    $diag.requested_input_count = $count
    $diag.utf16_code_units      = $text.Length
    $inp = New-Object 'SI+INPUT[]' $count
    for ($i = 0; $i -lt $text.Length; $i++) {
        $cu = [uint16][int]$text[$i]
        $j  = $i * 2
        $inp[$j].type = 1
        $inp[$j].u.ki.wVk = [uint16]0
        $inp[$j].u.ki.wScan = $cu
        $inp[$j].u.ki.dwFlags = $KEYEVENTF_UNICODE
        $inp[$j + 1].type = 1
        $inp[$j + 1].u.ki.wVk = [uint16]0
        $inp[$j + 1].u.ki.wScan = $cu
        $inp[$j + 1].u.ki.dwFlags = ($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)
        $diag.keydown_count++
        $diag.keyup_count++
    }
    $sent = [SI]::SendInput([uint32]$count, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
    $diag.returned_input_count = [int]$sent
    $diag.last_error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    return $diag
}

function Invoke-UiaValueSet([string]$text) {
    # 0.4.21 verified-type fallback #1: UIA ValuePattern.SetValue on the
    # focused element. Works on classic Edit controls and many WPF/XAML
    # TextBox surfaces; NOT supported by RichEditD2DPT (returns $false).
    try {
        $el = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $el) { return $false }
        $vpId = [System.Windows.Automation.ValuePattern]::Pattern
        $vp = $null
        if ($el.TryGetCurrentPattern($vpId, [ref]$vp)) {
            if (-not $vp.Current.IsReadOnly) {
                $vp.SetValue([string]$text)
                return $true
            }
        }
    } catch {}
    return $false
}

function Invoke-ClipboardPaste([string]$text) {
    # 0.4.21 verified-type fallback #2: preserve current clipboard, write the
    # target text, synthesise Ctrl+V via SendInput, then restore. The restore
    # is best-effort — if the app is Notepad and the paste succeeded, the
    # clipboard is guaranteed to hold the injected text momentarily.
    $original = $null
    try { $original = [System.Windows.Forms.Clipboard]::GetText() } catch {}
    $wroteOk = $false
    try {
        [System.Windows.Forms.Clipboard]::SetText([string]$text)
        $wroteOk = $true
    } catch {}
    if (-not $wroteOk) { return @{ ok = $false; reason = 'clipboard_set_failed'; restored = $false } }
    # Ctrl+V via SendInput — bypasses SendKeys quirks on modern edits.
    try {
        $VK_CONTROL = [uint16]0x11; $VK_V = [uint16]0x56
        $inp = New-Object 'SI+INPUT[]' 4
        $inp[0].type = 1; $inp[0].u.ki.wVk = $VK_CONTROL
        $inp[1].type = 1; $inp[1].u.ki.wVk = $VK_V
        $inp[2].type = 1; $inp[2].u.ki.wVk = $VK_V;      $inp[2].u.ki.dwFlags = [uint32]0x0002
        $inp[3].type = 1; $inp[3].u.ki.wVk = $VK_CONTROL; $inp[3].u.ki.dwFlags = [uint32]0x0002
        [void][SI]::SendInput(4, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
    } catch { return @{ ok = $false; reason = "ctrl_v_dispatch_failed:$($_.Exception.Message)"; restored = $false } }
    Start-Sleep -Milliseconds 120
    $restored = $false
    try {
        if ($null -ne $original) { [System.Windows.Forms.Clipboard]::SetText([string]$original); $restored = $true }
        elseif ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::Clear(); $restored = $true }
    } catch {}
    return @{ ok = $true; reason = 'clipboard_paste_dispatched'; restored = $restored }
}


function Get-TextSha256([string]$s) {
    if ($null -eq $s) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
        $hash = $sha.ComputeHash($bytes)
        return -join ($hash | ForEach-Object { $_.ToString('x2') })
    } finally { $sha.Dispose() }
}

function Tool-Type($a) {
    # 0.4.20: real verified injection + editor-debounce stability window +
    # semantic classification for pre-populated targets. The 0.4.19 path
    # returned TYPE_NO_EFFECT on the first 50ms miss even though editors
    # like ProseMirror/Monaco/Slate render the model asynchronously and
    # commit the string after several hundred milliseconds. It also
    # accepted a bare "hash changed" as verified even when UIA truncated
    # the post value (e.g. Chrome Omnibox with a long URL already present),
    # so long injections could look verified while the actual characters
    # were dropped. See src/lib/desktop/verifier.ts for the canonical
    # decision table used by the vitest regressions.
    $text = [string]$a.text
    $cpsHint = if ($a.PSObject.Properties['chars_per_second'] -and $a.chars_per_second) { [int]$a.chars_per_second } else { 0 }
    $pre = Get-FocusedControlInfo
    $expectedHandle = $null
    if ($a.PSObject.Properties['window_handle'] -and $a.window_handle) {
        $expectedHandle = [string]$a.window_handle
    }
    if (-not $pre.is_document_or_edit) {
        return @{ ok = $false; error_code = 'FOCUS_CONTROL_INVALID'; error_message = "Focused control is not Document/Edit (got '$($pre.focused_control_type)')"; evidence = @{ pre = $pre; expected_window_handle = $expectedHandle } }
    }
    if ($expectedHandle -and ($expectedHandle -ne $pre.foreground_window_handle)) {
        return @{ ok = $false; error_code = 'FOCUS_TARGET_MISMATCH'; error_message = "Foreground window handle $($pre.foreground_window_handle) does not match expected $expectedHandle"; evidence = @{ pre = $pre; expected_window_handle = $expectedHandle } }
    }

    $preText = if ($pre.focused_text) { [string]$pre.focused_text } elseif ($pre.focused_value) { [string]$pre.focused_value } else { '' }
    $preLen  = $preText.Length
    $preHash = Get-TextSha256 $preText

    # ------------------------------------------------------------------
    # 0.4.21 Verified-Type Fallback
    # ------------------------------------------------------------------
    # `Send-UnicodeText` now returns SendInput dispatch counts + GetLastError.
    # `Invoke-TypeAttempt` performs a SendInput pass and polls UIA on the
    # stability ladder; if the readback still does not match the requested
    # text we escalate through UIA ValuePattern.SetValue and clipboard
    # paste. TYPE_FALLBACK_FAILED surfaces only after every method fails.
    $stabilityLadder = @(50, 100, 100, 200, 200, 400, 400, 800, 800, 200)

    function Invoke-TypeAttempt([string]$text, [string]$injectionMethod, [scriptblock]$injector) {
        $post = $null; $postText = ''; $postHash = Get-TextSha256 ''
        $observedAt = 0; $stable = 0; $lastChangedHash = $null; $attempts = 0
        $preSnapshot = Get-FocusedControlInfo
        $preText = if ($preSnapshot.focused_text) { [string]$preSnapshot.focused_text } elseif ($preSnapshot.focused_value) { [string]$preSnapshot.focused_value } else { '' }
        $lastChangedHash = Get-TextSha256 $preText
        $injectDiag = & $injector
        foreach ($d in $stabilityLadder) {
            Start-Sleep -Milliseconds $d
            $attempts++
            $post = Get-FocusedControlInfo
            $postText = if ($post.focused_text) { [string]$post.focused_text } elseif ($post.focused_value) { [string]$post.focused_value } else { '' }
            $postHash = Get-TextSha256 $postText
            if ($observedAt -eq 0 -and $postHash -ne $lastChangedHash) {
                $observedAt = $attempts; $lastChangedHash = $postHash; $stable = 1; continue
            }
            if ($observedAt -gt 0) {
                if ($postHash -eq $lastChangedHash) { $stable++; if ($stable -ge 3) { break } }
                else { $lastChangedHash = $postHash; $stable = 1 }
            }
        }
        if ($null -eq $post) { $post = Get-FocusedControlInfo }
        return @{
            attempts = $attempts; observed_at = $observedAt; stable = $stable
            post = $post; postText = $postText; postHash = $postHash
            injection_method = $injectionMethod
            inject_diag = $injectDiag
        }
    }

    $preText = if ($pre.focused_text) { [string]$pre.focused_text } elseif ($pre.focused_value) { [string]$pre.focused_value } else { '' }
    $preLen  = $preText.Length
    $preHash = Get-TextSha256 $preText

    $swType = [System.Diagnostics.Stopwatch]::StartNew()

    $sendInputDiag = @{ requested_input_count = 0; returned_input_count = 0; last_error = 0; keydown_count = 0; keyup_count = 0; utf16_code_units = 0 }
    $sendOk = $true
    $sendInjector = { try { $script:__sd = Send-UnicodeText $text } catch { $script:__sd = @{ error = $_.Exception.Message } } ; return $script:__sd }.GetNewClosure()
    $primary = Invoke-TypeAttempt $text 'SendInput+KEYEVENTF_UNICODE' $sendInjector
    if ($primary.inject_diag -is [hashtable]) { $sendInputDiag = $primary.inject_diag }
    if ($sendInputDiag.returned_input_count -ne $sendInputDiag.requested_input_count) { $sendOk = $false }

    $attemptsSummary = @()
    $attemptsSummary += @{ method = $primary.injection_method; attempts = $primary.attempts; observed_at = $primary.observed_at; stable = $primary.stable; post_length = $primary.postText.Length; inject_diag = $sendInputDiag }
    $current = $primary
    $post = $primary.post; $postText = $primary.postText; $postHash = $primary.postHash
    $observedAt = $primary.observed_at; $stable = $primary.stable; $attempts = $primary.attempts

    function _TypeMatches([string]$injected, [string]$pre_, [string]$post_) {
        if ($pre_.Length -eq 0) {
            $trimmed = $post_.TrimEnd([char]13, [char]10)
            return ($post_ -eq $injected -or $trimmed -eq $injected)
        }
        $ap = $pre_ + $injected
        $apt = $ap.TrimEnd([char]13, [char]10)
        return ($post_ -eq $injected -or $post_ -eq $ap -or $post_ -eq $apt)
    }

    $triedFallbacks = @()
    $fallbackDetails = @()
    $verifiedViaFallback = $false
    if (-not (_TypeMatches $text $preText $postText)) {
        # Fallback 1: UIA ValuePattern.SetValue.
        $curFocus = Get-FocusedControlInfo
        if ($curFocus.foreground_window_handle -eq $pre.foreground_window_handle -and $curFocus.is_document_or_edit) {
            $vpInjector = { $ok = Invoke-UiaValueSet $text; return @{ value_pattern_ok = [bool]$ok } }.GetNewClosure()
            $vpResult = Invoke-TypeAttempt $text 'UIA.ValuePattern.SetValue' $vpInjector
            $triedFallbacks += 'uia_value_set'
            $fallbackDetails += @{ step = 'uia_value_set'; attempts = $vpResult.attempts; observed_at = $vpResult.observed_at; stable = $vpResult.stable; post_length = $vpResult.postText.Length; inject_diag = $vpResult.inject_diag }
            $attemptsSummary += @{ method = $vpResult.injection_method; attempts = $vpResult.attempts; observed_at = $vpResult.observed_at; stable = $vpResult.stable; post_length = $vpResult.postText.Length; inject_diag = $vpResult.inject_diag }
            if ((_TypeMatches $text $preText $vpResult.postText)) {
                $verifiedViaFallback = $true; $current = $vpResult
                $post = $vpResult.post; $postText = $vpResult.postText; $postHash = $vpResult.postHash
                $observedAt = $vpResult.observed_at; $stable = $vpResult.stable; $attempts += $vpResult.attempts
            }
        }
    }
    if (-not $verifiedViaFallback -and -not (_TypeMatches $text $preText $postText)) {
        # Fallback 2: clipboard paste (with restore).
        $curFocus = Get-FocusedControlInfo
        if ($curFocus.foreground_window_handle -eq $pre.foreground_window_handle -and $curFocus.is_document_or_edit) {
            $cbInjector = { $r = Invoke-ClipboardPaste $text; return $r }.GetNewClosure()
            $cbResult = Invoke-TypeAttempt $text 'Clipboard.Paste+SendInput.Ctrl+V' $cbInjector
            $triedFallbacks += 'clipboard_paste'
            $fallbackDetails += @{ step = 'clipboard_paste'; attempts = $cbResult.attempts; observed_at = $cbResult.observed_at; stable = $cbResult.stable; post_length = $cbResult.postText.Length; inject_diag = $cbResult.inject_diag }
            $attemptsSummary += @{ method = $cbResult.injection_method; attempts = $cbResult.attempts; observed_at = $cbResult.observed_at; stable = $cbResult.stable; post_length = $cbResult.postText.Length; inject_diag = $cbResult.inject_diag }
            if ((_TypeMatches $text $preText $cbResult.postText)) {
                $verifiedViaFallback = $true; $current = $cbResult
                $post = $cbResult.post; $postText = $cbResult.postText; $postHash = $cbResult.postHash
                $observedAt = $cbResult.observed_at; $stable = $cbResult.stable; $attempts += $cbResult.attempts
            }
        }
    }
    $swType.Stop()

    $stillTarget = ($pre.foreground_window_handle -eq $post.foreground_window_handle)
    $uiaReadable = $true
    if (-not $post.is_document_or_edit -and $observedAt -eq 0) { $uiaReadable = $false }

    # Semantic classification — mirrors computeTypeVerdict in verifier.ts.
    $verified = $false
    $verificationKind = 'type_semantics'
    $semantic = 'ambiguous'
    $failureReason = $null
    $errorCode = $null

    if (-not $stillTarget) {
        $errorCode = 'FOCUS_TARGET_LOST'; $failureReason = 'foreground_window_changed_during_type'
    }
    elseif (-not $uiaReadable) {
        $errorCode = 'UIA_UNREADABLE'; $failureReason = 'uia_text_value_pattern_unavailable'; $verificationKind = 'input_only'; $semantic = 'input_only'
    }
    elseif ($observedAt -eq 0) {
        $errorCode = if ($triedFallbacks.Count -gt 0) { 'TYPE_FALLBACK_FAILED' } else { 'TYPE_NO_EFFECT' }
        $failureReason = 'no_uia_change_within_stability_window'
    }
    elseif ($stable -lt 2) {
        $errorCode = 'TYPE_SEMANTICS_UNVERIFIED'; $failureReason = 'uia_text_still_churning_no_stability'
    }
    elseif ($preLen -eq 0) {
        $trimmed = $postText.TrimEnd([char]13, [char]10)
        if ($postText -eq $text -or $trimmed -eq $text) {
            $verified = $true; $semantic = 'empty_exact'; $failureReason = 'empty_target_exact_match'
        } else {
            $errorCode = if ($triedFallbacks.Count -gt 0) { 'TYPE_FALLBACK_FAILED' } else { 'TYPE_SEMANTICS_UNVERIFIED' }
            $failureReason = 'empty_target_mismatch'
        }
    }
    else {
        $appendCandidate = $preText + $text
        $appendTrimmed = $appendCandidate.TrimEnd([char]13, [char]10)
        if ($postText -eq $appendCandidate -or $postText -eq $appendTrimmed) {
            $verified = $true; $semantic = 'append'; $failureReason = 'append_after_existing_text'
        }
        elseif ($postText -eq $text) {
            $verified = $true; $semantic = 'replace'; $failureReason = 'replaced_existing_selection'
        }
        elseif ($postText.Length -lt $appendCandidate.Length -and $appendCandidate.StartsWith($postText) -and $text.Length -gt 0) {
            $errorCode = 'TYPE_SEMANTICS_UNVERIFIED'; $failureReason = 'uia_value_appears_truncated_cannot_confirm_semantics'; $verificationKind = 'input_only'; $semantic = 'input_only'
        }
        else {
            $errorCode = if ($triedFallbacks.Count -gt 0) { 'TYPE_FALLBACK_FAILED' } else { 'TYPE_SEMANTICS_UNVERIFIED' }
            $failureReason = 'post_text_does_not_match_append_or_replace'
        }
    }
    if ($verified) { $errorCode = $null }

    $diag = @{
        pre = $pre
        post = $post
        expected_window_handle = $expectedHandle
        expected_target_still_foreground = $stillTarget
        pre_foreground_window_handle  = $pre.foreground_window_handle
        post_foreground_window_handle = $post.foreground_window_handle
        pre_focused_class             = $pre.focused_class
        post_focused_class            = $post.focused_class
        pre_focused_control_type      = $pre.focused_control_type
        post_focused_control_type     = $post.focused_control_type
        text_length_before            = $preLen
        text_length_after             = $postText.Length
        text_hash_before              = $preHash
        text_hash_after               = $postHash
        text_changed                  = ($observedAt -gt 0)
        verified                      = $verified
        verification_kind             = $verificationKind
        verification_attempts         = $attempts
        verification_elapsed_ms       = [int]$swType.ElapsedMilliseconds
        stability_polls               = $stable
        observed_at_attempt           = $observedAt
        semantic                      = $semantic
        exact_match_when_empty        = ($verified -and $semantic -eq 'empty_exact')
        length                        = $text.Length
        send_input_ok                 = $sendOk
        send_input                    = $sendInputDiag
        injection_method              = $current.injection_method
        fallback_used                 = ($triedFallbacks.Count -gt 0)
        fallback_steps                = $triedFallbacks
        fallback_details              = $fallbackDetails
        attempts_summary              = $attemptsSummary
        failure_reason                = $failureReason
    }
    if (-not $verified) {
        $ec = if ($errorCode) { $errorCode } else { 'TYPE_NO_EFFECT' }
        return @{ ok = $false; error_code = $ec; error_message = "Type unverified: $failureReason"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}


function Get-ClipboardTextInfo() {
    # Best-effort: try Windows.Forms clipboard read. Returns availability +
    # length + sha256 (never the plaintext) so audit logs stay clean.
    $info = @{
        text_format_available = $false
        read_succeeded        = $false
        length                = $null
        hash                  = $null
        value                 = $null
    }
    try {
        $info.text_format_available = [System.Windows.Forms.Clipboard]::ContainsText()
    } catch { $info.text_format_available = $false }
    if (-not $info.text_format_available) { return $info }
    try {
        $v = [System.Windows.Forms.Clipboard]::GetText()
        $info.read_succeeded = $true
        $info.value = $v
        $info.length = if ($null -ne $v) { $v.Length } else { 0 }
        $info.hash   = Get-TextSha256 ([string]$v)
    } catch { $info.read_succeeded = $false }
    return $info
}

function Tool-ClipboardGet($a) {
    # 0.4.22-C1: emit a full verification contract. Value stays in result for
    # legitimate reads, but pre/post evidence only carries length/hash so audit
    # logs never see plaintext.
    $pre = Get-ActionEvidence
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $openOk = $true # Windows.Forms clipboard handles retry internally.
    $info = Get-ClipboardTextInfo
    $sw.Stop()
    $post = Get-ActionEvidence
    $post.clipboard_format_available = [bool]$info.text_format_available
    $post.clipboard_hash             = $info.hash
    $post.clipboard_length           = $info.length
    $pre.clipboard_format_available  = $pre.clipboard_format_available
    $verified = $false; $kind = 'clipboard_text_verified'; $errorCode = $null; $reason = $null; $successReason = $null
    if (-not $info.text_format_available) {
        $verified = $false; $errorCode = 'CLIPBOARD_TEXT_FORMAT_UNAVAILABLE'; $reason = 'text_format_unavailable'
    } elseif (-not $info.read_succeeded) {
        $verified = $false; $errorCode = 'CLIPBOARD_READ_FAILED';             $reason = 'getclipboarddata_failed'
    } elseif ($info.length -eq 0) {
        $verified = $true;  $errorCode = 'EMPTY_CLIPBOARD';                   $reason = 'clipboard_empty_confirmed'
        $kind = 'clipboard_empty_verified'; $successReason = 'clipboard_empty_confirmed'
    } else {
        $verified = $true; $successReason = 'clipboard_text_read'
    }
    $diag = @{
        require_verified        = $true
        verified                = [bool]$verified
        verification_kind       = $kind
        verification_attempts   = 1
        verification_elapsed_ms = [int]$sw.ElapsedMilliseconds
        pre                     = $pre
        post                    = $post
        target_still_foreground = ($pre.foreground_window_handle -eq $post.foreground_window_handle)
        failure_reason          = if ($verified) { $null } else { $reason }
        success_reason          = if ($verified) { $successReason } else { $null }
        error_code              = if ($verified) { $null } else { $errorCode }
        value                   = $info.value
        length                  = $info.length
        sequence                = [int64]$post.clipboard_sequence
    }
    if (-not $verified) {
        return @{ ok = $false; error_code = $errorCode; error_message = "Clipboard read unverified: $reason"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}

function Tool-ClipboardSet($a) {
    # 0.4.22-C1: write + immediate readback verification. On mismatch we return
    # CLIPBOARD_WRITE_VERIFY_FAILED with pre/post sequence + hash diagnostics.
    $expected = [string]$a.value
    $expectedLen  = $expected.Length
    $expectedHash = Get-TextSha256 $expected
    $pre = Get-ActionEvidence
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $setOk = $true
    try {
        if ($expectedLen -eq 0) {
            [System.Windows.Forms.Clipboard]::Clear()
        } else {
            [System.Windows.Forms.Clipboard]::SetText($expected)
        }
    } catch { $setOk = $false }
    Start-Sleep -Milliseconds 40
    $readback = Get-ClipboardTextInfo
    $sw.Stop()
    $post = Get-ActionEvidence
    $post.clipboard_format_available = [bool]$readback.text_format_available
    $post.clipboard_hash             = $readback.hash
    $post.clipboard_length           = $readback.length

    $verified = $false; $errorCode = $null; $reason = $null; $successReason = $null
    if (-not $setOk) {
        $reason = 'setclipboarddata_failed'; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
    } elseif ($expectedLen -eq 0) {
        # Cleared: format may go away entirely OR come back empty; either is ok.
        if (-not $readback.text_format_available -or $readback.length -eq 0) {
            $verified = $true; $successReason = 'clipboard_cleared_confirmed'
        } else {
            $reason = 'clipboard_not_cleared'; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
        }
    } elseif (-not $readback.text_format_available -or -not $readback.read_succeeded) {
        $reason = 'unicode_format_unavailable'; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
    } elseif ($readback.length -ne $expectedLen) {
        $reason = "length_mismatch:expected=$expectedLen,actual=$($readback.length)"; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
    } elseif ($readback.hash -ne $expectedHash) {
        $reason = 'content_overwritten_by_other_process'; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
    } elseif ($post.clipboard_sequence -eq $pre.clipboard_sequence) {
        $reason = 'clipboard_sequence_did_not_advance'; $errorCode = 'CLIPBOARD_WRITE_VERIFY_FAILED'
    } else {
        $verified = $true; $successReason = 'clipboard_content_verified'
    }
    $diag = @{
        require_verified        = $true
        verified                = [bool]$verified
        verification_kind       = if ($verified -and $expectedLen -eq 0) { 'clipboard_empty_verified' } else { 'clipboard_readback_exact' }
        verification_attempts   = 1
        verification_elapsed_ms = [int]$sw.ElapsedMilliseconds
        pre                     = $pre
        post                    = $post
        target_still_foreground = ($pre.foreground_window_handle -eq $post.foreground_window_handle)
        failure_reason          = if ($verified) { $null } else { $reason }
        success_reason          = if ($verified) { $successReason } else { $null }
        error_code              = if ($verified) { $null } else { $errorCode }
        expected_length         = $expectedLen
        expected_hash           = $expectedHash
        length                  = $readback.length
        sequence                = [int64]$post.clipboard_sequence
    }
    if (-not $verified) {
        return @{ ok = $false; error_code = $errorCode; error_message = "Clipboard write unverified: $reason"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}

function Tool-Launch($a) {
    $id = [string]$a.app_id
    $whitelist = @{
        notepad = 'notepad.exe'; calc = 'calc.exe'; mspaint = 'mspaint.exe';
        explorer = 'explorer.exe'; cmd_readonly = 'cmd.exe';
        chrome = 'chrome.exe'; edge = 'msedge.exe'
    }
    if ($id -and $whitelist.ContainsKey($id)) {
        Start-Process -FilePath $whitelist[$id] | Out-Null
        return @{ ok = $true; result = @{ launched = $id } }
    }
    $p = [string]$a.app_path
    if (-not $p -or -not (Test-Path $p)) {
        return @{ ok = $false; error_code = 'LAUNCH_PATH_NOT_FOUND'; error_message = 'app_path missing or does not resolve' }
    }
    Start-Process -FilePath $p | Out-Null
    return @{ ok = $true; result = @{ launched = $p } }
}

# P0-R6: real implementations for press/hotkey/scroll/drag/inspect.
# Named key -> Virtual-Key code (subset matching NamedKey in schemas.ts).
$script:NamedVk = @{
    enter=0x0D; escape=0x1B; tab=0x09; backspace=0x08; delete=0x2E;
    space=0x20; up=0x26; down=0x28; left=0x25; right=0x27;
    home=0x24; end=0x23; pageup=0x21; pagedown=0x22; insert=0x2D;
    f1=0x70; f2=0x71; f3=0x72; f4=0x73; f5=0x74; f6=0x75;
    f7=0x76; f8=0x77; f9=0x78; f10=0x79; f11=0x7A; f12=0x7B
}
$script:ModVk = @{ ctrl=0x11; shift=0x10; alt=0x12; win=0x5B }

function Send-VkDownUp([uint16]$vk, [switch]$KeyDownOnly, [switch]$KeyUpOnly) {
    $count = 2
    if ($KeyDownOnly -or $KeyUpOnly) { $count = 1 }
    $inp = New-Object 'SI+INPUT[]' $count
    if ($KeyUpOnly) {
        $inp[0].type = 1; $inp[0].u.ki.wVk = $vk; $inp[0].u.ki.dwFlags = 2
    } elseif ($KeyDownOnly) {
        $inp[0].type = 1; $inp[0].u.ki.wVk = $vk
    } else {
        $inp[0].type = 1; $inp[0].u.ki.wVk = $vk
        $inp[1].type = 1; $inp[1].u.ki.wVk = $vk; $inp[1].u.ki.dwFlags = 2
    }
    [void][SI]::SendInput([uint32]$count, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}

function Resolve-PressVerification([string]$key) {
    # 0.4.22-C1: map named keys to a verification kind + predicate reason.
    # requires=$true means verification failure MUST surface
    # PRESS_NO_OBSERVABLE_EFFECT (or PRESS_EFFECT_UNVERIFIABLE if evidence
    # is missing).
    $k = $key.ToLowerInvariant()
    switch ($k) {
        'tab'       { return @{ kind = 'press_focus_change';             semantic = 'focus_change';               requires = $true } }
        'backspace' { return @{ kind = 'press_text_change';              semantic = 'text_length_or_hash_change'; requires = $true } }
        'delete'    { return @{ kind = 'press_text_change';              semantic = 'text_length_or_hash_change'; requires = $true } }
        'enter'     { return @{ kind = 'foreground_or_focus_change';     semantic = 'text_focus_or_window_change';requires = $true } }
        'escape'    { return @{ kind = 'foreground_or_focus_change';     semantic = 'window_or_focus_change';     requires = $true } }
    }
    if ($k -in @('up','down','left','right','home','end','pageup','pagedown')) {
        return @{ kind = 'press_caret_or_selection_change'; semantic = 'caret_or_selection_change'; requires = $true }
    }
    if ($k -match '^f(\d+)$') {
        $n = [int]$matches[1]
        if ($n -ge 1 -and $n -le 12) { return @{ kind = 'press_window_change'; semantic = 'text_focus_or_window_change'; requires = $true } }
    }
    return @{ kind = 'input_only'; semantic = 'unknown'; requires = $false }
}

function Test-PressObserved([hashtable]$pre, [hashtable]$post, [string]$semantic) {
    switch ($semantic) {
        'focus_change' {
            if ($post.focused_class -ne $pre.focused_class -or $post.focused_control_type -ne $pre.focused_control_type -or $post.focused_text_hash -ne $pre.focused_text_hash) {
                return @{ observed = $true; reason = 'focused_element_changed' }
            }
            return @{ observed = $false; reason = 'focused_element_unchanged' }
        }
        'text_length_or_hash_change' {
            if ($post.focused_text_length -ne $pre.focused_text_length -or $post.focused_text_hash -ne $pre.focused_text_hash -or $post.focused_value_hash -ne $pre.focused_value_hash) {
                return @{ observed = $true; reason = 'focused_text_changed' }
            }
            return @{ observed = $false; reason = 'focused_text_unchanged' }
        }
        'caret_or_selection_change' {
            # We do not have per-tick caret sampling here; approximate with
            # text/value hash change or focus change. If nothing at all is
            # available, caller flips this to PRESS_EFFECT_UNVERIFIABLE.
            if ($post.focused_text_hash -ne $pre.focused_text_hash -or $post.focused_value_hash -ne $pre.focused_value_hash -or $post.focused_class -ne $pre.focused_class) {
                return @{ observed = $true; reason = 'caret_or_selection_moved' }
            }
            return @{ observed = $false; reason = 'no_caret_or_selection_evidence' }
        }
        'text_focus_or_window_change' {
            if ($post.foreground_window_handle -ne $pre.foreground_window_handle -or $post.focused_class -ne $pre.focused_class -or $post.focused_text_hash -ne $pre.focused_text_hash) {
                return @{ observed = $true; reason = 'text_focus_or_window_changed' }
            }
            return @{ observed = $false; reason = 'no_text_focus_or_window_change' }
        }
        'window_or_focus_change' {
            if ($post.foreground_window_handle -ne $pre.foreground_window_handle -or $post.focused_class -ne $pre.focused_class) {
                return @{ observed = $true; reason = 'window_or_focus_changed' }
            }
            return @{ observed = $false; reason = 'no_window_or_focus_change' }
        }
        default { return @{ observed = $false; reason = "unknown_semantic:$semantic" } }
    }
}

function Tool-Press($a) {
    $key = ([string]$a.key).ToLowerInvariant()
    if (-not $script:NamedVk.ContainsKey($key)) {
        return @{ ok = $false; error_code = 'KEY_UNKNOWN'; error_message = "unknown named key: $key" }
    }
    $vk = [uint16]$script:NamedVk[$key]
    $presses = if ($a.presses) { [int]$a.presses } else { 1 }
    if ($presses -lt 1) { $presses = 1 } elseif ($presses -gt 10) { $presses = 10 }
    $requireVerified = $true
    if ($a.PSObject.Properties['require_verified'] -and $null -ne $a.require_verified) {
        $requireVerified = [bool]$a.require_verified
    }
    $classifier = Resolve-PressVerification $key
    $kind      = $classifier.kind
    $semantic  = $classifier.semantic
    $mustVerify = ([bool]$classifier.requires) -and $requireVerified

    $predicate = {
        param($pre, $post)
        return Test-PressObserved $pre $post $semantic
    }.GetNewClosure()

    $action = {
        for ($i = 0; $i -lt $presses; $i++) {
            Send-VkDownUp $vk
            Start-Sleep -Milliseconds 30
        }
    }.GetNewClosure()

    $vr = Invoke-VerifiedAction -Action $action -Predicate $predicate -Kind $kind
    $errorCode = $null
    if ($mustVerify -and -not $vr.verified) {
        # If pre/post lacked evidence to judge the semantic at all, flag as
        # unverifiable instead of no-effect.
        $noEvidence = (
            $null -eq $vr.pre.focused_class -and $null -eq $vr.post.focused_class -and
            $null -eq $vr.pre.focused_text_hash -and $null -eq $vr.post.focused_text_hash
        )
        $errorCode = if ($noEvidence -or $semantic -eq 'caret_or_selection_change' -and $vr.failure_reason -match 'no_caret_or_selection_evidence') { 'PRESS_EFFECT_UNVERIFIABLE' } else { 'PRESS_NO_OBSERVABLE_EFFECT' }
    }
    $diag = @{
        key                     = $key
        presses                 = $presses
        require_verified        = $requireVerified
        verified                = $vr.verified
        verification_kind       = $vr.verification_kind
        verification_attempts   = $vr.verification_attempts
        verification_elapsed_ms = $vr.verification_elapsed_ms
        pre                     = $vr.pre
        post                    = $vr.post
        target_still_foreground = $vr.target_still_foreground
        effect_observed         = $vr.effect_observed
        failure_reason          = $vr.failure_reason
        success_reason          = if ($vr.verified) { $vr.failure_reason } else { $null }
        error_code              = $errorCode
        action_error            = $vr.action_error
    }
    if ($mustVerify -and -not $vr.verified) {
        return @{ ok = $false; error_code = $errorCode; error_message = "Press '$key' unverified: $($vr.failure_reason)"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}


function Tool-Hotkey($a) {
    # 0.4.20 Action Verification Engine: known chords are classified into a
    # verification kind (clipboard change, focused-text change, foreground
    # change). If the classified predicate does not fire, we return
    # HOTKEY_NO_EFFECT (or CLIPBOARD_UNCHANGED_AFTER_COPY for Ctrl+C/X).
    # Unknown chords fall back to verification_kind='input_only' which is
    # ok=true but verified=false — callers MUST NOT treat input_only as
    # a real effect.
    $mods = @()
    $modNames = @()
    foreach ($m in @($a.modifiers)) {
        $mk = ([string]$m).ToLowerInvariant()
        if (-not $script:ModVk.ContainsKey($mk)) {
            return @{ ok = $false; error_code = 'MODIFIER_UNKNOWN'; error_message = "unknown modifier: $mk" }
        }
        $mods += [uint16]$script:ModVk[$mk]
        $modNames += $mk
    }
    $key = ([string]$a.key)
    $vk = $null
    $lk = $key.ToLowerInvariant()
    if ($script:NamedVk.ContainsKey($lk)) {
        $vk = [uint16]$script:NamedVk[$lk]
    } elseif ($key.Length -eq 1) {
        $vk = [uint16]([SI]::VkKeyScan([char]$key) -band 0xff)
    } else {
        return @{ ok = $false; error_code = 'KEY_UNKNOWN'; error_message = "unknown key: $key" }
    }
    $requireVerified = $true
    if ($a.PSObject.Properties['require_verified'] -and $null -ne $a.require_verified) {
        $requireVerified = [bool]$a.require_verified
    }
    $classifier = Resolve-HotkeyVerification $modNames $key
    $kind = $classifier.kind
    $mustVerify = ([bool]$classifier.requires) -and $requireVerified
    $predicate = New-VerificationPredicate $kind

    $action = {
        foreach ($mv in $mods) { Send-VkDownUp $mv -KeyDownOnly }
        Send-VkDownUp $vk
        for ($i = $mods.Count - 1; $i -ge 0; $i--) { Send-VkDownUp $mods[$i] -KeyUpOnly }
    }.GetNewClosure()

    $vr = Invoke-VerifiedAction -Action $action -Predicate $predicate -Kind $kind
    $diag = @{
        modifiers               = $a.modifiers
        key                     = $key
        require_verified        = $requireVerified
        verified                = $vr.verified
        verification_kind       = $vr.verification_kind
        verification_attempts   = $vr.verification_attempts
        verification_elapsed_ms = $vr.verification_elapsed_ms
        pre                     = $vr.pre
        post                    = $vr.post
        target_still_foreground = $vr.target_still_foreground
        effect_observed         = $vr.effect_observed
        failure_reason          = $vr.failure_reason
        action_error            = $vr.action_error
        clipboard_seq_before    = $vr.pre.clipboard_sequence
        clipboard_seq_after     = $vr.post.clipboard_sequence
        clipboard_changed       = ($vr.pre.clipboard_sequence -ne $vr.post.clipboard_sequence)
        expected_target_still_foreground = $vr.target_still_foreground
    }
    if ($mustVerify -and -not $vr.verified) {
        $errCode = 'HOTKEY_NO_EFFECT'
        $foregroundStolen = ($vr.pre.foreground_window_handle -ne $vr.post.foreground_window_handle)
        if ($kind -eq 'clipboard_change') { $errCode = 'CLIPBOARD_UNCHANGED_AFTER_COPY' }
        elseif ($kind -eq 'selection_change' -and $vr.failure_reason -match 'no_selection_evidence') { $errCode = 'HOTKEY_EFFECT_UNVERIFIABLE' }
        elseif ($kind -eq 'focused_text_change' -and $foregroundStolen) { $errCode = 'FOCUS_TARGET_LOST' }
        elseif ($kind -eq 'input_only') { $errCode = 'HOTKEY_EFFECT_UNVERIFIABLE' }
        $chord = ($modNames -join '+') + '+' + $key
        $diag.error_code = $errCode
        return @{ ok = $false; error_code = $errCode; error_message = "Chord '$chord' delivered but predicate '$kind' saw no change within 1600ms poll ladder"; result = $diag; evidence = $diag }
    }

    return @{ ok = $true; result = $diag; evidence = $diag }
}

function Tool-Scroll($a) {
    # MOUSEEVENTF_WHEEL=0x0800, MOUSEEVENTF_HWHEEL=0x1000. mouseData carries
    # signed multiples of WHEEL_DELTA (120).
    $x = [int]$a.x; $y = [int]$a.y
    $dy = [int]($a.delta_y | ForEach-Object { $_ }); if (-not $dy) { $dy = 0 }
    $dx = [int]($a.delta_x | ForEach-Object { $_ }); if (-not $dx) { $dx = 0 }
    [void][SI]::SetCursorPos($x, $y)
    if ($dy -ne 0) {
        $inp = New-Object 'SI+INPUT[]' 1
        $inp[0].type = 0
        $inp[0].u.mi.dx = $x; $inp[0].u.mi.dy = $y
        $inp[0].u.mi.mouseData = [uint32]([int32]$dy)
        $inp[0].u.mi.dwFlags = 0x0800
        [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
    }
    if ($dx -ne 0) {
        $inp2 = New-Object 'SI+INPUT[]' 1
        $inp2[0].type = 0
        $inp2[0].u.mi.dx = $x; $inp2[0].u.mi.dy = $y
        $inp2[0].u.mi.mouseData = [uint32]([int32]$dx)
        $inp2[0].u.mi.dwFlags = 0x1000
        [void][SI]::SendInput(1, $inp2, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
    }
    return @{ ok = $true; result = @{ x = $x; y = $y; delta_y = $dy; delta_x = $dx } }
}

function Tool-Drag($a) {
    # 0.4.20 Action Verification Engine: title-bar / resize drags MUST prove
    # the target window actually moved or resized. We identify the top-level
    # window under the from point via WindowFromPoint + GetAncestor(GA_ROOT),
    # capture GetWindowRect BEFORE performing the drag, then let the engine
    # poll for a bounds change. No change with require_verified => DRAG_NO_EFFECT.
    $btn = if ($a.button) { [string]$a.button } else { 'left' }
    $down = switch ($btn) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up   = switch ($btn) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    $duration = if ($a.duration_ms) { [int]$a.duration_ms } else { 200 }
    if ($duration -lt 0) { $duration = 0 } elseif ($duration -gt 5000) { $duration = 5000 }
    $requireVerified = $true
    if ($a.PSObject.Properties['require_verified'] -and $null -ne $a.require_verified) {
        $requireVerified = [bool]$a.require_verified
    }
    $fx = [int]$a.from_x; $fy = [int]$a.from_y
    $tx = [int]$a.to_x;   $ty = [int]$a.to_y

    $pt = New-Object 'SI+POINT'
    $pt.X = $fx; $pt.Y = $fy
    $target = [IntPtr]::Zero
    try { $target = [SI]::WindowFromPoint($pt) } catch {}
    if ($target -ne [IntPtr]::Zero) {
        try { $target = [SI]::GetAncestor($target, [uint32]2) } catch {}  # GA_ROOT = 2
    }
    $rectBefore = Get-WindowRect $target

    $predicate = {
        param($pre, $post)
        $after = Get-WindowRect $target
        if ($null -eq $rectBefore -or $null -eq $after) {
            return @{ observed = $false; reason = 'no_target_rect' }
        }
        if ($after.L -ne $rectBefore.L -or $after.T -ne $rectBefore.T) {
            return @{ observed = $true; reason = 'target_window_moved' }
        }
        if ($after.W -ne $rectBefore.W -or $after.H -ne $rectBefore.H) {
            return @{ observed = $true; reason = 'target_window_resized' }
        }
        return @{ observed = $false; reason = 'target_rect_unchanged' }
    }.GetNewClosure()

    $action = {
        Send-MouseAt $fx $fy $down
        $steps = [Math]::Max(2, [Math]::Min(30, [Math]::Ceiling($duration / 20.0)))
        for ($i = 1; $i -le $steps; $i++) {
            $t = $i / $steps
            $x = [int]([Math]::Round($fx + ($tx - $fx) * $t))
            $y = [int]([Math]::Round($fy + ($ty - $fy) * $t))
            [void][SI]::SetCursorPos($x, $y)
            $inp = New-Object 'SI+INPUT[]' 1
            $inp[0].type = 0
            $inp[0].u.mi.dx = $x; $inp[0].u.mi.dy = $y
            $inp[0].u.mi.dwFlags = 0x0001
            [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
            if ($duration -gt 0) { Start-Sleep -Milliseconds ([int]($duration / $steps)) }
        }
        Send-MouseAt $tx $ty $up
    }.GetNewClosure()

    $vr = Invoke-VerifiedAction -Action $action -Predicate $predicate -Kind 'window_bounds_change'
    $rectAfter = Get-WindowRect $target
    $diag = @{
        from = @{ x = $fx; y = $fy }; to = @{ x = $tx; y = $ty }
        button = $btn; duration_ms = $duration
        require_verified        = $requireVerified
        target_window_handle    = "$($target.ToInt64())"
        target_rect_before      = $rectBefore
        target_rect_after       = $rectAfter
        verified                = $vr.verified
        verification_kind       = $vr.verification_kind
        verification_attempts   = $vr.verification_attempts
        verification_elapsed_ms = $vr.verification_elapsed_ms
        pre                     = $vr.pre
        post                    = $vr.post
        target_still_foreground = $vr.target_still_foreground
        effect_observed         = $vr.effect_observed
        failure_reason          = $vr.failure_reason
        action_error            = $vr.action_error
    }
    if ($requireVerified -and -not $vr.verified) {
        return @{ ok = $false; error_code = 'DRAG_NO_EFFECT'; error_message = "Drag from ($fx,$fy) to ($tx,$ty) completed but target window bounds did not change within 1600ms poll ladder"; result = $diag; evidence = $diag }
    }
    return @{ ok = $true; result = $diag; evidence = $diag }
}

function Tool-Inspect($a) {
    # Try UIA first; fall back to Win32 metrics (foreground window bounds).
    # P0-R6 (0.4.4): honor `max_depth` from the schema — bounded descent that
    # collects up to 3 direct/nested children so callers can see the local
    # subtree. Echoing `max_depth` also proves the parameter is actually bound
    # (the 0.4.3 `$args` shadowing regression would have surfaced $null here).
    $x = if ($a.PSObject.Properties['x']) { [int]$a.x } else { $null }
    $y = if ($a.PSObject.Properties['y']) { [int]$a.y } else { $null }
    $hnd = if ($a.window_handle) { [string]$a.window_handle } else { $null }
    $maxDepth = if ($a.PSObject.Properties['max_depth'] -and $a.max_depth) { [int]$a.max_depth } else { 4 }
    if ($maxDepth -lt 1) { $maxDepth = 1 } elseif ($maxDepth -gt 8) { $maxDepth = 8 }
    try {
        $auto = [System.Windows.Automation.AutomationElement]
        $el = $null
        if ($x -ne $null -and $y -ne $null) {
            $pt = New-Object System.Windows.Point $x, $y
            $el = $auto::FromPoint($pt)
        } elseif ($hnd) {
            $el = $auto::FromHandle([IntPtr]::new([int64]$hnd))
        } else {
            $el = $auto::FocusedElement
        }
        if ($null -ne $el) {
            $current = $el.Current
            $rect = $current.BoundingRectangle
            # Bounded child descent — cap total collected nodes to keep the
            # response small regardless of max_depth.
            $children = @()
            try {
                $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $stack = New-Object System.Collections.Stack
                $child = $walker.GetFirstChild($el)
                while ($null -ne $child -and $children.Count -lt 3) {
                    $cc = $child.Current
                    $children += @{ name = $cc.Name; control_type = $cc.ControlType.ProgrammaticName }
                    $child = $walker.GetNextSibling($child)
                }
            } catch { Log "[inspect] child walk failed: $($_.Exception.Message)" }
            # 0.4.15: For Document/Edit control types, extract the actual
            # readable text via TextPattern.DocumentRange.GetText(-1) and/or
            # ValuePattern.Current.Value. Direct tool result carries the
            # plaintext (this IS the caller's requested read); the event log
            # is redacted to length + sha256 by redactDesktopResult.
            $ctrlType = $current.ControlType.ProgrammaticName
            $isDocOrEdit = ($ctrlType -match '\.Document$' -or $ctrlType -match '\.Edit$')
            $textVal = $null; $valueVal = $null
            if ($isDocOrEdit) {
                try {
                    $tpId = [System.Windows.Automation.TextPattern]::Pattern
                    $tp = $null
                    if ($el.TryGetCurrentPattern($tpId, [ref]$tp)) {
                        $textVal = $tp.DocumentRange.GetText(-1)
                    }
                } catch { Log "[inspect] TextPattern read failed: $($_.Exception.Message)" }
                try {
                    $vpId = [System.Windows.Automation.ValuePattern]::Pattern
                    $vp = $null
                    if ($el.TryGetCurrentPattern($vpId, [ref]$vp)) {
                        $valueVal = $vp.Current.Value
                    }
                } catch { Log "[inspect] ValuePattern read failed: $($_.Exception.Message)" }
            }
            return @{
                ok = $true; result = @{
                    source = 'uia'
                    name = $current.Name
                    control_type = $ctrlType
                    class_name = $current.ClassName
                    is_enabled = $current.IsEnabled
                    is_offscreen = $current.IsOffscreen
                    bounds = @{ x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height }
                    max_depth = $maxDepth
                    children = $children
                    is_document_or_edit = $isDocOrEdit
                    text = $textVal
                    value = $valueVal
                    text_length = if ($textVal)  { $textVal.Length }  else { 0 }
                    value_length = if ($valueVal) { $valueVal.Length } else { 0 }
                }
            }
        }
    } catch {
        Log "[inspect] uia failed: $($_.Exception.Message)"
    }
    # Win32 fallback: foreground window metrics.
    $fg = [SI]::GetForegroundWindow()
    $r = New-Object SI+RECT
    [void][SI]::GetWindowRect($fg, [ref]$r)
    $sb = New-Object System.Text.StringBuilder 256
    [void][SI]::GetWindowText($fg, $sb, 256)
    return @{
        ok = $true; result = @{
            source = 'win32'
            name = $sb.ToString()
            window_handle = "$($fg.ToInt64())"
            bounds = @{ x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T) }
            max_depth = $maxDepth
        }
    }
}



function Write-SessionDoc($doc) {
    # BOM-less UTF-8 is required: helper/src/desktop.mjs does JSON.parse(readFile(...,"utf8"))
    # and JSON.parse rejects a leading BOM. Set-Content -Encoding UTF8 (WinPS 5.1) emits a BOM.
    # Write atomically via a UNIQUE same-directory temp file so:
    #   * heartbeat readers cannot observe a partial write
    #   * concurrent publishes cannot collide on a shared .tmp name
    # Guarantee cleanup of BOTH the staging temp AND the backup replaced by
    # File.Replace in a finally block if either survived the publish.
    #
    # WinPS 5.1 / .NET Framework: `File.Replace($tmp, $sessionFile, $null)`
    # throws "The given path's format is not supported." because the null
    # backup arg is coerced to an invalid path. Provide a REAL same-directory
    # backup path and delete it in finally. Never accept $null here.
    $stamp = $PID.ToString() + "." + ([guid]::NewGuid().ToString('N'))
    $tmp    = Join-Path $sentinelDir ("desktop-session." + $stamp + ".tmp")
    $backup = Join-Path $sentinelDir ("desktop-session." + $stamp + ".bak")
    try {
        $json = ($doc | ConvertTo-Json)
        [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path $sessionFile) {
            # Non-null $backup keeps WinPS 5.1 happy AND lets us re-secure the
            # displaced document before removing it (fail-closed on ACL failure).
            [System.IO.File]::Replace($tmp, $sessionFile, $backup)
        } else {
            [System.IO.File]::Move($tmp, $sessionFile)
        }
        # Re-apply owner-only ACL on EVERY publish. File.Replace on WinPS 5.1
        # is not guaranteed to preserve the destination ACL (behaviour varies
        # by filesystem/OS build). Re-asserting the same rule the initial
        # publish set is cheap and idempotent, and never touches the bearer
        # secret (icacls only sees the file path).
        Set-OwnerOnlyAcl $sessionFile
    } finally {
        if (Test-Path $tmp) {
            try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch {}
        }
        if (Test-Path $backup) {
            # Backup briefly contains the previous session doc (bearer secret).
            # Re-assert owner-only ACL best-effort, then delete. If ACL fails
            # here we still delete the file so no residue survives on disk.
            try { & icacls $backup /inheritance:r /grant:r "${ownerPrincipal}:(F)" | Out-Null } catch {}
            try { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Invoke-FatalSessionInvalidate([string]$reason) {
    # Fail-closed: an ACL enforcement failure (or any other Write-SessionDoc
    # failure after a publish) means the published desktop-session.json may
    # be unreadable to the Helper OR readable to OTHER local users. Either
    # way we MUST stop advertising an ACTIVE session and stop serving
    # authenticated requests immediately.
    #
    # 1. Flip the abort flag so the main loop exits at its next check.
    # 2. Stop the HttpListener so no further authenticated request is served.
    # 3. Best-effort remove the published session file so no fresh caller
    #    can discover the bridge (readers get DESKTOP_SESSION_INACTIVE).
    #
    # We NEVER log the bearer secret or session file contents - only the
    # short reason string, which comes from icacls/system error text and
    # does not contain the secret.
    $script:AbortRequested = $true
    Log "[fatal] $reason - invalidating desktop session"
    try {
        if ($null -ne $script:http -and $script:http.IsListening) {
            $script:http.Stop()
        }
    } catch {}
    try {
        if (Test-Path $sessionFile) {
            Remove-Item -Force $sessionFile -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Bump-Activity() {
    $script:LastActivityAt = [DateTime]::UtcNow
    # Read/parse of the current session doc is best-effort (external races
    # with restart/repair are non-fatal). Re-publishing MUST fail closed so
    # a Set-OwnerOnlyAcl failure cannot leave the bridge ACTIVE with an
    # unreadable or over-permissive session file. NEVER swallow the ACL
    # exception with a bare `catch {}`.
    $doc = $null
    try {
        $doc = Get-Content $sessionFile -Raw | ConvertFrom-Json
        $ms = [int64](($script:LastActivityAt) - (Get-Date '1970-01-01').ToUniversalTime()).TotalMilliseconds
        $doc.last_activity_at = $ms
    } catch {
        return
    }
    try {
        Write-SessionDoc $doc
    } catch {
        Invoke-FatalSessionInvalidate "Bump-Activity: session republish failed: $($_.Exception.Message)"
    }
}

$script:LastActivityAt = [DateTime]::UtcNow

# Idempotency journal: composite key -> stored result (JSON on disk).
$journalDir = Join-Path $sentinelDir "desktop-journal-$sessionId"
function Journal-Key($body) {
    # P0-R5 0.4.1: journal identity uses TRUSTED orchestration envelope
    # (run_id + intent_id + orchestrator idempotency_key) PLUS the active
    # local session_id. Never derived from caller-supplied desktop tool
    # arguments, which two different runs can collide on (e.g. both use
    # "att1:seq1" and neither ever sets `session_id` / `idempotency_key`
    # inside `args`). Retrying the SAME intent replays; two different runs
    # execute independently.
    $env = $body.envelope
    $runId    = if ($env -and $env.run_id)          { [string]$env.run_id }          else { '' }
    $intentId = if ($env -and $env.intent_id)       { [string]$env.intent_id }       else { '' }
    $idem     = if ($env -and $env.idempotency_key) { [string]$env.idempotency_key } else { '' }
    $composite = "$sessionId|$runId|$intentId|$idem"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($composite)
    $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return -join ($sha | ForEach-Object { $_.ToString('x2') })
}

function Dispatch-Tool($body) {
    switch ($body.tool) {
        'desktop_wait'          { return Tool-Wait $body.args }
        'desktop_snapshot'      { return Tool-Snapshot $body.args }
        'desktop_list_windows'  { return Tool-ListWindows $body.args }
        'desktop_focus_window'  { return Tool-FocusWindow $body.args }
        'desktop_click'         { return Tool-Click $body.args }
        'desktop_type'          { return Tool-Type $body.args }
        'desktop_clipboard_get' { return Tool-ClipboardGet $body.args }
        'desktop_clipboard_set' { return Tool-ClipboardSet $body.args }
        'desktop_launch'        { return Tool-Launch $body.args }
        'desktop_press'         { return Tool-Press $body.args }
        'desktop_hotkey'        { return Tool-Hotkey $body.args }
        'desktop_scroll'        { return Tool-Scroll $body.args }
        'desktop_drag'          { return Tool-Drag $body.args }
        'desktop_inspect'       { return Tool-Inspect $body.args }
        default                 { return @{ ok = $false; error_code = 'TOOL_UNKNOWN'; error_message = "no impl for $($body.tool)" } }
    }
}

# ---------- HTTP listener lifecycle ----------
# A probe socket is used only to ask Windows for a candidate loopback port.
# It MUST be fully released before HttpListener attempts to bind that port.
$script:http = $null
$script:AbortRequested = $false
$probeListener = $null
$port = $null
$maxBindAttempts = 5

try {
    for ($bindAttempt = 1; $bindAttempt -le $maxBindAttempts; $bindAttempt++) {
        try {
            $probeListener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
            $probeListener.Start()
            $port = ([System.Net.IPEndPoint]$probeListener.LocalEndpoint).Port
        } finally {
            if ($null -ne $probeListener) {
                try { $probeListener.Stop() } catch {}
                try { $probeListener.Server.Dispose() } catch {}
                $probeListener = $null
            }
        }

        try {
            $script:http = New-Object System.Net.HttpListener
            $script:http.Prefixes.Add("http://127.0.0.1:$port/")
            $script:http.Start()
            break
        } catch {
            $bindError = $_
            if ($null -ne $script:http) {
                try { $script:http.Stop() } catch {}
                try { $script:http.Close() } catch {}
                $script:http = $null
            }
            if ($bindAttempt -ge $maxBindAttempts) { throw $bindError }
            Start-Sleep -Milliseconds (100 * $bindAttempt)
        }
    }

    if ($null -eq $script:http -or -not $script:http.IsListening) {
        throw "Desktop Operator could not bind a loopback HTTP listener after $maxBindAttempts attempts."
    }

    # ACTIVE state is published only after the authenticated HTTP bridge is listening.
    $now = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds
    $sessionDoc = [ordered]@{
        session_id       = $sessionId
        port             = $port
        secret           = $secret
        worker_id        = $workerId
        started_at       = $now
        last_activity_at = $now
        idle_ttl_ms      = ($IdleTtlSeconds * 1000)
        log_path         = $logPath
    }
    Write-SessionDoc $sessionDoc
    # Restrict to current user with FULL control (needs Delete/Modify to
    # remove/rewrite session file on restart) and REVOKE inherited ACEs so
    # other local users cannot read the bearer secret. (F) = Full Control =
    # Read + Write + Delete + Modify (fixes prior R/W-only Remove-Item denial).
    Set-OwnerOnlyAcl $sessionFile
    # PID file MUST be plain ASCII (no BOM) so cmd.exe `set /p` in
    # stop-desktop-operator.bat reads a clean numeric PID.
    [System.IO.File]::WriteAllText($pidFile, "$PID", [System.Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path $journalDir | Out-Null


    Log "[desktop-operator] listening on http://127.0.0.1:$port"
    Log "[desktop-operator] ACTIVE session=$sessionId port=$port ttl=${IdleTtlSeconds}s log=$logPath"
    Write-Host ""
    Write-Host "==================================================================="
    Write-Host " Sentinel OS Desktop Operator - ACTIVE"
    Write-Host "   session_id : $sessionId"
    Write-Host "   port       : 127.0.0.1:$port (loopback only)"
    Write-Host "   log        : $logPath"
    Write-Host "   idle TTL   : ${IdleTtlSeconds}s"
    Write-Host " Stop with:  helper\stop-desktop-operator.bat"
    Write-Host "==================================================================="
    Write-Host ""

    # P0-R5 0.4.1: only ONE pending GetContextAsync task at any time. Creating
    # a fresh task every 5-second idle-poll timeout leaked the previous task,
    # and a real request that arrived later could be consumed by an abandoned
    # task while the current task never completed -> DESKTOP_BRIDGE_TIMEOUT
    # after 20s. We keep the single task alive across polling intervals and
    # only null it out after successful completion.
    $ctxTask = $null
    while ($script:http.IsListening) {
        if ($script:AbortRequested) {
            Log "[desktop-operator] abort requested - exiting main loop."
            break
        }
        if (([DateTime]::UtcNow - $script:LastActivityAt).TotalSeconds -gt $IdleTtlSeconds) {
            Log "[desktop-operator] idle TTL exceeded - exiting."
            break
        }
        if ($null -eq $ctxTask) {
            $ctxTask = $script:http.GetContextAsync()
        }
        if (-not $ctxTask.Wait(5000)) { continue }
        $ctx = $ctxTask.Result
        $ctxTask = $null
        $req = $ctx.Request; $res = $ctx.Response
        $res.ContentType = 'application/json; charset=utf-8'
        $res.Headers['Cache-Control'] = 'no-store'

        $auth = $req.Headers['Authorization']
        if (-not $auth -or $auth -ne "Bearer $secret") {
            $res.StatusCode = 401
            $b = ([System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error_code":"UNAUTHORIZED"}'))
            $res.OutputStream.Write($b, 0, $b.Length); $res.Close(); continue
        }
        if ($req.RemoteEndPoint.Address.ToString() -notin @('127.0.0.1', '::1')) {
            $res.StatusCode = 403
            $b = ([System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error_code":"LOOPBACK_ONLY"}'))
            $res.OutputStream.Write($b, 0, $b.Length); $res.Close(); continue
        }

        try {
            $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
            $bodyText = $reader.ReadToEnd()
            $body = $bodyText | ConvertFrom-Json

            $jkey = Journal-Key $body
            $jfile = Join-Path $journalDir "$jkey.json"
            if (Test-Path $jfile) {
                $prev = Get-Content $jfile -Raw
                $b = [System.Text.Encoding]::UTF8.GetBytes($prev)
                $res.StatusCode = 200
                $res.OutputStream.Write($b, 0, $b.Length); $res.Close(); continue
            }

            $result = Dispatch-Tool $body
            $payload = $result | ConvertTo-Json -Depth 10 -Compress
            Set-Content -Path $jfile -Value $payload -Encoding UTF8
            $b = [System.Text.Encoding]::UTF8.GetBytes($payload)
            $res.StatusCode = if ($result.ok) { 200 } else { 400 }
            $res.OutputStream.Write($b, 0, $b.Length); $res.Close()
            Bump-Activity
            Log "[tool] $($body.tool) ok=$($result.ok)"
        } catch {
            Log "[error] $($_.Exception.Message)"
            try {
                $err = @{ ok = $false; error_code = 'BRIDGE_EXCEPTION'; error_message = $_.Exception.Message } | ConvertTo-Json -Compress
                $b = [System.Text.Encoding]::UTF8.GetBytes($err)
                $res.StatusCode = 500
                $res.OutputStream.Write($b, 0, $b.Length); $res.Close()
            } catch {}
        }
    }
} finally {
    if ($null -ne $probeListener) {
        try { $probeListener.Stop() } catch {}
        try { $probeListener.Server.Dispose() } catch {}
        $probeListener = $null
    }
    if ($null -ne $script:http) {
        try { $script:http.Stop() } catch {}
        try { $script:http.Close() } catch {}
        $script:http = $null
    }
    if (Test-Path $sessionFile) { Remove-Item -Force $sessionFile }
    if (Test-Path $pidFile)     { Remove-Item -Force $pidFile }
    if (Test-Path $journalDir)  { Remove-Item -Recurse -Force $journalDir }
    Log "[desktop-operator] STOPPED"
}
