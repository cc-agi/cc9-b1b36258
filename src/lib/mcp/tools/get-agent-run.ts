import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "get_agent_run",
  title: "Get agent run",
  description:
    "Fetch a single Sentinel OS agent run by id, including its ordered event log.",
  inputSchema: {
    run_id: z.string().uuid().describe("Agent run UUID."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ run_id }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const sb = supabaseForUser(ctx);
    const [runRes, evRes] = await Promise.all([
      sb
        .from("agent_runs")
        .select("id,goal,status,final_output,created_at,updated_at,completed_at")
        .eq("id", run_id)
        .maybeSingle(),
      sb
        .from("agent_events")
        .select("id,step_index,event_type,payload,created_at")
        .eq("run_id", run_id)
        .order("step_index", { ascending: true }),
    ]);
    if (runRes.error)
      return { content: [{ type: "text", text: runRes.error.message }], isError: true };
    if (!runRes.data)
      return { content: [{ type: "text", text: "Run not found" }], isError: true };
    if (evRes.error)
      return { content: [{ type: "text", text: evRes.error.message }], isError: true };
    const payload = { run: runRes.data, events: evRes.data ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
