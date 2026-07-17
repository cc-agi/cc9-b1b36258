import { describe, it, expect } from "vitest";
import { redactMcpUrl, redactText } from "@/lib/mcp/redact";

describe("redactMcpUrl", () => {
  it("redacts unknown query params", () => {
    const out = redactMcpUrl(
      "https://mcp.browserbase.com/mcp?browserbaseApiKey=sk-live-abcdef123456",
    );
    expect(out).toContain("browserbaseApiKey=***");
    expect(out).not.toContain("sk-live-abcdef123456");
  });
  it("keeps whitelisted params", () => {
    const out = redactMcpUrl("https://example.com/x?transport=sse&token=secret123");
    expect(out).toContain("transport=sse");
    expect(out).toContain("token=***");
  });
  it("returns REDACTED_INVALID_URL for garbage", () => {
    expect(redactMcpUrl("not a url at all")).toBe("[REDACTED_INVALID_URL]");
  });
  it("strips basic auth and fragment", () => {
    const out = redactMcpUrl("https://user:pass@example.com/x#frag");
    expect(out).not.toContain("user");
    expect(out).not.toContain("pass");
    expect(out).not.toContain("frag");
  });
});

describe("redactText", () => {
  it("redacts bearer tokens", () => {
    expect(redactText("Bearer abc123def456ghi789")).toContain("Bearer ***");
  });
  it("redacts sk- style keys", () => {
    expect(redactText("key=sk-live-abcdef123456xyz")).toContain("***");
  });
});
