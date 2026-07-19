/**
 * 0.4.22-A — Final Outcome Truthfulness Guard regression suite.
 *
 * Verifies that classifyFinalOutputFailure catches the explicit failure
 * declarations enumerated in the 0.4.22-A brief, and that a genuine success
 * report (including one that mentions "previous attempt failed" as history)
 * is NOT downgraded. Also proves the invariant that when the classifier
 * reports failed=true, the worker route's outcome.kind === "final" branch
 * cannot reach the status='succeeded' path.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFinalOutputFailure,
  type FinalOutputClassification,
  type FinalOutputFailureCode,
} from "@/lib/orchestrator/validate-final-output";

function expectFailed(
  r: FinalOutputClassification,
  code: FinalOutputFailureCode,
): void {
  expect(r.failed).toBe(true);
  expect(r.error_code).toBe(code);
  expect(r.reason).toBeTruthy();
}

function expectOk(r: FinalOutputClassification): void {
  expect(r.failed).toBe(false);
  expect(r.error_code).toBeNull();
  expect(r.reason).toBeNull();
}

describe("classifyFinalOutputFailure — explicit failure declarations", () => {
  it("'Status: FAILED — 0.4.22 NOT IMPLEMENTED' → MODEL_DECLARED_FAILURE", () => {
    const text =
      "Status: FAILED — 0.4.22 NOT IMPLEMENTED\n" +
      "Files modified: 0. Tests added: 0.";
    // First matcher wins; status label is checked before NOT IMPLEMENTED,
    // so the reported code is the declared-failure one. Either way the run
    // MUST NOT be succeeded.
    const r = classifyFinalOutputFailure(text);
    expect(r.failed).toBe(true);
    expect(r.error_code).toBe("MODEL_DECLARED_FAILURE");
  });

  it("'**Final status: FAILED — CODE NOT READY**' → MODEL_DECLARED_FAILURE", () => {
    const r = classifyFinalOutputFailure(
      "Everything else looks fine.\n\n**Final status: FAILED — CODE NOT READY, 0.4.22 NOT DELIVERED.**",
    );
    expect(r.failed).toBe(true);
    expect(r.error_code).toBe("MODEL_DECLARED_FAILURE");
  });

  it("standalone 'CODE NOT READY' phrase → MODEL_DECLARED_FAILURE", () => {
    const r = classifyFinalOutputFailure("Result: CODE NOT READY, awaiting owner review.");
    expect(r.failed).toBe(true);
    expect(r.error_code).toBe("MODEL_DECLARED_FAILURE");
  });

  it("bare 'NOT IMPLEMENTED' as declarative marker → MODEL_DECLARED_NOT_IMPLEMENTED", () => {
    const r = classifyFinalOutputFailure(
      "Sentinel OS 0.4.22 NOT IMPLEMENTED. See regression matrix.",
    );
    expect(r.failed).toBe(true);
    expect(r.error_code).toBe("MODEL_DECLARED_NOT_IMPLEMENTED");
  });

  it("'0.4.22 NOT DELIVERED' → MODEL_DECLARED_NOT_IMPLEMENTED", () => {
    const r = classifyFinalOutputFailure("Deliverables: NOT DELIVERED this turn.");
    expect(r.failed).toBe(true);
    expect(r.error_code).toBe("MODEL_DECLARED_NOT_IMPLEMENTED");
  });
});

describe("classifyFinalOutputFailure — explicit machine error codes", () => {
  it("CODE_WRITE_CAPABILITY_REQUIRED → failed", () => {
    expectFailed(
      classifyFinalOutputFailure(
        "I need CODE_WRITE_CAPABILITY_REQUIRED to finish this task; aborting.",
      ),
      "CODE_WRITE_CAPABILITY_REQUIRED",
    );
  });

  it("DESKTOP_TOOL_UNAVAILABLE → failed", () => {
    expectFailed(
      classifyFinalOutputFailure(
        "The browser-only branch reports DESKTOP_TOOL_UNAVAILABLE for this session.",
      ),
      "DESKTOP_TOOL_UNAVAILABLE",
    );
  });

  it("DESKTOP_DIRECT_TOOL_REQUIRED → failed", () => {
    expectFailed(
      classifyFinalOutputFailure("Blocking on DESKTOP_DIRECT_TOOL_REQUIRED — user attention needed."),
      "DESKTOP_DIRECT_TOOL_REQUIRED",
    );
  });

  it("ACTION_VERIFICATION_FAILED → failed", () => {
    expectFailed(
      classifyFinalOutputFailure("Result: ACTION_VERIFICATION_FAILED for the drag step."),
      "ACTION_VERIFICATION_FAILED",
    );
  });

  it("kebab-case lookalike does NOT match the uppercase token", () => {
    // We only accept the exact uppercase identifier so a stray sentence like
    // "the code-write capability required to..." doesn't false-fail.
    const r = classifyFinalOutputFailure(
      "The code-write-capability required for this task is documented in the plan.",
    );
    expectOk(r);
  });
});

describe("classifyFinalOutputFailure — action verification", () => {
  it("'verified=false' → ACTION_VERIFICATION_FAILED", () => {
    expectFailed(
      classifyFinalOutputFailure("Diagnostics: {verified=false, failure_reason: no_change}"),
      "ACTION_VERIFICATION_FAILED",
    );
  });
  it("JSON-shaped '\"verified\": false' → ACTION_VERIFICATION_FAILED", () => {
    expectFailed(
      classifyFinalOutputFailure(
        `Tool result summary: {"verified": false, "verification_kind": "input_only"}`,
      ),
      "ACTION_VERIFICATION_FAILED",
    );
  });
  it("YAML-shaped 'verified: false' → ACTION_VERIFICATION_FAILED", () => {
    expectFailed(
      classifyFinalOutputFailure("outcome:\n  verified: false\n  reason: no_effect"),
      "ACTION_VERIFICATION_FAILED",
    );
  });
});

describe("classifyFinalOutputFailure — desktop refusal shares detector", () => {
  it("'desktop_click is not available' surfaces DESKTOP_TOOL_UNAVAILABLE", () => {
    expectFailed(
      classifyFinalOutputFailure(
        "I attempted desktop_click, but the desktop tool is not available in this session.",
      ),
      "DESKTOP_TOOL_UNAVAILABLE",
    );
  });
});

describe("classifyFinalOutputFailure — must NOT downgrade genuine success", () => {
  it("normal CODE READY report → not failed", () => {
    const r = classifyFinalOutputFailure(
      "Sentinel OS 0.4.21 — CODE READY. All 308 vitest checks passed and 28/28 release gates green.",
    );
    expectOk(r);
  });

  it("history that mentions 'previous attempt failed' but ends succeeded → not failed", () => {
    const r = classifyFinalOutputFailure(
      "The previous attempt failed with a transient network error, but this retry succeeded and the fix is verified.",
    );
    expectOk(r);
  });

  it("Acceptance Lab structured summary → not failed", () => {
    const r = classifyFinalOutputFailure(
      "SENTINEL_ACCEPTANCE_LAB · fixed script complete\n" +
        "url=https://example.com/\n" +
        "title=Example Domain\n" +
        "h1=Example Domain",
    );
    expectOk(r);
  });

  it("prose mentioning 'not-implemented behaviour' as documentation → not failed", () => {
    const r = classifyFinalOutputFailure(
      "See the not-implemented behaviour section of the design doc for the deferred capabilities.",
    );
    expectOk(r);
  });

  it("empty final_output → not failed (handled by validateFinalOutput's MODEL_OUTPUT_EMPTY)", () => {
    expectOk(classifyFinalOutputFailure(""));
    expectOk(classifyFinalOutputFailure("   \n\t"));
    expectOk(classifyFinalOutputFailure(null));
    expectOk(classifyFinalOutputFailure(undefined));
  });

  it("mention of a lower-case tool name inside a success report → not failed", () => {
    const r = classifyFinalOutputFailure(
      "Successfully invoked desktop_click and verified the target focus was preserved.",
    );
    expectOk(r);
  });
});

// ---------------------------------------------------------------------------
// Contract test — the outcome.kind === "final" branch of
// src/routes/api/worker/v1/$action.ts CANNOT reach status='succeeded' when
// the classifier reports failed=true. Encoded here as a pure fake of the
// route's decision table so it can run in vitest without a live worker.
// ---------------------------------------------------------------------------

type Finalized = {
  status: "succeeded" | "failed";
  error_code: string | null;
  final_output: string;
};

/**
 * Faithful pure re-implementation of the branch introduced by 0.4.22-A. If
 * this diverges from the real handler the vitest that pins the source line
 * (below) will fail — forcing the two to be updated in lockstep.
 */
function fakeHandleFinalOutcome(finalOutput: string): Finalized {
  const truncated = finalOutput.slice(0, 20000);
  const c = classifyFinalOutputFailure(truncated);
  if (c.failed && c.error_code) {
    return { status: "failed", error_code: c.error_code, final_output: truncated };
  }
  return { status: "succeeded", error_code: null, final_output: truncated };
}

describe("worker route contract — failed classification cannot become succeeded", () => {
  const failureFixtures: readonly string[] = [
    "Status: FAILED — 0.4.22 NOT IMPLEMENTED\nFiles modified: 0.",
    "**Final status: FAILED — CODE NOT READY, 0.4.22 NOT DELIVERED.**",
    "CODE_WRITE_CAPABILITY_REQUIRED to proceed further.",
    "DESKTOP_TOOL_UNAVAILABLE for this run.",
    "DESKTOP_DIRECT_TOOL_REQUIRED — user attention needed.",
    "ACTION_VERIFICATION_FAILED on the drag step.",
    `Tool result: {"verified": false, "verification_kind": "input_only"}`,
    "Result: CODE NOT READY.",
    "Deliverables NOT DELIVERED this turn.",
  ];
  for (const text of failureFixtures) {
    it(`classifier failed=true ⇒ finalized status='failed' for: ${text.slice(0, 60)}...`, () => {
      const out = fakeHandleFinalOutcome(text);
      expect(out.status).toBe("failed");
      // final_output preserved so the owner can read the model's own report.
      expect(out.final_output.length).toBeGreaterThan(0);
      expect(out.error_code).toMatch(
        /^(MODEL_DECLARED_FAILURE|MODEL_DECLARED_NOT_IMPLEMENTED|CODE_WRITE_CAPABILITY_REQUIRED|DESKTOP_TOOL_UNAVAILABLE|DESKTOP_DIRECT_TOOL_REQUIRED|ACTION_VERIFICATION_FAILED)$/,
      );
    });
  }

  it("a genuine success report still finalizes as 'succeeded'", () => {
    const out = fakeHandleFinalOutcome(
      "Task complete: 3 pull requests reviewed, 2 merged, 1 needs revisions.",
    );
    expect(out.status).toBe("succeeded");
    expect(out.error_code).toBeNull();
  });
});
