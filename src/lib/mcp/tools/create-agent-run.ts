import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * 创建 agent run。P0-R2 预检：
 * - 若 10 秒内没有在线 worker_heartbeats → 直接建 blocked / WORKER_OFFLINE
 * - Owner 需在 Helper 恢复后显式 retry_agent_run
 */
export default defineTool({
  name: "create_agent_run",
  title: "Create agent run",
  description:
    "Queue a new Sentinel OS agent run. If no local Sentinel Helper worker has heartbeat within the last 10s, the run is created as `blocked` with `error_code=WORKER_OFFLINE` — the Owner must start the Helper and explicitly call `retry_agent_run`.",
  inputSchema: {
    goal: z.string().trim().min(1).max(4000).describe("The task/goal in natural language."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async ({ goal }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const sb = supabaseForUser(ctx);

    // Worker 在线预检
    const cutoff = new Date(Date.now() - 10_000).toISOString();
    const { data: alive } = await sb
      .from("worker_heartbeats")
      .select("worker_id,cdp_reachable,state")
      .gte("last_seen_at", cutoff)
      .limit(1)
      .maybeSingle();

    const workerOffline = !alive;
    const cdpUnreachable = alive && alive.cdp_reachable === false;

    let status: "queued" | "blocked" = "queued";
    let error_code: string | null = null;
    let last_error: string | null = null;
    if (workerOffline) {
      status = "blocked";
      error_code = "WORKER_OFFLINE";
      last_error = "No local Sentinel Helper heartbeat within 10s. Start the Helper and retry.";
    } else if (cdpUnreachable) {
      status = "blocked";
      error_code = "CDP_UNREACHABLE";
      last_error = "Helper is online but Chrome DevTools Protocol is not reachable.";
    }

    const { data, error } = await sb
      .from("agent_runs")
      .insert({ user_id: ctx.getUserId(), goal, status, error_code, last_error })
      .select("id,goal,status,error_code,last_error,created_at")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { run: data },
    };
  },
});
