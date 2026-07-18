/**
 * 0.4.20 type verdict regressions from the field.
 *
 *  - ProseMirror commits its text model AFTER SendInput returns. The first
 *    50-100ms UIA polls read the stale value. The engine MUST NOT fail with
 *    TYPE_NO_EFFECT on the first miss; it MUST wait until the hash is stable
 *    across >=2 consecutive polls before finalising a verdict.
 *
 *  - Chrome Omnibox already contains a long URL. UIA's Value pattern
 *    truncates long strings, so a naive "hash changed" check would claim
 *    verified=true even when the injected characters were dropped. The
 *    engine MUST downgrade to input_only when the post value looks like a
 *    truncated prefix of the expected append.
 *
 * These tests also assert the PowerShell operator carries the same
 * stability-window + semantic classification so the verify:release Gate 28
 * catches drift between TS and PS.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computeTypeVerdict } from "@/lib/desktop/verifier";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");

describe("ProseMirror delayed commit regression", () => {
  it("first-poll miss does NOT finalise TYPE_NO_EFFECT (observedAtAttempt>0 but stability<2)", () => {
    const v = computeTypeVerdict({
      preText: "",
      injected: "hello world",
      postText: "hello world",
      targetStillForeground: true,
      observedAtAttempt: 4,
      stableAcrossAttempts: 1,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("TYPE_SEMANTICS_UNVERIFIED");
    expect(v.reason).toBe("uia_text_still_churning_no_stability");
  });

  it("stable commit after debounce → verified=true empty_exact", () => {
    const v = computeTypeVerdict({
      preText: "",
      injected: "hello world",
      postText: "hello world",
      targetStillForeground: true,
      observedAtAttempt: 6,
      stableAcrossAttempts: 3,
    });
    expect(v.verified).toBe(true);
    expect(v.semantic).toBe("empty_exact");
    expect(v.error_code).toBeNull();
  });

  it("never observed → TYPE_NO_EFFECT (not TYPE_SEMANTICS_UNVERIFIED)", () => {
    const v = computeTypeVerdict({
      preText: "",
      injected: "abc",
      postText: "",
      targetStillForeground: true,
      observedAtAttempt: 0,
      stableAcrossAttempts: 0,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("TYPE_NO_EFFECT");
  });
});

describe("Omnibox UIA-truncated post value regression", () => {
  const preURL = "https://example.com/very/long/existing/path?query=" + "x".repeat(2000);
  const injected = "&injected=hello-world";
  it("apparent truncation of appended value → input_only downgrade, verified=false", () => {
    // UIA returns only the first 512 chars of the "value" pattern. postText
    // is a strict prefix of (pre+injected) but shorter than the full expected
    // append.
    const truncated = (preURL + injected).slice(0, 512);
    const v = computeTypeVerdict({
      preText: preURL,
      injected,
      postText: truncated,
      targetStillForeground: true,
      observedAtAttempt: 4,
      stableAcrossAttempts: 3,
    });
    expect(v.verified).toBe(false);
    expect(v.verification_kind).toBe("input_only");
    expect(v.error_code).toBe("TYPE_SEMANTICS_UNVERIFIED");
    expect(v.semantic).toBe("input_only");
  });

  it("full append value visible → verified=true append", () => {
    const v = computeTypeVerdict({
      preText: "short",
      injected: "!",
      postText: "short!",
      targetStillForeground: true,
      observedAtAttempt: 3,
      stableAcrossAttempts: 3,
    });
    expect(v.verified).toBe(true);
    expect(v.semantic).toBe("append");
  });

  it("replace semantics (selection was live) → verified=true replace", () => {
    const v = computeTypeVerdict({
      preText: "old value",
      injected: "new",
      postText: "new",
      targetStillForeground: true,
      observedAtAttempt: 2,
      stableAcrossAttempts: 3,
    });
    expect(v.verified).toBe(true);
    expect(v.semantic).toBe("replace");
  });

  it("foreground stolen → FOCUS_TARGET_LOST regardless of text state", () => {
    const v = computeTypeVerdict({
      preText: "",
      injected: "hi",
      postText: "hi",
      targetStillForeground: false,
      observedAtAttempt: 2,
      stableAcrossAttempts: 3,
    });
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_TARGET_LOST");
  });
});

describe("PowerShell Tool-Type mirrors the verifier module (regression on drift)", () => {
  it("uses the extended stability ladder (>=10 polls, includes 800ms)", () => {
    expect(operator).toMatch(
      /stabilityLadder\s*=\s*@\(50,\s*100,\s*100,\s*200,\s*200,\s*400,\s*400,\s*800,\s*800,\s*200\)/,
    );
  });
  it("requires >=2 consecutive stable polls before finalising", () => {
    expect(operator).toMatch(/stable\s+-ge\s+3/); // 1 initial + 2 consecutive matches
  });
  it("classifies append / replace / empty_exact semantics", () => {
    for (const s of ["'empty_exact'", "'append'", "'replace'", "'input_only'", "'ambiguous'"]) {
      expect(operator).toContain(s);
    }
  });
  it("downgrades apparent UIA truncation to input_only with TYPE_SEMANTICS_UNVERIFIED", () => {
    expect(operator).toContain("uia_value_appears_truncated_cannot_confirm_semantics");
    expect(operator).toContain("TYPE_SEMANTICS_UNVERIFIED");
  });
  it("still surfaces TYPE_NO_EFFECT when the observation never fires", () => {
    expect(operator).toContain("TYPE_NO_EFFECT");
    expect(operator).toContain("no_uia_change_within_stability_window");
  });
});
