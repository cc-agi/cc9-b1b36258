/**
 * P0-R2b: 服务端 Secret 存储 (AES-256-GCM + AAD + key_version)。
 * - service_role 独占。
 * - AAD = `mcp_conn:<userId>:<connectionId>` — 防止 blob 跨行/跨用户重放。
 * - 缺少加密密钥、解密失败一律 fail-closed，返回 null。
 * - 任何日志/事件都不得输出解密后的内容；仅在服务端内存中使用。
 */
import { encryptJson, decryptJson, connectionAad } from "./crypto.server";
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
  const ciphertext = encryptJson(secret, connectionAad(userId, connectionId));
  const { data, error } = await supabaseAdmin
    .from("mcp_connection_secrets")
    .insert({ user_id: userId, connection_id: connectionId, ciphertext })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

export async function readConnectionSecret(
  userId: string,
  connectionId: string,
  secretRef: string,
): Promise<ConnectionSecret | null> {
  const { data, error } = await supabaseAdmin
    .from("mcp_connection_secrets")
    .select("ciphertext,user_id,connection_id")
    .eq("id", secretRef)
    .maybeSingle();
  if (error || !data) return null;
  // 强制归属检查
  if (data.user_id !== userId || (data.connection_id && data.connection_id !== connectionId)) {
    return null;
  }
  try {
    return decryptJson<ConnectionSecret>(data.ciphertext, connectionAad(userId, connectionId));
  } catch {
    return null;
  }
}
