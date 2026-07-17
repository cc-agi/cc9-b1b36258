import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";
import { redactMcpUrl } from "../redact";

/**
 * P0-R2 security fix:
 * - Strip any secrets embedded in an updated `url` (query / userinfo) and
 *   push the full URL into the encrypted secret store; only `base_url`
 *   lives in the plaintext column.
 * - Never return the raw row (which historically leaked url / auth_metadata)
 *   back to external MCP clients — return a redacted, safe projection.
 */
export default defineTool({
  name: "update_mcp_connection",
  title: "Update MCP connection",
  description:
    "Update fields of an existing MCP connection owned by the caller. Secrets embedded in the URL (query / userinfo) or in a bearer field are moved to the encrypted secret store; the response is always redacted.",
  inputSchema: {
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    url: z.string().url().optional(),
    transport: z.enum(["http", "sse", "stdio"]).optional(),
    auth_type: z.enum(["none", "oauth", "bearer", "custom"]).optional(),
    auth_token: z.string().optional(),
    state: z.string().optional(),
  },
  annotations: { readOnlyHint: false },
  handler: async ({ id, ...patch }, ctx) => {
    const client = supabaseForUser(ctx); // enforces owner + auth
    const userId = ctx.getUserId()!;

    const patchClean: Record<string, unknown> = {};
    if (patch.name !== undefined) patchClean.name = patch.name;
    if (patch.transport !== undefined) patchClean.transport = patch.transport;
    if (patch.auth_type !== undefined) patchClean.auth_type = patch.auth_type;
    if (patch.state !== undefined) patchClean.state = patch.state;

    let newSecretRef: string | null = null;
    let hasCredentialsAfter: boolean | null = null;

    if (patch.url !== undefined || patch.auth_token !== undefined) {
      let baseUrl: string | undefined;
      let embeddedCreds = false;
      if (patch.url !== undefined) {
        let parsed: URL;
        try {
          parsed = new URL(patch.url);
        } catch {
          return { content: [{ type: "text", text: "Invalid URL" }], isError: true };
        }
        embeddedCreds =
          parsed.search.length > 0 || Boolean(parsed.username) || Boolean(parsed.password);
        baseUrl = `${parsed.origin}${parsed.pathname}`;
        patchClean.url = baseUrl;
        patchClean.base_url = baseUrl;
      }

      const headers: Record<string, string> = {};
      if (patch.auth_token) headers.Authorization = `Bearer ${patch.auth_token}`;
      const hasBearer = Object.keys(headers).length > 0;

      if (embeddedCreds || hasBearer) {
        const { storeConnectionSecret } = await import("../secrets.server");
        newSecretRef = await storeConnectionSecret(userId, id, {
          full_url: patch.url,
          headers: hasBearer ? headers : undefined,
        });
        patchClean.secret_ref = newSecretRef;
        patchClean.has_credentials = true;
        hasCredentialsAfter = true;
      } else if (patch.url !== undefined) {
        // URL rotated but no secrets embedded; leave existing secret_ref alone.
      }
    }

    // Never let external callers set auth_metadata directly — it's the
    // historical plaintext-secret column.
    delete (patchClean as Record<string, unknown>).auth_metadata;

    const { data, error } = await client
      .from("mcp_connections")
      .update(patchClean)
      .eq("id", id)
      .select(
        "id,name,base_url,url,transport,state,has_credentials,rotation_required,disabled_reason,updated_at",
      )
      .single();
    if (error || !data) {
      return { content: [{ type: "text", text: error?.message ?? "update failed" }], isError: true };
    }

    const safe = {
      id: data.id,
      name: data.name,
      base_url: redactMcpUrl(data.base_url ?? data.url),
      transport: data.transport,
      state: data.state,
      has_credentials: hasCredentialsAfter ?? data.has_credentials,
      rotation_required: data.rotation_required,
      disabled_reason: data.disabled_reason,
      updated_at: data.updated_at,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(safe) }],
      structuredContent: { connection: safe },
    };
  },
});
