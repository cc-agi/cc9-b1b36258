import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "append_agent_event",
  title: "Append agent event",
  description: "Append a step/log event to an agent run owned by the caller.",
  inputSchema: {
    run_id: z.string().uuid(),
    event_type: z.string().min(1),
    step_index: z.number().int().min(0).default(0),
    payload: z.record(z.string(), z.unknown()).default({}),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ run_id, event_type, step_index, payload }, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_events")
      .insert({ user_id: ctx.getUserId(), run_id, event_type, step_index, payload })
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { row: data } };
  },
});
