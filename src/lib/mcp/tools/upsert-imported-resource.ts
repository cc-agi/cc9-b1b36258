import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "upsert_imported_resource",
  title: "Upsert imported resource",
  description: "Create or update an imported resource (plugin / skill / MCP tool metadata) owned by the caller.",
  inputSchema: {
    source: z.string().default("cc6"),
    source_id: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated()) return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("imported_resources")
      .upsert(
        {
          user_id: ctx.getUserId(),
          source: input.source,
          source_id: input.source_id,
          kind: input.kind,
          name: input.name,
          description: input.description ?? null,
          version: input.version ?? null,
          metadata: input.metadata ?? {},
          synced_at: new Date().toISOString(),
        },
        { onConflict: "user_id,source,source_id" },
      )
      .select()
      .single();
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { row: data } };
  },
});
