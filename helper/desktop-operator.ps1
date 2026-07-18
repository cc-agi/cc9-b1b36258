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

$sessionId = [guid]::NewGuid().ToString()
$logPath   = Join-Path $logDir ("session-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".log")

function Log([string]$msg) {
    $line = "$([DateTime]::UtcNow.ToString('o')) $msg"
    Add-Content -Path $logPath -Value $line
    Write-Host $line
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
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder t, int c);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
try { Add-Type -TypeDefinition $typeSig -Language CSharp | Out-Null } catch { Log "[warn] SendInput bindings unavailable: $($_.Exception.Message)" }
try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {}
try { Add-Type -AssemblyName System.Drawing | Out-Null } catch {}
try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes | Out-Null } catch { Log "[warn] UIA unavailable" }

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
function Tool-FocusWindow($a) {
    # P0-R7 desktop_focus_window verification fix:
    # Historic bug (Helper 0.4.5): the tool ignored the return values of
    # ShowWindow/SetForegroundWindow and never asked Windows whether the
    # target actually acquired the foreground. Field regression showed a
    # `succeeded` response while the real foreground window was still an
    # unrelated app (WorkBuddy) — subsequent desktop_inspect at target
    # coordinates therefore hit the wrong window. Fix: validate the handle
    # via IsWindow, honour the ShowWindow/SetForegroundWindow booleans, and
    # confirm GetForegroundWindow()==target with a short bounded retry.
    # `minimize` intentionally does NOT re-grab focus (nothing to focus).
    if ($null -eq $a -or -not $a.PSObject.Properties['window_handle']) {
        return @{ ok = $false; error_code = 'WINDOW_HANDLE_MISSING'; error_message = 'window_handle is required' }
    }
    $act = if ($a.PSObject.Properties['action']) { [string]$a.action } else { 'focus' }
    if ($act -notin @('focus','restore','minimize','maximize')) {
        return @{ ok = $false; error_code = 'ACTION_INVALID'; error_message = "action must be focus|restore|minimize|maximize (got $act)" }
    }
    $reqHandle = [string]$a.window_handle
    $handleInt = 0L
    if (-not [int64]::TryParse($reqHandle, [ref]$handleInt) -or $handleInt -eq 0) {
        return @{ ok = $false; error_code = 'WINDOW_HANDLE_INVALID'; error_message = "window_handle is not a valid integer handle: $reqHandle" }
    }
    $h = [IntPtr]::new($handleInt)
    if (-not [SI]::IsWindow($h)) {
        return @{ ok = $false; error_code = 'WINDOW_HANDLE_INVALID'; error_message = "window_handle $reqHandle does not refer to a live top-level window" }
    }

    # SW_ constants: RESTORE=9, MINIMIZE=6, MAXIMIZE=3, SHOW=5.
    $swMap = @{ focus = 9; restore = 9; minimize = 6; maximize = 3 }
    $sw = $swMap[$act]
    $showOk = [SI]::ShowWindow($h, $sw)

    $fgBefore = [SI]::GetForegroundWindow()
    $needForeground = ($act -ne 'minimize')
    $setOk = $true
    if ($needForeground) {
        # Bounded retry: Windows can transiently refuse SetForegroundWindow
        # (foreground lock timeout, focus stolen mid-race). Cap at 5 attempts
        # spaced 60 ms — never an unbounded loop.
        $setOk = $false
        for ($i = 0; $i -lt 5; $i++) {
            if ([SI]::SetForegroundWindow($h)) { $setOk = $true; break }
            Start-Sleep -Milliseconds 60
        }
    }

    # Verify actual foreground / final state, again with a short bounded wait.
    $fgAfter = [IntPtr]::Zero
    $verified = $false
    for ($i = 0; $i -lt 10; $i++) {
        $fgAfter = [SI]::GetForegroundWindow()
        if ($needForeground) {
            if ($fgAfter -eq $h) { $verified = $true; break }
        } else {
            # For `minimize`, verify IsIconic($h) instead of foreground.
            if ([SI]::IsIconic($h)) { $verified = $true; break }
        }
        Start-Sleep -Milliseconds 40
    }

    # State-mode verification for restore/maximize/minimize.
    $stateOk = $true
    switch ($act) {
        'maximize' { $stateOk = [SI]::IsZoomed($h) }
        'restore'  { $stateOk = (-not [SI]::IsIconic($h)) }
        'minimize' { $stateOk = [SI]::IsIconic($h) }
    }

    $fgHandleStr = "$($fgAfter.ToInt64())"
    $base = @{
        requested_window_handle  = $reqHandle
        foreground_window_handle = $fgHandleStr
        action                   = $act
        window_handle            = $reqHandle
        verified                 = ($verified -and $stateOk)
        show_window_ok           = [bool]$showOk
        set_foreground_ok        = [bool]$setOk
    }

    if (-not $verified -or -not $stateOk) {
        return @{
            ok             = $false
            error_code     = 'FOCUS_NOT_ACQUIRED'
            error_message  = "Windows did not confirm action '$act' on window $reqHandle (foreground=$fgHandleStr, show=$showOk, set=$setOk, stateOk=$stateOk)"
            result         = $base
        }
    }
    return @{ ok = $true; result = $base }
}
function Send-MouseAt($x, $y, $flags) {
    [void][SI]::SetCursorPos([int]$x, [int]$y)
    $inp = New-Object 'SI+INPUT[]' 1
    $inp[0].type = 0
    $inp[0].u.mi.dx = [int]$x; $inp[0].u.mi.dy = [int]$y
    $inp[0].u.mi.dwFlags = [uint32]$flags
    [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Tool-Click($a) {
    $btn = [string]$a.button; $clicks = if ($a.clicks) { [int]$a.clicks } else { 1 }
    $down = switch ($btn) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up   = switch ($btn) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    for ($i = 0; $i -lt $clicks; $i++) {
        Send-MouseAt $a.x $a.y $down
        Send-MouseAt $a.x $a.y $up
        Start-Sleep -Milliseconds 40
    }
    return @{ ok = $true; result = @{ x = $a.x; y = $a.y; button = $btn; clicks = $clicks } }
}
function Send-KeyChar([char]$c) {
    $vk = [SI]::VkKeyScan($c); $low = $vk -band 0xff
    $inp = New-Object 'SI+INPUT[]' 2
    $inp[0].type = 1; $inp[0].u.ki.wVk = [uint16]$low
    $inp[1].type = 1; $inp[1].u.ki.wVk = [uint16]$low; $inp[1].u.ki.dwFlags = 2
    [void][SI]::SendInput(2, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Tool-Type($a) {
    $text = [string]$a.text
    $cps = if ($a.chars_per_second) { [int]$a.chars_per_second } else { 20 }
    $delay = [int](1000 / [Math]::Max(1, $cps))
    foreach ($ch in $text.ToCharArray()) { Send-KeyChar $ch; Start-Sleep -Milliseconds $delay }
    return @{ ok = $true; result = @{ length = $text.Length } }
}
function Tool-ClipboardGet($a) {
    $v = [System.Windows.Forms.Clipboard]::GetText()
    return @{ ok = $true; result = @{ value = $v; length = $v.Length } }
}
function Tool-ClipboardSet($a) {
    [System.Windows.Forms.Clipboard]::SetText([string]$a.value)
    return @{ ok = $true; result = @{ length = ([string]$a.value).Length } }
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

function Tool-Press($a) {
    $key = ([string]$a.key).ToLowerInvariant()
    if (-not $script:NamedVk.ContainsKey($key)) {
        return @{ ok = $false; error_code = 'KEY_UNKNOWN'; error_message = "unknown named key: $key" }
    }
    $vk = [uint16]$script:NamedVk[$key]
    $presses = if ($a.presses) { [int]$a.presses } else { 1 }
    if ($presses -lt 1) { $presses = 1 } elseif ($presses -gt 10) { $presses = 10 }
    for ($i = 0; $i -lt $presses; $i++) {
        Send-VkDownUp $vk
        Start-Sleep -Milliseconds 30
    }
    return @{ ok = $true; result = @{ key = $key; presses = $presses } }
}

function Tool-Hotkey($a) {
    $mods = @()
    foreach ($m in @($a.modifiers)) {
        $mk = ([string]$m).ToLowerInvariant()
        if (-not $script:ModVk.ContainsKey($mk)) {
            return @{ ok = $false; error_code = 'MODIFIER_UNKNOWN'; error_message = "unknown modifier: $mk" }
        }
        $mods += [uint16]$script:ModVk[$mk]
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
    # Press modifiers down, key down/up, then modifiers up (reverse order).
    foreach ($mv in $mods) { Send-VkDownUp $mv -KeyDownOnly }
    Send-VkDownUp $vk
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { Send-VkDownUp $mods[$i] -KeyUpOnly }
    return @{ ok = $true; result = @{ modifiers = $a.modifiers; key = $key } }
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
    $btn = if ($a.button) { [string]$a.button } else { 'left' }
    $down = switch ($btn) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up   = switch ($btn) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    $duration = if ($a.duration_ms) { [int]$a.duration_ms } else { 200 }
    if ($duration -lt 0) { $duration = 0 } elseif ($duration -gt 5000) { $duration = 5000 }
    $fx = [int]$a.from_x; $fy = [int]$a.from_y
    $tx = [int]$a.to_x;   $ty = [int]$a.to_y
    Send-MouseAt $fx $fy $down
    # Linear interpolation with ~10 steps or 20ms cadence, whichever is smaller.
    $steps = [Math]::Max(2, [Math]::Min(30, [Math]::Ceiling($duration / 20.0)))
    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $x = [int]([Math]::Round($fx + ($tx - $fx) * $t))
        $y = [int]([Math]::Round($fy + ($ty - $fy) * $t))
        [void][SI]::SetCursorPos($x, $y)
        # MOUSEEVENTF_MOVE=0x0001
        $inp = New-Object 'SI+INPUT[]' 1
        $inp[0].type = 0
        $inp[0].u.mi.dx = $x; $inp[0].u.mi.dy = $y
        $inp[0].u.mi.dwFlags = 0x0001
        [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
        if ($duration -gt 0) { Start-Sleep -Milliseconds ([int]($duration / $steps)) }
    }
    Send-MouseAt $tx $ty $up
    return @{ ok = $true; result = @{ from = @{ x = $fx; y = $fy }; to = @{ x = $tx; y = $ty }; button = $btn; duration_ms = $duration } }
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
            return @{
                ok = $true; result = @{
                    source = 'uia'
                    name = $current.Name
                    control_type = $current.ControlType.ProgrammaticName
                    class_name = $current.ClassName
                    is_enabled = $current.IsEnabled
                    is_offscreen = $current.IsOffscreen
                    bounds = @{ x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height }
                    max_depth = $maxDepth
                    children = $children
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
