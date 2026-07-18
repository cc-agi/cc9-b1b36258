// Sentinel OS Helper — shared locale-independent PID existence parser.
//
// This is the JavaScript mirror of helper/lib/tasklist-pid.ps1. It exists so
// the parsing contract can be regression-tested from Vitest on Linux CI
// (which has no `tasklist`, no PowerShell, no Windows locale variants).
//
// The parser MUST behave identically to the PowerShell function:
//   - a "valid" tasklist CSV process row matches ^"[^"]*","(\d+)","
//   - the captured integer must equal the requested pid
//   - anything else (English "INFO:", Chinese "信息:", empty output, whitespace)
//     is treated as "no such pid"
// It MUST NOT match or exclude localized informational prose.

/**
 * @param {number} targetPid
 * @param {{ exitCode: number, stdout: string }} result   raw tasklist result
 * @returns {{ ok: boolean, alive: boolean, exit: number }}
 */
export function classifyTasklistResult(targetPid, result) {
  const { exitCode, stdout } = result;
  if (exitCode !== 0) {
    return { ok: false, alive: false, exit: exitCode };
  }
  if (!stdout) return { ok: true, alive: false, exit: 0 };
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const m = /^"[^"]*","(\d+)","/.exec(line);
    if (m && Number.parseInt(m[1], 10) === targetPid) {
      return { ok: true, alive: true, exit: 0 };
    }
  }
  return { ok: true, alive: false, exit: 0 };
}
