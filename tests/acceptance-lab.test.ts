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
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 1 }).success).toBe(true);
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 60000 }).success).toBe(true);
  });
  it("rejects >60000 ms", () => {
    expect(
      ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 60001 }).success,
    ).toBe(false);
    expect(
      ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 3_600_000 }).success,
    ).toBe(false);
  });
  it("rejects zero and negatives", () => {
    expect(ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: 0 }).success).toBe(false);
    expect(
      ACCEPTANCE_TOOL_SCHEMAS.acceptance_wait.safeParse({ duration_ms: -1 }).success,
    ).toBe(false);
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
