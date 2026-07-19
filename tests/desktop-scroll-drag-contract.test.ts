/**
 * 0.4.22-D — Scroll & Drag Verification Contract.
 *
 * Exercises the pure verdict helpers `computeScrollVerdict` and
 * `computeDragScenarioVerdict`, the surrounding contract wiring, and the
 * PowerShell operator's Tool-Scroll / Tool-Drag sources to ensure they:
 *   - Never claim success solely because SendInput / mouse_event returned.
 *   - Report the correct error_code per scenario.
 *   - Whitelist scroll/drag evidence in the shared verification contract.
 *   - Drop raw content bodies from the audit-safe evidence payload.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeDragScenarioVerdict,
  computeScrollVerdict,
  DESKTOP_ERROR_CODES,
  VERIFICATION_KINDS,
  type DragInput,
  type DragSnapshot,
  type ScrollInput,
  type ScrollSnapshot,
} from "@/lib/desktop/verifier";
import {
  EVIDENCE_ALLOWED_FIELDS,
  evaluateVerificationOutcome,
  normalizeVerification,
} from "@/lib/desktop/verification-contract";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

// --- fixtures ---------------------------------------------------------------

function baseScrollSnap(overrides: Partial<ScrollSnapshot> = {}): ScrollSnapshot {
  return {
    foregroundWindowHandle: "1000",
    focusedRuntimeId: "runtime-a",
    targetRuntimeId: "runtime-a",
    targetBounds: { L: 0, T: 0, R: 800, B: 600 },
    scrollPatternAvailable: true,
    horizontalScrollPercent: 0,
    verticalScrollPercent: 30,
    horizontalViewSize: 100,
    verticalViewSize: 25,
    visibleAnchorHash: "hash-pre",
    scrollbarPosition: { h: 0, v: 240 },
    selectionHash: null,
    selectionLength: null,
    ...overrides,
  };
}

function scrollInput(
  pre: ScrollSnapshot,
  post: ScrollSnapshot,
  o: Partial<ScrollInput> = {},
): ScrollInput {
  return {
    direction: "vertical",
    requestedDeltaX: 0,
    requestedDeltaY: -120,
    inputDispatched: true,
    pre,
    post,
    requireVerified: true,
    ...o,
  };
}

function baseDragSnap(overrides: Partial<DragSnapshot> = {}): DragSnapshot {
  return {
    window: { foregroundWindowHandle: "1000", windowRect: { L: 10, T: 10, R: 810, B: 610 } },
    source: {
      runtimeId: "src-1",
      exists: true,
      bounds: { L: 100, T: 100, R: 200, B: 130 },
      controlType: "Button",
      windowClass: null,
      topLevelWindowHandle: "1000",
      rangeValue: null,
      toggleState: null,
      containerChildCount: null,
    },
    target: {
      runtimeId: "tgt-1",
      exists: true,
      bounds: { L: 500, T: 100, R: 700, B: 400 },
      controlType: "Pane",
      windowClass: null,
      topLevelWindowHandle: "1000",
      rangeValue: null,
      toggleState: null,
      containerChildCount: 3,
    },
    scroll: {
      horizontalScrollPercent: 0,
      verticalScrollPercent: 0,
      scrollbarPosition: { h: 0, v: 0 },
    },
    selection: { selectionLength: 0, selectionHash: null },
    focusedRuntimeId: "src-1",
    ...overrides,
  };
}

function dragInput(pre: DragSnapshot, post: DragSnapshot, o: Partial<DragInput> = {}): DragInput {
  return {
    scenario: "auto",
    fromPoint: { x: 150, y: 115 },
    toPoint: { x: 600, y: 250 },
    targetPointRuntimeId: "tgt-1",
    inputDispatched: true,
    pre,
    post,
    requireVerified: true,
    ...o,
  };
}

// --- identifier tables ------------------------------------------------------

describe("0.4.22-D identifier tables", () => {
  it("registers scroll/drag verification kinds", () => {
    expect(VERIFICATION_KINDS).toContain("scroll_position_changed");
    expect(VERIFICATION_KINDS).toContain("drag_effect_observed");
  });
  it("registers scroll/drag error codes", () => {
    for (const c of [
      "SCROLL_AT_BOUNDARY",
      "SCROLL_NO_EFFECT",
      "SCROLL_EFFECT_UNVERIFIABLE",
      "DRAG_EFFECT_UNVERIFIABLE",
      "DRAG_SOURCE_NOT_FOUND",
      "DRAG_TARGET_NOT_FOUND",
      "DRAG_TARGET_LOST",
      "DRAG_WRONG_TARGET",
    ] as const) {
      expect(DESKTOP_ERROR_CODES).toContain(c);
    }
  });
  it("whitelists scroll/drag evidence in the shared contract", () => {
    for (const f of [
      "horizontal_scroll_percent",
      "vertical_scroll_percent",
      "visible_anchor_hash",
      "scrollbar_position",
      "source_runtime_id",
      "target_runtime_id",
      "range_value",
      "container_child_count",
      "scenario_resolved",
      "evidence_source",
    ]) {
      expect(EVIDENCE_ALLOWED_FIELDS).toContain(f);
    }
  });
});

// --- scroll verdict --------------------------------------------------------

describe("computeScrollVerdict", () => {
  it("verifies via UIA ScrollPattern percent change", () => {
    const v = computeScrollVerdict(
      scrollInput(baseScrollSnap(), baseScrollSnap({ verticalScrollPercent: 55 })),
    );
    expect(v.verified).toBe(true);
    expect(v.success_reason).toBe("scroll_effect_observed");
    expect(v.evidence_source).toBe("scroll_pattern");
    expect(v.failure_reason).toBeNull();
  });

  it("verifies via scrollbar position when ScrollPattern is unchanged", () => {
    const pre = baseScrollSnap({ verticalScrollPercent: 30, scrollbarPosition: { h: 0, v: 240 } });
    const post = baseScrollSnap({ verticalScrollPercent: 30, scrollbarPosition: { h: 0, v: 260 } });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("scrollbar_position");
  });

  it("verifies via visible anchor hash change", () => {
    const pre = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: "a",
    });
    const post = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: "b",
    });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("visible_anchor");
  });

  it("falls back to focused/selection evidence when other channels absent", () => {
    const pre = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: "x",
      focusedRuntimeId: "a",
    });
    const post = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: "x",
      focusedRuntimeId: "b",
    });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("focused_or_selection");
  });

  it("reports SCROLL_AT_BOUNDARY when direction is already at boundary and nothing moved", () => {
    const pre = baseScrollSnap({ verticalScrollPercent: 0 });
    const post = baseScrollSnap({ verticalScrollPercent: 0 });
    const v = computeScrollVerdict(
      scrollInput(pre, post, { direction: "vertical", requestedDeltaY: 120 }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("SCROLL_AT_BOUNDARY");
  });

  it("reports SCROLL_NO_EFFECT when input dispatched but nothing changed away from boundary", () => {
    const pre = baseScrollSnap({ verticalScrollPercent: 30 });
    const post = baseScrollSnap({ verticalScrollPercent: 30 });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("SCROLL_NO_EFFECT");
    expect(v.failure_reason).toBe("scroll_input_dispatched_but_no_position_change_observed");
  });

  it("reports FOCUS_TARGET_LOST when foreground handle changes during scroll", () => {
    const pre = baseScrollSnap();
    const post = baseScrollSnap({ foregroundWindowHandle: "2000", verticalScrollPercent: 55 });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_TARGET_LOST");
    expect(v.target_still_foreground).toBe(false);
  });

  it("reports SCROLL_EFFECT_UNVERIFIABLE when no evidence channel is available", () => {
    const pre = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: null,
    });
    const post = baseScrollSnap({
      scrollPatternAvailable: false,
      scrollbarPosition: null,
      visibleAnchorHash: null,
    });
    const v = computeScrollVerdict(scrollInput(pre, post));
    expect(v.error_code).toBe("SCROLL_EFFECT_UNVERIFIABLE");
  });

  it("cannot yield step.completed when require_verified=true and verified=false", () => {
    const pre = baseScrollSnap();
    const post = baseScrollSnap();
    const v = computeScrollVerdict(scrollInput(pre, post));
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      failure_reason: v.failure_reason,
      success_reason: v.success_reason,
      error_code: v.error_code,
      verification_attempts: 1,
      verification_elapsed_ms: 40,
      pre: { vertical_scroll_percent: 30 },
      post: { vertical_scroll_percent: 30 },
      target_still_foreground: true,
    });
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("SCROLL_NO_EFFECT");
  });
});

// --- drag verdict ----------------------------------------------------------

describe("computeDragScenarioVerdict", () => {
  it("verifies a window drag by rect change", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      window: { foregroundWindowHandle: "1000", windowRect: { L: 60, T: 40, R: 860, B: 640 } },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "window" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("window_rect");
    expect(v.success_reason).toBe("drag_state_changed");
  });

  it("verifies a scrollbar drag by scrollbar position change", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      scroll: {
        horizontalScrollPercent: 0,
        verticalScrollPercent: 40,
        scrollbarPosition: { h: 0, v: 320 },
      },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "scrollbar" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("scroll_position");
  });

  it("verifies a slider drag by range value change", () => {
    const pre = baseDragSnap({
      source: { ...baseDragSnap().source, controlType: "Slider", rangeValue: 25 },
      target: { ...baseDragSnap().target, controlType: "Slider", rangeValue: 25 },
    });
    const post = baseDragSnap({
      source: { ...baseDragSnap().source, controlType: "Slider", rangeValue: 75 },
      target: { ...baseDragSnap().target, controlType: "Slider", rangeValue: 75 },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "slider" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("range_value");
  });

  it("verifies a selection drag by selection length change", () => {
    const pre = baseDragSnap({ selection: { selectionLength: 0, selectionHash: null } });
    const post = baseDragSnap({ selection: { selectionLength: 42, selectionHash: "sha-post" } });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "selection" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("selection");
  });

  it("verifies a drop when source element disappears", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      source: { ...pre.source, exists: false, bounds: null, runtimeId: null },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("source_disappeared");
  });

  it("verifies a drop when container child count grows", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      target: { ...pre.target, containerChildCount: 4 },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.verified).toBe(true);
    expect(v.evidence_source).toBe("container_content");
  });

  it("returns DRAG_SOURCE_NOT_FOUND when source did not exist pre-drag", () => {
    const pre = baseDragSnap({ source: { ...baseDragSnap().source, exists: false } });
    const post = baseDragSnap();
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("DRAG_SOURCE_NOT_FOUND");
  });

  it("returns DRAG_TARGET_NOT_FOUND when target absent for drop", () => {
    const pre = baseDragSnap({ target: { ...baseDragSnap().target, exists: false } });
    const post = baseDragSnap({ target: { ...baseDragSnap().target, exists: false } });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.error_code).toBe("DRAG_TARGET_NOT_FOUND");
  });

  it("returns DRAG_TARGET_LOST when the target vanishes mid-drop", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({ target: { ...pre.target, exists: false } });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.error_code).toBe("DRAG_TARGET_LOST");
  });

  it("returns DRAG_WRONG_TARGET when drop lands on a different element", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      target: { ...pre.target, runtimeId: "someone-else" },
    });
    const v = computeDragScenarioVerdict(
      dragInput(pre, post, { scenario: "drop", targetPointRuntimeId: "tgt-1" }),
    );
    expect(v.error_code).toBe("DRAG_WRONG_TARGET");
  });

  it("returns DRAG_NO_EFFECT when input completes but nothing changes", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap();
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "window" }));
    expect(v.error_code).toBe("DRAG_NO_EFFECT");
    expect(v.failure_reason).toBe("drag_dispatched_but_no_state_change_observed");
  });

  it("returns FOCUS_TARGET_LOST when foreground handle changes during drag", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap({
      window: { foregroundWindowHandle: "9999", windowRect: pre.window.windowRect },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "window" }));
    expect(v.error_code).toBe("FOCUS_TARGET_LOST");
    expect(v.target_still_foreground).toBe(false);
  });

  it("returns DRAG_EFFECT_UNVERIFIABLE when no channel is readable", () => {
    const pre = baseDragSnap({
      window: { foregroundWindowHandle: "1000", windowRect: null },
      source: { ...baseDragSnap().source, bounds: null },
      target: { ...baseDragSnap().target, bounds: null, containerChildCount: null },
      scroll: {
        horizontalScrollPercent: null,
        verticalScrollPercent: null,
        scrollbarPosition: null,
      },
      selection: { selectionLength: null, selectionHash: null },
    });
    const post = baseDragSnap({
      window: { foregroundWindowHandle: "1000", windowRect: null },
      source: { ...baseDragSnap().source, bounds: null },
      target: { ...baseDragSnap().target, bounds: null, containerChildCount: null },
      scroll: {
        horizontalScrollPercent: null,
        verticalScrollPercent: null,
        scrollbarPosition: null,
      },
      selection: { selectionLength: null, selectionHash: null },
    });
    const v = computeDragScenarioVerdict(dragInput(pre, post, { scenario: "drop" }));
    expect(v.error_code).toBe("DRAG_EFFECT_UNVERIFIABLE");
  });

  it("cannot succeed even when the helper claims mouse events dispatched cleanly", () => {
    const pre = baseDragSnap();
    const post = baseDragSnap();
    const v = computeDragScenarioVerdict(
      dragInput(pre, post, { scenario: "window", inputDispatched: true }),
    );
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      failure_reason: v.failure_reason,
      success_reason: v.success_reason,
      error_code: v.error_code,
      verification_attempts: 1,
      verification_elapsed_ms: 60,
      pre: { window_rect: pre.window.windowRect, source_runtime_id: "src-1" },
      post: { window_rect: post.window.windowRect, source_runtime_id: "src-1" },
      target_still_foreground: true,
    });
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("DRAG_NO_EFFECT");
  });
});

// --- redaction & contract wiring --------------------------------------------

describe("scroll/drag contract redaction", () => {
  it("drops raw text bodies from pre/post evidence", () => {
    const contract = normalizeVerification({
      require_verified: true,
      verified: false,
      verification_kind: "scroll_position_changed",
      failure_reason: "no_change",
      success_reason: null,
      error_code: "SCROLL_NO_EFFECT",
      verification_attempts: 1,
      verification_elapsed_ms: 10,
      pre: {
        vertical_scroll_percent: 30,
        visible_anchor_hash: "aaa",
        // Sensitive fields that MUST be dropped by the whitelist.
        page_full_text: "TOP SECRET DOCUMENT",
        user_home_dir: "C:/Users/alice/Desktop/secrets.txt",
        file_names: ["passwords.txt", "diary.md"],
        selection_text: "SSN 123-45-6789",
      },
      post: {
        vertical_scroll_percent: 30,
        visible_anchor_hash: "aaa",
        page_full_text: "TOP SECRET DOCUMENT",
      },
      target_still_foreground: true,
    });
    expect(contract).not.toBeNull();
    const pre = contract!.pre as Record<string, unknown>;
    expect(pre.page_full_text).toBeUndefined();
    expect(pre.user_home_dir).toBeUndefined();
    expect(pre.file_names).toBeUndefined();
    expect(pre.selection_text).toBeUndefined();
    expect(pre.vertical_scroll_percent).toBe(30);
    expect(pre.visible_anchor_hash).toBe("aaa");
  });

  it("normalizes a helper drag blob and evaluates it as failed when unverified", () => {
    const contract = normalizeVerification({
      require_verified: true,
      verified: false,
      verification_kind: "drag_effect_observed",
      failure_reason: "drag_dispatched_but_no_state_change_observed",
      error_code: "DRAG_NO_EFFECT",
      verification_attempts: 4,
      verification_elapsed_ms: 1600,
      pre: {
        window_rect: { L: 0, T: 0, R: 100, B: 100 },
        source_runtime_id: "src",
        scenario_resolved: "window",
      },
      post: {
        window_rect: { L: 0, T: 0, R: 100, B: 100 },
        source_runtime_id: "src",
        scenario_resolved: "window",
      },
      target_still_foreground: true,
    });
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("DRAG_NO_EFFECT");
  });
});

// --- PowerShell wiring -----------------------------------------------------

describe("helper/desktop-operator.ps1 scroll/drag wiring", () => {
  it("Tool-Scroll captures pre/post snapshots and calls Build-ScrollVerification", () => {
    const idx = operator.indexOf("function Tool-Scroll");
    expect(idx).toBeGreaterThan(0);
    const body = operator.slice(idx, idx + 4000);
    expect(body).toMatch(/Get-ScrollSnapshot[\s\S]*Build-ScrollVerification/);
    expect(body).toMatch(/require_verified/);
    // Tool-Scroll must never return ok=true purely because SendInput succeeded;
    // the verdict codes themselves live in Build-ScrollVerification (asserted below).
  });

  it("Tool-Drag captures pre/post snapshots and calls Build-DragVerification", () => {
    const idx = operator.indexOf("function Tool-Drag");
    expect(idx).toBeGreaterThan(0);
    const body = operator.slice(idx, idx + 6000);
    expect(body).toMatch(/Get-DragSnapshot/);
    expect(body).toMatch(/Build-DragVerification/);
    expect(body).toMatch(/scenario/);
    expect(body).toMatch(/DRAG_NO_EFFECT/);
  });

  it("Build-ScrollVerification mirrors the TypeScript verdict identifiers", () => {
    const idx = operator.indexOf("function Build-ScrollVerification");
    expect(idx).toBeGreaterThan(0);
    const body = operator.slice(idx, idx + 4000);
    expect(body).toMatch(/scroll_position_changed/);
    for (const kw of [
      "SCROLL_NO_EFFECT",
      "SCROLL_AT_BOUNDARY",
      "SCROLL_EFFECT_UNVERIFIABLE",
      "FOCUS_TARGET_LOST",
      "scroll_effect_observed",
    ]) {
      expect(body).toContain(kw);
    }
  });

  it("Build-DragVerification mirrors the TypeScript verdict identifiers", () => {
    const idx = operator.indexOf("function Build-DragVerification");
    expect(idx).toBeGreaterThan(0);
    const body = operator.slice(idx, idx + 6000);
    expect(body).toMatch(/drag_effect_observed/);
    for (const kw of [
      "DRAG_NO_EFFECT",
      "DRAG_SOURCE_NOT_FOUND",
      "DRAG_TARGET_NOT_FOUND",
      "DRAG_TARGET_LOST",
      "DRAG_WRONG_TARGET",
      "DRAG_EFFECT_UNVERIFIABLE",
      "FOCUS_TARGET_LOST",
      "drag_state_changed",
    ]) {
      expect(body).toContain(kw);
    }
  });
});
