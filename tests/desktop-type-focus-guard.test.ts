/**
 * 0.4.15 regression — desktop_type must refuse to send characters unless
 * the currently focused UIA element is a Document/Edit control, and must
 * return pre/post foreground_window_handle + focused control class/type
 * evidence. desktop_hotkey must poll GetClipboardSequenceNumber for
 * Ctrl+C / Ctrl+X and report clipboard_changed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

function extractFn(source: string, name: string): string {
  const re = new RegExp(
    `function\\s+${name}(?:\\([^)]*\\))?\\s*\\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`could not extract ${name}`);
  return match[0];
}

describe("desktop_type focus guard (0.4.15)", () => {
  const type = extractFn(operator, "Tool-Type");
  const info = extractFn(operator, "Get-FocusedControlInfo");

  it("captures pre/post focused control + foreground handle", () => {
    expect(type).toMatch(/\$pre = Get-FocusedControlInfo/);
    expect(type).toMatch(/\$post = Get-FocusedControlInfo/);
    expect(info).toContain("foreground_window_handle");
    expect(info).toContain("focused_control_type");
    expect(info).toContain("focused_class");
  });

  it("refuses to type when focused control is not Document/Edit", () => {
    expect(type).toContain("FOCUS_CONTROL_INVALID");
    expect(type).toMatch(/-not \$pre\.is_document_or_edit/);
  });

  it("fails when foreground_window_handle does not match expected", () => {
    expect(type).toContain("FOCUS_TARGET_MISMATCH");
    expect(type).toMatch(/\$expectedHandle\s+-ne\s+\$pre\.foreground_window_handle/);
  });

  it("returns expected_target_still_foreground on success", () => {
    expect(type).toContain("expected_target_still_foreground");
  });
});

describe("desktop_hotkey clipboard-sequence verification (0.4.15)", () => {
  const hot = extractFn(operator, "Tool-Hotkey");

  it("captures GetClipboardSequenceNumber before and after", () => {
    expect(hot).toMatch(/\$seqBefore = 0.*GetClipboardSequenceNumber/s);
    expect(hot).toContain("clipboard_seq_before");
    expect(hot).toContain("clipboard_seq_after");
    expect(hot).toContain("clipboard_changed");
  });

  it("polls up to 500ms for copy/cut hotkeys", () => {
    expect(hot).toMatch(/\$isCopyLike\s*=\s*\(\$mkSet\s+-contains\s+\$ctrlMod\)/);
    expect(hot).toMatch(/@\('c','x'\)/);
    expect(hot).toMatch(/for \(\$i = 0; \$i -lt 10;/);
    expect(hot).toMatch(/Start-Sleep -Milliseconds 50/);
  });

  it("returns CLIPBOARD_UNCHANGED_AFTER_COPY when seq did not change", () => {
    expect(hot).toContain("CLIPBOARD_UNCHANGED_AFTER_COPY");
  });

  it("returns pre/post foreground evidence", () => {
    expect(hot).toMatch(/\$pre = Get-FocusedControlInfo/);
    expect(hot).toMatch(/\$post = Get-FocusedControlInfo/);
    expect(hot).toContain("expected_target_still_foreground");
  });
});
