import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "delete_agent_run",
  title: "Delete agent run",
  description: "Delete an agent run (and its events via cascade if configured) owned by the caller.",
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async ({ id }, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const sb = supabaseForUser(ctx);
    await sb.from("agent_events").delete().eq("run_id", id);
    const { error } = await sb.from("agent_runs").delete().eq("id", id);
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: `Deleted ${id}` }], structuredContent: { deleted: id } };
  },
});
