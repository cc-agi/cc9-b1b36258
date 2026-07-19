/**
 * 0.4.20 Action Verification Engine — unified TypeScript verifier module.
 *
 * This file is the SINGLE source of truth for:
 *   - Stable verification-kind identifiers used by desktop_click / desktop_drag /
 *     desktop_hotkey / desktop_type diagnostics.
 *   - Stable desktop_* error codes surfaced to MCP callers when a verified
 *     action's classified effect predicate never fires.
 *   - Zod schemas that describe the shape of the `pre` / `post` evidence
 *     records and the `verification_result` block the PowerShell operator
 *     embeds in every effect-bearing tool response.
 *   - Pure, deterministic predicate evaluators + verdict helpers used by the
 *     Vitest regressions in tests/desktop-verifier.test.ts,
 *     tests/desktop-drag-regression.test.ts, and
 *     tests/desktop-type-prosemirror-omnibox.test.ts.
 *
 * The helper (helper/desktop-operator.ps1) mirrors the same predicates in
 * PowerShell so the operator side can enforce them without depending on the
 * cloud. Both sides MUST stay in lockstep on the identifiers below; the
 * verify:release Gate 28 fails when they drift.
 */
import { z } from "zod";

// ---------- Stable identifier tables ----------

export const VERIFICATION_KINDS = [
  "clipboard_change",
  "focused_text_change",
  "foreground_change",
  "foreground_or_focus_change",
  "window_bounds_change",
  "type_semantics",
  "input_only",
  // 0.4.21 — Click Target Verification.
  "target_focus_verified",
  "caret_changed",
  "semantic_state_changed",
  "unverifiable",
  // 0.4.22-C1 — Press / Hotkey / Clipboard verification kinds.
  "press_focus_change",
  "press_text_change",
  "press_caret_or_selection_change",
  "press_window_change",
  "selection_change",
  "clipboard_readback_exact",
  "clipboard_empty_verified",
  "clipboard_text_verified",
  "window_closed",
  // 0.4.22-C2 — Focus / Launch verification kinds.
  "foreground_window_verified",
  "process_or_window_appeared",
  // 0.4.22-D — Scroll / Drag verification kinds.
  "scroll_position_changed",
  "drag_effect_observed",
] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export const DESKTOP_ERROR_CODES = [
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
  "FOCUS_CONTROL_INVALID",
  "FOCUS_TARGET_MISMATCH",
  // 0.4.21.
  "TYPE_FALLBACK_FAILED",
  // 0.4.22-C1 — press / hotkey / clipboard error codes.
  "PRESS_NO_OBSERVABLE_EFFECT",
  "PRESS_EFFECT_UNVERIFIABLE",
  "HOTKEY_EFFECT_UNVERIFIABLE",
  "CLIPBOARD_WRITE_VERIFY_FAILED",
  "CLIPBOARD_READ_FAILED",
  "CLIPBOARD_TEXT_FORMAT_UNAVAILABLE",
  "EMPTY_CLIPBOARD",
  // 0.4.22-C2 — focus / launch verification error codes.
  "FOCUS_VERIFICATION_FAILED",
  "FOCUS_TARGET_NOT_FOUND",
  "FOCUS_TARGET_NOT_VISIBLE",
  "FOCUS_WINDOW_STATE_MISMATCH",
  "LAUNCH_VERIFICATION_FAILED",
  "LAUNCH_PROCESS_NOT_OBSERVED",
  "LAUNCH_WINDOW_NOT_OBSERVED",
  "LAUNCH_WRONG_PROCESS",
  "LAUNCH_TIMEOUT",
  // 0.4.22-D — scroll / drag verification error codes.
  "SCROLL_AT_BOUNDARY",
  "SCROLL_NO_EFFECT",
  "SCROLL_EFFECT_UNVERIFIABLE",
  "DRAG_EFFECT_UNVERIFIABLE",
  "DRAG_SOURCE_NOT_FOUND",
  "DRAG_TARGET_NOT_FOUND",
  "DRAG_TARGET_LOST",
  "DRAG_WRONG_TARGET",
] as const;
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

// Cumulative poll ladder in milliseconds. MUST match the PowerShell helper's
// @(50, 100, 200, 400, 800, 1600) exactly.
export const POLL_LADDER_MS = [50, 100, 200, 400, 800, 1600] as const;

// Extended ladder used by Tool-Type for editors that debounce their model
// updates (ProseMirror, Monaco, Slate). Cumulative to ~3200 ms so the initial
// SendInput does not race the editor's render pass.
export const TYPE_STABILITY_LADDER_MS = [50, 100, 100, 200, 200, 400, 400, 800, 800, 200] as const;

// ---------- Schemas ----------

const RectSchema = z
  .object({
    L: z.number(),
    T: z.number(),
    R: z.number(),
    B: z.number(),
    W: z.number(),
    H: z.number(),
  })
  .nullable();

export const EvidenceSchema = z.object({
  foreground_window_handle: z.string(),
  foreground_class: z.string().nullable().optional(),
  foreground_title: z.string().nullable().optional(),
  foreground_rect: RectSchema.optional(),
  focused_class: z.string().nullable().optional(),
  focused_control_type: z.string().nullable().optional(),
  focused_text: z.string().nullable().optional(),
  focused_value: z.string().nullable().optional(),
  focused_text_length: z.number().int().nonnegative().optional(),
  focused_value_length: z.number().int().nonnegative().optional(),
  focused_text_hash: z.string().nullable().optional(),
  focused_value_hash: z.string().nullable().optional(),
  is_document_or_edit: z.boolean().optional(),
  clipboard_sequence: z.number().int().nonnegative(),
  captured_at_ms: z.number().int().nonnegative(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const VerificationResultSchema = z.object({
  verified: z.boolean(),
  verification_kind: z.enum(VERIFICATION_KINDS),
  verification_attempts: z.number().int().nonnegative(),
  verification_elapsed_ms: z.number().int().nonnegative(),
  pre: EvidenceSchema,
  post: EvidenceSchema,
  target_still_foreground: z.boolean(),
  effect_observed: z.boolean(),
  failure_reason: z.string().nullable(),
  action_error: z.string().nullable().optional(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ---------- Predicate evaluators (pure) ----------

export type PredicateVerdict = { observed: boolean; reason: string };

export function evaluatePredicate(
  kind: VerificationKind,
  pre: Evidence,
  post: Evidence,
): PredicateVerdict {
  switch (kind) {
    case "clipboard_change":
      return post.clipboard_sequence !== pre.clipboard_sequence
        ? { observed: true, reason: "clipboard_sequence_changed" }
        : { observed: false, reason: "clipboard_sequence_unchanged" };

    case "focused_text_change":
      return post.focused_text_hash !== pre.focused_text_hash ||
        post.focused_value_hash !== pre.focused_value_hash
        ? { observed: true, reason: "focused_text_hash_changed" }
        : { observed: false, reason: "focused_text_hash_unchanged" };

    case "foreground_change":
      return post.foreground_window_handle !== pre.foreground_window_handle
        ? { observed: true, reason: "foreground_window_handle_changed" }
        : { observed: false, reason: "foreground_window_unchanged" };

    case "foreground_or_focus_change": {
      if (post.foreground_window_handle !== pre.foreground_window_handle) {
        return { observed: true, reason: "foreground_window_handle_changed" };
      }
      if (
        post.focused_class !== pre.focused_class ||
        post.focused_control_type !== pre.focused_control_type
      ) {
        return { observed: true, reason: "focused_control_changed" };
      }
      if (
        post.focused_text_hash !== pre.focused_text_hash ||
        post.focused_value_hash !== pre.focused_value_hash
      ) {
        return { observed: true, reason: "focused_text_hash_changed" };
      }
      const a = pre.foreground_rect;
      const b = post.foreground_rect;
      if (a && b && (a.L !== b.L || a.T !== b.T || a.R !== b.R || a.B !== b.B)) {
        return { observed: true, reason: "foreground_rect_changed" };
      }
      return { observed: false, reason: "no_focus_or_text_or_bounds_change" };
    }

    case "window_bounds_change": {
      const a = pre.foreground_rect;
      const b = post.foreground_rect;
      if (!a || !b) return { observed: false, reason: "no_target_rect" };
      if (a.L !== b.L || a.T !== b.T) return { observed: true, reason: "target_window_moved" };
      if (a.W !== b.W || a.H !== b.H) return { observed: true, reason: "target_window_resized" };
      return { observed: false, reason: "target_rect_unchanged" };
    }

    case "type_semantics":
      // Type semantics are decided by computeTypeVerdict, not the pre/post
      // predicate alone. Return input_only so callers never claim
      // verified=true purely from the raw hash comparison.
      return { observed: false, reason: "type_semantics_requires_computeTypeVerdict" };

    case "input_only":
      return { observed: false, reason: "input_only_semantics" };

    case "target_focus_verified":
    case "caret_changed":
    case "semantic_state_changed":
    case "unverifiable":
      // 0.4.21 — decided by computeClickVerdict, not by pre/post predicate.
      return { observed: false, reason: "click_semantics_requires_computeClickVerdict" };

    case "press_focus_change":
    case "press_text_change":
    case "press_caret_or_selection_change":
    case "press_window_change":
      // 0.4.22-C1 — decided by computePressVerdict.
      return { observed: false, reason: "press_semantics_requires_computePressVerdict" };

    case "selection_change":
    case "clipboard_readback_exact":
    case "clipboard_empty_verified":
    case "clipboard_text_verified":
    case "window_closed":
      // 0.4.22-C1 — decided by dedicated hotkey / clipboard verdict helpers.
      return { observed: false, reason: "requires_dedicated_verdict_helper" };

    case "foreground_window_verified":
    case "process_or_window_appeared":
      // 0.4.22-C2 — decided by computeFocusWindowVerdict / computeLaunchVerdict.
      return { observed: false, reason: "requires_focus_or_launch_verdict_helper" };

    case "scroll_position_changed":
    case "drag_effect_observed":
      // 0.4.22-D — decided by computeScrollVerdict / computeDragVerdict.
      return { observed: false, reason: "requires_scroll_or_drag_verdict_helper" };
  }
}

// ---------- Drag verdict (pure) ----------

export type DragRect = { L: number; T: number; R: number; B: number };

export type DragVerdict =
  | { verified: true; reason: "target_window_moved" | "target_window_resized" }
  | {
      verified: false;
      error_code: "DRAG_NO_EFFECT" | "TARGET_WINDOW_VANISHED";
      reason: string;
    };

export function computeDragVerdict(before: DragRect | null, after: DragRect | null): DragVerdict {
  if (!before || !after) {
    return {
      verified: false,
      error_code: "TARGET_WINDOW_VANISHED",
      reason: "target_rect_unavailable",
    };
  }
  if (before.L !== after.L || before.T !== after.T) {
    return { verified: true, reason: "target_window_moved" };
  }
  if (before.R - before.L !== after.R - after.L || before.B - before.T !== after.B - after.T) {
    return { verified: true, reason: "target_window_resized" };
  }
  return {
    verified: false,
    error_code: "DRAG_NO_EFFECT",
    reason: "target_rect_unchanged",
  };
}

// ---------- Type verdict (pure) ----------

export type TypeVerdictInput = {
  preText: string;
  injected: string;
  postText: string | null; // null = UIA unreadable
  targetStillForeground: boolean;
  observedAtAttempt: number; // 0 = never observed
  stableAcrossAttempts: number; // consecutive polls where hash matched final
};

export type TypeVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
  semantic: "empty_exact" | "append" | "replace" | "ambiguous" | "input_only";
};

/**
 * Type verdict encoding the two field regressions the operator hit in prod:
 *
 *  - ProseMirror: SendInput commits immediately but the editor's React render
 *    debounces the model update. The first UIA poll (50 ms) reads the stale
 *    string; the change only appears after ~600-1200 ms. We MUST wait for
 *    stability (`stableAcrossAttempts >= 2`) before we accept the verdict,
 *    and MUST NOT fail with TYPE_NO_EFFECT on the first missed poll.
 *
 *  - Omnibox: the address bar already contains a long URL. Typing appends
 *    (or replaces the selection). UIA returns only a truncated `Value` for
 *    long strings, so a naive hash-changed check can report `verified=true`
 *    even when the injected characters were dropped. We require the post
 *    text to encode either an append (`postText.endsWith(injected)`), a
 *    length-delta consistent with an append/replace inside the truncation
 *    budget, or we downgrade to `input_only` and refuse to claim verified.
 */
export function computeTypeVerdict(input: TypeVerdictInput): TypeVerdict {
  const {
    preText,
    injected,
    postText,
    targetStillForeground,
    observedAtAttempt,
    stableAcrossAttempts,
  } = input;

  if (!targetStillForeground) {
    return {
      verified: false,
      verification_kind: "type_semantics",
      error_code: "FOCUS_TARGET_LOST",
      reason: "foreground_window_changed_during_type",
      semantic: "ambiguous",
    };
  }
  if (postText === null) {
    return {
      verified: false,
      verification_kind: "input_only",
      error_code: "UIA_UNREADABLE",
      reason: "uia_text_value_pattern_unavailable",
      semantic: "input_only",
    };
  }
  if (observedAtAttempt === 0) {
    return {
      verified: false,
      verification_kind: "type_semantics",
      error_code: "TYPE_NO_EFFECT",
      reason: "no_uia_change_within_stability_window",
      semantic: "ambiguous",
    };
  }
  // Stability window — the editor must have committed and stopped churning.
  if (stableAcrossAttempts < 2) {
    return {
      verified: false,
      verification_kind: "type_semantics",
      error_code: "TYPE_SEMANTICS_UNVERIFIED",
      reason: "uia_text_still_churning_no_stability",
      semantic: "ambiguous",
    };
  }

  // Semantics classification.
  if (preText.length === 0) {
    const trimmed = postText.replace(/[\r\n]+$/, "");
    if (postText === injected || trimmed === injected) {
      return {
        verified: true,
        verification_kind: "type_semantics",
        error_code: null,
        reason: "empty_target_exact_match",
        semantic: "empty_exact",
      };
    }
    return {
      verified: false,
      verification_kind: "type_semantics",
      error_code: "TYPE_SEMANTICS_UNVERIFIED",
      reason: "empty_target_mismatch",
      semantic: "ambiguous",
    };
  }

  // Non-empty target. Two acceptable shapes:
  //   1. append: postText === preText + injected (± trailing CR/LF)
  //   2. replace: postText === injected (selection was live)
  const appendCandidate = preText + injected;
  const appendTrimmed = appendCandidate.replace(/[\r\n]+$/, "");
  if (postText === appendCandidate || postText === appendTrimmed) {
    return {
      verified: true,
      verification_kind: "type_semantics",
      error_code: null,
      reason: "append_after_existing_text",
      semantic: "append",
    };
  }
  if (postText === injected) {
    return {
      verified: true,
      verification_kind: "type_semantics",
      error_code: null,
      reason: "replaced_existing_selection",
      semantic: "replace",
    };
  }

  // Truncation heuristic: UIA truncates long Value strings. If postText is
  // shorter than pre+injected but is a strict prefix of it AND the injected
  // string is longer than the truncation delta, we cannot confirm append.
  // Refuse verified=true and downgrade to input_only.
  if (
    postText.length < appendCandidate.length &&
    appendCandidate.startsWith(postText) &&
    injected.length > 0
  ) {
    return {
      verified: false,
      verification_kind: "input_only",
      error_code: "TYPE_SEMANTICS_UNVERIFIED",
      reason: "uia_value_appears_truncated_cannot_confirm_semantics",
      semantic: "input_only",
    };
  }

  return {
    verified: false,
    verification_kind: "type_semantics",
    error_code: "TYPE_SEMANTICS_UNVERIFIED",
    reason: "post_text_does_not_match_append_or_replace",
    semantic: "ambiguous",
  };
}

// ---------- Hotkey classification (pure, mirrors Resolve-HotkeyVerification) ----------

export function classifyHotkey(
  modifiers: readonly ("ctrl" | "shift" | "alt" | "win")[],
  key: string,
): { kind: VerificationKind; requires: boolean } {
  const hasCtrl = modifiers.includes("ctrl");
  const hasAlt = modifiers.includes("alt");
  const hasWin = modifiers.includes("win");
  const k = key.toLowerCase();
  if (hasCtrl && (k === "c" || k === "x")) return { kind: "clipboard_change", requires: true };
  if (hasCtrl && (k === "v" || k === "z" || k === "y"))
    return { kind: "focused_text_change", requires: true };
  if (hasCtrl && k === "a") return { kind: "input_only", requires: false };
  if (hasAlt && (k === "tab" || k === "f4" || k === "escape"))
    return { kind: "foreground_change", requires: true };
  if (hasWin && (k === "d" || k === "e" || k === "r" || k === "tab"))
    return { kind: "foreground_change", requires: true };
  if (hasCtrl && ["n", "o", "w", "s", "t"].includes(k))
    return { kind: "foreground_or_focus_change", requires: true };
  return { kind: "input_only", requires: false };
}

// ---------- 0.4.21 Click Target Verification (pure) ----------
//
// Finding A regression: clicking an already-focused Notepad RichEditD2DPT
// Document at (400,300) legitimately preserves foreground, focus, text and
// bounds. The 0.4.20 `foreground_or_focus_change` predicate reported
// CLICK_NO_EFFECT for that case even though the click hit its intended
// target. computeClickVerdict encodes the corrected decision table:
//
//   1. If the pre-click UIA element resolved at (x,y) via AutomationElement
//      .FromPoint is a Document / Edit control AND the post-click focused
//      element is that same element (or a descendant, matched by
//      target_runtime_id_prefix), AND the click point still falls inside
//      the resolved target bounds, AND the top-level window is still
//      foreground → verified with `target_focus_verified`.
//   2. If UIA reports a caret-position change (Win32 GetGUIThreadInfo or
//      TextPattern selection) → verified with `caret_changed`.
//   3. If a semantic state change is reported (toggle button pressed,
//      selection index changed, expanded/collapsed) → verified with
//      `semantic_state_changed`.
//   4. If none observable AND the target was NOT a Document/Edit AND no
//      focus/text/bounds changed → CLICK_NO_EFFECT (strict semantics
//      preserved for buttons / toggles / menu items).
//   5. If UIA target resolution failed → verification_kind='unverifiable'
//      with verified=false so callers see the truth instead of a stale
//      "pass". `require_verified=false` explicitly opts out of failure.

export type ClickTargetInfo = {
  resolved: boolean;
  runtime_id: string | null;
  control_type: string | null;
  class_name: string | null;
  bounds: { L: number; T: number; R: number; B: number } | null;
  top_level_handle: string | null;
  is_document_or_edit: boolean;
};

export type ClickVerdictInput = {
  clickX: number;
  clickY: number;
  pre: {
    target: ClickTargetInfo;
    foregroundHandle: string;
    focusedRuntimeId: string | null;
    caret: { X: number; Y: number } | null;
    toggleState: string | null;
    selectionSnapshot: string | null;
  };
  post: {
    focusedRuntimeId: string | null;
    focusedIsDescendantOfTarget: boolean;
    foregroundHandle: string;
    hitTestRuntimeId: string | null; // UIA element under (clickX,clickY) after click
    caret: { X: number; Y: number } | null;
    toggleState: string | null;
    selectionSnapshot: string | null;
    focusedTextHashChanged: boolean;
    focusedClassChanged: boolean;
    foregroundRectChanged: boolean;
  };
};

export type ClickVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
};

function pointInBounds(
  x: number,
  y: number,
  b: { L: number; T: number; R: number; B: number } | null,
): boolean {
  if (!b) return false;
  return x >= b.L && x < b.R && y >= b.T && y < b.B;
}

export function computeClickVerdict(input: ClickVerdictInput): ClickVerdict {
  const { pre, post, clickX, clickY } = input;

  // Strict failure preserved: foreground_change tells us either the click
  // opened a menu (fine — foreground_or_focus_change would fire) or a
  // completely unrelated window stole focus (bad). Callers already receive
  // pre/post evidence to disambiguate.
  const foregroundChanged = pre.foregroundHandle !== post.foregroundHandle;

  // 1. Toggle / selection state (buttons, checkboxes, list items).
  if (
    pre.toggleState !== null &&
    post.toggleState !== null &&
    pre.toggleState !== post.toggleState
  ) {
    return {
      verified: true,
      verification_kind: "semantic_state_changed",
      error_code: null,
      reason: "toggle_state_changed",
    };
  }
  if (
    pre.selectionSnapshot !== null &&
    post.selectionSnapshot !== null &&
    pre.selectionSnapshot !== post.selectionSnapshot
  ) {
    return {
      verified: true,
      verification_kind: "semantic_state_changed",
      error_code: null,
      reason: "selection_snapshot_changed",
    };
  }

  // 2. Caret movement inside a text control — strong evidence the click
  //    landed and produced a caret update. Notepad RichEditD2DPT moves the
  //    caret to the click point even on the already-focused document.
  if (pre.caret && post.caret && (pre.caret.X !== post.caret.X || pre.caret.Y !== post.caret.Y)) {
    return {
      verified: true,
      verification_kind: "caret_changed",
      error_code: null,
      reason: "gui_thread_info_caret_moved",
    };
  }

  // 3. Target-focus verification — the crux of Finding A. If the click
  //    resolved to a Document/Edit target and the same element (or a
  //    descendant) is still focused, and the click point still lies inside
  //    the target bounds, we PASS even when text/bounds are unchanged.
  if (
    pre.target.resolved &&
    pre.target.is_document_or_edit &&
    !foregroundChanged &&
    pointInBounds(clickX, clickY, pre.target.bounds) &&
    (post.focusedIsDescendantOfTarget ||
      (pre.target.runtime_id !== null && post.focusedRuntimeId === pre.target.runtime_id) ||
      (pre.target.runtime_id !== null && post.hitTestRuntimeId === pre.target.runtime_id))
  ) {
    return {
      verified: true,
      verification_kind: "target_focus_verified",
      error_code: null,
      reason: "document_or_edit_target_still_focused",
    };
  }

  // 4. Legacy foreground_or_focus_change signals — preserved for buttons /
  //    menu items where the click MUST produce an observable change.
  if (
    post.focusedTextHashChanged ||
    post.focusedClassChanged ||
    post.foregroundRectChanged ||
    foregroundChanged
  ) {
    return {
      verified: true,
      verification_kind: "foreground_or_focus_change",
      error_code: null,
      reason: "focus_or_bounds_or_text_changed",
    };
  }

  // 5. UIA resolution failed entirely — mark unverifiable rather than
  //    fabricate a pass or fail.
  if (!pre.target.resolved) {
    return {
      verified: false,
      verification_kind: "unverifiable",
      error_code: "CLICK_NO_EFFECT",
      reason: "uia_target_unresolved_at_click_point",
    };
  }

  // 6. Non-text targets (buttons/toggles) with no observable change → fail.
  return {
    verified: false,
    verification_kind: "foreground_or_focus_change",
    error_code: "CLICK_NO_EFFECT",
    reason: "no_focus_or_text_or_bounds_or_caret_change",
  };
}

// ---------- 0.4.21 Verified-Type Fallback plan (pure) ----------
//
// Finding B regression: SendInput reports success but UIA readback confirms
// zero characters landed. The Helper MUST NOT accept `send_input_ok=true`
// as evidence of a successful type. planTypeFallback drives the recovery
// sequence used by Tool-Type when the initial SendInput pass leaves
// text_length_after == text_length_before within the stability window.
//
// Fallback order:
//   1. UIA ValuePattern.SetValue(text) — instant when the control supports it.
//   2. Clipboard paste (save → SetText → Ctrl+V → restore original clipboard).
//
// Each step is independently verified via the same UIA polling loop. The
// helper stops at the first verified step. If every step fails, the tool
// returns error_code=TYPE_FALLBACK_FAILED with per-step diagnostics.

export type TypeFallbackStep = "uia_value_set" | "clipboard_paste";

export type SendInputDiagnostics = {
  requested_input_count: number;
  returned_input_count: number;
  last_error: number;
  keydown_count: number;
  keyup_count: number;
  utf16_code_units: number;
};

export type TypeFallbackContext = {
  preTextLength: number;
  postTextLength: number;
  postTextEqualsInjected: boolean;
  sendInputSucceeded: boolean; // returned_input_count === requested_input_count
  supportsValuePattern: boolean;
  focusedIsDocumentOrEdit: boolean;
  targetStillForeground: boolean;
  triedSteps: TypeFallbackStep[];
};

export type TypeFallbackDecision =
  | { action: "accept"; reason: string }
  | { action: "abort"; error_code: DesktopErrorCode; reason: string }
  | { action: "run"; step: TypeFallbackStep; reason: string };

export function planTypeFallback(ctx: TypeFallbackContext): TypeFallbackDecision {
  if (!ctx.targetStillForeground) {
    return {
      action: "abort",
      error_code: "FOCUS_TARGET_LOST",
      reason: "foreground_lost_before_fallback",
    };
  }
  if (!ctx.focusedIsDocumentOrEdit) {
    return {
      action: "abort",
      error_code: "FOCUS_CONTROL_INVALID",
      reason: "focus_left_document_or_edit_before_fallback",
    };
  }
  // Success gate: only when the UIA readback matches the injected text is
  // it safe to accept. Length parity alone is NOT enough — an editor may
  // have carried an unrelated string of the same length.
  if (ctx.postTextEqualsInjected) {
    return { action: "accept", reason: "post_text_matches_injected" };
  }
  if (!ctx.triedSteps.includes("uia_value_set") && ctx.supportsValuePattern) {
    return {
      action: "run",
      step: "uia_value_set",
      reason: "sendinput_ineffective_try_value_pattern",
    };
  }
  if (!ctx.triedSteps.includes("clipboard_paste")) {
    return {
      action: "run",
      step: "clipboard_paste",
      reason: ctx.supportsValuePattern
        ? "value_pattern_ineffective_try_clipboard_paste"
        : "no_value_pattern_try_clipboard_paste",
    };
  }
  return {
    action: "abort",
    error_code: "TYPE_FALLBACK_FAILED",
    reason: "sendinput_value_pattern_and_clipboard_all_failed",
  };
}

// Deterministic guard: SendInput must have delivered EVERY UTF-16 code unit
// as a matched keydown/keyup pair. Called by Tool-Type diagnostics gate and
// by the vitest regression for Send-UnicodeText instrumentation.
export function validateSendInputDiagnostics(
  d: SendInputDiagnostics,
  utf16Text: string,
): { ok: boolean; reason: string } {
  const cu = utf16Text.length;
  if (d.utf16_code_units !== cu) {
    return { ok: false, reason: `utf16_code_units_mismatch:${d.utf16_code_units}!=${cu}` };
  }
  if (d.requested_input_count !== cu * 2) {
    return { ok: false, reason: `requested_input_count_expected_${cu * 2}` };
  }
  if (d.returned_input_count !== d.requested_input_count) {
    return { ok: false, reason: "sendinput_partial_dispatch" };
  }
  if (d.keydown_count !== cu || d.keyup_count !== cu) {
    return {
      ok: false,
      reason: `keydown_or_keyup_mismatch:${d.keydown_count}/${d.keyup_count}!=${cu}`,
    };
  }
  return { ok: true, reason: "sendinput_diagnostics_valid" };
}

// ============================================================================
// 0.4.22-C1 — Press / Hotkey / Clipboard pure verdict helpers
// ============================================================================

// ---------- Press ----------

export type PressSemantic =
  | "focus_change" // Tab / Shift+Tab
  | "text_length_or_hash_change" // Backspace / Delete
  | "caret_or_selection_change" // Arrow / Home / End / PageUp / PageDown
  | "text_or_focus_or_window_change" // Enter
  | "window_or_focus_change" // Escape
  | "any_observable_change" // F-keys — must SEE something to verify
  | "unverifiable"; // key we cannot pin

export function classifyPress(key: string): {
  semantic: PressSemantic;
  kind: VerificationKind;
  requires: boolean;
} {
  const k = key.toLowerCase();
  if (k === "tab") return { semantic: "focus_change", kind: "press_focus_change", requires: true };
  if (k === "backspace" || k === "delete")
    return { semantic: "text_length_or_hash_change", kind: "press_text_change", requires: true };
  if (["up", "down", "left", "right", "home", "end", "pageup", "pagedown"].includes(k))
    return {
      semantic: "caret_or_selection_change",
      kind: "press_caret_or_selection_change",
      requires: true,
    };
  if (k === "enter")
    return {
      semantic: "text_or_focus_or_window_change",
      kind: "press_window_change",
      requires: true,
    };
  if (k === "escape")
    return { semantic: "window_or_focus_change", kind: "press_window_change", requires: true };
  if (/^f([1-9]|1[0-2])$/.test(k))
    return { semantic: "any_observable_change", kind: "press_window_change", requires: true };
  return { semantic: "unverifiable", kind: "unverifiable", requires: false };
}

export type PressEvidence = {
  foregroundHandle: string;
  focusedRuntimeId: string | null;
  focusedClass: string | null;
  focusedControlType: string | null;
  focusedTextHash: string | null;
  focusedValueHash: string | null;
  focusedTextLength: number | null;
  focusedValueLength: number | null;
  caret: { X: number; Y: number } | null;
  selectionSnapshot: string | null;
  windowExists: boolean;
};

export type PressVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
};

function pressAny(pre: PressEvidence, post: PressEvidence): string | null {
  if (pre.foregroundHandle !== post.foregroundHandle) return "foreground_changed";
  if (pre.focusedRuntimeId !== post.focusedRuntimeId) return "focused_runtime_id_changed";
  if (pre.focusedClass !== post.focusedClass) return "focused_class_changed";
  if (pre.focusedTextHash !== post.focusedTextHash) return "focused_text_hash_changed";
  if (pre.focusedValueHash !== post.focusedValueHash) return "focused_value_hash_changed";
  if (pre.focusedTextLength !== post.focusedTextLength) return "focused_text_length_changed";
  if (pre.caret && post.caret && (pre.caret.X !== post.caret.X || pre.caret.Y !== post.caret.Y))
    return "caret_moved";
  if (pre.selectionSnapshot !== post.selectionSnapshot) return "selection_changed";
  if (pre.windowExists !== post.windowExists) return "window_existence_changed";
  return null;
}

export function computePressVerdict(
  key: string,
  pre: PressEvidence,
  post: PressEvidence,
): PressVerdict {
  const { semantic, kind, requires } = classifyPress(key);
  if (!requires) {
    return {
      verified: false,
      verification_kind: "unverifiable",
      error_code: "PRESS_EFFECT_UNVERIFIABLE",
      reason: "press_semantic_not_classifiable",
    };
  }
  // If UIA yielded no evidence at all in both snapshots we cannot verify.
  const evidenceMissing =
    pre.focusedRuntimeId === null &&
    post.focusedRuntimeId === null &&
    pre.focusedTextHash === null &&
    post.focusedTextHash === null &&
    pre.caret === null &&
    post.caret === null;
  if (evidenceMissing) {
    return {
      verified: false,
      verification_kind: "unverifiable",
      error_code: "PRESS_EFFECT_UNVERIFIABLE",
      reason: "no_uia_or_caret_evidence_available",
    };
  }
  switch (semantic) {
    case "focus_change": {
      if (
        pre.focusedRuntimeId !== null &&
        post.focusedRuntimeId !== null &&
        pre.focusedRuntimeId !== post.focusedRuntimeId
      )
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "focused_runtime_id_changed",
        };
      if (pre.focusedClass !== post.focusedClass)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "focused_class_changed",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "PRESS_NO_OBSERVABLE_EFFECT",
        reason: "focus_did_not_change",
      };
    }
    case "text_length_or_hash_change": {
      if (
        pre.focusedTextLength !== post.focusedTextLength ||
        pre.focusedValueLength !== post.focusedValueLength ||
        pre.focusedTextHash !== post.focusedTextHash ||
        pre.focusedValueHash !== post.focusedValueHash
      )
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "focused_text_or_value_changed",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "PRESS_NO_OBSERVABLE_EFFECT",
        reason: "text_and_value_unchanged",
      };
    }
    case "caret_or_selection_change": {
      if (pre.caret && post.caret && (pre.caret.X !== post.caret.X || pre.caret.Y !== post.caret.Y))
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "caret_moved",
        };
      if (pre.selectionSnapshot !== post.selectionSnapshot)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "selection_changed",
        };
      // For arrow keys inside long documents the app may scroll instead —
      // accept a focused_text_hash change as evidence of content anchor
      // movement (screen readers see it as content change).
      if (pre.focusedTextHash !== post.focusedTextHash)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "content_anchor_changed",
        };
      // No caret evidence available at all → cannot verify.
      if (!pre.caret && !post.caret && pre.selectionSnapshot === null)
        return {
          verified: false,
          verification_kind: "unverifiable",
          error_code: "PRESS_EFFECT_UNVERIFIABLE",
          reason: "no_caret_or_selection_evidence",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "PRESS_NO_OBSERVABLE_EFFECT",
        reason: "caret_and_selection_unchanged",
      };
    }
    case "text_or_focus_or_window_change":
    case "window_or_focus_change":
    case "any_observable_change": {
      const reason = pressAny(pre, post);
      if (reason) return { verified: true, verification_kind: kind, error_code: null, reason };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "PRESS_NO_OBSERVABLE_EFFECT",
        reason: "no_focus_text_caret_or_window_change",
      };
    }
    case "unverifiable":
      return {
        verified: false,
        verification_kind: "unverifiable",
        error_code: "PRESS_EFFECT_UNVERIFIABLE",
        reason: "press_semantic_not_classifiable",
      };
  }
}

// ---------- Hotkey (extended) ----------

export type HotkeySemantic =
  | "selection_change" // Ctrl+A
  | "clipboard_change" // Ctrl+C / Ctrl+X
  | "focused_text_change" // Ctrl+V / Ctrl+Z / Ctrl+Y
  | "window_closed" // Alt+F4
  | "foreground_change" // Alt+Tab
  | "foreground_or_focus_change" // Ctrl+N/O/W/S/T, Win+D/E/R/Tab
  | "input_only";

export function classifyHotkeyExtended(
  modifiers: readonly ("ctrl" | "shift" | "alt" | "win")[],
  key: string,
): { semantic: HotkeySemantic; kind: VerificationKind; requires: boolean } {
  const hasCtrl = modifiers.includes("ctrl");
  const hasAlt = modifiers.includes("alt");
  const hasWin = modifiers.includes("win");
  const k = key.toLowerCase();
  if (hasCtrl && k === "a")
    return { semantic: "selection_change", kind: "selection_change", requires: true };
  if (hasCtrl && (k === "c" || k === "x"))
    return { semantic: "clipboard_change", kind: "clipboard_change", requires: true };
  if (hasCtrl && (k === "v" || k === "z" || k === "y"))
    return { semantic: "focused_text_change", kind: "focused_text_change", requires: true };
  if (hasAlt && k === "f4")
    return { semantic: "window_closed", kind: "window_closed", requires: true };
  if (hasAlt && k === "tab")
    return { semantic: "foreground_change", kind: "foreground_change", requires: true };
  if (hasAlt && k === "escape")
    return { semantic: "foreground_change", kind: "foreground_change", requires: true };
  if (hasWin && (k === "d" || k === "e" || k === "r" || k === "tab"))
    return { semantic: "foreground_change", kind: "foreground_change", requires: true };
  if (hasCtrl && ["n", "o", "w", "s", "t"].includes(k))
    return {
      semantic: "foreground_or_focus_change",
      kind: "foreground_or_focus_change",
      requires: true,
    };
  return { semantic: "input_only", kind: "input_only", requires: false };
}

export type HotkeyEvidence = {
  foregroundHandle: string;
  targetWindowExists: boolean; // for Alt+F4 tracking
  focusedTextHash: string | null;
  focusedValueHash: string | null;
  selectionLength: number | null;
  selectionSnapshot: string | null;
  clipboardSequence: number;
  clipboardFormatAvailable: boolean;
  clipboardHash: string | null;
};

export type HotkeyVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
};

export function computeHotkeyVerdict(
  modifiers: readonly ("ctrl" | "shift" | "alt" | "win")[],
  key: string,
  pre: HotkeyEvidence,
  post: HotkeyEvidence,
): HotkeyVerdict {
  const { semantic, kind, requires } = classifyHotkeyExtended(modifiers, key);
  if (!requires) {
    return {
      verified: false,
      verification_kind: "input_only",
      error_code: "HOTKEY_EFFECT_UNVERIFIABLE",
      reason: "hotkey_semantic_not_classifiable",
    };
  }
  switch (semantic) {
    case "selection_change": {
      if (pre.selectionSnapshot !== post.selectionSnapshot)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "selection_snapshot_changed",
        };
      if (
        pre.selectionLength !== null &&
        post.selectionLength !== null &&
        pre.selectionLength !== post.selectionLength
      )
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "selection_length_changed",
        };
      if (pre.selectionSnapshot === null && post.selectionSnapshot === null)
        return {
          verified: false,
          verification_kind: "unverifiable",
          error_code: "HOTKEY_EFFECT_UNVERIFIABLE",
          reason: "uia_selection_unreadable",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "HOTKEY_NO_EFFECT",
        reason: "selection_unchanged",
      };
    }
    case "clipboard_change": {
      if (post.clipboardSequence !== pre.clipboardSequence) {
        if (post.clipboardHash && post.clipboardHash !== pre.clipboardHash)
          return {
            verified: true,
            verification_kind: kind,
            error_code: null,
            reason: "clipboard_sequence_and_hash_changed",
          };
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "clipboard_sequence_changed",
        };
      }
      return {
        verified: false,
        verification_kind: kind,
        error_code: "CLIPBOARD_UNCHANGED_AFTER_COPY",
        reason: "clipboard_sequence_unchanged",
      };
    }
    case "focused_text_change": {
      if (pre.foregroundHandle !== post.foregroundHandle)
        return {
          verified: false,
          verification_kind: kind,
          error_code: "FOCUS_TARGET_LOST",
          reason: "foreground_changed_during_paste",
        };
      if (
        pre.focusedTextHash !== post.focusedTextHash ||
        pre.focusedValueHash !== post.focusedValueHash
      )
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "focused_text_or_value_changed",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "HOTKEY_NO_EFFECT",
        reason: "focused_text_unchanged",
      };
    }
    case "window_closed": {
      if (pre.targetWindowExists && !post.targetWindowExists)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "target_window_closed",
        };
      // A save dialog may have appeared instead — accept foreground change as
      // "close in progress" and let the caller inspect the new foreground.
      if (pre.foregroundHandle !== post.foregroundHandle && post.targetWindowExists)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "close_dialog_present",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "HOTKEY_NO_EFFECT",
        reason: "target_window_still_present",
      };
    }
    case "foreground_change": {
      if (pre.foregroundHandle !== post.foregroundHandle)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "foreground_handle_changed",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "HOTKEY_NO_EFFECT",
        reason: "foreground_unchanged",
      };
    }
    case "foreground_or_focus_change": {
      if (pre.foregroundHandle !== post.foregroundHandle)
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "foreground_changed",
        };
      if (
        pre.focusedTextHash !== post.focusedTextHash ||
        pre.focusedValueHash !== post.focusedValueHash
      )
        return {
          verified: true,
          verification_kind: kind,
          error_code: null,
          reason: "focused_text_changed",
        };
      return {
        verified: false,
        verification_kind: kind,
        error_code: "HOTKEY_NO_EFFECT",
        reason: "no_foreground_or_focus_change",
      };
    }
    case "input_only":
      return {
        verified: false,
        verification_kind: "input_only",
        error_code: "HOTKEY_EFFECT_UNVERIFIABLE",
        reason: "hotkey_semantic_not_classifiable",
      };
  }
}

// ---------- Clipboard write / read verdict (pure) ----------

export type ClipboardWriteInput = {
  sequenceBefore: number;
  sequenceAfter: number;
  openClipboardSucceeded: boolean;
  setClipboardDataSucceeded: boolean;
  readbackAvailable: boolean;
  readbackLength: number | null;
  readbackHash: string | null;
  expectedLength: number;
  expectedHash: string;
};

export type ClipboardWriteVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
  success_reason: string | null;
};

export function computeClipboardWriteVerdict(input: ClipboardWriteInput): ClipboardWriteVerdict {
  if (!input.openClipboardSucceeded) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: "openclipboard_failed_retries_exhausted",
      success_reason: null,
    };
  }
  if (!input.setClipboardDataSucceeded) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: "setclipboarddata_failed",
      success_reason: null,
    };
  }
  if (input.sequenceAfter === input.sequenceBefore) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: "clipboard_sequence_did_not_advance",
      success_reason: null,
    };
  }
  if (!input.readbackAvailable) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: "readback_unicode_format_unavailable",
      success_reason: null,
    };
  }
  if (input.readbackLength !== input.expectedLength) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: `readback_length_mismatch:${input.readbackLength}!=${input.expectedLength}`,
      success_reason: null,
    };
  }
  if (input.readbackHash !== input.expectedHash) {
    return {
      verified: false,
      verification_kind: "clipboard_readback_exact",
      error_code: "CLIPBOARD_WRITE_VERIFY_FAILED",
      reason: "readback_hash_mismatch_content_overwritten_or_corrupted",
      success_reason: null,
    };
  }
  return {
    verified: true,
    verification_kind: "clipboard_readback_exact",
    error_code: null,
    reason: "clipboard_content_verified",
    success_reason: "clipboard_content_verified",
  };
}

export type ClipboardReadInput = {
  openSucceeded: boolean;
  textFormatAvailable: boolean;
  readSucceeded: boolean;
  textLength: number | null; // null when read failed
};

export type ClipboardReadVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  reason: string;
  success_reason: string | null;
};

export function computeClipboardReadVerdict(input: ClipboardReadInput): ClipboardReadVerdict {
  if (!input.openSucceeded) {
    return {
      verified: false,
      verification_kind: "clipboard_text_verified",
      error_code: "CLIPBOARD_READ_FAILED",
      reason: "openclipboard_failed",
      success_reason: null,
    };
  }
  if (!input.textFormatAvailable) {
    // Legit empty clipboard vs. non-text content: if read succeeded and
    // length is 0 we call it EMPTY_CLIPBOARD (verified=true, we CONFIRMED
    // empty). If the format flag reports no text and we could not read
    // anything, mark as non-text.
    if (input.readSucceeded && input.textLength === 0) {
      return {
        verified: true,
        verification_kind: "clipboard_empty_verified",
        error_code: "EMPTY_CLIPBOARD",
        reason: "clipboard_confirmed_empty",
        success_reason: "clipboard_confirmed_empty",
      };
    }
    return {
      verified: false,
      verification_kind: "clipboard_text_verified",
      error_code: "CLIPBOARD_TEXT_FORMAT_UNAVAILABLE",
      reason: "no_cf_unicodetext_format_available",
      success_reason: null,
    };
  }
  if (!input.readSucceeded || input.textLength === null) {
    return {
      verified: false,
      verification_kind: "clipboard_text_verified",
      error_code: "CLIPBOARD_READ_FAILED",
      reason: "getclipboarddata_returned_null",
      success_reason: null,
    };
  }
  if (input.textLength === 0) {
    return {
      verified: true,
      verification_kind: "clipboard_empty_verified",
      error_code: "EMPTY_CLIPBOARD",
      reason: "clipboard_text_present_but_empty",
      success_reason: "clipboard_confirmed_empty",
    };
  }
  return {
    verified: true,
    verification_kind: "clipboard_text_verified",
    error_code: null,
    reason: "clipboard_text_read_successfully",
    success_reason: "clipboard_text_read_successfully",
  };
}

// ---------- Focus window verdict (pure, 0.4.22-C2) ----------

export type FocusAction = "focus" | "restore" | "minimize" | "maximize";

export type FocusWindowSnapshot = {
  windowHandle: string;
  windowExists: boolean;
  visible: boolean;
  isIconic: boolean;
  isZoomed: boolean;
  foregroundHandle: string;
  processId: number | null;
  windowClass: string | null;
};

export type FocusWindowInput = {
  requestedWindowHandle: string;
  action: FocusAction;
  pre: FocusWindowSnapshot;
  post: FocusWindowSnapshot;
  apiReported: {
    setForegroundReturned: boolean;
    showWindowReturned: boolean;
  };
};

export type FocusWindowVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  failure_reason: string | null;
  success_reason: string | null;
  target_still_foreground: boolean;
};

export function computeFocusWindowVerdict(input: FocusWindowInput): FocusWindowVerdict {
  const { requestedWindowHandle, action, post } = input;
  if (!post.windowExists || post.windowHandle !== requestedWindowHandle) {
    return {
      verified: false,
      verification_kind: "foreground_window_verified",
      error_code: "FOCUS_TARGET_NOT_FOUND",
      failure_reason: "requested_window_handle_not_live_post_action",
      success_reason: null,
      target_still_foreground: false,
    };
  }
  // Minimize requires: iconic, and does NOT require foreground==requested.
  if (action === "minimize") {
    if (!post.isIconic) {
      return {
        verified: false,
        verification_kind: "foreground_window_verified",
        error_code: "FOCUS_WINDOW_STATE_MISMATCH",
        failure_reason: "requested_minimize_but_window_not_iconic",
        success_reason: null,
        target_still_foreground: post.foregroundHandle === requestedWindowHandle,
      };
    }
    return {
      verified: true,
      verification_kind: "foreground_window_verified",
      error_code: null,
      failure_reason: null,
      success_reason: "window_minimized_as_requested",
      target_still_foreground: post.foregroundHandle === requestedWindowHandle,
    };
  }
  if (action === "restore" && post.isIconic) {
    return {
      verified: false,
      verification_kind: "foreground_window_verified",
      error_code: "FOCUS_WINDOW_STATE_MISMATCH",
      failure_reason: "requested_restore_but_window_still_iconic",
      success_reason: null,
      target_still_foreground: false,
    };
  }
  if (!post.visible || post.isIconic) {
    return {
      verified: false,
      verification_kind: "foreground_window_verified",
      error_code: "FOCUS_TARGET_NOT_VISIBLE",
      failure_reason: post.isIconic
        ? "window_still_minimized_after_focus"
        : "window_not_visible_after_focus",
      success_reason: null,
      target_still_foreground: false,
    };
  }
  if (action === "maximize" && !post.isZoomed) {
    return {
      verified: false,
      verification_kind: "foreground_window_verified",
      error_code: "FOCUS_WINDOW_STATE_MISMATCH",
      failure_reason: "requested_maximize_but_window_not_zoomed",
      success_reason: null,
      target_still_foreground: post.foregroundHandle === requestedWindowHandle,
    };
  }
  if (post.foregroundHandle !== requestedWindowHandle) {
    // Was previously foreground and then lost — distinct diagnostic.
    if (input.pre.foregroundHandle === requestedWindowHandle) {
      return {
        verified: false,
        verification_kind: "foreground_window_verified",
        error_code: "FOCUS_TARGET_LOST",
        failure_reason: "foreground_stolen_by_other_window_after_action",
        success_reason: null,
        target_still_foreground: false,
      };
    }
    return {
      verified: false,
      verification_kind: "foreground_window_verified",
      error_code: "FOCUS_VERIFICATION_FAILED",
      failure_reason: "foreground_window_is_not_requested_handle",
      success_reason: null,
      target_still_foreground: false,
    };
  }
  return {
    verified: true,
    verification_kind: "foreground_window_verified",
    error_code: null,
    failure_reason: null,
    success_reason: "requested_window_is_foreground",
    target_still_foreground: true,
  };
}

// ---------- Launch verdict (pure, 0.4.22-C2) ----------

export type LaunchProcessSample = { pid: number; processName: string };
export type LaunchWindowSample = {
  handle: string;
  processId: number;
  visible: boolean;
  windowClass: string | null;
};

export type LaunchInput = {
  expectedProcessNames: readonly string[]; // lowercase, e.g. ["notepad", "notepad++"]
  pre: {
    processes: readonly LaunchProcessSample[];
    windows: readonly LaunchWindowSample[];
    foregroundHandle: string;
  };
  post: {
    processes: readonly LaunchProcessSample[];
    windows: readonly LaunchWindowSample[];
    foregroundHandle: string;
  };
  shellExecuteSucceeded: boolean;
  elapsedMs: number;
  timeoutMs: number;
};

export type LaunchVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  failure_reason: string | null;
  success_reason: string | null;
  matched_process_id: number | null;
  matched_window_handle: string | null;
  existing_window_reactivated: boolean;
  new_process_ids: number[];
  new_window_handles: string[];
};

export function computeLaunchVerdict(input: LaunchInput): LaunchVerdict {
  const preProcIds = new Set(input.pre.processes.map((p) => p.pid));
  const preWinHandles = new Set(input.pre.windows.map((w) => w.handle));
  const newProcesses = input.post.processes.filter((p) => !preProcIds.has(p.pid));
  const newWindows = input.post.windows.filter((w) => !preWinHandles.has(w.handle));

  const expected = input.expectedProcessNames.map((n) => n.toLowerCase());
  const matchesExpected = (name: string) =>
    expected.length === 0 || expected.includes(name.toLowerCase());

  const base = {
    new_process_ids: newProcesses.map((p) => p.pid),
    new_window_handles: newWindows.map((w) => w.handle),
    existing_window_reactivated: false,
    matched_process_id: null as number | null,
    matched_window_handle: null as string | null,
  };

  const matchingNewProcess = newProcesses.find((p) => matchesExpected(p.processName));
  const matchingNewWindow = newWindows.find(
    (w) => w.visible && matchesExpected(processNameForPid(w.processId, input.post.processes) ?? ""),
  );

  if (matchingNewWindow) {
    return {
      verified: true,
      verification_kind: "process_or_window_appeared",
      error_code: null,
      failure_reason: null,
      success_reason: "expected_app_observed",
      ...base,
      matched_process_id: matchingNewWindow.processId,
      matched_window_handle: matchingNewWindow.handle,
    };
  }

  // Existing app instance: reactivation is acceptable ONLY when the foreground
  // now belongs to a process matching the expected app.
  if (input.post.foregroundHandle !== input.pre.foregroundHandle) {
    const fgWin = input.post.windows.find((w) => w.handle === input.post.foregroundHandle);
    if (fgWin) {
      const fgName = processNameForPid(fgWin.processId, input.post.processes);
      if (fgName && matchesExpected(fgName)) {
        return {
          verified: true,
          verification_kind: "process_or_window_appeared",
          error_code: null,
          failure_reason: null,
          success_reason: "expected_app_observed",
          ...base,
          existing_window_reactivated: true,
          matched_process_id: fgWin.processId,
          matched_window_handle: fgWin.handle,
        };
      }
    }
  }

  if (matchingNewProcess) {
    return {
      verified: false,
      verification_kind: "process_or_window_appeared",
      error_code: "LAUNCH_WINDOW_NOT_OBSERVED",
      failure_reason: "new_process_started_but_no_visible_window",
      success_reason: null,
      ...base,
      matched_process_id: matchingNewProcess.pid,
    };
  }

  if (newProcesses.length > 0 && expected.length > 0) {
    return {
      verified: false,
      verification_kind: "process_or_window_appeared",
      error_code: "LAUNCH_WRONG_PROCESS",
      failure_reason: `new_process_names_do_not_match_expected:${expected.join("|")}`,
      success_reason: null,
      ...base,
    };
  }

  if (input.elapsedMs >= input.timeoutMs) {
    return {
      verified: false,
      verification_kind: "process_or_window_appeared",
      error_code: "LAUNCH_TIMEOUT",
      failure_reason: "no_new_process_or_window_before_timeout",
      success_reason: null,
      ...base,
    };
  }

  if (input.shellExecuteSucceeded) {
    return {
      verified: false,
      verification_kind: "process_or_window_appeared",
      error_code: "LAUNCH_PROCESS_NOT_OBSERVED",
      failure_reason: "shell_execute_succeeded_but_no_new_process_observed",
      success_reason: null,
      ...base,
    };
  }

  return {
    verified: false,
    verification_kind: "process_or_window_appeared",
    error_code: "LAUNCH_VERIFICATION_FAILED",
    failure_reason: "no_observable_effect_after_launch_attempt",
    success_reason: null,
    ...base,
  };
}

function processNameForPid(pid: number, processes: readonly LaunchProcessSample[]): string | null {
  const match = processes.find((p) => p.pid === pid);
  return match ? match.processName : null;
}

// ---------- Scroll verdict (pure, 0.4.22-D) ----------

export type ScrollDirection = "vertical" | "horizontal" | "both";

export type ScrollSnapshot = {
  foregroundWindowHandle: string;
  focusedRuntimeId: string | null;
  targetRuntimeId: string | null;
  targetBounds: { L: number; T: number; R: number; B: number } | null;
  scrollPatternAvailable: boolean;
  horizontalScrollPercent: number | null;
  verticalScrollPercent: number | null;
  horizontalViewSize: number | null;
  verticalViewSize: number | null;
  visibleAnchorHash: string | null;
  scrollbarPosition: { h: number | null; v: number | null } | null;
  selectionHash: string | null;
  selectionLength: number | null;
};

export type ScrollInput = {
  direction: ScrollDirection;
  requestedDeltaX: number;
  requestedDeltaY: number;
  inputDispatched: boolean;
  pre: ScrollSnapshot;
  post: ScrollSnapshot;
  requireVerified: boolean;
};

export type ScrollVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  failure_reason: string | null;
  success_reason: string | null;
  target_still_foreground: boolean;
  evidence_source:
    | "scroll_pattern"
    | "scrollbar_position"
    | "visible_anchor"
    | "focused_or_selection"
    | "none";
};

function nearlyEqual(a: number | null, b: number | null, epsilon = 0.05): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < epsilon;
}

export function computeScrollVerdict(input: ScrollInput): ScrollVerdict {
  const { pre, post, direction, requestedDeltaX, requestedDeltaY } = input;
  const targetStillForeground = post.foregroundWindowHandle === pre.foregroundWindowHandle;

  if (!targetStillForeground) {
    return {
      verified: false,
      verification_kind: "scroll_position_changed",
      error_code: "FOCUS_TARGET_LOST",
      failure_reason: "foreground_window_changed_during_scroll",
      success_reason: null,
      target_still_foreground: false,
      evidence_source: "none",
    };
  }

  // Priority 1: UIA ScrollPattern percentages.
  if (pre.scrollPatternAvailable && post.scrollPatternAvailable) {
    const vChanged = !nearlyEqual(pre.verticalScrollPercent, post.verticalScrollPercent);
    const hChanged = !nearlyEqual(pre.horizontalScrollPercent, post.horizontalScrollPercent);
    if (vChanged || hChanged) {
      return {
        verified: true,
        verification_kind: "scroll_position_changed",
        error_code: null,
        failure_reason: null,
        success_reason: "scroll_effect_observed",
        target_still_foreground: true,
        evidence_source: "scroll_pattern",
      };
    }
  }

  // Priority 2: scrollbar position change.
  if (pre.scrollbarPosition && post.scrollbarPosition) {
    const vDiff = !nearlyEqual(pre.scrollbarPosition.v, post.scrollbarPosition.v);
    const hDiff = !nearlyEqual(pre.scrollbarPosition.h, post.scrollbarPosition.h);
    if (vDiff || hDiff) {
      return {
        verified: true,
        verification_kind: "scroll_position_changed",
        error_code: null,
        failure_reason: null,
        success_reason: "scroll_effect_observed",
        target_still_foreground: true,
        evidence_source: "scrollbar_position",
      };
    }
  }

  // Priority 3: visible content anchor / hash change.
  if (pre.visibleAnchorHash && post.visibleAnchorHash && pre.visibleAnchorHash !== post.visibleAnchorHash) {
    return {
      verified: true,
      verification_kind: "scroll_position_changed",
      error_code: null,
      failure_reason: null,
      success_reason: "scroll_effect_observed",
      target_still_foreground: true,
      evidence_source: "visible_anchor",
    };
  }

  // Priority 4: focused element or selection change (weakest evidence).
  if (
    (pre.focusedRuntimeId !== null || post.focusedRuntimeId !== null) &&
    pre.focusedRuntimeId !== post.focusedRuntimeId
  ) {
    return {
      verified: true,
      verification_kind: "scroll_position_changed",
      error_code: null,
      failure_reason: null,
      success_reason: "scroll_effect_observed",
      target_still_foreground: true,
      evidence_source: "focused_or_selection",
    };
  }
  if (
    pre.selectionHash !== null &&
    post.selectionHash !== null &&
    pre.selectionHash !== post.selectionHash
  ) {
    return {
      verified: true,
      verification_kind: "scroll_position_changed",
      error_code: null,
      failure_reason: null,
      success_reason: "scroll_effect_observed",
      target_still_foreground: true,
      evidence_source: "focused_or_selection",
    };
  }

  // No effect observed. Decide boundary vs no-effect vs unverifiable.
  const anyEvidence =
    (pre.scrollPatternAvailable && post.scrollPatternAvailable) ||
    (pre.scrollbarPosition !== null && post.scrollbarPosition !== null) ||
    (pre.visibleAnchorHash !== null && post.visibleAnchorHash !== null);

  if (!anyEvidence) {
    return {
      verified: false,
      verification_kind: "scroll_position_changed",
      error_code: "SCROLL_EFFECT_UNVERIFIABLE",
      failure_reason: "no_scroll_evidence_channels_available",
      success_reason: null,
      target_still_foreground: true,
      evidence_source: "none",
    };
  }

  // At boundary detection based on ScrollPattern percent.
  if (pre.scrollPatternAvailable && post.scrollPatternAvailable) {
    const atBoundary = isAtBoundary(post, direction, requestedDeltaX, requestedDeltaY);
    if (atBoundary) {
      return {
        verified: false,
        verification_kind: "scroll_position_changed",
        error_code: "SCROLL_AT_BOUNDARY",
        failure_reason: "requested_scroll_direction_already_at_boundary",
        success_reason: null,
        target_still_foreground: true,
        evidence_source: "scroll_pattern",
      };
    }
  }

  return {
    verified: false,
    verification_kind: "scroll_position_changed",
    error_code: "SCROLL_NO_EFFECT",
    failure_reason: "scroll_input_dispatched_but_no_position_change_observed",
    success_reason: null,
    target_still_foreground: true,
    evidence_source: "scroll_pattern",
  };
}

function isAtBoundary(
  post: ScrollSnapshot,
  direction: ScrollDirection,
  dx: number,
  dy: number,
): boolean {
  const atTop = post.verticalScrollPercent !== null && post.verticalScrollPercent <= 0.5;
  const atBottom = post.verticalScrollPercent !== null && post.verticalScrollPercent >= 99.5;
  const atLeft = post.horizontalScrollPercent !== null && post.horizontalScrollPercent <= 0.5;
  const atRight = post.horizontalScrollPercent !== null && post.horizontalScrollPercent >= 99.5;
  if (direction === "vertical" || direction === "both") {
    if (dy > 0 && atTop) return true; // wheel up when already at top
    if (dy < 0 && atBottom) return true; // wheel down when already at bottom
  }
  if (direction === "horizontal" || direction === "both") {
    if (dx > 0 && atLeft) return true;
    if (dx < 0 && atRight) return true;
  }
  return false;
}

// ---------- Drag verdict (pure, 0.4.22-D) ----------

export type DragScenario = "window" | "scrollbar" | "slider" | "selection" | "drop" | "auto";

export type DragBounds = { L: number; T: number; R: number; B: number };

export type DragElementSnapshot = {
  runtimeId: string | null;
  exists: boolean;
  bounds: DragBounds | null;
  controlType: string | null;
  windowClass: string | null;
  topLevelWindowHandle: string | null;
  rangeValue: number | null;
  toggleState: string | null;
  containerChildCount: number | null;
};

export type DragScrollSnapshot = {
  horizontalScrollPercent: number | null;
  verticalScrollPercent: number | null;
  scrollbarPosition: { h: number | null; v: number | null } | null;
};

export type DragSelectionSnapshot = {
  selectionLength: number | null;
  selectionHash: string | null;
};

export type DragWindowSnapshot = {
  foregroundWindowHandle: string;
  windowRect: DragBounds | null;
};

export type DragSnapshot = {
  window: DragWindowSnapshot;
  source: DragElementSnapshot;
  target: DragElementSnapshot;
  scroll: DragScrollSnapshot;
  selection: DragSelectionSnapshot;
  focusedRuntimeId: string | null;
};

export type DragInput = {
  scenario: DragScenario;
  fromPoint: { x: number; y: number };
  toPoint: { x: number; y: number };
  targetPointRuntimeId: string | null;
  inputDispatched: boolean;
  pre: DragSnapshot;
  post: DragSnapshot;
  requireVerified: boolean;
};

export type DragScenarioVerdict = {
  verified: boolean;
  verification_kind: VerificationKind;
  error_code: DesktopErrorCode | null;
  failure_reason: string | null;
  success_reason: string | null;
  target_still_foreground: boolean;
  scenario_resolved: DragScenario;
  evidence_source:
    | "window_rect"
    | "scroll_position"
    | "range_value"
    | "element_bounds"
    | "selection"
    | "source_disappeared"
    | "container_content"
    | "none";
};

function boundsChanged(a: DragBounds | null, b: DragBounds | null): boolean {
  if (!a || !b) return false;
  return a.L !== b.L || a.T !== b.T || a.R !== b.R || a.B !== b.B;
}
function boundsMoved(a: DragBounds | null, b: DragBounds | null): boolean {
  if (!a || !b) return false;
  return a.L !== b.L || a.T !== b.T;
}

export function computeDragScenarioVerdict(input: DragInput): DragScenarioVerdict {
  const { pre, post } = input;
  const scenario = input.scenario === "auto" ? resolveDragScenario(pre, post) : input.scenario;
  const targetStillForeground =
    post.window.foregroundWindowHandle === pre.window.foregroundWindowHandle;

  // Structural pre-checks — apply regardless of scenario.
  if (!pre.source.exists) {
    return failDrag(scenario, targetStillForeground, "DRAG_SOURCE_NOT_FOUND", "source_element_not_present_pre_drag");
  }
  if (
    (scenario === "drop" || scenario === "slider" || scenario === "scrollbar") &&
    input.targetPointRuntimeId !== null &&
    !pre.target.exists
  ) {
    return failDrag(scenario, targetStillForeground, "DRAG_TARGET_NOT_FOUND", "target_element_not_present_pre_drag");
  }

  if (!targetStillForeground) {
    return failDrag(scenario, false, "FOCUS_TARGET_LOST", "foreground_window_changed_during_drag");
  }

  if (scenario === "drop" && pre.target.exists && !post.target.exists) {
    return failDrag(scenario, targetStillForeground, "DRAG_TARGET_LOST", "target_element_disappeared_during_drop");
  }

  if (
    scenario === "drop" &&
    input.targetPointRuntimeId !== null &&
    post.target.runtimeId !== null &&
    input.targetPointRuntimeId !== post.target.runtimeId
  ) {
    return failDrag(scenario, targetStillForeground, "DRAG_WRONG_TARGET", "drop_landed_on_different_element_than_requested");
  }

  switch (scenario) {
    case "window":
      if (boundsChanged(pre.window.windowRect, post.window.windowRect)) {
        return okDrag(scenario, "window_rect", "drag_state_changed");
      }
      break;
    case "scrollbar": {
      const scrollChanged =
        !nearlyEqual(pre.scroll.verticalScrollPercent, post.scroll.verticalScrollPercent) ||
        !nearlyEqual(pre.scroll.horizontalScrollPercent, post.scroll.horizontalScrollPercent);
      const barChanged = !!(
        pre.scroll.scrollbarPosition &&
        post.scroll.scrollbarPosition &&
        (!nearlyEqual(pre.scroll.scrollbarPosition.v, post.scroll.scrollbarPosition.v) ||
          !nearlyEqual(pre.scroll.scrollbarPosition.h, post.scroll.scrollbarPosition.h))
      );
      if (scrollChanged || barChanged) {
        return okDrag(scenario, "scroll_position", "drag_state_changed");
      }
      break;
    }
    case "slider":
      if (
        pre.target.rangeValue !== null &&
        post.target.rangeValue !== null &&
        pre.target.rangeValue !== post.target.rangeValue
      ) {
        return okDrag(scenario, "range_value", "drag_state_changed");
      }
      if (boundsChanged(pre.target.bounds, post.target.bounds)) {
        return okDrag(scenario, "element_bounds", "drag_state_changed");
      }
      break;
    case "selection":
      if (
        pre.selection.selectionLength !== post.selection.selectionLength ||
        (pre.selection.selectionHash !== null &&
          post.selection.selectionHash !== null &&
          pre.selection.selectionHash !== post.selection.selectionHash)
      ) {
        return okDrag(scenario, "selection", "drag_state_changed");
      }
      break;
    case "drop":
      if (!post.source.exists) {
        return okDrag(scenario, "source_disappeared", "drag_state_changed");
      }
      if (boundsMoved(pre.source.bounds, post.source.bounds)) {
        return okDrag(scenario, "element_bounds", "drag_state_changed");
      }
      if (
        pre.target.containerChildCount !== null &&
        post.target.containerChildCount !== null &&
        post.target.containerChildCount !== pre.target.containerChildCount
      ) {
        return okDrag(scenario, "container_content", "drag_state_changed");
      }
      break;
  }

  // No effect. Distinguish no-evidence vs no-effect.
  const anyChannelReadable =
    pre.window.windowRect !== null ||
    pre.scroll.scrollbarPosition !== null ||
    pre.scroll.verticalScrollPercent !== null ||
    pre.scroll.horizontalScrollPercent !== null ||
    pre.target.rangeValue !== null ||
    pre.target.bounds !== null ||
    pre.selection.selectionLength !== null ||
    pre.source.bounds !== null;
  if (!anyChannelReadable) {
    return failDrag(scenario, targetStillForeground, "DRAG_EFFECT_UNVERIFIABLE", "no_readable_drag_evidence_channels");
  }
  return failDrag(scenario, targetStillForeground, "DRAG_NO_EFFECT", "drag_dispatched_but_no_state_change_observed");
}

function okDrag(
  scenario: DragScenario,
  evidence: DragScenarioVerdict["evidence_source"],
  successReason: string,
): DragScenarioVerdict {
  return {
    verified: true,
    verification_kind: "drag_effect_observed",
    error_code: null,
    failure_reason: null,
    success_reason: successReason,
    target_still_foreground: true,
    scenario_resolved: scenario,
    evidence_source: evidence,
  };
}

function failDrag(
  scenario: DragScenario,
  targetStillForeground: boolean,
  code: DesktopErrorCode,
  reason: string,
): DragScenarioVerdict {
  return {
    verified: false,
    verification_kind: "drag_effect_observed",
    error_code: code,
    failure_reason: reason,
    success_reason: null,
    target_still_foreground: targetStillForeground,
    scenario_resolved: scenario,
    evidence_source: "none",
  };
}

function resolveDragScenario(pre: DragSnapshot, _post: DragSnapshot): DragScenario {
  const ct = (pre.source.controlType ?? "").toLowerCase();
  const cls = (pre.source.windowClass ?? "").toLowerCase();
  if (ct.includes("scrollbar") || cls.includes("scrollbar")) return "scrollbar";
  if (ct.includes("slider") || cls.includes("slider") || pre.source.rangeValue !== null) return "slider";
  if (ct.includes("titlebar") || ct.includes("caption") || cls.includes("titlebar")) return "window";
  if (
    (pre.selection.selectionLength ?? 0) > 0 &&
    (ct.includes("edit") || ct.includes("document") || ct.includes("text"))
  ) {
    return "selection";
  }
  return "drop";
}
