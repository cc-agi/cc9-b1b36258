import { describe, it, expect } from "vitest";
import { validateFinalOutput } from "@/lib/orchestrator/validate-final-output";

describe("P0-R6 desktop-refusal detection", () => {
  it("classifies English refusals as DESKTOP_TOOL_UNAVAILABLE", () => {
    for (const t of [
      "The desktop_snapshot tool is not available in this environment.",
      "I cannot execute desktop_click because no desktop operator is connected.",
      "Desktop operator is unavailable right now.",
      "No desktop tool available for this run.",
    ]) {
      const r = validateFinalOutput(t);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("DESKTOP_TOOL_UNAVAILABLE");
    }
  });

  it("classifies Chinese refusals as DESKTOP_TOOL_UNAVAILABLE", () => {
    const r = validateFinalOutput("抱歉，桌面工具不可用，无法执行 desktop_snapshot。");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DESKTOP_TOOL_UNAVAILABLE");
  });

  it("does not misfire on ordinary browser answers that mention 'desktop'", () => {
    const r = validateFinalOutput(
      "The homepage renders correctly on a desktop viewport of 1280x800 with no layout issues.",
    );
    expect(r.ok).toBe(true);
  });
});
