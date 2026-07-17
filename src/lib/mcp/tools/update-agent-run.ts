import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

/**
 * P0-R2：收窄 update_agent_run，只允许 Worker（通过外部 MCP 也允许 Owner）
 * 报告终态 succeeded/failed。状态机由 DB 触发器 enforce_agent_run_transition 保证。
 * cancel/retry 请用独立工具。
 */
export default defineTool({
  name: "update_agent_run",
  title: "Update agent run",
  description:
    "Report a terminal outcome (succeeded or failed) on an agent run. Cancellation and retry have dedicated tools. Legal transitions are enforced at the database level.",
  inputSchema: {
    id: z.string().uuid(),
    status: z.enum(["succeeded", "failed"]),
    final_output: z.string().optional(),
    last_error: z.string().max(2000).optional(),
    error_code: z.string().max(128).optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ id, status, final_output, last_error, error_code }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const patch: Record<string, unknown> = {
      status,
      completed_at: new Date().toISOString(),
      lease_expires_at: null,
      worker_id: null,
    };
    if (final_output !== undefined) patch.final_output = final_output;
    if (last_error !== undefined) patch.last_error = last_error;
    if (error_code !== undefined) patch.error_code = error_code;

    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update(patch)
      .eq("id", id)
      .in("status", ["claimed", "running"])
      .select()
      .maybeSingle();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data)
      return {
        content: [{ type: "text", text: "Run is not in claimed/running state — cannot finalize." }],
        isError: true,
      };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { run: data },
    };
  },
});
