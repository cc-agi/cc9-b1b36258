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

// ============================================================================
// 0.4.22-A Final Outcome Truthfulness Guard
// ----------------------------------------------------------------------------
// classifyFinalOutputFailure inspects the model's final_output text BEFORE the
// worker route writes status='succeeded'. When the model explicitly declares
// failure — via a known error code, a labelled status line, an
// action-verification `verified=false` statement, or a desktop-tool-refusal —
// the run MUST be finalized as `failed` with the classified error_code.
//
// The classifier is intentionally strict about textual anchors so that
// casual mentions like "the previous attempt failed but I recovered" or a
// log line containing the word "failed" do NOT flip a genuine success into
// a failure.
// ============================================================================

/**
 * Structured error codes the classifier can emit. Kept as a stable string
 * union so the worker route can persist them into `agent_runs.error_code`
 * unchanged.
 */
export type FinalOutputFailureCode =
  | "CODE_WRITE_CAPABILITY_REQUIRED"
  | "DESKTOP_TOOL_UNAVAILABLE"
  | "DESKTOP_DIRECT_TOOL_REQUIRED"
  | "ACTION_VERIFICATION_FAILED"
  | "MODEL_DECLARED_FAILURE"
  | "MODEL_DECLARED_NOT_IMPLEMENTED";

export type FinalOutputClassification = {
  failed: boolean;
  error_code: FinalOutputFailureCode | null;
  reason: string | null;
};

/**
 * Explicit machine-readable error codes the orchestrator recognises. Match is
 * on a word-boundary basis: the token must appear as its own uppercase word,
 * not as a substring of unrelated text.
 */
const EXPLICIT_ERROR_CODES: readonly FinalOutputFailureCode[] = [
  "CODE_WRITE_CAPABILITY_REQUIRED",
  "DESKTOP_TOOL_UNAVAILABLE",
  "DESKTOP_DIRECT_TOOL_REQUIRED",
  "ACTION_VERIFICATION_FAILED",
];

/**
 * Labelled status declarations. Each entry pairs a matching regex with the
 * error_code the classifier reports. Regexes are anchored to a label
 * ("Status:", "Final status:") or an all-caps quoted marker so history-style
 * prose can't false-positive.
 */
const STATUS_DECLARATIONS: ReadonlyArray<{
  rx: RegExp;
  code: FinalOutputFailureCode;
  reason: string;
}> = [
  // "Status: FAILED", "**Final status: FAILED**", "final-status = failed"
  {
    rx: /(?:^|[\n\r*_`\s>-])(?:final[\s_-]*)?status\s*[:=]\s*\*{0,2}["']?failed\b/i,
    code: "MODEL_DECLARED_FAILURE",
    reason: "model_declared_status_failed",
  },
  // "CODE NOT READY" — exact phrase, uppercase or title.
  {
    rx: /\bCODE\s+NOT\s+READY\b/,
    code: "MODEL_DECLARED_FAILURE",
    reason: "model_declared_code_not_ready",
  },
  // "NOT IMPLEMENTED" / "NOT DELIVERED" as a declarative marker, e.g.
  // "0.4.22 NOT IMPLEMENTED" — anchored uppercase to avoid picking up
  // "the not-implemented behaviour is documented as ..."
  {
    rx: /\bNOT\s+IMPLEMENTED\b(?![\s-]*(?:behaviou?r|list|section|feature[s]?|item[s]?))/,
    code: "MODEL_DECLARED_NOT_IMPLEMENTED",
    reason: "model_declared_not_implemented",
  },
  {
    rx: /\bNOT\s+DELIVERED\b/,
    code: "MODEL_DECLARED_NOT_IMPLEMENTED",
    reason: "model_declared_not_delivered",
  },
];

/**
 * Action-verification failure markers. Matches `verified=false`,
 * `verified: false`, `"verified": false`, in any casing / spacing.
 */
const VERIFIED_FALSE_RX = /["'`]?verified["'`]?\s*[:=]\s*["'`]?false\b/i;

/**
 * Classify the model's final_output for explicit failure declarations.
 *
 * Never throws. Callers pass the raw text as returned by the model; the
 * classifier internally trims and strips code fences, then applies the
 * ordered detector list. First match wins.
 */
export function classifyFinalOutputFailure(
  raw: string | null | undefined,
): FinalOutputClassification {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    // Empty text is handled by validateFinalOutput (MODEL_OUTPUT_EMPTY). The
    // truthfulness guard has nothing to say — the caller must not reach the
    // succeeded path with an empty final_output regardless.
    return { failed: false, error_code: null, reason: null };
  }
  const cleaned = stripFences(trimmed);
  if (!cleaned) return { failed: false, error_code: null, reason: null };

  // 1. Explicit machine error codes.
  for (const code of EXPLICIT_ERROR_CODES) {
    // Require the code to appear as a whole uppercase token, optionally
    // followed by punctuation. This avoids matching a sentence that merely
    // references the identifier in kebab-case or embedded inside another
    // word.
    const rx = new RegExp(`(?:^|[^A-Z0-9_])${code}(?:[^A-Z0-9_]|$)`);
    if (rx.test(cleaned)) {
      return { failed: true, error_code: code, reason: `explicit_error_code:${code}` };
    }
  }

  // 2. Labelled status declarations.
  for (const decl of STATUS_DECLARATIONS) {
    if (decl.rx.test(cleaned)) {
      return { failed: true, error_code: decl.code, reason: decl.reason };
    }
  }

  // 3. Action-verification `verified=false`.
  if (VERIFIED_FALSE_RX.test(cleaned)) {
    return {
      failed: true,
      error_code: "ACTION_VERIFICATION_FAILED",
      reason: "verified_false_reported_in_final_output",
    };
  }

  // 4. Desktop refusal — reuse the existing shared detector so there is no
  //    duplicated regex table. Report the same error code the pre-toolcall
  //    branch would emit.
  if (looksLikeDesktopRefusal(cleaned)) {
    return {
      failed: true,
      error_code: "DESKTOP_TOOL_UNAVAILABLE",
      reason: "model_refused_desktop_tool_in_final_output",
    };
  }

  return { failed: false, error_code: null, reason: null };
}
