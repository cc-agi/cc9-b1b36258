import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * 心跳：延长 lease。Worker 每 30~60 秒调用一次。
 * 必须由持有 lease 的 worker_id 调用；否则说明 lease 已被其他 worker 抢走，
 * 返回 lease_lost，调用方应立刻终止当前任务。
 */
export default defineTool({
  name: "heartbeat_agent_run",
  title: "Heartbeat agent run",
  description:
    "Extend the lease on a running agent run. Must be called periodically (recommended every 30-60s) by the worker that claimed it. Returns lease_lost=true if another worker has taken over — the caller MUST stop.",
  inputSchema: {
    id: z.string().uuid(),
    worker_id: z.string().trim().min(1).max(128),
    lease_seconds: z.number().int().min(30).max(1800).default(120),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ id, worker_id, lease_seconds }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const now = new Date();
    const lease = new Date(now.getTime() + lease_seconds * 1000);
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update({
        heartbeat_at: now.toISOString(),
        lease_expires_at: lease.toISOString(),
      })
      .eq("id", id)
      .eq("status", "running")
      .eq("worker_id", worker_id)
      .select("id,status,heartbeat_at,lease_expires_at,worker_id")
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ lease_lost: true, reason: "not_running_or_worker_mismatch" }),
          },
        ],
        structuredContent: { lease_lost: true },
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ lease_lost: false, ...data }) }],
      structuredContent: { lease_lost: false, run: data },
    };
  },
});
