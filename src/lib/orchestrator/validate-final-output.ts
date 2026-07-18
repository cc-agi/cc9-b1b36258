/**
 * P0-R4 Section A — Execution Integrity.
 *
 * Pure, testable validator for the LLM's final natural-language answer.
 * Rejects:
 *  - empty / whitespace-only text
 *  - raw tool-invocation leakage (`<call:`, `<tool`, `default_api:`,
 *    `tool_calls`, `<lov-tool-use`, JSON-shaped call placeholders, etc.)
 *  - "the model literally emitted the tool DSL as text" cases like the
 *    observed regression on run 5c33ec43-0ace-4733-873b-ed4e30fca9bf:
 *      "<call:default_api:browser_inspect_candidates{textOrSelector:input}"
 *
 * NOTE: this validator is intentionally strict on tool-syntax leakage and
 * only mildly opinionated on prose length. Acceptance Lab's fixed final
 * answer starts with "SENTINEL_ACCEPTANCE_LAB" and MUST pass — regression
 * test coverage in tests/orchestrator-final-output.test.ts.
 */

export type ValidateResult =
  | { ok: true; cleaned: string }
  | {
      ok: false;
      code: "MODEL_OUTPUT_EMPTY" | "MODEL_TOOLCALL_LEAK" | "DESKTOP_TOOL_UNAVAILABLE";
      reason: string;
    };

/**
 * P0-R6: patterns that mean the model answered a desktop_* request from the
 * BROWSER-only branch by declaring the tool unavailable. Those outputs must
 * NOT be marked succeeded — the orchestrator translates them into
 * `DESKTOP_TOOL_UNAVAILABLE` / `failed`. Every marker is case-insensitive.
 * Kept narrow so ordinary browser outputs that mention "desktop" don't trip.
 */
export const DESKTOP_UNAVAILABLE_MARKERS: readonly RegExp[] = [
  /desktop_[a-z_]+[^A-Za-z0-9_]{0,20}(is\s+)?(un)?available/i,
  /desktop[_\s-]?snapshot[^A-Za-z0-9_]{0,30}(not|un)\s*available/i,
  /cannot\s+(execute|run|use|access)\s+desktop_/i,
  /desktop\s+operator\s+(is\s+)?(not\s+available|unavailable|inactive)/i,
  /no\s+desktop\s+(tool|operator)\s+available/i,
  /桌面(?:工具|操作)?(?:不可用|不可执行|不可访问|无法执行|尚未可用)/,
];

/**
 * Substrings whose presence in the final answer indicates raw tool-call
 * leakage. Match is case-insensitive and applied after trimming code
 * fences and quotes.
 */
export const TOOL_LEAK_MARKERS: readonly string[] = [
  "<call:",
  "<tool",
  "</tool",
  "default_api:",
  "default_api.",
  "tool_calls",
  "tool_call",
  "<lov-tool-use",
  "</lov-tool-use",
  "<function_calls",
  "<invoke",
  "<parameter",
  "```tool_code",
  "```tool_use",
];

/**
 * Regexes that match JSON-shaped or DSL-shaped placeholders with no
 * accompanying natural-language explanation.
 */
const JSON_ONLY_PATTERNS: readonly RegExp[] = [
  // {"tool":"foo","arguments":{...}} with nothing else
  /^\s*\{[\s\S]*"(tool|tool_name|name|function|arguments|parameters)"[\s\S]*\}\s*$/i,
  // tool_name(arg=...) alone
  /^\s*[a-z_][a-z0-9_]*\s*\(\s*[a-z_][a-z0-9_]*\s*[:=]/i,
  // browser_*({ ... }) alone
  /^\s*browser_[a-z_]+\s*\(/i,
];

function stripFences(input: string): string {
  return input
    .replace(/^```[a-zA-Z_]*\s*/, "")
    .replace(/```$/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

/**
 * Pure validator. Does NOT throw. Callers decide how to react
 * (blocked / corrective reprompt).
 */
export function validateFinalOutput(raw: string | null | undefined): ValidateResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, code: "MODEL_OUTPUT_EMPTY", reason: "empty or whitespace-only" };
  }
  const cleaned = stripFences(trimmed);
  if (!cleaned) {
    return { ok: false, code: "MODEL_OUTPUT_EMPTY", reason: "only fences/quotes" };
  }

  const lower = cleaned.toLowerCase();
  for (const marker of TOOL_LEAK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      return {
        ok: false,
        code: "MODEL_TOOLCALL_LEAK",
        reason: `raw tool-invocation marker present: ${marker}`,
      };
    }
  }
  for (const rx of JSON_ONLY_PATTERNS) {
    if (rx.test(cleaned)) {
      return {
        ok: false,
        code: "MODEL_TOOLCALL_LEAK",
        reason: `tool-shaped placeholder with no natural-language content`,
      };
    }
  }

  // Require at least a few natural-language characters. A one-token blob
  // like "{" or "..." shouldn't count as a real answer, but Acceptance
  // Lab's short structured summary MUST still pass.
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, "");
  if (letters.length < 3) {
    return {
      ok: false,
      code: "MODEL_OUTPUT_EMPTY",
      reason: "no meaningful natural-language characters",
    };
  }

  return { ok: true, cleaned: cleaned.slice(0, 20000) };
}

/**
 * Never interpret leaked free-text tool-call syntax as an executable action.
 * Callers must check this BEFORE parsing the model's text for actions.
 */
export function looksLikeToolLeak(text: string | null | undefined): boolean {
  const r = validateFinalOutput(text);
  return r.ok === false && r.code === "MODEL_TOOLCALL_LEAK";
}
