import { describe, it, expect } from "vitest";
import {
  ACCEPTANCE_SCRIPT,
  ACCEPTANCE_GOAL_PREFIX,
  ACCEPTANCE_TOOL_SCHEMAS,
  BROWSER_TOOL_SCHEMAS,
  isAcceptanceRunGoal,
  validateToolCall,
} from "@/lib/orchestrator.server";
import { isSentinelOwnerEmail, SENTINEL_OWNER_EMAIL } from "@/lib/owner-guard";
import {
  deriveAcceptanceMatrix,
  type AttemptGroup,
  type MatrixEvent,
} from "@/lib/acceptance-lab.functions";

// ---------- Matrix-derivation fixtures ----------
function ev(
  event_type: string,
  payload: Record<string, unknown> = {},
  at = "2026-07-17T10:00:00Z",
): MatrixEvent {
  return { event_type, payload, created_at: at };
}
function attemptGroup(attempt: number, intentCount = 5): AttemptGroup {
  return {
    attempt,
    intents: Array.from({ length: intentCount }, (_, i) => ({
      id: `intent-a${attempt}-${i}`,
      sequence: i + 1,
      tool_name: i === 0 ? "browser_goto" : "acceptance_wait",
      arguments_json: "{}",
      status: "completed",
    })),
    results: [],
    events: [],
  };
}
const runBase = {
  status: "queued",
  error_code: null as string | null,
  attempts: 1 as number | null,
  final_output: null as string | null,
  started_at: null as string | null,
};

describe("deriveAcceptanceMatrix — persisted evidence semantics", () => {
  it("attempt 1 timed_out: helper_offline_detection + running_to_timed_out PASS", () => {
    const events: MatrixEvent[] = [
      ev("acceptance.helper_online_verified", { attempt: 1, worker_id: "w1" }),
      ev("run.timed_out", { attempt: 1, worker_id: "w1", error_code: "LEASE_EXPIRED" }),
      ev("acceptance.helper_offline_verified", { attempt: 1, worker_id: "w1" }),
    ];
    const m = deriveAcceptanceMatrix({
      run: { ...runBase, status: "timed_out", error_code: "LEASE_EXPIRED", attempts: 1 },
      events,
      attempts_summary: [attemptGroup(1)],
    });
    expect(m.helper_online_detection).toBe("PASS");
    expect(m.helper_offline_detection).toBe("PASS");
    expect(m.running_to_timed_out).toBe("PASS");
    expect(m.fully_accepted).toBe(false);
  });

  it("after retry succeeded: worker_id cleared but attempt-1 PASS conclusions still hold", () => {
    const events: MatrixEvent[] = [
      ev("acceptance.helper_online_verified", { attempt: 1, worker_id: "w1" }),
      ev("run.timed_out", { attempt: 1, worker_id: "w1", error_code: "LEASE_EXPIRED" }),
      ev("acceptance.helper_offline_verified", { attempt: 1, worker_id: "w1" }),
      ev("run.retry_requested", { attempt: 2 }),
      ev("acceptance.helper_online_verified", { attempt: 2, worker_id: "w1" }),
      ev("acceptance.retry_succeeded", { attempt: 2, final_output_present: true, worker_id: "w1" }),
    ];
    const m = deriveAcceptanceMatrix({
      run: { ...runBase, status: "succeeded", error_code: null, attempts: 2, final_output: "ok" },
      events,
      attempts_summary: [attemptGroup(1), attemptGroup(2)],
    });
    expect(m.helper_online_detection).toBe("PASS");
    expect(m.helper_offline_detection).toBe("PASS");
    expect(m.running_to_timed_out).toBe("PASS");
    expect(m.timed_out_to_retry).toBe("PASS");
    expect(m.retry_to_succeeded).toBe("PASS");
    expect(m.fully_accepted).toBe(true);
  });

  it("missing LEASE_EXPIRED evidence: helper_offline_detection does NOT PASS", () => {
    const events: MatrixEvent[] = [
      ev("acceptance.helper_online_verified", { attempt: 1, worker_id: "w1" }),
      // no run.timed_out event, no helper_offline_verified
    ];
    const m = deriveAcceptanceMatrix({
      run: { ...runBase, status: "timed_out", error_code: "NO_PROGRESS_TIMEOUT", attempts: 1 },
      events,
      attempts_summary: [attemptGroup(1)],
    });
    expect(m.helper_offline_detection).toBe("FAIL");
    expect(m.fully_accepted).toBe(false);
  });

  it("attempt-1 evidence lost after retry: fully_accepted stays false", () => {
    const events: MatrixEvent[] = [
      ev("run.timed_out", { attempt: 1, worker_id: "w1", error_code: "LEASE_EXPIRED" }),
      ev("acceptance.helper_offline_verified", { attempt: 1, worker_id: "w1" }),
      ev("run.retry_requested", { attempt: 2 }),
      ev("acceptance.retry_succeeded", { attempt: 2, final_output_present: true, worker_id: "w1" }),
    ];
    const m = deriveAcceptanceMatrix({
      run: { ...runBase, status: "succeeded", attempts: 2, final_output: "ok" },
      events,
      // attempt 1 intents wiped
      attempts_summary: [attemptGroup(1, 0), attemptGroup(2)],
    });
    expect(m.timed_out_to_retry).toBe("FAIL");
    expect(m.retry_to_succeeded).not.toBe("PASS");
    expect(m.fully_accepted).toBe(false);
  });

  it("no events at all: everything PENDING (never falsely PASS)", () => {
    const m = deriveAcceptanceMatrix({
      run: { ...runBase, status: "queued" },
      events: [],
      attempts_summary: [attemptGroup(1, 0)],
    });
    expect(m.helper_online_detection).toBe("PENDING");
    expect(m.helper_offline_detection).toBe("PENDING");
    expect(m.running_to_timed_out).toBe("PENDING");
    expect(m.timed_out_to_retry).toBe("PENDING");
    expect(m.retry_to_succeeded).toBe("PENDING");
    expect(m.fully_accepted).toBe(false);
  });
});

describe("owner guard", () => {
  it("accepts canonical Sentinel Owner email", () => {
    expect(isSentinelOwnerEmail(SENTINEL_OWNER_EMAIL)).toBe(true);
    expect(isSentinelOwnerEmail("AOSENBEARING@gmail.com")).toBe(true);
    expect(isSentinelOwnerEmail(" aosenbearing@gmail.com ")).toBe(true);
  });
  it("rejects everyone else", () => {
    expect(isSentinelOwnerEmail("attacker@evil.com")).toBe(false);
    expect(isSentinelOwnerEmail("")).toBe(false);
    expect(isSentinelOwnerEmail(undefined)).toBe(false);
    expect(isSentinelOwnerEmail(null)).toBe(false);
    expect(isSentinelOwnerEmail(123)).toBe(false);
  });
});

describe("acceptance_wait tool", () => {
  it("accepts 1..60000 ms", () => {
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 1 }).success).toBe(
      true,
    );
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 60000 }).success).toBe(
      true,
    );
  });
  it("rejects >60000 ms", () => {
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 60001 }).success).toBe(
      false,
    );
    expect(
      ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 3_600_000 }).success,
    ).toBe(false);
  });
  it("rejects zero and negatives", () => {
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 0 }).success).toBe(
      false,
    );
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: -1 }).success).toBe(
      false,
    );
  });
  it("is NOT in the general browser tool whitelist — normal runs cannot emit it", () => {
    expect((BROWSER_TOOL_SCHEMAS as Record<string, unknown>).acceptance_wait).toBeUndefined();
    // A normal-run validation path (model→tool) rejects acceptance_wait.
    const r = validateToolCall("acceptance_wait", { duration_ms: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_NOT_WHITELISTED");
  });
});

describe("acceptance lab deterministic script", () => {
  it("goal prefix detector matches only lab goals", () => {
    expect(isAcceptanceRunGoal(`${ACCEPTANCE_GOAL_PREFIX} whatever`)).toBe(true);
    expect(isAcceptanceRunGoal("Open the Alibaba seller portal")).toBe(false);
    expect(isAcceptanceRunGoal(null)).toBe(false);
    expect(isAcceptanceRunGoal(undefined)).toBe(false);
  });
  it("script executes exactly 3 acceptance_wait calls plus goto/extract", () => {
    const waits = ACCEPTANCE_SCRIPT.filter((s) => s.tool_name === "acceptance_wait");
    expect(waits.length).toBe(3);
    for (const w of waits) expect(w.arguments.duration_ms).toBe(60000);
    expect(ACCEPTANCE_SCRIPT[0]).toEqual({
      tool_name: "browser_goto",
      arguments: { url: "https://example.com" },
    });
    expect(ACCEPTANCE_SCRIPT[ACCEPTANCE_SCRIPT.length - 1]).toEqual({
      tool_name: "browser_extract",
      arguments: { selector: "h1" },
    });
    expect(ACCEPTANCE_SCRIPT.length).toBe(5);
  });
});
