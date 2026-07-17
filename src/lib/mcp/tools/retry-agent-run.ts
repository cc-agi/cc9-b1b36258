import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * Owner 显式重试。仅 blocked / failed 可被重放为 queued。
 * 由数据库触发器 enforce_agent_run_transition 保证合法性。
 */
export default defineTool({
  name: "retry_agent_run",
  title: "Retry agent run",
  description:
    "Owner-explicit retry: move a `blocked` or `failed` run back to `queued`. Terminal runs (succeeded/cancelled) cannot be retried. Browser side-effects are unknown, so retries never happen automatically — call this only when you understand the previous run's state.",
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  handler: async ({ id }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update({
        status: "queued",
        worker_id: null,
        started_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
        completed_at: null,
        cancel_requested_at: null,
        error_code: null,
        last_error: null,
        attempts: 0,
      })
      .eq("id", id)
      .in("status", ["blocked", "failed"])
      .select()
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data)
      return {
        content: [
          {
            type: "text",
            text: "Run cannot be retried (not in blocked/failed state, or not owned by caller).",
          },
        ],
        isError: true,
      };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { run: data },
    };
  },
});
