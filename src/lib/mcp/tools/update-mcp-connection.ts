import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "update_mcp_connection",
  title: "Update MCP connection",
  description: "Update fields of an existing MCP connection owned by the caller.",
  inputSchema: {
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    transport: z.enum(["http", "sse", "stdio"]).optional(),
    auth_type: z.enum(["none", "oauth", "bearer", "custom"]).optional(),
    auth_metadata: z.record(z.string(), z.unknown()).optional(),
    state: z.string().optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ id, ...patch }, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const patchClean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { data, error } = await supabaseForUser(ctx)
      .from("mcp_connections")
      .update(patchClean)
      .eq("id", id)
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { row: data } };
  },
});
