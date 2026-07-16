import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "create_mcp_connection",
  title: "Create MCP connection",
  description: "Save a new MCP server connection for the signed-in user.",
  inputSchema: {
    name: z.string().min(1),
    url: z.string().url(),
    transport: z.enum(["http", "sse", "stdio"]).default("http"),
    auth_type: z.enum(["none", "oauth", "bearer", "custom"]).default("none"),
    auth_metadata: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("mcp_connections")
      .insert({
        user_id: ctx.getUserId(),
        name: input.name,
        url: input.url,
        transport: input.transport,
        auth_type: input.auth_type,
        auth_metadata: input.auth_metadata ?? {},
      })
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { row: data } };
  },
});
