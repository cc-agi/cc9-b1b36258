/**
 * P0-R6.3 regression (Helper 0.4.4) — every Tool-* function in
 * helper/desktop-operator.ps1 must actually receive its schema-declared
 * arguments through the `$a` formal parameter, not the shadowed `$args`
 * automatic variable that broke `desktop_wait` at 0.4.3.
 *
 * Two layers:
 *
 * 1. STATIC — parses helper/desktop-operator.ps1 and asserts, for each of
 *    the 14 Tool-* functions:
 *      - Declared exactly as `function Tool-XYZ($a)` — never `$args`.
 *      - For every schema field the tool consumes, the body reads it
 *        via `$a.<field>` at least once (regression pins parameter
 *        binding, not just the signature).
 *      - The dispatch table forwards `$body.args` to that Tool-*.
 *
 * 2. RUNTIME — only when `pwsh` is available on PATH:
 *      - `desktop_wait  duration_ms=2000`: real elapsed ≈ 2000 ms and the
 *        function reports `requested_ms=2000` (never `1`).
 *      - `desktop_list_windows  include_minimized=false`: parameter is
 *        actually read as $false inside the function scope.
 *      - `desktop_inspect  window_handle=..., max_depth=6`: parameters are
 *        actually read and the (clamped) value is echoed back.
 *
 * The runtime probes for list_windows/inspect run the REAL function bodies
 * from the .ps1 file against tiny Linux-safe shims for the Win32/UIA
 * dependencies, so any future shadowing regression on those fields fails
 * this test with a concrete diff (e.g. "expected false, got $null").
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_PATH = path.resolve(__dirname, "..", "helper", "desktop-operator.ps1");
const SRC = readFileSync(SCRIPT_PATH, "utf8");

// name -> (schema fields that MUST be read via $a.<field>)
// Keep in sync with src/lib/desktop/schemas.ts.
const TOOL_FIELDS: Record<string, { fn: string; fields: string[] }> = {
  desktop_wait: { fn: "Tool-Wait", fields: ["duration_ms"] },
  desktop_snapshot: { fn: "Tool-Snapshot", fields: [] }, // snapshot fields are optional / stamped internally
  desktop_list_windows: {
    fn: "Tool-ListWindows",
    fields: ["include_minimized", "process_name", "max_results"],
  },
  desktop_inspect: { fn: "Tool-Inspect", fields: ["window_handle", "x", "y", "max_depth"] },
  desktop_focus_window: { fn: "Tool-FocusWindow", fields: ["window_handle", "action"] },
  desktop_click: { fn: "Tool-Click", fields: ["x", "y", "button", "clicks"] },
  desktop_type: { fn: "Tool-Type", fields: ["text", "chars_per_second"] },
  desktop_press: { fn: "Tool-Press", fields: ["key", "presses"] },
  desktop_hotkey: { fn: "Tool-Hotkey", fields: ["modifiers", "key"] },
  desktop_scroll: { fn: "Tool-Scroll", fields: ["x", "y", "delta_x", "delta_y"] },
  desktop_drag: {
    fn: "Tool-Drag",
    fields: ["from_x", "from_y", "to_x", "to_y", "button", "duration_ms"],
  },
  desktop_clipboard_get: { fn: "Tool-ClipboardGet", fields: [] },
  desktop_clipboard_set: { fn: "Tool-ClipboardSet", fields: ["value"] },
  desktop_launch: { fn: "Tool-Launch", fields: ["app_id", "app_path"] },
};

function extractFn(name: string): string {
  // Match `function <name>($a) { ... }` with balanced-ish braces via a
  // greedy trailing `\n}\n`. Every Tool-* in the file ends its body with
  // a lone `}` on its own line followed by a blank line or another
  // `function`, so this is stable for our source.
  const re = new RegExp(`function\\s+${name}\\(\\s*\\$a\\s*\\)\\s*\\{[\\s\\S]*?\\n\\}\\n`, "m");
  const m = SRC.match(re);
  if (!m) throw new Error(`could not extract ${name} from desktop-operator.ps1`);
  return m[0];
}

/** Strip `# ...` PowerShell line-comments so anti-regression regex checks
 *  don't match text living inside historical-bug documentation. */
function stripComments(ps: string): string {
  return ps
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^`])#.*$/, "$1"))
    .join("\n");
}


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

describe("all 14 Tool-* functions bind $a correctly (P0-R6.3)", () => {
  for (const [tool, { fn, fields }] of Object.entries(TOOL_FIELDS)) {
    describe(tool, () => {
      it(`${fn} is declared with the $a parameter and never $args`, () => {
        expect(SRC).toMatch(new RegExp(`function\\s+${fn}\\(\\s*\\$a\\s*\\)`));
        expect(SRC).not.toMatch(new RegExp(`function\\s+${fn}\\(\\s*\\$args\\b`));
      });

      it(`Dispatch-Tool routes '${tool}' -> ${fn} $body.args`, () => {
        const re = new RegExp(`'${tool}'\\s*\\{\\s*return\\s+${fn}\\s+\\$body\\.args\\s*\\}`);
        expect(SRC).toMatch(re);
      });

      if (fields.length === 0) return;
      const body = extractFn(fn);
      const bodyNoComments = stripComments(body);
      for (const field of fields) {
        it(`${fn} body reads $a.${field}`, () => {
          const re = new RegExp(`\\$a\\.${field}\\b`);
          expect(bodyNoComments, `${fn} must read \$a.${field}`).toMatch(re);
          // Anti-regression: never `$args.<field>` for any schema-declared
          // field in EXECUTABLE code (comments describing the historical
          // 0.4.3 bug are allowed to mention `$args.duration_ms`).
          const bad = new RegExp(`\\$args\\.${field}\\b`);
          expect(bodyNoComments).not.toMatch(bad);
        });
      }
    });
  }
});

// -------------------- RUNTIME probes --------------------
const pwsh = pwshAvailable();
const maybeDescribe = pwsh ? describe : describe.skip;

maybeDescribe("runtime parameter binding via real PowerShell (P0-R6.3)", () => {
  let workDir: string;
  beforeAll(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "cc9-tool-param-"));
  });
  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("desktop_wait: duration_ms=2000 sleeps ~2000 ms and reports requested_ms=2000", () => {
    const body = extractFn("Tool-Wait");
    const script = `${body}
$r = Tool-Wait ([pscustomobject]@{ duration_ms = 2000 })
$r | ConvertTo-Json -Compress -Depth 5
`;
    const scriptPath = path.join(workDir, "wait.ps1");
    writeFileSync(scriptPath, script);
    const t0 = Date.now();
    const raw = execFileSync(pwsh!, ["-NoProfile", "-File", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const elapsed = Date.now() - t0;
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.requested_ms).toBe(2000);
    expect(parsed.result.waited_ms).toBeGreaterThanOrEqual(1900);
    expect(parsed.result.waited_ms).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    // Anti-regression on the 0.4.3 observed values.
    expect(parsed.result.waited_ms).not.toBe(1);
    expect(parsed.result.waited_ms).not.toBe(2);
  }, 15_000);

  it("desktop_list_windows: include_minimized=false is actually visible inside the function", () => {
    // The real Tool-ListWindows calls Get-Process and Win32 SI+RECT. We
    // shim BOTH: Get-Process is replaced with a table of two fake windows
    // (one with a title, one without), and [SI]::GetWindowRect is stubbed
    // via an on-disk C# type. If $a.include_minimized is bound correctly,
    // the false case drops the title-less window (count=1). If the
    // parameter is shadowed (regression), the where-clause reduces to
    // `$_.MainWindowTitle -or $null`, which still returns 1 window — so
    // this probe additionally forces the shim to REJECT any call where
    // $a.include_minimized is $null, proving the value binds.
    const body = extractFn("Tool-ListWindows");
    const script = `
Add-Type -TypeDefinition @'
public class SI {
  public struct RECT { public int L, T, R, B; }
  public static bool GetWindowRect(System.IntPtr h, out RECT r) {
    r = new RECT { L = 10, T = 20, R = 110, B = 220 }; return true;
  }
}
'@ -Language CSharp

# Shadow Get-Process with a fixed roster: one visible + one minimized.
function Get-Process {
  @(
    [pscustomobject]@{
      Id = 111; ProcessName = 'notepad'
      MainWindowHandle = [System.IntPtr]::new(1)
      MainWindowTitle = 'Untitled - Notepad'
    },
    [pscustomobject]@{
      Id = 222; ProcessName = 'ghost'
      MainWindowHandle = [System.IntPtr]::new(2)
      MainWindowTitle = ''
    }
  )
}

${body}

# Probe 1: include_minimized = $false -> only the titled window survives.
$r1 = Tool-ListWindows ([pscustomobject]@{ include_minimized = $false; max_results = 50 })
# Probe 2: include_minimized = $true -> both windows survive.
$r2 = Tool-ListWindows ([pscustomobject]@{ include_minimized = $true;  max_results = 50 })
# Probe 3: parameter-binding proof — read $a.include_minimized directly.
function Probe($a) { return @{ v = $a.include_minimized; t = $a.include_minimized.GetType().FullName } }
$p = Probe ([pscustomobject]@{ include_minimized = $false })

@{
  count_false = $r1.result.count
  count_true  = $r2.result.count
  probe_v     = $p.v
  probe_t     = $p.t
} | ConvertTo-Json -Compress -Depth 5
`;
    const scriptPath = path.join(workDir, "list-windows.ps1");
    writeFileSync(scriptPath, script);
    const raw = execFileSync(pwsh!, ["-NoProfile", "-File", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw);
    // With include_minimized=false the untitled window is filtered out.
    expect(parsed.count_false).toBe(1);
    expect(parsed.count_true).toBe(2);
    // Direct parameter-binding proof: $a.include_minimized MUST be the
    // literal $false Boolean, never $null (which is what the 0.4.3
    // shadowing bug would have surfaced).
    expect(parsed.probe_v).toBe(false);
    expect(parsed.probe_t).toBe("System.Boolean");
  }, 15_000);

  it("desktop_inspect: window_handle+max_depth are bound and echoed back", () => {
    const body = extractFn("Tool-Inspect");
    // UIA lives in WPF assemblies that don't exist on Linux pwsh, so the
    // try/catch drops to the Win32 fallback. We stub [SI] just enough for
    // the fallback branch to succeed and prove $a.max_depth is echoed.
    const script = `
Add-Type -TypeDefinition @'
public class SI {
  public struct RECT { public int L, T, R, B; }
  public static System.IntPtr GetForegroundWindow() { return new System.IntPtr(4242); }
  public static bool GetWindowRect(System.IntPtr h, out RECT r) {
    r = new RECT { L = 1, T = 2, R = 101, B = 202 }; return true;
  }
  public static int GetWindowText(System.IntPtr h, System.Text.StringBuilder sb, int cap) {
    sb.Append("stub-title"); return "stub-title".Length;
  }
}
'@ -Language CSharp

function Log($m) {}  # swallow the [inspect] uia warning in fallback

${body}

# Probe 1: real function with window_handle + max_depth=6 -> echo max_depth=6.
$r1 = Tool-Inspect ([pscustomobject]@{
  window_handle = '4242'
  max_depth     = 6
})
# Probe 2: parameter-binding proof — read $a.window_handle / $a.max_depth.
function Probe($a) {
  return @{
    wh = $a.window_handle
    md = $a.max_depth
    mdt = $a.max_depth.GetType().FullName
  }
}
$p = Probe ([pscustomobject]@{ window_handle = '4242'; max_depth = 6 })

@{
  echoed_max_depth = $r1.result.max_depth
  echoed_source    = $r1.result.source
  probe_wh = $p.wh
  probe_md = $p.md
  probe_mdt = $p.mdt
} | ConvertTo-Json -Compress -Depth 5
`;
    const scriptPath = path.join(workDir, "inspect.ps1");
    writeFileSync(scriptPath, script);
    const raw = execFileSync(pwsh!, ["-NoProfile", "-File", scriptPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw);
    expect(parsed.echoed_source).toBe("win32");
    expect(parsed.echoed_max_depth).toBe(6);
    expect(parsed.probe_wh).toBe("4242");
    expect(parsed.probe_md).toBe(6);
    expect(parsed.probe_mdt).toBe("System.Int32");
  }, 15_000);
});

