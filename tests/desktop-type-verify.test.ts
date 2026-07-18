/**
 * 0.4.16 regression — Tool-Type must inject via SendInput + KEYEVENTF_UNICODE,
 * poll UIA for a real text change, refuse to return succeeded when the
 * target's TextPattern/ValuePattern is unchanged (TYPE_NO_EFFECT), and
 * surface pre/post text_length + text_hash + text_changed diagnostics in
 * the direct tool result.
 *
 * Also exercises the audit-side redaction: the direct result carries the
 * verbatim focused_text/focused_value; the audit copy replaces them with
 * length + sha256.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redactDesktopResult, sha256Hex } from "@/lib/desktop/redact";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");
const status = readFileSync(path.join(ROOT, "helper", "status-helper.ps1"), "utf8");

function extractFn(source: string, name: string): string {
  const re = new RegExp(
    `function\\s+${name}(?:\\([^)]*\\))?\\s*\\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`could not extract ${name}`);
  return match[0];
}

describe("Tool-Type uses SendInput + KEYEVENTF_UNICODE (0.4.16)", () => {
  const type = extractFn(operator, "Tool-Type");
  const send = extractFn(operator, "Send-UnicodeText");

  it("defines a KEYEVENTF_UNICODE per-character sender", () => {
    expect(send).toContain("KEYEVENTF_UNICODE");
    expect(send).toContain("0x0004");
    expect(send).toMatch(/wVk\s*=\s*\[uint16\]0/);
    expect(send).toMatch(/wScan\s*=\s*\$cu/);
    expect(send).toContain("SendInput");
  });

  it("Tool-Type calls Send-UnicodeText (no SendKeys fallback)", () => {
    expect(type).toContain("Send-UnicodeText $text");
    expect(type).not.toMatch(/\[System\.Windows\.Forms\.SendKeys\]/);
    expect(type).not.toMatch(/Send-KeyChar\s+\$ch/);
  });

  it("reads pre text/hash and polls UIA on the 0.4.20 stability ladder", () => {
    expect(type).toContain("Get-TextSha256");
    expect(type).toMatch(/stabilityLadder\s*=\s*@\(50,\s*100,\s*100,\s*200,\s*200,\s*400,\s*400,\s*800,\s*800,\s*200\)/);
    expect(type).toMatch(/Start-Sleep -Milliseconds \$d/);
    expect(type).toMatch(/\$postHash\s+-ne\s+\$preHash/);
  });

  it("returns TYPE_NO_EFFECT when the text did not change", () => {
    expect(type).toContain("TYPE_NO_EFFECT");
    expect(type).toMatch(/-not\s+\$verified/);
  });

  it("empty-target readback must equal the injected text verbatim", () => {
    expect(type).toContain("exact_match_when_empty");
    expect(type).toMatch(/TrimEnd\(\[char\]13,\s*\[char\]10\)/);
  });

  it("direct diagnostics carry pre/post evidence required by the spec", () => {
    for (const k of [
      "pre_foreground_window_handle",
      "post_foreground_window_handle",
      "pre_focused_class",
      "post_focused_class",
      "pre_focused_control_type",
      "post_focused_control_type",
      "text_length_before",
      "text_length_after",
      "text_hash_before",
      "text_hash_after",
      "text_changed",
      "verified",
      "expected_target_still_foreground",
      "injection_method",
    ]) {
      expect(type).toContain(k);
    }
  });
});

describe("redactDesktopResult scrubs focused_text/value for desktop_type (0.4.16)", () => {
  it("hashes pre/post focused_text but keeps direct plaintext intact", () => {
    const doc = "Sentinel-0.4.16-desktop-chain-RETEST";
    const direct = {
      ok: true,
      result: {
        pre: { focused_text: "", focused_value: null, foreground_window_handle: "5311592" },
        post: { focused_text: doc, focused_value: null, foreground_window_handle: "5311592" },
        text_length_before: 0,
        text_length_after: doc.length,
        text_hash_before: sha256Hex(""),
        text_hash_after: sha256Hex(doc),
        text_changed: true,
        verified: true,
      },
    };
    // Direct: caller sees the plaintext exactly.
    expect((direct.result.post as { focused_text: string }).focused_text).toBe(doc);

    const audit = redactDesktopResult("desktop_type", direct);
    const post = (audit?.result as { post: Record<string, unknown> }).post;
    expect(post.focused_text).toMatchObject({
      redacted: true,
      length: doc.length,
      sha256: sha256Hex(doc),
    });
    expect(JSON.stringify(audit)).not.toContain(doc);
  });
});

describe("status-helper.ps1 dynamic version (0.4.16)", () => {
  it("does not hardcode a version string", () => {
    expect(status).not.toMatch(/\$HELPER_VERSION\s*=\s*"0\.\d+\.\d+"/);
  });
  it("reads helper/package.json via ConvertFrom-Json", () => {
    expect(status).toContain("package.json");
    expect(status).toContain("ConvertFrom-Json");
    expect(status).toContain("$pkg.version");
  });
});
