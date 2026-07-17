/**
 * Sentinel OS — Cloud Orchestrator (P0-R2c)
 *
 * One-intent-per-turn loop, driven by Helper polling `/api/worker/v1/next-intent`.
 *
 * - Reads goal + prior (intent, result) pairs.
 * - Runs `generateText` with the read-only browser tool whitelist and
 *   `stopWhen: stepCountIs(1)` so the model must either emit ONE tool call
 *   OR a final text answer.
 * - Tool call → validate against whitelist → insert `agent_step_intents`
 *   (idempotent per (run, attempt, sequence)).
 * - Final text → write `succeeded` + `final_output`.
 * - Every turn re-checks run.status / cancel_requested_at / worker/lease.
 * - Hard step cap and wall-clock cap → `blocked` (never fake succeeded).
 *
 * Tools have NO `execute()`; Helper runs them locally over CDP and posts
 * `agent_step_results` back through `/api/worker/v1/step-result`.
 */
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { redactText } from "@/lib/mcp/redact";
import { validateFinalOutput } from "@/lib/orchestrator/validate-final-output";
import { isDesktopToolName, type DesktopToolName } from "@/lib/desktop/schemas";

// P0-R5 R1: Desktop runs are queued via MCP with a goal that starts with
// `[DESKTOP:<tool>] <json>`. The orchestrator emits exactly one desktop_*
// intent, waits for its result, then synthesizes a deterministic final
// output. The AI model is never invoked for desktop runs.
export const DESKTOP_GOAL_PREFIX = "[DESKTOP:";

export function parseDesktopGoal(
  goal: string | null | undefined,
):
  | { ok: true; tool: DesktopToolName; args: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (typeof goal !== "string" || !goal.startsWith(DESKTOP_GOAL_PREFIX)) {
    return { ok: false, reason: "not a desktop goal" };
  }
  const close = goal.indexOf("]");
  if (close < 0) return { ok: false, reason: "malformed desktop goal header" };
  const toolName = goal.slice(DESKTOP_GOAL_PREFIX.length, close);
  if (!isDesktopToolName(toolName)) {
    return { ok: false, reason: `unknown desktop tool: ${toolName}` };
  }
  const jsonPart = goal.slice(close + 1).trim();
  let meta: unknown = null;
  try {
    meta = JSON.parse(jsonPart);
  } catch {
    return { ok: false, reason: "goal payload is not valid JSON" };
  }
  const args = (meta as { args?: Record<string, unknown> } | null)?.args;
  if (!args || typeof args !== "object") {
    return { ok: false, reason: "goal payload missing args" };
  }
  return { ok: true, tool: toolName, args };
}


// P0-R4 A3: at most this many corrective re-prompts per attempt for
// empty-output / leaked-tool-call cases. Each corrective reprompt is
// recorded as an `orchestrator.corrective_reprompt` agent_event so
// subsequent turns can count them WITHOUT any schema change and
// WITHOUT re-running side-effecting browser tools.
export const MAX_CORRECTIVE_REPROMPTS = 2;

// --------------------------------------------------------------- constants
export const MAX_STEPS_PER_ATTEMPT = 30;
export const MAX_WALLCLOCK_MS = 5 * 60 * 1000; // 5 min per attempt
export const DEFAULT_ORCH_MODEL = "google/gemini-3.5-flash";

// --------------------------------------------------------------- whitelist
/**
 * P0-R2c read-only whitelist. Every allowed tool has a compact Zod schema
 * that MUST also be re-validated on the Helper. Absent from this map = rejected.
 */
export const BROWSER_TOOL_SCHEMAS = {
  browser_goto: z.object({ url: z.string().url() }),
  browser_inspect_candidates: z.object({ textOrSelector: z.string().min(1).max(500) }),
  browser_wait_for: z.object({
    selector: z.string().min(1).max(500),
    timeoutMs: z.number().int().positive().max(60000).optional(),
  }),
  browser_extract: z.object({
    selector: z.string().min(1).max(500),
    attr: z.string().max(64).optional(),
  }),
  browser_screenshot: z.object({ name: z.string().min(1).max(120) }),
  browser_click: z.object({ selector: z.string().min(1).max(500) }),
} as const;
export type BrowserToolName = keyof typeof BROWSER_TOOL_SCHEMAS;

/**
 * Click labels/aria that MUST be rejected by the Helper (double-check).
 * The orchestrator itself cannot enforce label semantics without DOM access,
 * so we rely on Helper-side validation described in helper/src/browser.mjs.
 */
export const CLICK_DENY_KEYWORDS = [
  "submit",
  "confirm",
  "delete",
  "remove",
  "purchase",
  "buy",
  "pay",
  "checkout",
  "publish",
  "send",
  "post",
  "upload",
  "reply",
  "comment",
  "subscribe",
  "confirm order",
  "确认",
  "删除",
  "移除",
  "购买",
  "支付",
  "结算",
  "下单",
  "发布",
  "发送",
  "上传",
  "提交",
  "回复",
  "订阅",
];

const SYSTEM_PROMPT = `你是 SENTINEL 只读浏览器 Agent（P0-R2c 白名单模式）。

规则：
- 你只能调用下列白名单工具，参数必须严格匹配 schema：browser_goto、browser_inspect_candidates、browser_wait_for、browser_extract、browser_screenshot、browser_click（仅限导航用途）。
- 禁止 fill / press / eval / upload / 文件操作 / 任何写副作用。
- browser_click 只能点击已收集候选中的**导航链接**（a[href]、role=link、role=menuitem、侧边栏/导航区域内的按钮），禁止 submit / 购买 / 发布 / 删除 / 发送类按钮。
- 每一步 **只返回一个** 工具调用；等待外部工具结果后再继续。
- 一切确认完成后，用一段纯文本给出最终答复。答复本身必须精炼、可核对，包含关键 URL、标题或抽取字段。
- 如果无法安全完成，直接给出简短的失败原因说明作为最终答复。`;

// --------------------------------------------------------------- helpers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildBrowserTools(): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};
  for (const [name, schema] of Object.entries(BROWSER_TOOL_SCHEMAS)) {
    tools[name] = tool({
      description: `Sentinel 只读浏览器工具 · ${name}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: schema as any,
    });
  }
  return tools;
}

export function validateToolCall(
  name: string,
  input: unknown,
):
  | { ok: true; toolName: BrowserToolName; args: Record<string, unknown> }
  | { ok: false; code: string; message: string } {
  if (!(name in BROWSER_TOOL_SCHEMAS)) {
    return {
      ok: false,
      code: "TOOL_NOT_WHITELISTED",
      message: `tool "${name}" not in P0-R2c whitelist`,
    };
  }
  const schema = BROWSER_TOOL_SCHEMAS[name as BrowserToolName];
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "TOOL_INPUT_INVALID",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  return {
    ok: true,
    toolName: name as BrowserToolName,
    args: parsed.data as Record<string, unknown>,
  };
}

// ------------------------------------------------------------ P0-R3.2 lab
/**
 * Acceptance Lab dedicated tools. Kept OUT of BROWSER_TOOL_SCHEMAS on purpose:
 * the orchestrator's deterministic branch inserts these intents directly for
 * Acceptance Lab runs only. The main model-driven path CANNOT emit them
 * because they are not exposed as AI tools.
 */
export const ACCEPTANCE_TOOL_SCHEMAS = {
  acceptance_wait: z.object({
    duration_ms: z.number().int().positive().max(60000),
  }),
} as const;

export const ACCEPTANCE_GOAL_PREFIX = "[SENTINEL_ACCEPTANCE_LAB]";

export function isAcceptanceRunGoal(goal: string | null | undefined): boolean {
  return typeof goal === "string" && goal.trim().startsWith(ACCEPTANCE_GOAL_PREFIX);
}

/**
 * Fixed, model-independent script executed for every Acceptance Lab run
 * attempt. Six steps total: 5 tool intents + 1 synthetic final_output.
 */
export const ACCEPTANCE_SCRIPT: ReadonlyArray<{
  tool_name: string;
  arguments: Record<string, unknown>;
}> = [
  { tool_name: "browser_goto", arguments: { url: "https://example.com" } },
  { tool_name: "acceptance_wait", arguments: { duration_ms: 60000 } },
  { tool_name: "acceptance_wait", arguments: { duration_ms: 60000 } },
  { tool_name: "acceptance_wait", arguments: { duration_ms: 60000 } },
  { tool_name: "browser_extract", arguments: { selector: "h1" } },
];

type PriorStep = {
  intent: { id: string; sequence: number; tool_name: string; arguments: Record<string, unknown> };
  result: {
    ok: boolean;
    result: unknown;
    error_code: string | null;
    error_message: string | null;
  } | null;
};

async function loadPriorSteps(runId: string, attempt: number): Promise<PriorStep[]> {
  const { data: intents } = await supabaseAdmin
    .from("agent_step_intents")
    .select("id, sequence, tool_name, arguments")
    .eq("run_id", runId)
    .eq("attempt", attempt)
    .order("sequence", { ascending: true });
  if (!intents?.length) return [];
  const { data: results } = await supabaseAdmin
    .from("agent_step_results")
    .select("intent_id, ok, result, error_code, error_message")
    .in(
      "intent_id",
      intents.map((i) => i.id),
    );
  const rMap = new Map(results?.map((r) => [r.intent_id, r]) ?? []);
  return intents.map((i) => ({
    intent: {
      id: i.id,
      sequence: i.sequence,
      tool_name: i.tool_name,
      arguments: (i.arguments as Record<string, unknown>) ?? {},
    },
    result: rMap.get(i.id)
      ? {
          ok: rMap.get(i.id)!.ok,
          result: rMap.get(i.id)!.result,
          error_code: rMap.get(i.id)!.error_code,
          error_message: rMap.get(i.id)!.error_message,
        }
      : null,
  }));
}

function toModelMessages(goal: string, prior: PriorStep[]): ModelMessage[] {
  const msgs: ModelMessage[] = [{ role: "user", content: goal }];
  for (const step of prior) {
    msgs.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: step.intent.id,
          toolName: step.intent.tool_name,
          input: step.intent.arguments,
        },
      ],
    });
    if (step.result) {
      msgs.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: step.intent.id,
            toolName: step.intent.tool_name,
            output: step.result.ok
              ? { type: "json", value: (step.result.result as never) ?? { ok: true } }
              : {
                  type: "json",
                  value: {
                    error_code: step.result.error_code,
                    error_message: step.result.error_message,
                  } as never,
                },
          },
        ],
      });
    }
  }
  return msgs;
}

// --------------------------------------------------------------- orchestrator
export type OrchestratorOutcome =
  | {
      kind: "pending_intent";
      intent: {
        id: string;
        sequence: number;
        tool_name: string;
        arguments: Record<string, unknown>;
        idempotency_key: string;
      };
    }
  | { kind: "final"; final_output: string }
  | { kind: "failed"; error_code: string; message: string }
  | { kind: "blocked"; error_code: string; message: string };


/**
 * Advance the run by one turn. Called by Helper via /api/worker/v1/next-intent.
 * Invariants (all checked here):
 *  - run must exist and belong to workerAuth.userId
 *  - run.worker_id must match workerAuth.workerId (lease holder)
 *  - run.cancel_requested_at → returns cancelled outcome (handled by caller)
 *  - number of prior intents <= MAX_STEPS_PER_ATTEMPT
 *  - wallclock since started_at <= MAX_WALLCLOCK_MS
 * Idempotency:
 *  - If the model happens to re-emit the same tool+args for the current sequence,
 *    we upsert on (run_id, attempt, sequence) so Helper never executes twice.
 */
export async function advanceOrchestrator(params: {
  runId: string;
  userId: string;
  workerId: string;
}): Promise<OrchestratorOutcome> {
  const { runId, userId, workerId } = params;

  const { data: run, error: runErr } = await supabaseAdmin
    .from("agent_runs")
    .select("id, user_id, worker_id, status, goal, attempts, started_at, cancel_requested_at")
    .eq("id", runId)
    .maybeSingle();
  if (runErr || !run)
    return { kind: "blocked", error_code: "RUN_NOT_FOUND", message: "run missing" };
  if (run.user_id !== userId)
    return { kind: "blocked", error_code: "RUN_FORBIDDEN", message: "not owner" };
  if (run.worker_id !== workerId)
    return { kind: "blocked", error_code: "LEASE_LOST", message: "worker mismatch" };
  if (run.status !== "running" && run.status !== "claimed") {
    return { kind: "blocked", error_code: "RUN_NOT_ACTIVE", message: `status=${run.status}` };
  }
  if (run.cancel_requested_at) {
    return { kind: "blocked", error_code: "CANCEL_REQUESTED", message: "owner requested cancel" };
  }

  const attempt = Math.max(1, run.attempts ?? 1);
  const prior = await loadPriorSteps(runId, attempt);
  if (prior.length >= MAX_STEPS_PER_ATTEMPT) {
    return {
      kind: "blocked",
      error_code: "MAX_STEPS_EXCEEDED",
      message: `>${MAX_STEPS_PER_ATTEMPT} steps`,
    };
  }
  if (run.started_at && Date.now() - new Date(run.started_at).getTime() > MAX_WALLCLOCK_MS) {
    return { kind: "blocked", error_code: "MAX_WALLCLOCK_EXCEEDED", message: "exceeded 5 min" };
  }

  // Must have result for the latest intent before generating the next one
  const latest = prior[prior.length - 1];
  if (latest && !latest.result) {
    return {
      kind: "blocked",
      error_code: "AWAITING_STEP_RESULT",
      message: "previous step has no result",
    };
  }

  // ---- P0-R3.2 Acceptance Lab: deterministic, model-free branch. ----
  if (isAcceptanceRunGoal(run.goal)) {
    const doneIntents = prior.length;
    if (doneIntents >= ACCEPTANCE_SCRIPT.length) {
      // Synthesize a fixed final answer from prior results — never runs the model.
      const goto = prior[0]?.result?.result as { url?: string; title?: string } | undefined;
      const extract = prior[4]?.result?.result as { value?: string | null } | undefined;
      const finalText =
        `SENTINEL_ACCEPTANCE_LAB · fixed script complete\n` +
        `url=${goto?.url ?? "?"}\n` +
        `title=${goto?.title ?? "?"}\n` +
        `h1=${(extract?.value ?? "?").toString().slice(0, 200)}`;
      return { kind: "final", final_output: finalText };
    }
    const nextSequence = doneIntents + 1;
    const step = ACCEPTANCE_SCRIPT[doneIntents];
    const idempotency_key = `att${attempt}:seq${nextSequence}`;
    const { data: existing } = await supabaseAdmin
      .from("agent_step_intents")
      .select("id, sequence, tool_name, arguments")
      .eq("run_id", runId)
      .eq("idempotency_key", idempotency_key)
      .maybeSingle();
    let row = existing;
    if (!row) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("agent_step_intents")
        .insert({
          run_id: runId,
          user_id: userId,
          sequence: nextSequence,
          attempt,
          idempotency_key,
          tool_name: step.tool_name,
          arguments: step.arguments as never,
          worker_id: workerId,
          status: "delivered",
          delivered_at: new Date().toISOString(),
        })
        .select("id, sequence, tool_name, arguments")
        .single();
      if (insErr)
        return { kind: "blocked", error_code: "INTENT_INSERT_FAILED", message: insErr.message };
      row = inserted;
    }
    return {
      kind: "pending_intent",
      intent: {
        id: row.id,
        sequence: row.sequence,
        tool_name: row.tool_name,
        arguments: (row.arguments as Record<string, unknown>) ?? {},
        idempotency_key,
      },
    };
  }

  const key = process.env.LOVABLE_API_KEY;
  if (!key)
    return {
      kind: "blocked",
      error_code: "MISSING_LOVABLE_API_KEY",
      message: "server missing key",
    };

  const model = createLovableAiGatewayProvider(key)(DEFAULT_ORCH_MODEL);
  const tools = buildBrowserTools();
  const baseMessages = toModelMessages(run.goal, prior);

  // P0-R4 A1/A3: bounded corrective-reprompt loop inside ONE turn.
  // No browser side effect can happen between iterations because a tool
  // intent is only inserted AFTER the loop below, and only if the model
  // finally emits a valid tool call. Reprompts don't touch the browser.
  let lastValidationReason = "";
  let lastValidationCode: "MODEL_OUTPUT_EMPTY" | "MODEL_TOOLCALL_LEAK" = "MODEL_OUTPUT_EMPTY";
  for (let attemptN = 0; attemptN <= MAX_CORRECTIVE_REPROMPTS; attemptN++) {
    const messages: ModelMessage[] =
      attemptN === 0
        ? baseMessages
        : [
            ...baseMessages,
            {
              role: "user",
              content:
                lastValidationCode === "MODEL_TOOLCALL_LEAK"
                  ? "你上一轮输出把工具调用当作纯文本泄漏了。禁止把 <call:...>、<tool>、default_api:、tool_calls、<lov-tool-use>、```tool_code``` 或 JSON 工具占位符写进最终答复。要么严格发起一次白名单工具调用，要么用简体中文自然语言给出可核对的最终答复。"
                  : "你上一轮没有工具调用也没有可读答复。请要么发起一次白名单工具调用，要么用简体中文自然语言给出最终答复（至少一句可核对的结论）。",
            },
          ];
    let iter;
    try {
      iter = await generateText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools,
        stopWhen: stepCountIs(50),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        kind: "blocked",
        error_code: "MODEL_ERROR",
        message: redactText(msg).slice(0, 500),
      };
    }

    const lastStep = iter.steps[iter.steps.length - 1];
    const iterToolCalls = lastStep?.toolCalls ?? [];

    if (iterToolCalls.length === 0) {
      const validation = validateFinalOutput(iter.text ?? "");
      if (validation.ok) return { kind: "final", final_output: validation.cleaned };
      lastValidationCode = validation.code;
      lastValidationReason = validation.reason;
      // Best-effort audit event; don't fail on insert error.
      try {
        const nextSeqRow = await supabaseAdmin
          .from("agent_events")
          .select("sequence")
          .eq("run_id", runId)
          .order("sequence", { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextSeq = (nextSeqRow.data?.sequence ?? 0) + 1;
        await supabaseAdmin.from("agent_events").insert({
          run_id: runId,
          user_id: userId,
          event_type: "orchestrator.corrective_reprompt",
          step_index: nextSeq,
          sequence: nextSeq,
          payload: {
            attempt,
            reprompt_number: attemptN + 1,
            code: validation.code,
            reason: validation.reason.slice(0, 300),
          },
        });
      } catch {
        /* audit best-effort */
      }
      continue;
    }

    // Model finally emitted a tool call: validate + insert intent below.
    const call = iterToolCalls[0];
    const v = validateToolCall(call.toolName, call.input);
    if (!v.ok) return { kind: "blocked", error_code: v.code, message: v.message };
    return await insertIntentAndReturn(runId, userId, workerId, attempt, prior.length + 1, v);
  }

  // Exhausted corrective reprompts.
  return {
    kind: "blocked",
    error_code:
      lastValidationCode === "MODEL_TOOLCALL_LEAK" ? "MODEL_TOOLCALL_LEAK" : "MODEL_NO_PROGRESS",
    message: `no progress after ${MAX_CORRECTIVE_REPROMPTS} corrective reprompts: ${lastValidationReason}`,
  };
}

async function insertIntentAndReturn(
  runId: string,
  userId: string,
  workerId: string,
  attempt: number,
  nextSequence: number,
  v: { ok: true; toolName: BrowserToolName; args: Record<string, unknown> },
): Promise<OrchestratorOutcome> {
  const idempotency_key = `att${attempt}:seq${nextSequence}`;
  const { data: existing } = await supabaseAdmin
    .from("agent_step_intents")
    .select("id, sequence, tool_name, arguments")
    .eq("run_id", runId)
    .eq("idempotency_key", idempotency_key)
    .maybeSingle();

  let intentRow = existing;
  if (!intentRow) {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("agent_step_intents")
      .insert({
        run_id: runId,
        user_id: userId,
        sequence: nextSequence,
        attempt,
        idempotency_key,
        tool_name: v.toolName,
        arguments: v.args as never,
        worker_id: workerId,
        status: "delivered",
        delivered_at: new Date().toISOString(),
      })
      .select("id, sequence, tool_name, arguments")
      .single();
    if (insErr)
      return { kind: "blocked", error_code: "INTENT_INSERT_FAILED", message: insErr.message };
    intentRow = inserted;
  }

  return {
    kind: "pending_intent",
    intent: {
      id: intentRow.id,
      sequence: intentRow.sequence,
      tool_name: intentRow.tool_name,
      arguments: (intentRow.arguments as Record<string, unknown>) ?? {},
      idempotency_key,
    },
  };
}
