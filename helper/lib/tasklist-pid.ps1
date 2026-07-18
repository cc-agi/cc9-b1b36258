# Sentinel OS Helper — shared locale-independent PID existence check.
#
# Windows `tasklist` localizes its "no matching task" message. On Chinese
# Windows the absent-PID line is:  信息: 没有运行的任务匹配指定标准。
# On English Windows it is:        INFO: No tasks are running which match...
#
# Any parser that keys off English `INFO:` prose misclassifies the Chinese
# message as a live process row. Do NOT match or exclude localized prose.
#
# Contract:
#   Test-TasklistPidAlive -TargetPid <int>
#     returns a hashtable: @{ ok = <bool>; alive = <bool>; exit = <int> }
#     - ok    = tasklist exited zero AND output was parseable.
#     - alive = a valid CSV row was returned whose SECOND column, parsed as
#               an integer, exactly equals $TargetPid.
#     - exit  = raw $LASTEXITCODE from tasklist.
#   When ok=$false the caller MUST fail closed:
#     - never launch a duplicate Helper;
#     - never delete the pid file;
#     - print a diagnostic and exit non-zero.
#
# A valid CSV process row (from `tasklist /FO CSV /NH`) looks like:
#   "node.exe","11696","Console","2","123,456 K"
# The parser accepts a row ONLY if it matches the anchored regex
#   ^"[^"]*","(\d+)","
# and the captured integer equals the requested PID. Localized info lines
# (which start with unquoted text such as `INFO:` or `信息:`) never match.

function Test-TasklistPidAlive {
    param(
        [Parameter(Mandatory = $true)]
        [int]$TargetPid
    )
    $tl = & tasklist /FI "PID eq $TargetPid" /FO CSV /NH 2>$null
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        return @{ ok = $false; alive = $false; exit = $exit }
    }
    $alive = $false
    if ($tl) {
        foreach ($line in $tl) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            if ($line -match '^"[^"]*","(\d+)","') {
                if ([int]$Matches[1] -eq $TargetPid) {
                    $alive = $true
                    break
                }
            }
        }
    }
    return @{ ok = $true; alive = $alive; exit = 0 }
}
