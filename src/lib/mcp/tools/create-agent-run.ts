import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "create_agent_run",
  title: "Create agent run",
  description:
    "Queue a new Sentinel OS agent run with a natural-language goal. Returns the new run id. The Sentinel OS console picks it up for execution.",
  inputSchema: {
    goal: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("The task/goal in natural language."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async ({ goal }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const { data, error } = await supabaseForUser(ctx)
      .from("agent_runs")
      .insert({ user_id: ctx.getUserId(), goal, status: "queued" })
      .select("id,goal,status,created_at")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: { run: data },
    };
  },
});
