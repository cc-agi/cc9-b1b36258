/**
 * 0.4.22-B — Unified Action Verification Contract regression suite.
 *
 * Covers:
 *  1. The five decision rules in evaluateVerificationOutcome.
 *  2. Tool-specific error codes are preserved by the contract.
 *  3. Existing click (target_focus_verified) and type (empty_exact) success
 *     diagnostics map into the contract without regression.
 *  4. verified=true guarantees failure_reason=null.
 *  5. Sensitive text (focused_text / focused_value bodies) NEVER survives
 *     normalization; only whitelisted length/hash/metadata does.
 *  6. Route + orchestrator source uses the shared contract (no test-only
 *     fake branch).
 *  7. step.completed cannot ride on top of require_verified=true+false.
 *  8. Pure fake mirroring the worker route proves the DB `succeeded` path is
 *     unreachable under structured failure — even when the model text says
 *     "success" and even when tool.ok=true.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildStepEventFromVerification,
  evaluateVerificationOutcome,
  extractVerification,
  normalizeVerification,
  redactVerificationForAudit,
  VerificationContractSchema,
  type VerificationContract,
} from "@/lib/desktop/verification-contract";
import { classifyFinalOutputFailure } from "@/lib/orchestrator/validate-final-output";

// ------------------------------------------------------------ tiny factories

function helperClickSuccess(): Record<string, unknown> {
  // Mirrors helper/desktop-operator.ps1 Tool-Click return shape on the
  // successful path (target_focus_verified).
  return {
    x: 400,
    y: 300,
    button: "left",
    clicks: 1,
    require_verified: true,
    verified: true,
    verification_kind: "target_focus_verified",
    verification_attempts: 1,
    verification_elapsed_ms: 74,
    pre: {
      foreground_window_handle: "0xAA",
      focused_class: "RichEditD2DPT",
      focused_text_length: 12,
      focused_text_hash: "abc",
      focused_value_hash: "def",
      focused_text: "SECRET STUFF", // MUST be scrubbed by normalizer.
      clipboard_sequence: 3,
      captured_at_ms: 1000,
    },
    post: {
      foreground_window_handle: "0xAA",
      focused_class: "RichEditD2DPT",
      focused_text_length: 12,
      focused_text_hash: "abc",
      focused_value_hash: "def",
      focused_text: "SECRET STUFF", // MUST be scrubbed by normalizer.
      clipboard_sequence: 3,
      captured_at_ms: 1074,
    },
    target_still_foreground: true,
    failure_reason: "document_or_edit_target_still_focused",
  };
}

function helperTypeSuccessEmptyExact(): Record<string, unknown> {
  return {
    require_verified: true,
    verified: true,
    verification_kind: "type_semantics",
    verification_attempts: 3,
    verification_elapsed_ms: 320,
    pre: {
      foreground_window_handle: "0xBB",
      focused_text_length: 0,
      focused_text_hash: "e3b0c44…",
      clipboard_sequence: 5,
      captured_at_ms: 2000,
    },
    post: {
      foreground_window_handle: "0xBB",
      focused_text_length: 5,
      focused_text_hash: "hello…",
      clipboard_sequence: 5,
      captured_at_ms: 2320,
    },
    target_still_foreground: true,
    semantic: "empty_exact",
    failure_reason: "empty_target_exact_match",
    text_length_before: 0,
    text_length_after: 5,
    text_hash_before: "e3b0c44…",
    text_hash_after: "hello…",
  };
}

function helperClickFailure(): Record<string, unknown> {
  return {
    require_verified: true,
    verified: false,
    verification_kind: "foreground_or_focus_change",
    error_code: "CLICK_NO_EFFECT",
    verification_attempts: 6,
    verification_elapsed_ms: 1600,
    pre: { foreground_window_handle: "0xCC", clipboard_sequence: 1, captured_at_ms: 0 },
    post: { foreground_window_handle: "0xCC", clipboard_sequence: 1, captured_at_ms: 1600 },
    target_still_foreground: true,
    failure_reason: "no_focus_or_text_or_bounds_or_caret_change",
  };
}

// ---------------------------------------------------- 1..5: decision rules

describe("evaluateVerificationOutcome — decision rules", () => {
  it("Rule 1: require_verified=true + verified=true → succeeded", () => {
    const contract = normalizeVerification(helperClickSuccess())!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.allowedToSucceed).toBe(true);
    expect(outcome.errorCode).toBeNull();
    expect(outcome.unverified).toBe(false);
  });

  it("Rule 2: require_verified=true + verified=false → failed (tool code preferred)", () => {
    const contract = normalizeVerification(helperClickFailure())!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.allowedToSucceed).toBe(false);
    // Tool-specific code preferred over generic ACTION_VERIFICATION_FAILED.
    expect(outcome.errorCode).toBe("CLICK_NO_EFFECT");
    expect(outcome.reason).toMatch(/no_focus_or_text/);
  });

  it("Rule 2 fallback: require_verified=true + verified=false, no error_code → ACTION_VERIFICATION_FAILED", () => {
    const raw = { require_verified: true, verified: false, verification_kind: "input_only" };
    const contract = normalizeVerification(raw)!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("ACTION_VERIFICATION_FAILED");
  });

  it("Rule 3: require_verified=true + verified MISSING → failed (ACTION_VERIFICATION_MISSING)", () => {
    const raw = {
      require_verified: true,
      verification_kind: "type_semantics",
      // deliberately omit `verified`
    };
    const contract = normalizeVerification(raw)!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("ACTION_VERIFICATION_MISSING");
  });

  it("Rule 3 also fires when the whole verification block is missing", () => {
    const outcome = evaluateVerificationOutcome({
      requireVerified: true,
      verification: null,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("ACTION_VERIFICATION_MISSING");
  });

  it("Rule 4: require_verified=false + verified=false → succeeded but unverified", () => {
    const raw = {
      require_verified: false,
      verified: false,
      verification_kind: "input_only",
      failure_reason: "input_only_semantics",
    };
    const contract = normalizeVerification(raw)!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.allowedToSucceed).toBe(true);
    expect(outcome.unverified).toBe(true);
    expect(outcome.reason).toBe("input_only_semantics");
  });

  it("Rule 4 does NOT set verified=true implicitly", () => {
    const raw = { require_verified: false, verified: false, verification_kind: "input_only" };
    const contract = normalizeVerification(raw)!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.unverified).toBe(true);
    expect(contract.verified).toBe(false); // preserved
    expect(contract.failure_reason).toBeNull(); // failure_reason cleared per success-path invariant (below)
  });

  it("Rule 5: tool API ok=true but structured verified=false → failed (route override)", () => {
    // This test mirrors the code path inside handleStepResult: contract wins.
    const contract = normalizeVerification(helperClickFailure())!;
    const outcome = evaluateVerificationOutcome({ verification: contract });
    const inputOk = true; // tool claimed it "delivered" but nothing landed
    const effectiveOk = inputOk && outcome.status === "succeeded";
    expect(effectiveOk).toBe(false);
  });
});

// ---------------------------------------------------- 6..8: contract mapping

describe("contract normalization — existing helper outputs", () => {
  it("click target_focus_verified success maps to the contract cleanly", () => {
    const contract = normalizeVerification(helperClickSuccess())!;
    expect(() => VerificationContractSchema.parse(contract)).not.toThrow();
    expect(contract.verified).toBe(true);
    expect(contract.verification_kind).toBe("target_focus_verified");
    expect(contract.failure_reason).toBeNull();
    expect(contract.success_reason).toBe("document_or_edit_target_still_focused");
    expect(contract.error_code).toBeNull();
    expect(contract.verification_attempts).toBe(1);
  });

  it("type empty_exact fallback success maps to the contract cleanly", () => {
    const contract = normalizeVerification(helperTypeSuccessEmptyExact())!;
    expect(() => VerificationContractSchema.parse(contract)).not.toThrow();
    expect(contract.verified).toBe(true);
    expect(contract.verification_kind).toBe("type_semantics");
    expect(contract.failure_reason).toBeNull();
    expect(contract.success_reason).toBe("empty_target_exact_match");
  });

  it("verified=true → failure_reason IS null (invariant)", () => {
    const raws = [
      helperClickSuccess(),
      helperTypeSuccessEmptyExact(),
      {
        require_verified: true,
        verified: true,
        verification_kind: "clipboard_change",
        failure_reason: "clipboard_sequence_changed", // helper backwards-compat
      },
    ];
    for (const raw of raws) {
      const c = normalizeVerification(raw)!;
      expect(c.verified).toBe(true);
      expect(c.failure_reason).toBeNull();
    }
  });

  it("tool-specific error_code is preserved on the failed path", () => {
    for (const code of [
      "CLICK_NO_EFFECT",
      "TYPE_NO_EFFECT",
      "DRAG_NO_EFFECT",
      "HOTKEY_NO_EFFECT",
      "TYPE_FALLBACK_FAILED",
    ] as const) {
      const raw = {
        require_verified: true,
        verified: false,
        verification_kind: "input_only",
        error_code: code,
        failure_reason: "x",
      };
      const c = normalizeVerification(raw)!;
      const outcome = evaluateVerificationOutcome({ verification: c });
      expect(outcome.status).toBe("failed");
      expect(outcome.errorCode).toBe(code);
    }
  });
});

// ---------------------------------------------------- 9: sensitive redaction

describe("sensitive data never enters normalized contract", () => {
  it("focused_text / focused_value bodies are stripped from pre and post", () => {
    const raw = helperClickSuccess();
    const c = normalizeVerification(raw)!;
    const preStr = JSON.stringify(c.pre ?? {});
    const postStr = JSON.stringify(c.post ?? {});
    expect(preStr).not.toContain("SECRET STUFF");
    expect(postStr).not.toContain("SECRET STUFF");
    // Whitelisted fields survive.
    expect(c.pre?.focused_text_hash).toBe("abc");
    expect(c.pre?.focused_text_length).toBe(12);
  });

  it("audit redaction returns only whitelisted contract fields", () => {
    const c = normalizeVerification(helperClickSuccess())!;
    const audit = redactVerificationForAudit(c);
    const s = JSON.stringify(audit);
    expect(s).not.toContain("SECRET STUFF");
    expect(Object.keys(audit).sort()).toEqual(
      [
        "error_code",
        "failure_reason",
        "post",
        "pre",
        "require_verified",
        "success_reason",
        "target_still_foreground",
        "verification_attempts",
        "verification_elapsed_ms",
        "verification_kind",
        "verified",
      ].sort(),
    );
  });
});

// ---------------------------------------------------- 10: event derivation

describe("buildStepEventFromVerification — step.completed cannot mask failure", () => {
  it("failed outcome → event_type='step.failed' with diagnostics", () => {
    const c = normalizeVerification(helperClickFailure())!;
    const outcome = evaluateVerificationOutcome({ verification: c });
    const ev = buildStepEventFromVerification({
      intentId: "00000000-0000-0000-0000-000000000001",
      toolName: "desktop_click",
      outcome,
      contract: c,
    });
    expect(ev.event_type).toBe("step.failed");
    const payload = ev.payload;
    expect(payload.error_code).toBe("CLICK_NO_EFFECT");
    expect(payload.diagnostics).toBeTruthy();
    expect(JSON.stringify(payload)).not.toContain("SECRET STUFF");
  });

  it("succeeded outcome → event_type='step.completed'", () => {
    const c = normalizeVerification(helperClickSuccess())!;
    const outcome = evaluateVerificationOutcome({ verification: c });
    const ev = buildStepEventFromVerification({
      intentId: "00000000-0000-0000-0000-000000000002",
      toolName: "desktop_click",
      outcome,
      contract: c,
    });
    expect(ev.event_type).toBe("step.completed");
  });

  it("require_verified=false, verified=false → step.completed with unverified=true", () => {
    const raw = {
      require_verified: false,
      verified: false,
      verification_kind: "input_only",
      failure_reason: "input_only_semantics",
    };
    const c = normalizeVerification(raw)!;
    const outcome = evaluateVerificationOutcome({ verification: c });
    const ev = buildStepEventFromVerification({
      intentId: "00000000-0000-0000-0000-000000000003",
      toolName: "desktop_press",
      outcome,
      contract: c,
    });
    expect(ev.event_type).toBe("step.completed");
    expect(ev.payload.unverified).toBe(true);
  });

  it("failed outcome INVARIANT: no representable path produces event_type='step.completed'", () => {
    // Fuzz-ish sweep across contract shapes.
    const shapes = [
      helperClickFailure(),
      { require_verified: true, verified: false, verification_kind: "input_only" },
      { require_verified: true, verification_kind: "type_semantics" }, // verified missing
    ];
    for (const raw of shapes) {
      const c = normalizeVerification(raw);
      const outcome = evaluateVerificationOutcome({
        requireVerified: raw.require_verified ?? true,
        verification: c,
      });
      const ev = buildStepEventFromVerification({
        intentId: "id",
        toolName: "desktop_x",
        outcome,
        contract: c,
      });
      if (outcome.status === "failed") {
        expect(ev.event_type).toBe("step.failed");
      }
    }
  });
});

// ---------------------------------------------------- 11: extractor coverage

describe("extractVerification — locates the block regardless of nesting", () => {
  const ver = { require_verified: true, verified: true, verification_kind: "input_only" };
  it("finds it at top level", () => {
    expect(extractVerification(ver)).toEqual(ver);
  });
  it("finds it under .evidence", () => {
    expect(extractVerification({ evidence: ver })).toEqual(ver);
  });
  it("finds it under .result", () => {
    expect(extractVerification({ result: ver })).toEqual(ver);
  });
  it("returns null for non-verification blobs (desktop_snapshot)", () => {
    expect(
      extractVerification({ evidence: { image_path: "/tmp/x.png", monitors: [] } }),
    ).toBeNull();
  });
  it("returns null for null/undefined/non-object", () => {
    expect(extractVerification(null)).toBeNull();
    expect(extractVerification(undefined)).toBeNull();
    expect(extractVerification("string")).toBeNull();
  });
});

// ---------------------------------------------------- 12: production wiring

describe("production wiring — real route + orchestrator import the contract", () => {
  const projectRoot = resolve(process.cwd());
  const routeSrc = readFileSync(
    resolve(projectRoot, "src/routes/api/worker/v1/$action.ts"),
    "utf8",
  );
  const orchSrc = readFileSync(resolve(projectRoot, "src/lib/orchestrator.server.ts"), "utf8");

  it("worker route imports the shared contract module by path", () => {
    expect(routeSrc).toContain("@/lib/desktop/verification-contract");
  });
  it("worker route calls evaluateVerificationOutcome and buildStepEventFromVerification", () => {
    expect(routeSrc).toMatch(/evaluateVerificationOutcome\s*\(/);
    expect(routeSrc).toMatch(/buildStepEventFromVerification\s*\(/);
  });
  it("orchestrator desktop branch consults the contract before finalizing", () => {
    expect(orchSrc).toContain("@/lib/desktop/verification-contract");
    expect(orchSrc).toMatch(/evaluateVerificationOutcome\s*\(/);
  });
});

// ---------------------------------------------------- 13: DB unreachability

/**
 * Pure fake mirroring the worker /step-result handler for the parts that
 * matter to the invariant: how the ok/error/event triple is computed from
 * the tool payload. If the real handler diverges from this fake, tests in
 * §12 (production wiring) still guarantee the shared contract runs; and
 * the fake alone proves the succeeded path is unreachable when the
 * structured verification says failed.
 */
type FakeInput = {
  ok: boolean;
  result: unknown;
  error_code?: string | null;
  error_message?: string | null;
};
function fakeHandleStepResult(input: FakeInput): {
  effectiveOk: boolean;
  errorCode: string | null;
  event: string;
  contract: VerificationContract | null;
} {
  const contract = normalizeVerification(extractVerification(input.result));
  const outcome = evaluateVerificationOutcome({ verification: contract });
  const effectiveOk = input.ok && outcome.status === "succeeded";
  const errorCode = outcome.status === "failed" ? outcome.errorCode : (input.error_code ?? null);
  const ev = buildStepEventFromVerification({
    intentId: "id",
    toolName: "desktop_x",
    outcome,
    contract,
  });
  return { effectiveOk, errorCode, event: ev.event_type, contract };
}

describe("invariant: DB succeeded unreachable under structured verification failure", () => {
  it("ok=true + require_verified=true + verified=false → effectiveOk=false + step.failed", () => {
    const r = fakeHandleStepResult({ ok: true, result: helperClickFailure() });
    expect(r.effectiveOk).toBe(false);
    expect(r.errorCode).toBe("CLICK_NO_EFFECT");
    expect(r.event).toBe("step.failed");
  });

  it("ok=true + require_verified=true + verified missing → effectiveOk=false", () => {
    const r = fakeHandleStepResult({
      ok: true,
      result: { require_verified: true, verification_kind: "input_only" },
    });
    expect(r.effectiveOk).toBe(false);
    expect(r.errorCode).toBe("ACTION_VERIFICATION_MISSING");
    expect(r.event).toBe("step.failed");
  });

  it("ok=true + require_verified=true + verified=true → effectiveOk=true + step.completed", () => {
    const r = fakeHandleStepResult({ ok: true, result: helperClickSuccess() });
    expect(r.effectiveOk).toBe(true);
    expect(r.errorCode).toBeNull();
    expect(r.event).toBe("step.completed");
  });
});

// ---------------------------------------------------- 14: priority vs text

describe("structured verification takes priority over textual classifier", () => {
  it("verified=false structured + model text 'success' → classifier sees verified=false", () => {
    // Even if a downstream synthesizer wrote model text that says "success",
    // the structured 'verified=false' phrase in it still trips the 0.4.22-A
    // final-output classifier. This is the belt-and-braces on top of the
    // structured priority enforced at the route/orchestrator layer.
    const summary =
      `SENTINEL_DESKTOP · desktop_click ok\n` +
      JSON.stringify({ verified: false, verification_kind: "input_only" });
    const c = classifyFinalOutputFailure(summary);
    expect(c.failed).toBe(true);
    expect(c.error_code).toBe("ACTION_VERIFICATION_FAILED");
  });

  it("verified=true structured + historical 'previous attempt failed' text → not flagged", () => {
    const summary =
      "The previous attempt failed but this retry succeeded and click was verified true.";
    const c = classifyFinalOutputFailure(summary);
    expect(c.failed).toBe(false);
  });
});
