import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.MCP_TOKEN_ENC_KEY = "test-key-do-not-use-in-prod-0123456789";
});

describe("crypto.server", () => {
  it("round-trips JSON with AAD", async () => {
    const { encryptJson, decryptJson, connectionAad } = await import("@/lib/mcp/crypto.server");
    const aad = connectionAad("user-1", "conn-1");
    const ct = encryptJson({ full_url: "https://x?token=abc" }, aad);
    const pt = decryptJson<{ full_url: string }>(ct, aad);
    expect(pt.full_url).toBe("https://x?token=abc");
  });
  it("fails when AAD does not match", async () => {
    const { encryptJson, decryptJson, connectionAad } = await import("@/lib/mcp/crypto.server");
    const ct = encryptJson({ x: 1 }, connectionAad("u1", "c1"));
    expect(() => decryptJson(ct, connectionAad("u1", "c2"))).toThrow();
  });
  it("legacy blob (no AAD) still decrypts", async () => {
    const { encryptJson, decryptJson } = await import("@/lib/mcp/crypto.server");
    const ct = encryptJson({ n: 42 });
    const pt = decryptJson<{ n: number }>(ct);
    expect(pt.n).toBe(42);
  });
});
