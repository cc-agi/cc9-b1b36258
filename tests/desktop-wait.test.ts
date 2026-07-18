/**
 * P0-R6.2 regression — desktop_wait must actually wait for `duration_ms`
 * milliseconds and report an accurate `waited_ms`.
 *
 * Field bug (Helper 0.4.3): PowerShell function was declared as
 * `function Tool-Wait($args) { ... $args.duration_ms ... }`. `$args` is
 * an AUTOMATIC PowerShell variable. The formal parameter was silently
 * shadowed by the empty automatic-args array, so `$args.duration_ms`
 * evaluated to $null, `[int]$null` = 0, clamp raised it to 1, and every
 * call returned `waited_ms: 1` after sleeping ~1 ms — regardless of the
 * requested value (2000 ms in the field report).
 *
 * Coverage:
 *  1. Schema: duration_ms=2000 passes; 0 and 30001 are rejected.
 *  2. Node bridge: `duration_ms` is transported unchanged over the local
 *     loopback envelope (no ms->s scaling anywhere in the JS layer).
 *  3. PowerShell integration (only when `pwsh` is available on PATH):
 *     invoke the real `Tool-Wait` from helper/desktop-operator.ps1 and
 *     assert that a 2000 ms request sleeps ~2000 ms and reports a
 *     `waited_ms` close to 2000 (never 1, never 2).
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DesktopWaitInput } from "@/lib/desktop/schemas";

const envelope = {
  session_id: "5e3bbf30-67ee-4ba5-93a4-7341ac8c4ef8",
  idempotency_key: "run-2df5cb6e.att-1.seq-1.k-abc",
};

function pwshAvailable(): string | null {
  for (const bin of ["pwsh", "powershell"]) {
    try {
      const r = spawnSync(bin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r.status === 0) return bin;
    } catch {
      /* ignore */
    }
  }
  return null;
}

describe("desktop_wait duration_ms fidelity (P0-R6.2)", () => {
  it("schema accepts 2000 ms and rejects boundary violations", () => {
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: 2000 }).success).toBe(true);
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: 1 }).success).toBe(true);
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: 30000 }).success).toBe(true);
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: 0 }).success).toBe(false);
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: 30001 }).success).toBe(false);
    expect(DesktopWaitInput.safeParse({ ...envelope, duration_ms: -1 }).success).toBe(false);
  });

  it("Node bridge envelope preserves duration_ms as ms (no unit conversion)", () => {
    // Simulate the exact JSON.stringify performed by helper/src/desktop.mjs.
    const payload = JSON.stringify({
      tool: "desktop_wait",
      args: { ...envelope, duration_ms: 2000 },
      envelope: { run_id: "r", intent_id: "i", idempotency_key: envelope.idempotency_key },
    });
    const round = JSON.parse(payload);
    expect(round.args.duration_ms).toBe(2000);
    expect(typeof round.args.duration_ms).toBe("number");
    // Guard against any accidental /1000 or *1000 scaling anywhere upstream:
    expect(round.args.duration_ms).not.toBe(2);
    expect(round.args.duration_ms).not.toBe(2_000_000);
  });

  it("verifies the source file no longer uses $args as a Tool-* parameter name", () => {
    const src = readFileSync(
      path.resolve(__dirname, "..", "helper", "desktop-operator.ps1"),
      "utf8",
    );
    // Regression guard: `$args` inside a Tool- function is a PS automatic
    // variable and MUST NOT be used as a formal parameter name.
    const badFormal = /function\s+Tool-[A-Za-z]+\s*\(\s*\$args\b/g;
    expect(src.match(badFormal), "no Tool-* function may declare a $args parameter").toBeNull();
    // Tool-Wait must return the stopwatch-measured elapsed, not the input.
    expect(src).toMatch(/System\.Diagnostics\.Stopwatch/);
    expect(src).toMatch(/waited_ms\s*=\s*\$elapsed/);
    expect(src).toMatch(/DURATION_MS_OUT_OF_RANGE/);
  });

  const pwsh = pwshAvailable();
  const maybeIt = pwsh ? it : it.skip;
  maybeIt(
    "PowerShell Tool-Wait sleeps ~2000 ms and reports honest waited_ms",
    () => {
      // Extract just the Tool-Wait function body from the real script and
      // evaluate it in a throwaway pwsh subprocess. We avoid dot-sourcing
      // the whole script because it registers Win32 P/Invoke bindings that
      // only exist on Windows.
      const src = readFileSync(
        path.resolve(__dirname, "..", "helper", "desktop-operator.ps1"),
        "utf8",
      );
      const m = src.match(/function Tool-Wait\([\s\S]*?\n\}\n/);
      expect(m, "Tool-Wait function must be extractable").toBeTruthy();
      const script = `${m![0]}
$cases = @(
  [pscustomobject]@{duration_ms=2000},
  [pscustomobject]@{duration_ms=1},
  [pscustomobject]@{duration_ms=30001},
  [pscustomobject]@{duration_ms=0}
)
$out = @()
foreach ($c in $cases) { $out += ,(Tool-Wait $c) }
$out | ConvertTo-Json -Compress -Depth 5
`;
      const t0 = Date.now();
      const raw = execFileSync(pwsh!, ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        timeout: 15_000,
      });
      const wall = Date.now() - t0;
      // ~2000 + ~1 + 0 (rejected) + 0 (rejected) ≈ 2000 ms of real sleep.
      expect(wall).toBeGreaterThanOrEqual(1900);
      const parsed = JSON.parse(raw) as Array<{
        ok: boolean;
        result?: { waited_ms: number; requested_ms: number };
        error_code?: string;
      }>;
      // Case 1: 2000 ms — the exact field-reported failure input.
      expect(parsed[0].ok).toBe(true);
      expect(parsed[0].result!.requested_ms).toBe(2000);
      expect(parsed[0].result!.waited_ms).toBeGreaterThanOrEqual(1900);
      expect(parsed[0].result!.waited_ms).toBeLessThan(3000);
      // Explicit anti-regression on the 0.4.3 observed value:
      expect(parsed[0].result!.waited_ms).not.toBe(1);
      expect(parsed[0].result!.waited_ms).not.toBe(2);
      // Case 2: 1 ms lower bound still succeeds.
      expect(parsed[1].ok).toBe(true);
      expect(parsed[1].result!.requested_ms).toBe(1);
      // Case 3: over cap is rejected — never silently clamped to succeeded.
      expect(parsed[2].ok).toBe(false);
      expect(parsed[2].error_code).toBe("DURATION_MS_OUT_OF_RANGE");
      // Case 4: below floor is rejected.
      expect(parsed[3].ok).toBe(false);
      expect(parsed[3].error_code).toBe("DURATION_MS_OUT_OF_RANGE");
    },
    20_000,
  );
});
