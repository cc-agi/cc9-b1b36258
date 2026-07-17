import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * P0-R2b: AES-256-GCM with AAD + key_version.
 * Storage format (base64): `v1:<iv12 | tag16 | ciphertext>` when AAD used,
 * or legacy `<iv12 | tag16 | ciphertext>` (base64) for pre-R2b blobs.
 * Fail-closed if MCP_TOKEN_ENC_KEY is missing.
 */

const KEY_VERSION = "v1";

function key(): Buffer {
  const raw = process.env.MCP_TOKEN_ENC_KEY;
  if (!raw) throw new Error("MCP_TOKEN_ENC_KEY is not set (fail-closed)");
  // sha256 -> 32 bytes deterministic
  return createHash("sha256").update(raw).digest();
}

function aadBuf(aad?: string): Buffer | undefined {
  return aad ? Buffer.from(aad, "utf8") : undefined;
}

export function encryptJson(value: unknown, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  if (aad) cipher.setAAD(aadBuf(aad)!);
  const pt = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, ct]).toString("base64");
  return aad ? `${KEY_VERSION}:${packed}` : packed;
}

export function decryptJson<T = unknown>(stored: string, aad?: string): T {
  let payload = stored;
  if (stored.startsWith(`${KEY_VERSION}:`)) payload = stored.slice(KEY_VERSION.length + 1);
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  if (aad) decipher.setAAD(aadBuf(aad)!);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as T;
}

/** Build a stable AAD for a connection secret. */
export function connectionAad(userId: string, connectionId: string | null): string {
  return `mcp_conn:${userId}:${connectionId ?? "-"}`;
}
