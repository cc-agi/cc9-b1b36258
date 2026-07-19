/**
 * 0.4.20 Action Verification Engine regression:
 *  - Tool-Click / Tool-Drag / Tool-Hotkey run through Invoke-VerifiedAction.
 *  - Poll ladder is 50/100/200/400/800/1600 ms cumulative.
 *  - Predicate misses surface CLICK_NO_EFFECT / DRAG_NO_EFFECT /
 *    HOTKEY_NO_EFFECT (or CLIPBOARD_UNCHANGED_AFTER_COPY for Ctrl+C/X).
 *  - Unknown chords are input_only and MUST NOT be reported as verified.
 *  - Schemas expose the require_verified opt-out.
 *  - Audit redaction still scrubs focused_text/value from pre/post for
 *    click and drag too, not just type/hotkey.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DesktopClickInput, DesktopDragInput, DesktopHotkeyInput } from "@/lib/desktop/schemas";
import { redactDesktopResult, sha256Hex } from "@/lib/desktop/redact";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

function extractFn(source: string, name: string): string {
  const re = new RegExp(
    `function\\s+${name}(?:\\([^)]*\\))?\\s*\\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`,
    "m",
  );
  const m = source.match(re);
  if (!m) throw new Error(`could not extract ${name}`);
  return m[0];
}

describe("Invoke-VerifiedAction poll ladder + evidence shape (0.4.20)", () => {
  const engine = extractFn(operator, "Invoke-VerifiedAction");
  const evidence = extractFn(operator, "Get-ActionEvidence");
  const predicate = extractFn(operator, "New-VerificationPredicate");

  it("polls at 50/100/200/400/800/1600 ms cumulative delays", () => {
    expect(engine).toContain("@(50, 100, 200, 400, 800, 1600)");
    expect(engine).toMatch(/Start-Sleep -Milliseconds \$d/);
  });

  it("captures pre/post evidence with foreground_rect + focused text hashes", () => {
    for (const k of [
      "foreground_window_handle",
      "foreground_rect",
      "focused_text_hash",
      "focused_value_hash",
      "clipboard_sequence",
    ]) {
      expect(evidence).toContain(k);
    }
  });

  it("returns verified/verification_kind/attempts/elapsed_ms/target_still_foreground", () => {
    for (const k of [
      "verified",
      "verification_kind",
      "verification_attempts",
      "verification_elapsed_ms",
      "target_still_foreground",
      "effect_observed",
      "failure_reason",
    ]) {
      expect(engine).toContain(k);
    }
  });

  it("classifies well-known predicates without treating input as effect", () => {
    for (const k of [
      "'clipboard_change'",
      "'focused_text_change'",
      "'foreground_change'",
      "'foreground_or_focus_change'",
      "'input_only'",
    ]) {
      expect(predicate).toContain(k);
    }
    // input_only ALWAYS reports observed=$false — never claim input as effect.
    expect(predicate).toMatch(/'input_only'[\s\S]{0,200}observed\s*=\s*\$false/);
  });
});

describe("Tool-Click / Tool-Drag / Tool-Hotkey are wrapped by the engine", () => {
  const click = extractFn(operator, "Tool-Click");
  const drag = extractFn(operator, "Tool-Drag");
  const hotkey = extractFn(operator, "Tool-Hotkey");

  it("Tool-Click (0.4.21) verifies via target focus + caret, returns CLICK_NO_EFFECT", () => {
    // 0.4.21 Click Target Verification replaces Invoke-VerifiedAction with
    // Get-ClickTargetInfo + Get-CaretPosition to detect real state change on
    // already-focused Document/Edit controls (Finding A regression).
    expect(click).toContain("Get-ClickTargetInfo");
    expect(click).toMatch(/Get-CaretPosition/);
    expect(click).toContain("CLICK_NO_EFFECT");
    expect(click).toMatch(/target_focus_verified|caret_changed/);
    expect(click).toMatch(/\$requireVerified\s+-and\s+-not\s+\$verified/);
  });

  it("Tool-Drag resolves target via WindowFromPoint and returns DRAG_NO_EFFECT", () => {
    expect(drag).toContain("Invoke-VerifiedAction");
    expect(drag).toContain("WindowFromPoint");
    expect(drag).toContain("GetAncestor");
    expect(drag).toContain("target_rect_before");
    expect(drag).toContain("target_rect_after");
    expect(drag).toContain("DRAG_NO_EFFECT");
  });

  it("Tool-Hotkey classifies chords and returns HOTKEY_NO_EFFECT / CLIPBOARD_UNCHANGED_AFTER_COPY", () => {
    expect(hotkey).toContain("Resolve-HotkeyVerification");
    expect(hotkey).toContain("Invoke-VerifiedAction");
    expect(hotkey).toContain("HOTKEY_NO_EFFECT");
    expect(hotkey).toContain("CLIPBOARD_UNCHANGED_AFTER_COPY");
  });
});

describe("Resolve-HotkeyVerification classification (0.4.20)", () => {
  const rhv = extractFn(operator, "Resolve-HotkeyVerification");
  it("Ctrl+C / Ctrl+X → clipboard_change requires=true", () => {
    expect(rhv).toMatch(
      /\$k -eq 'c' -or \$k -eq 'x'[\s\S]*clipboard_change[\s\S]*requires\s*=\s*\$true/,
    );
  });
  it("Ctrl+V / Ctrl+Z / Ctrl+Y → focused_text_change requires=true", () => {
    expect(rhv).toMatch(/focused_text_change[\s\S]*requires\s*=\s*\$true/);
  });
  it("Alt+Tab / Win+D → foreground_change requires=true", () => {
    expect(rhv).toContain("foreground_change");
    expect(rhv).toMatch(/hasWin[\s\S]*'d'[\s\S]*foreground_change/);
  });
  it("unknown chord falls back to input_only with requires=false", () => {
    expect(rhv).toMatch(/return @\{ kind = 'input_only'; requires = \$false \}/);
  });
});

describe("Schemas expose require_verified opt-out (0.4.20)", () => {
  it("desktop_click default require_verified=true", () => {
    const parsed = DesktopClickInput.parse({
      idempotency_key: "click-verify-01",
      session_id: "11111111-1111-1111-1111-111111111111",
      x: 100,
      y: 100,
    });
    expect(parsed.require_verified).toBe(true);
  });
  it("desktop_drag accepts require_verified=false", () => {
    const parsed = DesktopDragInput.parse({
      idempotency_key: "drag-verify-01",
      session_id: "11111111-1111-1111-1111-111111111111",
      from_x: 10,
      from_y: 10,
      to_x: 200,
      to_y: 200,
      require_verified: false,
    });
    expect(parsed.require_verified).toBe(false);
  });
  it("desktop_hotkey default require_verified=true", () => {
    const parsed = DesktopHotkeyInput.parse({
      idempotency_key: "hotkey-verify-01",
      session_id: "11111111-1111-1111-1111-111111111111",
      modifiers: ["ctrl"],
      key: "c",
    });
    expect(parsed.require_verified).toBe(true);
  });
});

describe("Audit redaction covers click/drag pre/post (0.4.20)", () => {
  const doc = "Sentinel-0.4.20-drag-target-doc";
  it("desktop_click pre/post focused_text is hashed in audit copy", () => {
    const direct = {
      ok: true,
      result: {
        pre: { focused_text: doc, foreground_window_handle: "1" },
        post: { focused_text: doc + "!", foreground_window_handle: "1" },
        verified: true,
      },
    };
    const audit = redactDesktopResult("desktop_click", direct);
    const post = (audit?.result as { post: Record<string, unknown> }).post;
    expect(post.focused_text).toMatchObject({
      redacted: true,
      length: (doc + "!").length,
      sha256: sha256Hex(doc + "!"),
    });
    expect(JSON.stringify(audit)).not.toContain(doc + "!");
  });
  it("desktop_drag pre/post focused_text is hashed in audit copy", () => {
    const direct = {
      ok: true,
      result: {
        pre: { focused_text: doc, foreground_window_handle: "1" },
        post: { focused_text: doc, foreground_window_handle: "1" },
        verified: false,
      },
    };
    const audit = redactDesktopResult("desktop_drag", direct);
    expect(JSON.stringify(audit)).not.toContain(doc);
  });
});
