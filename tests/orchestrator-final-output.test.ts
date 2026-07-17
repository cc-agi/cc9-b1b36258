import { describe, it, expect } from "vitest";
import {
  validateFinalOutput,
  looksLikeToolLeak,
  TOOL_LEAK_MARKERS,
} from "@/lib/orchestrator/validate-final-output";

describe("validateFinalOutput — P0-R4 regression suite", () => {
  it("accepts a plain natural-language answer", () => {
    const r = validateFinalOutput("Found 3 open pull requests on the dashboard.");
    expect(r.ok).toBe(true);
  });

  it("accepts the Acceptance Lab synthesized summary (must not break the lab)", () => {
    const finalText =
      "SENTINEL_ACCEPTANCE_LAB · fixed script complete\n" +
      "url=https://example.com/\n" +
      "title=Example Domain\n" +
      "h1=Example Domain";
    const r = validateFinalOutput(finalText);
    expect(r.ok).toBe(true);
  });

  it("rejects empty / whitespace-only output as MODEL_OUTPUT_EMPTY", () => {
    for (const s of ["", "   ", "\n\n\t"]) {
      const r = validateFinalOutput(s);
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe("MODEL_OUTPUT_EMPTY");
    }
  });

  // Regression: run 5c33ec43-0ace-4733-873b-ed4e30fca9bf was incorrectly
  // marked succeeded with the raw tool DSL as final_output.
  it("rejects the exact 5c33ec43 regression payload as MODEL_TOOLCALL_LEAK", () => {
    const bad = "<call:default_api:browser_inspect_candidates{textOrSelector:input}";
    const r = validateFinalOutput(bad);
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("MODEL_TOOLCALL_LEAK");
    expect(looksLikeToolLeak(bad)).toBe(true);
  });

  it("rejects every documented leak marker", () => {
    for (const marker of TOOL_LEAK_MARKERS) {
      const r = validateFinalOutput(`prefix ${marker} suffix`);
      expect(r.ok, `marker=${marker}`).toBe(false);
      expect((r as { code: string }).code).toBe("MODEL_TOOLCALL_LEAK");
    }
  });

  it("rejects JSON-only tool placeholders with no natural language", () => {
    const r = validateFinalOutput(
      `{"tool":"browser_click","arguments":{"selector":"button"}}`,
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("MODEL_TOOLCALL_LEAK");
  });

  it("rejects a bare tool_name(arg=...) invocation", () => {
    const r = validateFinalOutput("browser_inspect_candidates(textOrSelector=input)");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("MODEL_TOOLCALL_LEAK");
  });

  it("rejects a fenced tool-call block", () => {
    const r = validateFinalOutput("```tool_code\nbrowser_click(selector='.x')\n```");
    expect(r.ok).toBe(false);
  });

  it("accepts a short but real answer with structured summary", () => {
    const r = validateFinalOutput("完成：抽取到标题「示例域名」，URL=https://example.com/");
    expect(r.ok).toBe(true);
  });

  it("rejects an answer that is only punctuation", () => {
    const r = validateFinalOutput("— .");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("MODEL_OUTPUT_EMPTY");
  });

  it("cleaned output is trimmed and capped at 20k chars", () => {
    const big = "a".repeat(50000);
    const r = validateFinalOutput(big);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cleaned.length).toBeLessThanOrEqual(20000);
  });
});
