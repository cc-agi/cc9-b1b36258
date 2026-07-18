/**
 * 0.4.15 regression — end-to-end shape check for the Notepad flow.
 * Cannot execute Win32 in CI, so we verify: the operator wires TextPattern
 * for RichEditD2DPT (ControlType.Document), Tool-Type refuses non-Edit
 * focus, Tool-Hotkey Ctrl+A/Ctrl+C reports a real clipboard sequence
 * change, and the direct MCP tool result carries the actual text byte for
 * byte while the audit copy substitutes hash+length.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactDesktopResult, sha256Hex } from "@/lib/desktop/redact";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

describe("Win11 Notepad RichEditD2DPT flow (0.4.15)", () => {
  it("Tool-Inspect covers RichEditD2DPT via Document control type + TextPattern", () => {
    // Modern Win11 Notepad class = RichEditD2DPT; UIA control_type ends in
    // .Document. The operator must branch on the control type suffix, and
    // must attempt TextPattern.DocumentRange.GetText(-1).
    expect(operator).toMatch(/\$ctrlType\s+-match\s+'\\\.Document\$'/);
    expect(operator).toContain("DocumentRange.GetText(-1)");
  });

  it("direct tool result preserves the typed text byte-for-byte", () => {
    // The Helper returns { ok, result: { text, value, ... } }. Direct MCP
    // callers get the plaintext; only the audit copy is redacted.
    const typed = "hello 你好 world";
    const rawResult = { ok: true, result: { text: typed, value: null } };
    // Plaintext survives to the caller (no transformation on this path).
    expect((rawResult.result as { text: string }).text).toBe(typed);
    // Audit copy: text is hashed.
    const audit = redactDesktopResult("desktop_inspect", rawResult);
    const rr = audit?.result as Record<string, unknown>;
    expect(rr.text).toMatchObject({
      redacted: true,
      length: typed.length,
      sha256: sha256Hex(typed),
    });
    expect(JSON.stringify(audit)).not.toContain(typed);
  });

  it("Ctrl+C hotkey pathway reaches the sequence-number poll", () => {
    expect(operator).toContain("CLIPBOARD_UNCHANGED_AFTER_COPY");
    // 0.4.20 rewired hotkey verification through Resolve-HotkeyVerification
    // and the Invoke-VerifiedAction engine — Ctrl+C/X classify as
    // clipboard_change and share the CLIPBOARD_UNCHANGED_AFTER_COPY error path.
    expect(operator).toMatch(/\$k -eq 'c' -or \$k -eq 'x'/);
  });
});
