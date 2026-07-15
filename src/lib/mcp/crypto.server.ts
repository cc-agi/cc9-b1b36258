import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function key(): Buffer {
  const raw = process.env.MCP_TOKEN_ENC_KEY;
  if (!raw) throw new Error("MCP_TOKEN_ENC_KEY is not set");
  // Accept either base64 (>=32 bytes) or a hex/plain string of any length —
  // we derive a stable 32-byte key with sha256 to keep AES-256-GCM happy.
  return createHash("sha256").update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const pt = Buffer.from(JSON.stringify(value), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptJson<T = unknown>(stored: string): T {
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as T;
}
