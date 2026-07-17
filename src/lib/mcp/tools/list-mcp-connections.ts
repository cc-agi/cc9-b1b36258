import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "./_supabase";
import { redactMcpUrl } from "../redact";

/**
 * P0-R2：只返回安全字段。原始 url / auth_metadata / tools_cache 一律不出网。
 * 前端 UI 需要更多字段时，仍走内部 server function（RLS 保护）。
 */
export default defineTool({
  name: "list_mcp_connections",
  title: "List MCP connections",
  description:
    "List the caller's saved MCP server connections (id, name, base_url, transport, state, has_credentials, rotation_required, disabled_reason). base_url is redacted; original URLs and any auth tokens never leave the server.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("mcp_connections")
      .select(
        "id,name,base_url,url,transport,state,has_credentials,rotation_required,disabled_reason,updated_at",
      )
      .order("updated_at", { ascending: false });
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const safe = (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      base_url: redactMcpUrl(row.base_url ?? row.url),
      transport: row.transport,
      state: row.state,
      has_credentials: row.has_credentials,
      rotation_required: row.rotation_required,
      disabled_reason: row.disabled_reason,
      updated_at: row.updated_at,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(safe) }],
      structuredContent: { connections: safe },
    };
  },
});
