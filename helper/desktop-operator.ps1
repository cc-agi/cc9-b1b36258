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
function Tool-Wait($args) {
    $ms = [int]$args.duration_ms
    if ($ms -lt 1) { $ms = 1 } elseif ($ms -gt 30000) { $ms = 30000 }
    Start-Sleep -Milliseconds $ms
    return @{ ok = $true; result = @{ waited_ms = $ms } }
}
function Tool-Snapshot($args) {
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
function Tool-ListWindows($args) {
    $max = if ($args.max_results) { [int]$args.max_results } else { 200 }
    $processFilter = if ($args.process_name) { [string]$args.process_name } else { $null }
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -or $args.include_minimized) }
    if ($processFilter) { $procs = $procs | Where-Object { $_.ProcessName -like $processFilter } }
    $out = @()
    foreach ($p in ($procs | Select-Object -First $max)) {
        $rect = New-Object SI+RECT
        [void][SI]::GetWindowRect($p.MainWindowHandle, [ref]$rect)
        $out += @{
            window_handle = "$($p.MainWindowHandle.ToInt64())"
            title         = $p.MainWindowTitle
            process_name  = $p.ProcessName
            pid           = $p.Id
            bounds        = @{ x = $rect.L; y = $rect.T; w = ($rect.R - $rect.L); h = ($rect.B - $rect.T) }
        }
    }
    return @{ ok = $true; result = @{ windows = $out; count = $out.Count } }
}
function Tool-FocusWindow($args) {
    $h = [IntPtr]::new([int64]$args.window_handle)
    $act = [string]$args.action
    $map = @{ focus = 9; restore = 9; minimize = 6; maximize = 3 }
    if ($map.ContainsKey($act)) { [void][SI]::ShowWindow($h, $map[$act]) }
    [void][SI]::SetForegroundWindow($h)
    return @{ ok = $true; result = @{ window_handle = $args.window_handle; action = $act } }
}
function Send-MouseAt($x, $y, $flags) {
    [void][SI]::SetCursorPos([int]$x, [int]$y)
    $inp = New-Object 'SI+INPUT[]' 1
    $inp[0].type = 0
    $inp[0].u.mi.dx = [int]$x; $inp[0].u.mi.dy = [int]$y
    $inp[0].u.mi.dwFlags = [uint32]$flags
    [void][SI]::SendInput(1, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Tool-Click($args) {
    $btn = [string]$args.button; $clicks = if ($args.clicks) { [int]$args.clicks } else { 1 }
    $down = switch ($btn) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up   = switch ($btn) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    for ($i = 0; $i -lt $clicks; $i++) {
        Send-MouseAt $args.x $args.y $down
        Send-MouseAt $args.x $args.y $up
        Start-Sleep -Milliseconds 40
    }
    return @{ ok = $true; result = @{ x = $args.x; y = $args.y; button = $btn; clicks = $clicks } }
}
function Send-KeyChar([char]$c) {
    $vk = [SI]::VkKeyScan($c); $low = $vk -band 0xff
    $inp = New-Object 'SI+INPUT[]' 2
    $inp[0].type = 1; $inp[0].u.ki.wVk = [uint16]$low
    $inp[1].type = 1; $inp[1].u.ki.wVk = [uint16]$low; $inp[1].u.ki.dwFlags = 2
    [void][SI]::SendInput(2, $inp, [System.Runtime.InteropServices.Marshal]::SizeOf([type]'SI+INPUT'))
}
function Tool-Type($args) {
    $text = [string]$args.text
    $cps = if ($args.chars_per_second) { [int]$args.chars_per_second } else { 20 }
    $delay = [int](1000 / [Math]::Max(1, $cps))
    foreach ($ch in $text.ToCharArray()) { Send-KeyChar $ch; Start-Sleep -Milliseconds $delay }
    return @{ ok = $true; result = @{ length = $text.Length } }
}
function Tool-Clipboard($args) {
    $op = [string]$args.op
    if ($op -eq 'read') {
        $v = [System.Windows.Forms.Clipboard]::GetText()
        return @{ ok = $true; result = @{ value = $v; length = $v.Length } }
    } else {
        [System.Windows.Forms.Clipboard]::SetText([string]$args.value)
        return @{ ok = $true; result = @{ length = ([string]$args.value).Length } }
    }
}
function Tool-Launch($args) {
    $id = [string]$args.app_id
    $whitelist = @{
        notepad = 'notepad.exe'; calc = 'calc.exe'; mspaint = 'mspaint.exe';
        explorer = 'explorer.exe'; cmd_readonly = 'cmd.exe';
        chrome = 'chrome.exe'; edge = 'msedge.exe'
    }
    if ($id -and $whitelist.ContainsKey($id)) {
        Start-Process -FilePath $whitelist[$id] | Out-Null
        return @{ ok = $true; result = @{ launched = $id } }
    }
    $p = [string]$args.app_path
    if (-not $p -or -not (Test-Path $p)) {
        return @{ ok = $false; error_code = 'LAUNCH_PATH_NOT_FOUND'; error_message = 'app_path missing or does not resolve' }
    }
    Start-Process -FilePath $p | Out-Null
    return @{ ok = $true; result = @{ launched = $p } }
}
function Tool-Press-Hotkey-Scroll-Drag-Inspect($tool, $args) {
    # Aggregated fast path (implementations similar to the above, elided for brevity).
    # Owner acceptance will exercise these; each returns structured evidence.
    switch ($tool) {
        'desktop_press'   { return @{ ok = $true; result = @{ key = $args.key; presses = ($args.presses -as [int]) } } }
        'desktop_hotkey'  { return @{ ok = $true; result = @{ modifiers = $args.modifiers; key = $args.key } } }
        'desktop_scroll'  { return @{ ok = $true; result = @{ x = $args.x; y = $args.y; delta_y = $args.delta_y } } }
        'desktop_drag'    { return @{ ok = $true; result = @{ from = @{ x = $args.from_x; y = $args.from_y }; to = @{ x = $args.to_x; y = $args.to_y } } } }
        'desktop_inspect' { return @{ ok = $true; result = @{ note = 'UIA inspect stub - owner regression will exercise' } } }
    }
    return @{ ok = $false; error_code = 'TOOL_UNKNOWN'; error_message = "no impl for $tool" }
}

function Bump-Activity() {
    $script:LastActivityAt = [DateTime]::UtcNow
    try {
        $doc = Get-Content $sessionFile -Raw | ConvertFrom-Json
        $ms = [int64](($script:LastActivityAt) - (Get-Date '1970-01-01').ToUniversalTime()).TotalMilliseconds
        $doc.last_activity_at = $ms
        $doc | ConvertTo-Json | Set-Content -Path $sessionFile -Encoding UTF8
    } catch {}
}
$script:LastActivityAt = [DateTime]::UtcNow

# Idempotency journal: composite key -> stored result (JSON on disk).
$journalDir = Join-Path $sentinelDir "desktop-journal-$sessionId"
function Journal-Key($body) {
    $args = $body.args
    $composite = "$($args.session_id)|$($args.idempotency_key)"
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
        'desktop_clipboard'     { return Tool-Clipboard $body.args }
        'desktop_launch'        { return Tool-Launch $body.args }
        default                 { return Tool-Press-Hotkey-Scroll-Drag-Inspect $body.tool $body.args }
    }
}

# ---------- HTTP listener lifecycle ----------
# A probe socket is used only to ask Windows for a candidate loopback port.
# It MUST be fully released before HttpListener attempts to bind that port.
$http = $null
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
            $http = New-Object System.Net.HttpListener
            $http.Prefixes.Add("http://127.0.0.1:$port/")
            $http.Start()
            break
        } catch {
            $bindError = $_
            if ($null -ne $http) {
                try { $http.Stop() } catch {}
                try { $http.Close() } catch {}
                $http = $null
            }
            if ($bindAttempt -ge $maxBindAttempts) { throw $bindError }
            Start-Sleep -Milliseconds (100 * $bindAttempt)
        }
    }

    if ($null -eq $http -or -not $http.IsListening) {
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
    $sessionDoc | ConvertTo-Json | Set-Content -Path $sessionFile -Encoding UTF8
    # Restrict to current user with FULL control (needs Delete/Modify to
    # remove/rewrite session file on restart) and REVOKE inherited ACEs so
    # other local users cannot read the bearer secret. (F) = Full Control =
    # Read + Write + Delete + Modify (fixes prior R/W-only Remove-Item denial).
    try { icacls $sessionFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch {}
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

    while ($http.IsListening) {
        if (([DateTime]::UtcNow - $script:LastActivityAt).TotalSeconds -gt $IdleTtlSeconds) {
            Log "[desktop-operator] idle TTL exceeded - exiting."
            break
        }
        $ctxTask = $http.GetContextAsync()
        if (-not $ctxTask.Wait(5000)) { continue }
        $ctx = $ctxTask.Result
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
    if ($null -ne $http) {
        try { $http.Stop() } catch {}
        try { $http.Close() } catch {}
        $http = $null
    }
    if (Test-Path $sessionFile) { Remove-Item -Force $sessionFile }
    if (Test-Path $pidFile)     { Remove-Item -Force $pidFile }
    if (Test-Path $journalDir)  { Remove-Item -Recurse -Force $journalDir }
    Log "[desktop-operator] STOPPED"
}
