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
 * `DESKTOP_TOOL_UNAVAILABLE` / `failed`. Detection is a two-part check
 * (see `looksLikeDesktopRefusal`): the text mentions a `desktop_*` tool
 * name OR a "desktop operator/tool" phrase, AND carries a refusal marker.
 * Kept narrow so ordinary browser outputs that mention "desktop" don't trip.
 */
const DESKTOP_MENTION_RX = /\bdesktop_[a-z_]+\b|desktop\s+(?:operator|tool)/i;
const DESKTOP_REFUSAL_MARKERS: readonly RegExp[] = [
  /\b(?:not|un)\s*available\b/i,
  /\bcannot\s+(?:execute|run|use|access|call)\b/i,
  /\b(?:no|there\s+is\s+no)\s+desktop\s+(?:tool|operator)\b/i,
  /\binactive\b/i,
  /桌面(?:工具|操作|操作器)?.{0,10}(?:不可用|不可执行|不可访问|无法执行|尚未可用|未启用)/,
  /无法(?:执行|调用|使用)\s*desktop_/i,
];

export function looksLikeDesktopRefusal(text: string): boolean {
  if (!DESKTOP_MENTION_RX.test(text)) return false;
  return DESKTOP_REFUSAL_MARKERS.some((rx) => rx.test(text));
}

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
  // P0-R6: detect the "browser-only branch refused a desktop request" case.
  // Must run BEFORE the natural-language length check so a short refusal still
  // routes to DESKTOP_TOOL_UNAVAILABLE (not MODEL_OUTPUT_EMPTY).
  if (looksLikeDesktopRefusal(cleaned)) {
    return {
      ok: false,
      code: "DESKTOP_TOOL_UNAVAILABLE",
      reason: "model refused desktop tool from browser branch",
    };
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
