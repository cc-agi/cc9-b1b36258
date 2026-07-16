import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "list_imported_resources",
  title: "List imported resources",
  description:
    "List MCPs, plugins, and skills the caller has imported into Sentinel OS. Filter by kind.",
  inputSchema: {
    kind: z
      .enum(["mcp", "plugin", "skill", "all"])
      .default("all")
      .describe("Filter by resource kind."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ kind }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    let q = supabaseForUser(ctx)
      .from("imported_resources")
      .select("id,source,source_id,kind,name,description,metadata,created_at")
      .order("created_at", { ascending: false });
    if (kind !== "all") q = q.eq("kind", kind);
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { resources: data ?? [] },
    };
  },
});
