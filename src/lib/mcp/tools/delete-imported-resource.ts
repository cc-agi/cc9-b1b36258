import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "delete_imported_resource",
  title: "Delete imported resource",
  description: "Delete an imported resource owned by the caller.",
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  handler: async ({ id }, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { error } = await supabaseForUser(ctx).from("imported_resources").delete().eq("id", id);
    return error
      ? { content: [{ type: "text", text: error.message }], isError: true }
      : { content: [{ type: "text", text: `Deleted ${id}` }], structuredContent: { deleted: id } };
  },
});
