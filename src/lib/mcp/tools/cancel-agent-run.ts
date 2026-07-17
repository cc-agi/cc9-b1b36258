import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * 协作取消：queued 直接置 cancelled；claimed/running 写 cancel_requested_at，
 * Worker 在下一次心跳/步骤边界会看到并安全停止后置终态 cancelled。
 * 幂等：多次调用同一 id 结果一致。
 */
export default defineTool({
  name: "cancel_agent_run",
  title: "Cancel agent run",
  description:
    "Request cancellation of an agent run. If the run is `queued` it is cancelled immediately. If it is `claimed`/`running`, this sets `cancel_requested_at` — the worker will finalize `cancelled` at the next heartbeat/step boundary. Idempotent.",
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ id }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const sb = supabaseForUser(ctx);
    // 尝试直接 cancel queued
    const { data: quick } = await sb
      .from("agent_runs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "queued")
      .select()
      .maybeSingle();
    if (quick) {
      return {
        content: [{ type: "text", text: JSON.stringify({ cancelled: true, run: quick }) }],
        structuredContent: { cancelled: true, run: quick },
      };
    }
    // 否则请求协作取消
    const { data, error } = await sb
      .from("agent_runs")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["claimed", "running"])
      .select()
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ cancelled: false, note: "already terminal or not owned" }),
          },
        ],
        structuredContent: { cancelled: false },
      };
    return {
      content: [{ type: "text", text: JSON.stringify({ cancel_requested: true, run: data }) }],
      structuredContent: { cancel_requested: true, run: data },
    };
  },
});
