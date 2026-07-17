import { describe, it, expect } from "bun:test";
import {
  validateToolCall,
  BROWSER_TOOL_SCHEMAS,
  CLICK_DENY_KEYWORDS,
  MAX_STEPS_PER_ATTEMPT,
  MAX_WALLCLOCK_MS,
} from "@/lib/orchestrator.server";

describe("orchestrator whitelist", () => {
  it("accepts browser_goto with valid URL", () => {
    const r = validateToolCall("browser_goto", { url: "https://example.com" });
    expect(r.ok).toBe(true);
  });
  it("rejects browser_goto with non-URL", () => {
    const r = validateToolCall("browser_goto", { url: "not-a-url" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_INPUT_INVALID");
  });
  it("rejects browser_fill entirely (not whitelisted)", () => {
    const r = validateToolCall("browser_fill", { selector: "#x", value: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_NOT_WHITELISTED");
  });
  it("rejects browser_eval entirely", () => {
    const r = validateToolCall("browser_eval", { expression: "1+1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_NOT_WHITELISTED");
  });
  it("rejects browser_press entirely", () => {
    const r = validateToolCall("browser_press", { key: "Enter" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOOL_NOT_WHITELISTED");
  });
  it("rejects unknown tool", () => {
    const r = validateToolCall("browser_delete_files", { path: "/" });
    expect(r.ok).toBe(false);
  });
  it("browser_wait_for enforces max timeout", () => {
    const r = validateToolCall("browser_wait_for", { selector: "#x", timeoutMs: 99999999 });
    expect(r.ok).toBe(false);
  });
  it("browser_click requires selector", () => {
    const r = validateToolCall("browser_click", {});
    expect(r.ok).toBe(false);
  });
  it("whitelist contains only 6 read-only tools", () => {
    expect(Object.keys(BROWSER_TOOL_SCHEMAS).sort()).toEqual([
      "browser_click",
      "browser_extract",
      "browser_goto",
      "browser_inspect_candidates",
      "browser_screenshot",
      "browser_wait_for",
    ]);
  });
  it("click deny keywords include destructive actions", () => {
    for (const kw of ["delete", "purchase", "publish", "确认", "删除", "购买"]) {
      expect(CLICK_DENY_KEYWORDS).toContain(kw);
    }
  });
  it("has hard step + wallclock caps", () => {
    expect(MAX_STEPS_PER_ATTEMPT).toBeGreaterThan(0);
    expect(MAX_STEPS_PER_ATTEMPT).toBeLessThanOrEqual(50);
    expect(MAX_WALLCLOCK_MS).toBeGreaterThanOrEqual(60_000);
  });
});
