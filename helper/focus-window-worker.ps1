# Sentinel OS - isolated desktop_focus_window execution worker (P0-R9).
# ASCII-only source, CRLF-enforced via .gitattributes.
#
# Every invocation performs exactly one bounded focus stage in a disposable
# PowerShell process. The parent Desktop Operator enforces the wall-clock
# timeout and terminates this process if a user32 call never returns.

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('prepare','direct','alt_tap','attached_focus','switch_window','verify')]
    [string]$Stage,
    [Parameter(Mandatory=$true)][string]$RequestPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$CheckpointPath
)

$ErrorActionPreference = 'Stop'
# The parent starts this worker with CreateNoWindow=true. Do not touch the
# inherited console: a legacy conhost in QuickEdit/Mark mode can block console
# APIs indefinitely. All worker communication uses explicit UTF-8 files.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Checkpoint([string]$phase, $details) {
    $doc = [ordered]@{
        tool          = 'desktop_focus_window'
        stage         = $Stage
        phase         = $phase
        execution_pid = $PID
        timestamp_utc = [DateTime]::UtcNow.ToString('o')
    }
    if ($null -ne $script:Request -and $script:Request.window_handle) {
        $doc.requested_window_handle = [string]$script:Request.window_handle
    }
    if ($null -ne $details) {
        foreach ($p in $details.PSObject.Properties) { $doc[$p.Name] = $p.Value }
    }
    [System.IO.File]::WriteAllText(
        $CheckpointPath,
        ($doc | ConvertTo-Json -Depth 8 -Compress),
        $utf8NoBom
    )
}

function Write-Result($value) {
    [System.IO.File]::WriteAllText(
        $OutputPath,
        ($value | ConvertTo-Json -Depth 10 -Compress),
        $utf8NoBom
    )
}

$native = @"
using System;
using System.Runtime.InteropServices;
public static class FocusNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool AllowSetForegroundWindow(uint processId);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);
}
"@

try {
    $script:Request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
    Add-Type -TypeDefinition $native -Language CSharp | Out-Null

    $handleValue = 0L
    if (-not [int64]::TryParse([string]$script:Request.window_handle, [ref]$handleValue) -or $handleValue -eq 0) {
        $bad = @{ ok=$false; error_code='WINDOW_HANDLE_INVALID'; error_message='window_handle is not a valid non-zero integer' }
        Write-Checkpoint 'rejected' ([pscustomobject]@{ error_code='WINDOW_HANDLE_INVALID' })
        Write-Result $bad
        exit 0
    }
    $h = [IntPtr]::new($handleValue)
    $action = [string]$script:Request.action
    $swMap = @{ focus=9; restore=9; minimize=6; maximize=3 }
    $sw = [int]$swMap[$action]

    switch ($Stage) {
        'prepare' {
            Write-Checkpoint 'before_is_window' $null
            $isWindow = [FocusNative]::IsWindow($h)
            Write-Checkpoint 'after_is_window' ([pscustomobject]@{ is_window=[bool]$isWindow })
            if (-not $isWindow) {
                Write-Result @{ ok=$false; error_code='WINDOW_HANDLE_INVALID'; error_message='window handle is not live'; result=@{ is_window=$false } }
                exit 0
            }
            $iconicBefore = [FocusNative]::IsIconic($h)
            $zoomedBefore = [FocusNative]::IsZoomed($h)
            if ($action -ne 'minimize' -and $iconicBefore) {
                Write-Checkpoint 'before_restore_iconic' $null
                $restoreOk = [FocusNative]::ShowWindow($h, 9)
                Write-Checkpoint 'after_restore_iconic' ([pscustomobject]@{ restore_iconic_ok=[bool]$restoreOk })
            }
            Write-Checkpoint 'before_show_window' ([pscustomobject]@{ show_command=$sw })
            $showOk = [FocusNative]::ShowWindow($h, $sw)
            Write-Checkpoint 'after_show_window' ([pscustomobject]@{ show_window_ok=[bool]$showOk })
            Start-Sleep -Milliseconds 40
            $iconicAfter = [FocusNative]::IsIconic($h)
            $zoomedAfter = [FocusNative]::IsZoomed($h)
            $stateOk = $true
            if ($action -eq 'minimize') { $stateOk = $iconicAfter }
            elseif ($action -eq 'maximize') { $stateOk = $zoomedAfter }
            elseif ($action -eq 'restore') { $stateOk = (-not $iconicAfter) }
            Write-Result @{ ok=$true; result=@{
                is_window=$true; is_iconic_before=[bool]$iconicBefore; is_zoomed_before=[bool]$zoomedBefore;
                is_iconic=[bool]$iconicAfter; is_zoomed=[bool]$zoomedAfter; show_window_ok=[bool]$showOk;
                state_ok=[bool]$stateOk
            } }
        }
        'direct' {
            Write-Checkpoint 'before_set_foreground_window' $null
            $setOk = [FocusNative]::SetForegroundWindow($h)
            $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Write-Checkpoint 'after_set_foreground_window' ([pscustomobject]@{ set_foreground_ok=[bool]$setOk; set_foreground_last_error=[int64]$lastError })
            Start-Sleep -Milliseconds 60
            $fg = [FocusNative]::GetForegroundWindow()
            Write-Result @{ ok=$true; result=@{
                acquired=($fg -eq $h); set_foreground_ok=[bool]$setOk;
                set_foreground_last_error=[int64]$lastError; foreground_window_handle="$($fg.ToInt64())"
            } }
        }
        'alt_tap' {
            Write-Checkpoint 'before_alt_key_down' $null
            [FocusNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
            Write-Checkpoint 'after_alt_key_down' $null
            Write-Checkpoint 'before_alt_key_up' $null
            [FocusNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
            Write-Checkpoint 'after_alt_key_up' $null
            Write-Result @{ ok=$true; result=@{ alt_tap_ok=$true } }
        }
        'attached_focus' {
            $fgBefore = [FocusNative]::GetForegroundWindow()
            $targetPid = [uint32]0
            $foregroundPid = [uint32]0
            $tidTarget = [FocusNative]::GetWindowThreadProcessId($h, [ref]$targetPid)
            $tidCurrent = [FocusNative]::GetCurrentThreadId()
            $tidForeground = if ($fgBefore -ne [IntPtr]::Zero) { [FocusNative]::GetWindowThreadProcessId($fgBefore, [ref]$foregroundPid) } else { 0 }
            $attachedTarget = $false
            $attachedForeground = $false
            $diag = [ordered]@{
                foreground_before="$($fgBefore.ToInt64())"; target_thread_id=[int64]$tidTarget;
                current_thread_id=[int64]$tidCurrent; foreground_thread_id=[int64]$tidForeground
            }
            try {
                Write-Checkpoint 'before_allow_set_foreground_window' ([pscustomobject]$diag)
                $diag.allow_set_foreground_window_ok = [bool][FocusNative]::AllowSetForegroundWindow(0xFFFFFFFF)
                Write-Checkpoint 'after_allow_set_foreground_window' ([pscustomobject]$diag)
                if ($tidForeground -ne 0 -and $tidForeground -ne $tidCurrent) {
                    Write-Checkpoint 'before_attach_foreground_thread' ([pscustomobject]$diag)
                    $attachedForeground = [FocusNative]::AttachThreadInput($tidCurrent, $tidForeground, $true)
                    $diag.attach_foreground_thread_input_ok = [bool]$attachedForeground
                    Write-Checkpoint 'after_attach_foreground_thread' ([pscustomobject]$diag)
                }
                if ($tidTarget -ne 0 -and $tidTarget -ne $tidCurrent -and $tidTarget -ne $tidForeground) {
                    Write-Checkpoint 'before_attach_target_thread' ([pscustomobject]$diag)
                    $attachedTarget = [FocusNative]::AttachThreadInput($tidCurrent, $tidTarget, $true)
                    $diag.attach_thread_input_ok = [bool]$attachedTarget
                    Write-Checkpoint 'after_attach_target_thread' ([pscustomobject]$diag)
                }
                Write-Checkpoint 'before_show_window_async' ([pscustomobject]$diag)
                $diag.show_window_async_ok = [bool][FocusNative]::ShowWindowAsync($h, $sw)
                Write-Checkpoint 'after_show_window_async' ([pscustomobject]$diag)
                Write-Checkpoint 'before_bring_window_to_top' ([pscustomobject]$diag)
                $diag.bring_window_to_top_ok = [bool][FocusNative]::BringWindowToTop($h)
                Write-Checkpoint 'after_bring_window_to_top' ([pscustomobject]$diag)
                Write-Checkpoint 'before_set_window_topmost' ([pscustomobject]$diag)
                $diag.set_window_topmost_ok = [bool][FocusNative]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x43)
                Write-Checkpoint 'after_set_window_topmost' ([pscustomobject]$diag)
                Write-Checkpoint 'before_set_window_notopmost' ([pscustomobject]$diag)
                $diag.set_window_notopmost_ok = [bool][FocusNative]::SetWindowPos($h, [IntPtr]::new(-2), 0, 0, 0, 0, 0x43)
                Write-Checkpoint 'after_set_window_notopmost' ([pscustomobject]$diag)
                Write-Checkpoint 'before_set_active_window' ([pscustomobject]$diag)
                $diag.set_active_window_result = [int64][FocusNative]::SetActiveWindow($h).ToInt64()
                Write-Checkpoint 'after_set_active_window' ([pscustomobject]$diag)
                Write-Checkpoint 'before_set_focus' ([pscustomobject]$diag)
                $diag.set_focus_result = [int64][FocusNative]::SetFocus($h).ToInt64()
                Write-Checkpoint 'after_set_focus' ([pscustomobject]$diag)
                $setOk = $false
                $lastError = 0
                for ($i = 0; $i -lt 3; $i++) {
                    Write-Checkpoint "before_attached_set_foreground_$i" ([pscustomobject]$diag)
                    $attempt = [FocusNative]::SetForegroundWindow($h)
                    $lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    if ($attempt) { $setOk = $true }
                    $diag.set_foreground_ok = [bool]$setOk
                    $diag.set_foreground_last_error = [int64]$lastError
                    Write-Checkpoint "after_attached_set_foreground_$i" ([pscustomobject]$diag)
                    if ([FocusNative]::GetForegroundWindow() -eq $h) { break }
                    Start-Sleep -Milliseconds 60
                }
            } finally {
                if ($attachedTarget) {
                    Write-Checkpoint 'before_detach_target_thread' ([pscustomobject]$diag)
                    [void][FocusNative]::AttachThreadInput($tidCurrent, $tidTarget, $false)
                    Write-Checkpoint 'after_detach_target_thread' ([pscustomobject]$diag)
                }
                if ($attachedForeground) {
                    Write-Checkpoint 'before_detach_foreground_thread' ([pscustomobject]$diag)
                    [void][FocusNative]::AttachThreadInput($tidCurrent, $tidForeground, $false)
                    Write-Checkpoint 'after_detach_foreground_thread' ([pscustomobject]$diag)
                }
            }
            $fg = [FocusNative]::GetForegroundWindow()
            $diag.acquired = ($fg -eq $h)
            $diag.foreground_window_handle = "$($fg.ToInt64())"
            Write-Result @{ ok=$true; result=$diag }
        }
        'switch_window' {
            Write-Checkpoint 'before_switch_to_this_window' $null
            [FocusNative]::SwitchToThisWindow($h, $true)
            Write-Checkpoint 'after_switch_to_this_window' $null
            Start-Sleep -Milliseconds 80
            $fg = [FocusNative]::GetForegroundWindow()
            Write-Result @{ ok=$true; result=@{ switch_to_this_window_returned=$true; acquired=($fg -eq $h); foreground_window_handle="$($fg.ToInt64())" } }
        }
        'verify' {
            Write-Checkpoint 'before_final_verify' $null
            $fg = [FocusNative]::GetForegroundWindow()
            $iconic = [FocusNative]::IsIconic($h)
            $zoomed = [FocusNative]::IsZoomed($h)
            $stateOk = $true
            if ($action -eq 'minimize') { $stateOk = $iconic }
            elseif ($action -eq 'maximize') { $stateOk = $zoomed }
            elseif ($action -eq 'restore') { $stateOk = (-not $iconic) }
            $acquired = if ($action -eq 'minimize') { $stateOk } else { ($fg -eq $h) }
            Write-Checkpoint 'after_final_verify' ([pscustomobject]@{ acquired=[bool]$acquired; state_ok=[bool]$stateOk; foreground_window_handle="$($fg.ToInt64())" })
            Write-Result @{ ok=$true; result=@{
                acquired=[bool]$acquired; state_ok=[bool]$stateOk; is_window=[bool][FocusNative]::IsWindow($h);
                is_iconic=[bool]$iconic; is_zoomed=[bool]$zoomed; foreground_window_handle="$($fg.ToInt64())"
            } }
        }
    }
} catch {
    $message = [string]$_.Exception.Message
    try { Write-Checkpoint 'exception' ([pscustomobject]@{ error_code='FOCUS_STAGE_EXCEPTION'; error_message=$message }) } catch {}
    Write-Result @{ ok=$false; error_code='FOCUS_STAGE_EXCEPTION'; error_message=$message; result=@{ stage=$Stage; execution_pid=$PID } }
}
