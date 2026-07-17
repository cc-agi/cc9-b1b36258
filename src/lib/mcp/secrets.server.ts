/**
 * 服务端 Secret 存储：写入 mcp_connection_secrets（service_role only），
 * 使用 MCP_TOKEN_ENC_KEY 派生的 AES-256-GCM 密钥加密。
 * 任何前端 / 外部 MCP / Helper 都无法读取明文。
 */
import { encryptJson, decryptJson } from "./crypto.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type ConnectionSecret = {
  full_url?: string;
  headers?: Record<string, string>;
  extra?: Record<string, string>;
};

export async function storeConnectionSecret(
  userId: string,
  connectionId: string | null,
  secret: ConnectionSecret,
): Promise<string> {
  const ciphertext = encryptJson(secret);
  const { data, error } = await supabaseAdmin
    .from("mcp_connection_secrets")
    .insert({ user_id: userId, connection_id: connectionId, ciphertext })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function readConnectionSecret(
  secretRef: string,
): Promise<ConnectionSecret | null> {
  const { data, error } = await supabaseAdmin
    .from("mcp_connection_secrets")
    .select("ciphertext")
    .eq("id", secretRef)
    .maybeSingle();
  if (error || !data) return null;
  try {
    return decryptJson<ConnectionSecret>(data.ciphertext);
  } catch {
    return null;
  }
}
