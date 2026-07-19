/**
 * 0.4.22-B — Unified Action Verification Contract.
 *
 * SINGLE source of truth for how desktop_* tool results carry action-
 * verification evidence back through the worker route + orchestrator.
 *
 *   Helper (PowerShell) → step_results.result   ─┐
 *                                                 │
 *                              extractVerification / normalizeVerification
 *                                                 │
 *                                     evaluateVerificationOutcome
 *                                                 ▼
 *                worker route persistence / orchestrator finalization
 *
 * Every effect-bearing desktop action already surfaces a set of overlapping
 * fields (`require_verified`, `verified`, `verification_kind`, `pre`, `post`,
 * ...). Before 0.4.22-B those fields were per-tool ad-hoc and only inspected
 * by 0.4.22-A's TEXT classifier via a stringified snapshot in final_output.
 *
 * This module encodes the shared contract shape and the ONE decision function
 * that maps a normalized verification into a { status, error_code, reason }
 * outcome. Both the worker `/step-result` handler and the orchestrator's
 * desktop deterministic branch invoke this function, so:
 *
 *   require_verified=true + verified in {false, missing}
 *      ⇒  DB status='succeeded' is UNREACHABLE
 *      ⇒  step.completed cannot be emitted; step.failed is emitted instead
 *      ⇒  final_output classification is a lower-priority safety net
 */

import { z } from "zod";
import { redactString, type Redacted } from "@/lib/desktop/redact";
import {
  DESKTOP_ERROR_CODES,
  VERIFICATION_KINDS,
  type DesktopErrorCode,
  type VerificationKind,
} from "@/lib/desktop/verifier";

// ---------------------------------------------------------------- error codes

/**
 * Stable error codes emitted by the contract itself (as opposed to per-tool
 * DESKTOP_ERROR_CODES from `verifier.ts`). Kept as a stable string union so
 * `agent_runs.error_code` writes are backwards compatible.
 */
export const CONTRACT_ERROR_CODES = [
  "ACTION_VERIFICATION_FAILED",
  "ACTION_VERIFICATION_MISSING",
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

// ---------------------------------------------------------------- schemas

/**
 * Whitelisted evidence field names. Only these values may travel from the
 * Helper into event logs / step_results.result. Anything else is dropped
 * during normalization so a rogue Helper can never leak the caller's
 * document into the audit trail via a novel field name.
 *
 * Aligns with EvidenceSchema in verifier.ts plus the sha256/length/preview
 * fields Redact-D writes into audit copies (from redact.ts).
 */
export const EVIDENCE_ALLOWED_FIELDS: readonly string[] = [
  "foreground_window_handle",
  "foreground_class",
  "foreground_title",
  "foreground_rect",
  "focused_class",
  "focused_control_type",
  "focused_text_length",
  "focused_value_length",
  "focused_text_hash",
  "focused_value_hash",
  "is_document_or_edit",
  "clipboard_sequence",
  "clipboard_format_available",
  "clipboard_hash",
  "clipboard_length",
  "captured_at_ms",
  "runtime_id",
  "focused_runtime_id",
  "target_runtime_id",
  "handle",
  "target_window_handle",
  "target_window_exists",
  "bounds",
  "caret",
  "selection",
  "selection_length",
  "selection_snapshot",
  "toggle_state",
  // 0.4.22-C2 — focus_window / launch evidence fields.
  "requested_window_handle",
  "window_exists",
  "window_visible",
  "is_iconic",
  "is_zoomed",
  "window_state",
  "window_rect",
  "process_id",
  "process_name",
  "window_class",
  "window_title_hash",
  "expected_target",
  "new_process_ids",
  "new_window_handles",
  "matched_process_id",
  "matched_window_handle",
  "existing_window_reactivated",
  "elapsed_ms",
  "poll_attempts",
  // 0.4.22-D — scroll / drag evidence fields.
  "focused_runtime_id",
  "target_runtime_id",
  "target_bounds",
  "scroll_pattern_available",
  "horizontal_scroll_percent",
  "vertical_scroll_percent",
  "horizontal_view_size",
  "vertical_view_size",
  "visible_anchor_hash",
  "scrollbar_position",
  "selection_hash",
  "source_runtime_id",
  "source_bounds",
  "source_exists",
  "source_top_level_window_handle",
  "source_control_type",
  "source_window_class",
  "target_exists",
  "target_control_type",
  "target_window_class",
  "range_value",
  "container_child_count",
  "scenario",
  "scenario_resolved",
  "evidence_source",
  "from_point",
  "to_point",
];

/**
 * Runtime-safe verification contract. Every desktop_* action that reports a
 * verified/unverified outcome MUST normalize into this shape before it is
 * persisted or read by the orchestrator.
 */
export const VerificationContractSchema = z.object({
  require_verified: z.boolean(),
  verified: z.boolean(),
  verification_kind: z.string(),
  /** null when verified=true; MUST carry a stable reason otherwise. */
  failure_reason: z.string().nullable(),
  /** Optional companion to failure_reason on the success path. */
  success_reason: z.string().nullable(),
  error_code: z.string().nullable(),
  verification_attempts: z.number().int().nonnegative(),
  verification_elapsed_ms: z.number().int().nonnegative(),
  pre: z.record(z.string(), z.unknown()).nullable(),
  post: z.record(z.string(), z.unknown()).nullable(),
  target_still_foreground: z.boolean().nullable(),
});
export type VerificationContract = z.infer<typeof VerificationContractSchema>;

/**
 * `evaluateVerificationOutcome` return shape. `status` mirrors what will be
 * written into `agent_step_results.ok` and — for desktop deterministic runs —
 * into `agent_runs.status`.
 */
export type VerificationOutcome = {
  allowedToSucceed: boolean;
  status: "succeeded" | "failed";
  errorCode: string | null;
  reason: string | null;
  /** True when require_verified=false but the action nevertheless reported
   *  verified=false; the caller may complete the step but MUST NOT claim
   *  the effect was verified. */
  unverified: boolean;
};

// ---------------------------------------------------------------- extract

/**
 * Locations the helper writes verification fields into. Kept in a single
 * table so future desktop_* tools can drop their contract into the same
 * shape without teaching the worker route about tool-specific paths.
 */
const VERIFICATION_LOCATIONS: readonly string[] = ["", "evidence", "result", "diagnostics"];

function readObj(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (key === "") return value as Record<string, unknown>;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") return null;
  return nested as Record<string, unknown>;
}

/**
 * Locate the first object under `result` that carries a `verification_kind`
 * field. Returns the raw object OR null when no verification is embedded
 * (for example desktop_snapshot which is purely observational).
 */
export function extractVerification(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  for (const loc of VERIFICATION_LOCATIONS) {
    const obj = readObj(result, loc);
    if (
      obj &&
      (typeof obj.verification_kind === "string" ||
        typeof obj.verified === "boolean" ||
        typeof obj.require_verified === "boolean")
    ) {
      return obj;
    }
  }
  return null;
}

// ---------------------------------------------------------------- normalize

function coerceBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "True" || value === 1) return true;
  if (value === "false" || value === "False" || value === 0) return false;
  return undefined;
}

function coerceInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return fallback;
}

function coerceEvidence(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EVIDENCE_ALLOWED_FIELDS) {
    if (key in src) out[key] = src[key];
  }
  // Never propagate raw focused_text / focused_value into the contract; they
  // are content, not evidence. The Helper already ships length + hash for
  // those and normalizeVerification drops anything else at whitelisting time.
  return out;
}

/**
 * Normalize a raw verification blob (as emitted by helper/desktop-operator.ps1
 * for click / type / drag / hotkey / press / scroll / clipboard / launch /
 * focus) into the shared contract shape.
 *
 * Guarantees:
 *  - Every field in VerificationContractSchema is present.
 *  - `failure_reason` is `null` when `verified === true`.
 *  - `success_reason` is populated when the source only had `failure_reason`
 *    but reported success (helper backwards compat).
 *  - `pre` / `post` are whitelisted evidence-only (no `focused_text` /
 *    `focused_value` bodies).
 *  - `verification_kind` falls back to `"input_only"` when the helper did
 *    not classify one, so the contract is always well-formed.
 */
export function normalizeVerification(raw: unknown): VerificationContract | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;

  const requireVerified = coerceBool(src.require_verified) ?? false;
  const verifiedRaw = coerceBool(src.verified);
  const verified = verifiedRaw ?? false;

  const rawKind = typeof src.verification_kind === "string" ? src.verification_kind : "input_only";
  const verification_kind: string = (VERIFICATION_KINDS as readonly string[]).includes(rawKind)
    ? rawKind
    : rawKind || "input_only";

  const rawFailure = typeof src.failure_reason === "string" ? (src.failure_reason as string) : null;
  const rawSuccess = typeof src.success_reason === "string" ? (src.success_reason as string) : null;
  const failure_reason = verified ? null : rawFailure;
  const success_reason = verified ? (rawSuccess ?? rawFailure ?? null) : (rawSuccess ?? null);

  const rawErrorCode = typeof src.error_code === "string" ? (src.error_code as string) : null;
  const error_code = verified ? null : rawErrorCode;

  const contract: VerificationContract = {
    require_verified: requireVerified,
    verified,
    verification_kind,
    failure_reason,
    success_reason,
    error_code,
    verification_attempts: coerceInt(src.verification_attempts, 0),
    verification_elapsed_ms: coerceInt(src.verification_elapsed_ms, 0),
    pre: coerceEvidence(src.pre),
    post: coerceEvidence(src.post),
    target_still_foreground:
      typeof src.target_still_foreground === "boolean"
        ? (src.target_still_foreground as boolean)
        : null,
  };
  // If verifiedRaw was undefined (missing), we synthesize a verified=false
  // contract but the caller can distinguish the two states because
  // evaluateVerificationOutcome checks the raw `verified` field via the
  // dedicated helper below.
  Object.defineProperty(contract, "__verified_missing__", {
    value: verifiedRaw === undefined,
    enumerable: false,
  });
  return contract;
}

function isVerifiedMissing(contract: VerificationContract): boolean {
  const marker = (contract as unknown as { __verified_missing__?: boolean }).__verified_missing__;
  return marker === true;
}

// ---------------------------------------------------------------- evaluate

export type EvaluateInput = {
  /** Explicit override; when omitted we honour `contract.require_verified`. */
  requireVerified?: boolean;
  /** Normalized contract; use `normalizeVerification` on the raw helper blob. */
  verification: VerificationContract | null;
};

/**
 * Decision function for the shared contract. Encodes the five rules in the
 * 0.4.22-B brief:
 *
 *  1. require_verified=true  + verified=true            → succeeded
 *  2. require_verified=true  + verified=false           → failed (tool code preferred)
 *  3. require_verified=true  + verified missing         → failed (ACTION_VERIFICATION_MISSING)
 *  4. require_verified=false + verified=false           → succeeded but unverified=true
 *  5. Tool API delivered ok=true but structured verified=false → still failed
 */
export function evaluateVerificationOutcome(input: EvaluateInput): VerificationOutcome {
  const { verification } = input;
  const requireVerified = input.requireVerified ?? verification?.require_verified ?? false;

  if (!verification) {
    if (requireVerified) {
      return {
        allowedToSucceed: false,
        status: "failed",
        errorCode: "ACTION_VERIFICATION_MISSING",
        reason: "verification_result_missing_but_require_verified_true",
        unverified: false,
      };
    }
    return {
      allowedToSucceed: true,
      status: "succeeded",
      errorCode: null,
      reason: null,
      unverified: false,
    };
  }

  const missing = isVerifiedMissing(verification);

  if (requireVerified && missing) {
    return {
      allowedToSucceed: false,
      status: "failed",
      errorCode: "ACTION_VERIFICATION_MISSING",
      reason: "verified_field_missing_from_tool_result",
      unverified: false,
    };
  }

  if (requireVerified && !verification.verified) {
    // Prefer the tool-specific error code (CLICK_NO_EFFECT / TYPE_NO_EFFECT
    // / etc.) so the caller receives the most precise diagnostic. Only fall
    // back to ACTION_VERIFICATION_FAILED when the helper did not surface one.
    const specific = verification.error_code;
    const errorCode: string =
      typeof specific === "string" && specific.length > 0 ? specific : "ACTION_VERIFICATION_FAILED";
    return {
      allowedToSucceed: false,
      status: "failed",
      errorCode,
      reason: verification.failure_reason ?? "verification_failed_no_reason_reported",
      unverified: false,
    };
  }

  if (requireVerified && verification.verified) {
    return {
      allowedToSucceed: true,
      status: "succeeded",
      errorCode: null,
      reason: verification.success_reason,
      unverified: false,
    };
  }

  // require_verified=false path — allowed to complete but truthfully mark
  // as unverified when the effect was not observed.
  return {
    allowedToSucceed: true,
    status: "succeeded",
    errorCode: null,
    reason: verification.verified
      ? (verification.success_reason ?? null)
      : (verification.failure_reason ?? "unverified_but_not_required"),
    unverified: !verification.verified,
  };
}

// ---------------------------------------------------------------- redact

/**
 * Return a payload safe for `agent_events` / `agent_step_results.result`.
 * Only contract fields plus already-redacted-shaped values (length / sha256
 * / preview) survive. Never carries raw focused_text / focused_value / typed
 * body.
 */
export function redactVerificationForAudit(
  contract: VerificationContract,
): Record<string, unknown> {
  return {
    require_verified: contract.require_verified,
    verified: contract.verified,
    verification_kind: contract.verification_kind,
    failure_reason: contract.failure_reason,
    success_reason: contract.success_reason,
    error_code: contract.error_code,
    verification_attempts: contract.verification_attempts,
    verification_elapsed_ms: contract.verification_elapsed_ms,
    pre: contract.pre,
    post: contract.post,
    target_still_foreground: contract.target_still_foreground,
  };
}

/** Convenience: wrap a plain string that may carry raw content. */
export function redactContentString(value: string): Redacted {
  return redactString(value);
}

// ---------------------------------------------------------------- events

export type StepEvent =
  | { event_type: "step.completed"; payload: Record<string, unknown> }
  | { event_type: "step.failed"; payload: Record<string, unknown> };

/**
 * Build the audit event that MUST accompany a step's verification outcome.
 * Enforces the invariant: `step.completed` is UNREACHABLE when the outcome
 * is `failed` — the returned event_type is always `step.failed` in that case.
 */
export function buildStepEventFromVerification(params: {
  intentId: string;
  toolName: string;
  outcome: VerificationOutcome;
  contract: VerificationContract | null;
  toolErrorCode?: string | null;
  toolErrorMessage?: string | null;
}): StepEvent {
  const { intentId, toolName, outcome, contract, toolErrorCode, toolErrorMessage } = params;
  const diagnostics = contract ? redactVerificationForAudit(contract) : null;
  if (outcome.status === "failed") {
    return {
      event_type: "step.failed",
      payload: {
        intent_id: intentId,
        tool_name: toolName,
        error_code: outcome.errorCode,
        reason: outcome.reason,
        tool_error_code: toolErrorCode ?? null,
        tool_error_message: toolErrorMessage ? redactString(toolErrorMessage).preview : null,
        diagnostics,
      },
    };
  }
  return {
    event_type: "step.completed",
    payload: {
      intent_id: intentId,
      tool_name: toolName,
      unverified: outcome.unverified,
      reason: outcome.reason,
      diagnostics,
    },
  };
}

// ---------------------------------------------------------------- exports

export { DESKTOP_ERROR_CODES, VERIFICATION_KINDS };
export type { DesktopErrorCode, VerificationKind };
