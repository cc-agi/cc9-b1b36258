import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "update_agent_run",
  title: "Update agent run",
  description:
    "Update an agent run the caller owns. Terminal statuses (succeeded, failed, cancelled) automatically clear the lease so the sweeper won't re-queue it.",
  inputSchema: {
    id: z.string().uuid(),
    status: z.enum(["running", "succeeded", "failed", "cancelled", "paused"]).optional(),
    final_output: z.string().optional(),
    last_error: z.string().max(2000).optional(),
    mark_completed: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ id, status, final_output, last_error, mark_completed }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const patch: Record<string, unknown> = {};
    if (status) patch.status = status;
    if (final_output !== undefined) patch.final_output = final_output;
    if (last_error !== undefined) patch.last_error = last_error;
    const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
    if (mark_completed || terminal) patch.completed_at = new Date().toISOString();
    if (terminal) {
      // 释放 lease，避免 sweeper 把已完成的任务当成僵死运行重试
      patch.lease_expires_at = null;
      patch.worker_id = null;
    }
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: { row: data },
        };
  },
});
