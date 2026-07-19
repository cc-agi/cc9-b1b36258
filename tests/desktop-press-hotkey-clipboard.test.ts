/**
 * 0.4.22-C1 — Press / Hotkey / Clipboard verification pure classifiers.
 *
 * Locks the semantic decision tables so downstream helper-side PowerShell can
 * be re-implemented on top of the same classifiers without regressing.
 */
import { describe, it, expect } from "vitest";
import {
  classifyPress,
  computePressVerdict,
  classifyHotkeyExtended,
  computeHotkeyVerdict,
  computeClipboardWriteVerdict,
  computeClipboardReadVerdict,
  type PressEvidence,
  type HotkeyEvidence,
} from "@/lib/desktop/verifier";
import {
  normalizeVerification,
  evaluateVerificationOutcome,
  buildStepEventFromVerification,
} from "@/lib/desktop/verification-contract";

// ---------------- shared factories

function pressPre(overrides: Partial<PressEvidence> = {}): PressEvidence {
  return {
    foregroundHandle: "0xAA",
    focusedRuntimeId: "rt-1",
    focusedClass: "Edit",
    focusedControlType: "Edit",
    focusedTextHash: "hash-A",
    focusedValueHash: "hash-A",
    focusedTextLength: 10,
    focusedValueLength: 10,
    caret: { X: 100, Y: 200 },
    selectionSnapshot: "sel-A",
    windowExists: true,
    ...overrides,
  };
}

function hotkeyPre(overrides: Partial<HotkeyEvidence> = {}): HotkeyEvidence {
  return {
    foregroundHandle: "0xAA",
    targetWindowExists: true,
    focusedTextHash: "hash-A",
    focusedValueHash: "hash-A",
    selectionLength: 0,
    selectionSnapshot: "sel-A",
    clipboardSequence: 100,
    clipboardFormatAvailable: true,
    clipboardHash: "clip-A",
    ...overrides,
  };
}

// ================================================================ Press

describe("classifyPress — semantic table", () => {
  it("Tab → focus_change / press_focus_change", () => {
    const c = classifyPress("tab");
    expect(c.semantic).toBe("focus_change");
    expect(c.kind).toBe("press_focus_change");
    expect(c.requires).toBe(true);
  });
  it("Backspace/Delete → text length/hash change", () => {
    for (const k of ["backspace", "Delete"]) {
      const c = classifyPress(k);
      expect(c.semantic).toBe("text_length_or_hash_change");
      expect(c.requires).toBe(true);
    }
  });
  it("arrows / Home / End / PageUp / PageDown → caret or selection change", () => {
    for (const k of ["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]) {
      const c = classifyPress(k);
      expect(c.semantic).toBe("caret_or_selection_change");
      expect(c.requires).toBe(true);
    }
  });
  it("Enter → text/focus/window change (requires observation)", () => {
    expect(classifyPress("enter").requires).toBe(true);
  });
  it("Escape → window/focus change", () => {
    expect(classifyPress("escape").requires).toBe(true);
  });
  it("F-keys → observation required", () => {
    for (const k of ["f1", "f5", "f12"]) expect(classifyPress(k).requires).toBe(true);
    expect(classifyPress("f13").requires).toBe(false); // out of range
  });
});

describe("computePressVerdict", () => {
  it("Tab focus change verified when focused_runtime_id differs", () => {
    const v = computePressVerdict("tab", pressPre(), pressPre({ focusedRuntimeId: "rt-2" }));
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("press_focus_change");
    expect(v.error_code).toBeNull();
  });
  it("Backspace verified when focused_text_length shrinks", () => {
    const v = computePressVerdict(
      "backspace",
      pressPre(),
      pressPre({ focusedTextLength: 9, focusedTextHash: "hash-B" }),
    );
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("press_text_change");
  });
  it("Delete with no observable change → PRESS_NO_OBSERVABLE_EFFECT", () => {
    const v = computePressVerdict("delete", pressPre(), pressPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("PRESS_NO_OBSERVABLE_EFFECT");
  });
  it("ArrowRight verified via caret move", () => {
    const v = computePressVerdict("right", pressPre(), pressPre({ caret: { X: 108, Y: 200 } }));
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("press_caret_or_selection_change");
  });
  it("ArrowLeft with no caret/selection evidence → PRESS_EFFECT_UNVERIFIABLE", () => {
    const v = computePressVerdict(
      "left",
      pressPre({ caret: null, selectionSnapshot: null }),
      pressPre({ caret: null, selectionSnapshot: null }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("PRESS_EFFECT_UNVERIFIABLE");
  });
  it("Enter verified when foreground changes (dialog opened)", () => {
    const v = computePressVerdict("enter", pressPre(), pressPre({ foregroundHandle: "0xBB" }));
    expect(v.verified).toBe(true);
  });
  it("Escape with everything unchanged → PRESS_NO_OBSERVABLE_EFFECT", () => {
    const v = computePressVerdict("escape", pressPre(), pressPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("PRESS_NO_OBSERVABLE_EFFECT");
  });
  it("Foreground stolen counts as observable change under Enter semantics", () => {
    const v = computePressVerdict(
      "enter",
      pressPre(),
      pressPre({ foregroundHandle: "0xCC", focusedRuntimeId: null }),
    );
    expect(v.verified).toBe(true);
  });
  it("F5 with no evidence → unverifiable", () => {
    const v = computePressVerdict(
      "f5",
      pressPre({ focusedRuntimeId: null, focusedTextHash: null, caret: null }),
      pressPre({ focusedRuntimeId: null, focusedTextHash: null, caret: null }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("PRESS_EFFECT_UNVERIFIABLE");
  });
  it("Unknown/unclassifiable key → unverifiable, verified=false", () => {
    const v = computePressVerdict("caps_lock", pressPre(), pressPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("PRESS_EFFECT_UNVERIFIABLE");
  });
});

describe("press → contract wiring (step.failed / step.completed)", () => {
  it("verified=false + require_verified=true → step.failed with PRESS_NO_OBSERVABLE_EFFECT", () => {
    const v = computePressVerdict("delete", pressPre(), pressPre());
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      error_code: v.error_code,
      failure_reason: v.reason,
    })!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("PRESS_NO_OBSERVABLE_EFFECT");
    const ev = buildStepEventFromVerification({
      intentId: "i",
      toolName: "desktop_press",
      outcome,
      contract,
    });
    expect(ev.event_type).toBe("step.failed");
    expect(ev.payload.diagnostics).toBeTruthy();
  });
});

// ================================================================ Hotkey

describe("classifyHotkeyExtended — semantic table", () => {
  it("Ctrl+A → selection_change", () => {
    expect(classifyHotkeyExtended(["ctrl"], "a").semantic).toBe("selection_change");
  });
  it("Ctrl+C → clipboard_change", () => {
    expect(classifyHotkeyExtended(["ctrl"], "c").semantic).toBe("clipboard_change");
  });
  it("Ctrl+V → focused_text_change", () => {
    expect(classifyHotkeyExtended(["ctrl"], "v").semantic).toBe("focused_text_change");
  });
  it("Alt+F4 → window_closed", () => {
    expect(classifyHotkeyExtended(["alt"], "f4").semantic).toBe("window_closed");
  });
  it("Alt+Tab → foreground_change", () => {
    expect(classifyHotkeyExtended(["alt"], "tab").semantic).toBe("foreground_change");
  });
  it("Shift+F5 (unknown) → input_only, requires=false", () => {
    const c = classifyHotkeyExtended(["shift"], "f5");
    expect(c.semantic).toBe("input_only");
    expect(c.requires).toBe(false);
  });
});

describe("computeHotkeyVerdict", () => {
  it("Ctrl+A verified via selection snapshot", () => {
    const v = computeHotkeyVerdict(
      ["ctrl"],
      "a",
      hotkeyPre({ selectionSnapshot: null, selectionLength: 0 }),
      hotkeyPre({ selectionSnapshot: "sel-all", selectionLength: 42 }),
    );
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("selection_change");
  });
  it("Ctrl+A with no UIA selection evidence → HOTKEY_EFFECT_UNVERIFIABLE", () => {
    const v = computeHotkeyVerdict(
      ["ctrl"],
      "a",
      hotkeyPre({ selectionSnapshot: null, selectionLength: null }),
      hotkeyPre({ selectionSnapshot: null, selectionLength: null }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("HOTKEY_EFFECT_UNVERIFIABLE");
  });
  it("Ctrl+C verified via clipboard sequence + hash change", () => {
    const v = computeHotkeyVerdict(
      ["ctrl"],
      "c",
      hotkeyPre(),
      hotkeyPre({ clipboardSequence: 101, clipboardHash: "clip-B" }),
    );
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("clipboard_change");
  });
  it("Ctrl+C with empty selection → CLIPBOARD_UNCHANGED_AFTER_COPY", () => {
    const v = computeHotkeyVerdict(["ctrl"], "c", hotkeyPre(), hotkeyPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_UNCHANGED_AFTER_COPY");
  });
  it("Ctrl+V verified when focused_text_hash changes", () => {
    const v = computeHotkeyVerdict(
      ["ctrl"],
      "v",
      hotkeyPre(),
      hotkeyPre({ focusedTextHash: "hash-B" }),
    );
    expect(v.verified).toBe(true);
  });
  it("Ctrl+V with foreground stolen → FOCUS_TARGET_LOST", () => {
    const v = computeHotkeyVerdict(
      ["ctrl"],
      "v",
      hotkeyPre(),
      hotkeyPre({ foregroundHandle: "0xBB", focusedTextHash: "hash-B" }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_TARGET_LOST");
  });
  it("Alt+F4 verified when target window disappears", () => {
    const v = computeHotkeyVerdict(
      ["alt"],
      "f4",
      hotkeyPre(),
      hotkeyPre({ targetWindowExists: false }),
    );
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("window_closed");
  });
  it("Alt+F4 with save dialog (foreground changed, window still exists) counted as verified", () => {
    const v = computeHotkeyVerdict(
      ["alt"],
      "f4",
      hotkeyPre(),
      hotkeyPre({ foregroundHandle: "0xDD" }),
    );
    expect(v.verified).toBe(true);
    expect(v.reason).toBe("close_dialog_present");
  });
  it("Alt+F4 with no observable change → HOTKEY_NO_EFFECT", () => {
    const v = computeHotkeyVerdict(["alt"], "f4", hotkeyPre(), hotkeyPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("HOTKEY_NO_EFFECT");
  });
  it("Alt+Tab verified when foreground handle changes", () => {
    const v = computeHotkeyVerdict(
      ["alt"],
      "tab",
      hotkeyPre(),
      hotkeyPre({ foregroundHandle: "0xEE" }),
    );
    expect(v.verified).toBe(true);
  });
  it("Alt+Tab with foreground unchanged → HOTKEY_NO_EFFECT", () => {
    const v = computeHotkeyVerdict(["alt"], "tab", hotkeyPre(), hotkeyPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("HOTKEY_NO_EFFECT");
  });
  it("Unknown chord → HOTKEY_EFFECT_UNVERIFIABLE", () => {
    const v = computeHotkeyVerdict(["shift"], "f5", hotkeyPre(), hotkeyPre());
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("HOTKEY_EFFECT_UNVERIFIABLE");
  });
});

// ================================================================ Clipboard set

describe("computeClipboardWriteVerdict", () => {
  const base = {
    sequenceBefore: 10,
    sequenceAfter: 11,
    openClipboardSucceeded: true,
    setClipboardDataSucceeded: true,
    readbackAvailable: true,
    readbackLength: 5,
    readbackHash: "h-exp",
    expectedLength: 5,
    expectedHash: "h-exp",
  };
  it("exact readback → verified=true, clipboard_readback_exact", () => {
    const v = computeClipboardWriteVerdict(base);
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("clipboard_readback_exact");
    expect(v.success_reason).toBe("clipboard_content_verified");
  });
  it("length mismatch → CLIPBOARD_WRITE_VERIFY_FAILED", () => {
    const v = computeClipboardWriteVerdict({ ...base, readbackLength: 4 });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_WRITE_VERIFY_FAILED");
    expect(v.reason).toContain("length_mismatch");
  });
  it("hash mismatch (overwritten by other process) → failed", () => {
    const v = computeClipboardWriteVerdict({ ...base, readbackHash: "h-other" });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_WRITE_VERIFY_FAILED");
    expect(v.reason).toContain("overwritten");
  });
  it("sequence did not advance → failed", () => {
    const v = computeClipboardWriteVerdict({ ...base, sequenceAfter: 10 });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_WRITE_VERIFY_FAILED");
  });
  it("OpenClipboard busy → failed with retries_exhausted", () => {
    const v = computeClipboardWriteVerdict({ ...base, openClipboardSucceeded: false });
    expect(v.verified).toBe(false);
    expect(v.reason).toContain("openclipboard_failed");
  });
  it("SetClipboardData failed → failed", () => {
    const v = computeClipboardWriteVerdict({ ...base, setClipboardDataSucceeded: false });
    expect(v.verified).toBe(false);
    expect(v.reason).toContain("setclipboarddata_failed");
  });
  it("no unicode readback available → failed", () => {
    const v = computeClipboardWriteVerdict({ ...base, readbackAvailable: false });
    expect(v.verified).toBe(false);
    expect(v.reason).toContain("unicode_format_unavailable");
  });
});

// ================================================================ Clipboard get

describe("computeClipboardReadVerdict", () => {
  it("normal text → verified=true, clipboard_text_verified", () => {
    const v = computeClipboardReadVerdict({
      openSucceeded: true,
      textFormatAvailable: true,
      readSucceeded: true,
      textLength: 42,
    });
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("clipboard_text_verified");
    expect(v.error_code).toBeNull();
  });
  it("empty clipboard confirmed (text format present, length 0) → EMPTY_CLIPBOARD", () => {
    const v = computeClipboardReadVerdict({
      openSucceeded: true,
      textFormatAvailable: true,
      readSucceeded: true,
      textLength: 0,
    });
    expect(v.verified).toBe(true);
    expect(v.error_code).toBe("EMPTY_CLIPBOARD");
  });
  it("no text format available (image only, etc.) → CLIPBOARD_TEXT_FORMAT_UNAVAILABLE", () => {
    const v = computeClipboardReadVerdict({
      openSucceeded: true,
      textFormatAvailable: false,
      readSucceeded: true,
      textLength: null,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_TEXT_FORMAT_UNAVAILABLE");
  });
  it("OpenClipboard failed → CLIPBOARD_READ_FAILED", () => {
    const v = computeClipboardReadVerdict({
      openSucceeded: false,
      textFormatAvailable: false,
      readSucceeded: false,
      textLength: null,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_READ_FAILED");
  });
  it("GetClipboardData returned null → CLIPBOARD_READ_FAILED", () => {
    const v = computeClipboardReadVerdict({
      openSucceeded: true,
      textFormatAvailable: true,
      readSucceeded: false,
      textLength: null,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("CLIPBOARD_READ_FAILED");
  });
});

// ================================================================ Contract wiring — cross-cutting

describe("contract wiring — clipboard tools do not leak content", () => {
  it("clipboard write contract normalization drops any focused_text body", () => {
    const raw = {
      require_verified: true,
      verified: true,
      verification_kind: "clipboard_readback_exact",
      success_reason: "clipboard_content_verified",
      pre: { clipboard_sequence: 10, clipboard_hash: "prev", focused_text: "SECRET_PASTE" },
      post: { clipboard_sequence: 11, clipboard_hash: "next", focused_text: "SECRET_PASTE" },
    };
    const c = normalizeVerification(raw)!;
    const s = JSON.stringify(c);
    expect(s).not.toContain("SECRET_PASTE");
    expect(c.pre?.clipboard_sequence).toBe(10);
    expect(c.post?.clipboard_hash).toBe("next");
  });
  it("clipboard get verified=true retains no plaintext in normalized/audited contract", () => {
    const raw = {
      require_verified: true,
      verified: true,
      verification_kind: "clipboard_text_verified",
      pre: { clipboard_sequence: 1 },
      post: { clipboard_sequence: 1, clipboard_length: 12, clipboard_hash: "abcd" },
      // Intentional attempt at leaking:
      focused_text: "topsecret-value",
    };
    const c = normalizeVerification(raw)!;
    expect(JSON.stringify(c)).not.toContain("topsecret-value");
  });
  it("hotkey verified=false but tool ok=true still produces step.failed via outcome evaluation", () => {
    const raw = {
      require_verified: true,
      verified: false,
      verification_kind: "clipboard_change",
      error_code: "CLIPBOARD_UNCHANGED_AFTER_COPY",
      failure_reason: "clipboard_sequence_unchanged",
    };
    const c = normalizeVerification(raw)!;
    const o = evaluateVerificationOutcome({ verification: c });
    expect(o.status).toBe("failed");
    expect(o.errorCode).toBe("CLIPBOARD_UNCHANGED_AFTER_COPY");
    const ev = buildStepEventFromVerification({
      intentId: "i",
      toolName: "desktop_hotkey",
      outcome: o,
      contract: c,
    });
    expect(ev.event_type).toBe("step.failed");
  });
});
