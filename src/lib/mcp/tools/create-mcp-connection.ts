import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";
import { redactMcpUrl } from "../redact";

/**
 * 创建 MCP 连接。P0-R2 变更：
 * - `url` 里的凭据被剥离到服务端加密 Secret，数据库只留 base_url
 * - 已知的 Browserbase URL 强制 rotation_required（历史暴露）
 */
export default defineTool({
  name: "create_mcp_connection",
  title: "Create MCP connection",
  description:
    "Save a new MCP server connection for the signed-in user. Any secrets in the URL query (api key / token) are stripped and stored encrypted server-side; the returned `base_url` is safe to share. Browserbase URLs are automatically flagged `CREDENTIAL_ROTATION_REQUIRED` because that key has been in cleartext historically.",
  inputSchema: {
    name: z.string().min(1),
    url: z.string().url(),
    transport: z.enum(["http", "sse", "stdio"]).default("http"),
    auth_type: z.enum(["none", "oauth", "bearer", "custom"]).default("none"),
    auth_metadata: z.record(z.string(), z.unknown()).optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async (input, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const userId = ctx.getUserId();
    if (!userId) return { content: [{ type: "text", text: "Missing user id" }], isError: true };

    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return { content: [{ type: "text", text: "Invalid URL" }], isError: true };
    }
    const hasCredentials =
      parsed.search.length > 0 || Boolean(parsed.username) || Boolean(parsed.password);
    const baseUrl = `${parsed.origin}${parsed.pathname}`;
    const isBrowserbase = parsed.hostname.includes("browserbase");
    const rotationRequired = isBrowserbase && hasCredentials;

    // 先建行拿 id
    const { data: row, error } = await supabaseForUser(ctx)
      .from("mcp_connections")
      .insert({
        user_id: userId,
        name: input.name,
        url: baseUrl, // 兼容老列，不再存明文
        base_url: baseUrl,
        transport: input.transport,
        auth_type: input.auth_type,
        auth_metadata: input.auth_metadata ?? {},
        has_credentials: hasCredentials,
        rotation_required: rotationRequired,
        disabled_reason: rotationRequired ? "CREDENTIAL_ROTATION_REQUIRED" : null,
        state: rotationRequired ? "disabled" : "ready",
      })
      .select("id")
      .single();
    if (error || !row)
      return {
        content: [{ type: "text", text: error?.message ?? "insert failed" }],
        isError: true,
      };

    // 加密 secret 到独立表（service_role only）
    if (hasCredentials) {
      const { storeConnectionSecret } = await import("../secrets.server");
      const secretRef = await storeConnectionSecret(userId, row.id, {
        full_url: input.url,
      });
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("mcp_connections")
        .update({ secret_ref: secretRef })
        .eq("id", row.id);
    }

    const safe = {
      id: row.id,
      name: input.name,
      base_url: redactMcpUrl(baseUrl),
      has_credentials: hasCredentials,
      rotation_required: rotationRequired,
      disabled_reason: rotationRequired ? "CREDENTIAL_ROTATION_REQUIRED" : null,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(safe) }],
      structuredContent: { connection: safe },
    };
  },
});
