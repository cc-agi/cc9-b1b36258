import { describe, it, expect } from "vitest";
import {
  redactString,
  redactBytes,
  redactDesktopArgs,
  redactDesktopResult,
  sha256Hex,
} from "@/lib/desktop/redact";

describe("desktop redaction", () => {
  it("hashes the plaintext and never returns it", () => {
    const r = redactString("password123");
    expect(r).not.toHaveProperty("value");
    expect(r.length).toBe(11);
    expect(r.sha256).toBe(sha256Hex("password123"));
    expect(r.preview?.length).toBeLessThanOrEqual(4);
  });

  it("redacts typed text on desktop_type args", () => {
    const out = redactDesktopArgs("desktop_type", { text: "secret", chars_per_second: 20 });
    expect(out.text).toMatchObject({ redacted: true, length: 6 });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("redacts clipboard.value on desktop_clipboard args", () => {
    const out = redactDesktopArgs("desktop_clipboard", { op: "write", value: "sk_live_ABC" });
    expect(out.value).toMatchObject({ redacted: true, length: 11 });
    expect(JSON.stringify(out)).not.toContain("sk_live_ABC");
  });

  it("strips screenshot bytes from desktop_snapshot result", () => {
    const out = redactDesktopResult("desktop_snapshot", {
      ok: true,
      evidence: {
        image_base64: "aGVsbG8=", // "hello"
        image_bytes: [1, 2, 3],
        path: "/tmp/x.png",
        monitors: [{ image_base64: "AAA=", w: 100 }],
      },
    });
    const ev = out?.evidence as Record<string, unknown>;
    expect(ev).not.toHaveProperty("image_base64");
    expect(ev).not.toHaveProperty("image_bytes");
    expect(ev.path).toBe("/tmp/x.png");
    expect((ev.monitors as Array<Record<string, unknown>>)[0]).not.toHaveProperty("image_base64");
  });

  it("redacts clipboard read value in result evidence", () => {
    const out = redactDesktopResult("desktop_clipboard", {
      ok: true,
      evidence: { value: "topsecret" },
    });
    const ev = out?.evidence as Record<string, unknown>;
    expect(ev.value).toMatchObject({ redacted: true, length: 9 });
    expect(JSON.stringify(out)).not.toContain("topsecret");
  });

  it("byte hash matches string hash for the same content", () => {
    expect(redactBytes(new TextEncoder().encode("hello")).sha256).toBe(sha256Hex("hello"));
  });

  it("is idempotent for tools without sensitive fields", () => {
    const args = { x: 10, y: 20, button: "left" };
    expect(redactDesktopArgs("desktop_click", args)).toEqual(args);
  });
});
