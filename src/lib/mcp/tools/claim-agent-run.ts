import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * 认领一个 queued 的 agent_run：把状态改成 running，写入 worker_id、
 * started_at、heartbeat_at、lease_expires_at。使用条件更新
 * (`.eq("status", "queued")`) 保证多个 worker 不会同时抢到同一条任务。
 */
export default defineTool({
  name: "claim_agent_run",
  title: "Claim agent run",
  description:
    "Atomically claim a queued agent run for execution. Sets status=running, worker_id, started_at, heartbeat_at, and a lease that expires in `lease_seconds` (default 120). Returns the claimed row, or an error if the run is not queued (already claimed by another worker).",
  inputSchema: {
    id: z.string().uuid().describe("Agent run id to claim."),
    worker_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Stable identifier of the claiming worker (e.g. host+pid, or MCP client name)."),
    lease_seconds: z
      .number()
      .int()
      .min(30)
      .max(1800)
      .default(120)
      .describe("How long the lease is valid before it can be reclaimed by another worker."),
  },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  handler: async ({ id, worker_id, lease_seconds }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const now = new Date();
    const lease = new Date(now.getTime() + lease_seconds * 1000);
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update({
        status: "running",
        worker_id,
        started_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        lease_expires_at: lease.toISOString(),
        last_error: null,
      })
      .eq("id", id)
      .eq("status", "queued")
      .select()
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data)
      return {
        content: [
          {
            type: "text",
            text: "Run is not in queued state — already claimed, completed, or does not exist.",
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
