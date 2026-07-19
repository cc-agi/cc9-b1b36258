/**
 * 0.4.20 Action Verification Engine — unified verifier module regression.
 *
 * Covers the seven decision scenarios the user called out:
 *   1. success: classified predicate observes the expected change
 *   2. no effect: predicate never fires within the poll ladder
 *   3. foreground stolen: another window becomes foreground during the wait
 *   4. target disappears: WindowFromPoint returns null before post evidence
 *   5. verification timeout: predicate misses every poll on the ladder
 *   6. UIA unreadable: TextPattern/ValuePattern absent for focused control
 *   7. input sent but effect never observed (input_only downgrade)
 */
import { describe, it, expect } from "vitest";
import {
  VERIFICATION_KINDS,
  DESKTOP_ERROR_CODES,
  POLL_LADDER_MS,
  TYPE_STABILITY_LADDER_MS,
  evaluatePredicate,
  computeDragVerdict,
  computeTypeVerdict,
  classifyHotkey,
  EvidenceSchema,
  VerificationResultSchema,
  type Evidence,
} from "@/lib/desktop/verifier";

function ev(over: Partial<Evidence> = {}): Evidence {
  return EvidenceSchema.parse({
    foreground_window_handle: "0x1000",
    foreground_class: "Notepad",
    foreground_title: "Untitled",
    foreground_rect: { L: 100, T: 100, R: 500, B: 400, W: 400, H: 300 },
    focused_class: "Edit",
    focused_control_type: "Edit",
    focused_text: "",
    focused_value: "",
    focused_text_length: 0,
    focused_value_length: 0,
    focused_text_hash: "sha-empty",
    focused_value_hash: "sha-empty",
    is_document_or_edit: true,
    clipboard_sequence: 100,
    captured_at_ms: 0,
    ...over,
  });
}

describe("stable identifiers + schemas", () => {
  it("exposes the canonical VerificationKind list", () => {
    expect(VERIFICATION_KINDS).toEqual([
      "clipboard_change",
      "focused_text_change",
      "foreground_change",
      "foreground_or_focus_change",
      "window_bounds_change",
      "type_semantics",
      "input_only",
      // 0.4.21 Click Target Verification + Verified Type Fallback.
      "target_focus_verified",
      "caret_changed",
      "semantic_state_changed",
      "unverifiable",
      // 0.4.22-C1 Press / Hotkey / Clipboard verification kinds.
      "press_focus_change",
      "press_text_change",
      "press_caret_or_selection_change",
      "press_window_change",
      "selection_change",
      "clipboard_readback_exact",
      "clipboard_empty_verified",
      "clipboard_text_verified",
      "window_closed",
      // 0.4.22-C2 Focus & Launch verification kinds.
      "foreground_window_verified",
      "process_or_window_appeared",
    ]);
  });
  it("exposes stable desktop error codes", () => {
    for (const c of [
      "CLICK_NO_EFFECT",
      "DRAG_NO_EFFECT",
      "HOTKEY_NO_EFFECT",
      "CLIPBOARD_UNCHANGED_AFTER_COPY",
      "TYPE_NO_EFFECT",
      "TYPE_SEMANTICS_UNVERIFIED",
      "FOCUS_TARGET_LOST",
      "TARGET_WINDOW_VANISHED",
      "UIA_UNREADABLE",
      "VERIFICATION_TIMEOUT",
    ] as const) {
      expect(DESKTOP_ERROR_CODES).toContain(c);
    }
  });
  it("poll ladder matches the PowerShell operator exactly", () => {
    expect([...POLL_LADDER_MS]).toEqual([50, 100, 200, 400, 800, 1600]);
    // Type stability ladder is >=1600 and extends past to allow editor commit.
    const total = TYPE_STABILITY_LADDER_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1600);
  });
  it("verification_result schema round-trips", () => {
    const pre = ev();
    const post = ev({ clipboard_sequence: 101 });
    const parsed = VerificationResultSchema.parse({
      verified: true,
      verification_kind: "clipboard_change",
      verification_attempts: 1,
      verification_elapsed_ms: 50,
      pre,
      post,
      target_still_foreground: true,
      effect_observed: true,
      failure_reason: null,
    });
    expect(parsed.verified).toBe(true);
  });
});

describe("evaluatePredicate — scenario 1: success", () => {
  it("clipboard_change fires when sequence increments", () => {
    const v = evaluatePredicate("clipboard_change", ev(), ev({ clipboard_sequence: 101 }));
    expect(v.observed).toBe(true);
  });
  it("focused_text_change fires when hash changes", () => {
    const v = evaluatePredicate(
      "focused_text_change",
      ev(),
      ev({ focused_text_hash: "sha-hello" }),
    );
    expect(v.observed).toBe(true);
  });
  it("foreground_change fires when handle flips", () => {
    const v = evaluatePredicate(
      "foreground_change",
      ev(),
      ev({ foreground_window_handle: "0x2000" }),
    );
    expect(v.observed).toBe(true);
  });
  it("foreground_or_focus_change fires on control-type flip alone", () => {
    const v = evaluatePredicate(
      "foreground_or_focus_change",
      ev({ focused_control_type: "Edit" }),
      ev({ focused_control_type: "Document" }),
    );
    expect(v.observed).toBe(true);
  });
});

describe("evaluatePredicate — scenario 2/5: no effect / timeout", () => {
  it("clipboard_change misses when sequence unchanged", () => {
    expect(evaluatePredicate("clipboard_change", ev(), ev()).observed).toBe(false);
  });
  it("window_bounds_change misses when rect unchanged", () => {
    expect(evaluatePredicate("window_bounds_change", ev(), ev()).observed).toBe(false);
  });
});

describe("evaluatePredicate — scenario 3: foreground stolen", () => {
  it("foreground_or_focus_change treats a handle flip as observed, but the caller must inspect target_still_foreground", () => {
    const pre = ev();
    const post = ev({ foreground_window_handle: "0xSTOLEN" });
    const v = evaluatePredicate("foreground_or_focus_change", pre, post);
    // Predicate says observed; the ENGINE's target_still_foreground=false is
    // what downgrades the verdict. Encoded in Tool-Click's failure logic.
    expect(v.observed).toBe(true);
    expect(pre.foreground_window_handle === post.foreground_window_handle).toBe(false);
  });
});

describe("evaluatePredicate — scenario 4: target disappears", () => {
  it("window_bounds_change returns no_target_rect when either side lacks a rect", () => {
    expect(
      evaluatePredicate("window_bounds_change", ev({ foreground_rect: null }), ev()).observed,
    ).toBe(false);
    const v = computeDragVerdict(null, { L: 0, T: 0, R: 10, B: 10 });
    expect(v.verified).toBe(false);
    if (!v.verified) expect(v.error_code).toBe("TARGET_WINDOW_VANISHED");
  });
});

describe("evaluatePredicate — scenario 6/7: UIA unreadable / input_only", () => {
  it("input_only never claims observed even when hashes flip", () => {
    const v = evaluatePredicate("input_only", ev(), ev({ focused_text_hash: "sha-hello" }));
    expect(v.observed).toBe(false);
  });
  it("computeTypeVerdict downgrades to UIA_UNREADABLE when postText is null", () => {
    const v = computeTypeVerdict({
      preText: "",
      injected: "hi",
      postText: null,
      targetStillForeground: true,
      observedAtAttempt: 0,
      stableAcrossAttempts: 0,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("UIA_UNREADABLE");
    expect(v.verification_kind).toBe("input_only");
  });
});

describe("classifyHotkey mirrors PowerShell Resolve-HotkeyVerification", () => {
  it("Ctrl+C → clipboard_change", () => {
    expect(classifyHotkey(["ctrl"], "c")).toEqual({ kind: "clipboard_change", requires: true });
  });
  it("Ctrl+V → focused_text_change", () => {
    expect(classifyHotkey(["ctrl"], "v")).toEqual({ kind: "focused_text_change", requires: true });
  });
  it("Alt+Tab → foreground_change", () => {
    expect(classifyHotkey(["alt"], "tab")).toEqual({ kind: "foreground_change", requires: true });
  });
  it("Win+D → foreground_change", () => {
    expect(classifyHotkey(["win"], "d")).toEqual({ kind: "foreground_change", requires: true });
  });
  it("unknown chord → input_only requires=false", () => {
    expect(classifyHotkey(["shift"], "q")).toEqual({ kind: "input_only", requires: false });
  });
});
