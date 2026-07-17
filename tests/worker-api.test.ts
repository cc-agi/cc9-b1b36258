import { describe, it, expect } from "vitest";
import { hashToken, newRawToken, newPairingCode, safeEq, rateLimit } from "@/lib/worker-api.server";

describe("worker-api tokens", () => {
  it("hashToken is deterministic sha256 hex", () => {
    const h = hashToken("abc");
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("newRawToken produces >=32 char base64url", () => {
    const t = newRawToken();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("newPairingCode is 8 uppercase alnum without ambiguous chars", () => {
    for (let i = 0; i < 20; i++) {
      const c = newPairingCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    }
  });
  it("safeEq is length-safe", () => {
    expect(safeEq("abc", "abc")).toBe(true);
    expect(safeEq("abc", "abcd")).toBe(false);
    expect(safeEq("abc", "abd")).toBe(false);
  });
  it("rateLimit throttles bursts", () => {
    const k = "test-" + Date.now();
    // First 5 allowed with default 10rps/burst20
    for (let i = 0; i < 5; i++) expect(rateLimit(k, 1, 5)).toBe(true);
    // 6th within same tick should fail (burst=5, ~0 refill)
    expect(rateLimit(k, 1, 5)).toBe(false);
  });
});
