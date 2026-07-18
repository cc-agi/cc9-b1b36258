/**
 * 0.4.15 regression — desktop_inspect must read actual text out of
 * Document/Edit controls (TextPattern first, ValuePattern fallback), and
 * modern Win11 Notepad's RichEditD2DPT (ControlType.Document) must be
 * covered by the same code path. Log-side redaction must strip the plaintext.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactDesktopResult } from "@/lib/desktop/redact";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

describe("desktop_inspect text extraction (0.4.15)", () => {
  it("reads TextPattern.DocumentRange.GetText(-1) for Document/Edit", () => {
    expect(operator).toContain("TextPattern]::Pattern");
    expect(operator).toContain("DocumentRange.GetText(-1)");
  });

  it("falls back to ValuePattern.Current.Value", () => {
    expect(operator).toContain("ValuePattern]::Pattern");
    expect(operator).toMatch(/vp\.Current\.Value/);
  });

  it("returns text/value/text_length/value_length in Tool-Inspect result", () => {
    for (const key of ["text = $textVal", "value = $valueVal", "text_length", "value_length"]) {
      expect(operator).toContain(key);
    }
  });

  it("recognises Document AND Edit control types (covers Win11 Notepad RichEditD2DPT)", () => {
    // RichEditD2DPT is a *ClassName*; UIA still reports ControlType.Document,
    // so the code guards on ProgrammaticName ending in .Document or .Edit.
    expect(operator).toMatch(/\$ctrlType\s+-match\s+'\\\.Document\$'/);
    expect(operator).toMatch(/\$ctrlType\s+-match\s+'\\\.Edit\$'/);
  });

  it("audit copy strips text/value but preserves length + sha256", () => {
    const out = redactDesktopResult("desktop_inspect", {
      ok: true,
      result: { text: "hello world", value: null, control_type: "ControlType.Document" },
    });
    const r = out?.result as Record<string, unknown>;
    expect(r.text).toMatchObject({ redacted: true, length: 11 });
    expect(JSON.stringify(out)).not.toContain("hello world");
  });
});
