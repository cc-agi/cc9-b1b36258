import { CC6, assertAllowedServerUrl } from "./config";
import { decryptJson, encryptJson } from "./crypto.server";
import { refreshTokens, type ClientRegistration, type TokenSet } from "./oauth.server";

interface AuthMetadata {
  tokens?: TokenSet;
  client?: ClientRegistration;
}

/**
 * Loads (and if needed refreshes) an access token for a given user + server.
 * Returns null if the user has no connection yet.
 */
export async function loadAccessToken(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("mcp_connections")
    .select("id, auth_metadata")
    .eq("user_id", userId)
    .eq("name", CC6.name)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const meta = decodeMetadata(data.auth_metadata);
  if (!meta.tokens || !meta.client) return null;

  if (meta.tokens.expires_at > Date.now() + 15_000) {
    return meta.tokens.access_token;
  }
  if (!meta.tokens.refresh_token) return null;

  const fresh = await refreshTokens({
    client: meta.client,
    refreshToken: meta.tokens.refresh_token,
  });
  const nextMeta: AuthMetadata = { client: meta.client, tokens: fresh };
  await supabaseAdmin
    .from("mcp_connections")
    .update({
      auth_metadata: { ciphertext: encryptJson(nextMeta) } as unknown as object,
      state: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.id);
  return fresh.access_token;
}

export async function saveConnection(params: {
  userId: string;
  client: ClientRegistration;
  tokens: TokenSet;
}) {
  assertAllowedServerUrl(CC6.serverUrl);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const meta: AuthMetadata = { client: params.client, tokens: params.tokens };
  const { error } = await supabaseAdmin.from("mcp_connections").upsert(
    {
      user_id: params.userId,
      name: CC6.name,
      url: CC6.serverUrl,
      transport: "http",
      auth_type: "oauth",
      auth_metadata: { ciphertext: encryptJson(meta) } as unknown as object,
      state: "ready",
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,name" as unknown as string },
  );
  if (error) throw error;
}

export async function deleteConnection(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("mcp_connections")
    .delete()
    .eq("user_id", userId)
    .eq("name", CC6.name);
  if (error) throw error;
}

export async function getConnectionStatus(userId: string): Promise<{
  connected: boolean;
  updated_at?: string;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("mcp_connections")
    .select("updated_at, auth_metadata")
    .eq("user_id", userId)
    .eq("name", CC6.name)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { connected: false };
  const meta = decodeMetadata(data.auth_metadata);
  return { connected: Boolean(meta.tokens?.access_token), updated_at: data.updated_at };
}

function decodeMetadata(raw: unknown): AuthMetadata {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  if (typeof r.ciphertext === "string") {
    try {
      return decryptJson<AuthMetadata>(r.ciphertext);
    } catch {
      return {};
    }
  }
  return {};
}
