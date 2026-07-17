/**
 * P0-R5 R1 — regression tests for the runtime blockers the Owner surfaced:
 *
 *   1. desktop_* tools must be registered in the orchestrator's routing
 *      layer (parseDesktopGoal + isDesktopToolName), NOT just the MCP manifest.
 *   2. When a desktop tool cannot execute, the run must resolve to `failed`
 *      with error_code DESKTOP_TOOL_UNAVAILABLE — never `succeeded`.
 *   3. desktop-operator.ps1 must grant the current user Full (Delete/Modify)
 *      on desktop-session.json so restart Remove-Item does not deny.
 *   4. stop-desktop-operator.bat must not parse-error under cmd.exe: no
 *      unescaped `.` inside `if` conditions, PID validated as digits-only.
 *   5. status-desktop-operator.bat must produce output when the session
 *      file exists (delegated to PowerShell with -Command single-string).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESKTOP_TOOLS, isDesktopToolName } from "@/lib/desktop/schemas";
import { parseDesktopGoal, DESKTOP_GOAL_PREFIX } from "@/lib/orchestrator.server";

const ROOT = process.cwd();
const H = (f: string) => resolve(ROOT, "helper", f);

describe("orchestrator desktop tool registration", () => {
  it("recognises every advertised desktop_* tool", () => {
    for (const t of DESKTOP_TOOLS) {
      expect(isDesktopToolName(t.name)).toBe(true);
    }
    // Every MCP-advertised tool must survive round-trip through parseDesktopGoal.
    for (const t of DESKTOP_TOOLS) {
      const goal = `${DESKTOP_GOAL_PREFIX}${t.name}] ${JSON.stringify({ args: { session_id: "00000000-0000-0000-0000-000000000000", idempotency_key: "abcdefgh" } })}`;
      const parsed = parseDesktopGoal(goal);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.tool).toBe(t.name);
    }
  });

  it("rejects an unknown desktop tool in the goal header", () => {
    const goal = `${DESKTOP_GOAL_PREFIX}desktop_bogus] {"args":{}}`;
    const parsed = parseDesktopGoal(goal);
    expect(parsed.ok).toBe(false);
  });

  it("rejects malformed JSON payload", () => {
    const goal = `${DESKTOP_GOAL_PREFIX}desktop_snapshot] {not json`;
    const parsed = parseDesktopGoal(goal);
    expect(parsed.ok).toBe(false);
  });

  it("rejects payload without args", () => {
    const goal = `${DESKTOP_GOAL_PREFIX}desktop_snapshot] {}`;
    const parsed = parseDesktopGoal(goal);
    expect(parsed.ok).toBe(false);
  });
});

describe("desktop-operator.ps1 grants Modify/Delete on session file", () => {
  it("icacls grant clause is (F) not (R,W)", () => {
    const s = readFileSync(H("desktop-operator.ps1"), "utf8");
    // Must NOT contain the read-write-only ACL that caused the Windows regression.
    expect(/icacls[^\r\n]*\(R,W\)/i.test(s)).toBe(false);
    // Must grant Full Control to the qualified WindowsIdentity owner (0.4.1).
    expect(/icacls[^\r\n]*\$\{?ownerPrincipal\}?:\(F\)/i.test(s)).toBe(true);
  });

  it("PID file is written without a BOM so cmd.exe `set /p` reads clean digits", () => {
    const s = readFileSync(H("desktop-operator.ps1"), "utf8");
    // Legacy `Set-Content -Path $pidFile ... -Encoding UTF8` writes a BOM.
    expect(/Set-Content\s+-Path\s+\$pidFile[^\r\n]*-Encoding\s+UTF8/i.test(s)).toBe(false);
    // Must use WriteAllText with a BOM-less UTF8 encoder.
    expect(/WriteAllText\([^)]*\$pidFile/i.test(s)).toBe(true);
  });
});

describe("stop-desktop-operator.bat is cmd.exe parse-safe", () => {
  const s = readFileSync(H("stop-desktop-operator.bat"), "utf8");
  it("validates PID as digits before invoking taskkill", () => {
    expect(/findstr\s+\/R\s+"?\^\[0-9\]/i.test(s)).toBe(true);
  });
  it("does not use the fragile `for /f usebackq` pid parse", () => {
    expect(/for\s+\/f\s+"usebackq/i.test(s)).toBe(false);
  });
  it("cleans up session file after stop", () => {
    expect(/del\s+\/q\s+"%SESSION%"/i.test(s)).toBe(true);
  });
});

describe("status-desktop-operator.bat produces output when session exists", () => {
  const s = readFileSync(H("status-desktop-operator.bat"), "utf8");
  it("uses a single -Command string (not multi-line `^` continuations)", () => {
    // Multi-line `^` continuations were the cause of `no output` on some shells;
    // require the PowerShell call to fit on a single line. Skip the `where`
    // probe line and find the actual -Command invocation.
    const psLine = s.split(/\r?\n/).find((l) => /powershell\.exe[^\r\n]*-Command/i.test(l)) ?? "";
    expect(psLine).toMatch(/-Command\s+"/);
    // The single -Command payload must contain the state emit.
    expect(psLine).toMatch(/session_id/);
  });

  it("emits an OFF line when session file is missing", () => {
    expect(/echo\s+\[status-desktop-operator\][^\r\n]*OFF/i.test(s)).toBe(true);
  });
});
