import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "list_agent_runs",
  title: "List agent runs",
  description:
    "List the caller's recent Sentinel OS agent runs (goal, status, worker, heartbeat, timestamps). Newest first. Opportunistically sweeps stale runs so nothing stays stuck in queued.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Max rows to return (1-50, default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.rpc("sweep_stale_agent_runs");
    } catch {
      /* ignore */
    }
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .select(
        "id,goal,status,final_output,created_at,updated_at,completed_at,started_at,heartbeat_at,worker_id,attempts,last_error",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { runs: data ?? [] },
    };
  },
});
