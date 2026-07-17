import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "./_supabase";
import { redactMcpUrl } from "../redact";

export default defineTool({
  name: "list_mcp_connections",
  title: "List MCP connections",
  description:
    "List the caller's saved MCP server connections in Sentinel OS (id, name, url, transport, state). URLs are redacted — API keys / tokens in query strings are replaced with ***.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const { data, error } = await supabaseForUser(ctx)
      .from("mcp_connections")
      .select("id,name,url,transport,state,last_error,updated_at")
      .order("updated_at", { ascending: false });
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    // 关键安全修复：MCP 工具返回给外部 AI（Claude / ChatGPT 等）时脱敏 URL，
    // 防止 ?browserbaseApiKey=... 之类的密钥被写进对话上下文。
    const redacted = (data ?? []).map((row) => ({ ...row, url: redactMcpUrl(row.url) }));
    return {
      content: [{ type: "text", text: JSON.stringify(redacted) }],
      structuredContent: { connections: redacted },
    };
  },
});
