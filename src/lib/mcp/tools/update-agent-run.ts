import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "update_agent_run",
  title: "Update agent run",
  description: "Update the status, final_output, or completed_at of an agent run the caller owns.",
  inputSchema: {
    id: z.string().uuid(),
    status: z.enum(["running", "succeeded", "failed", "cancelled", "paused"]).optional(),
    final_output: z.string().optional(),
    mark_completed: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ id, status, final_output, mark_completed }, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const patch: Record<string, unknown> = {};
    if (status) patch.status = status;
    if (final_output !== undefined) patch.final_output = final_output;
    if (mark_completed) patch.completed_at = new Date().toISOString();
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { row: data } };
  },
});
