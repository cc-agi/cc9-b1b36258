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
  // 0.4.21 — Click Target Verification. Semantic verdicts for desktop_click
  // that avoid the 0.4.20 false-negative where clicking an already-focused
  // Document/Edit target reported CLICK_NO_EFFECT because nothing observable
  // in the previous predicate table changed.
  "target_focus_verified",
  "caret_changed",
  "semantic_state_changed",
  "unverifiable",
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
  // 0.4.21 — verified-type fallback exhausted (SendInput, UIA ValuePattern,
  // clipboard paste all failed to produce a matching UIA readback).
  "TYPE_FALLBACK_FAILED",
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
