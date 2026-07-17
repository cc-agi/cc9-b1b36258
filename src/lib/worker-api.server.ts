/**
 * Worker HTTP API 通用鉴权 + 输入校验中间件 (P0-R2b)。
 * Helper 只保存 { worker_id, token }。任何 worker_id 不匹配、token 已撤销、
 * 或 lease 已丢失 → 立即 401/409。
 *
 * 所有 /api/worker/v1/* 端点必须调用 requireWorker() 拿 { userId, workerId }。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type WorkerAuth = {
  userId: string;
  workerId: string;
  tokenId: string;
};

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newRawToken(): string {
  // 32 bytes, base64url, no padding
  return randomBytes(32).toString("base64url");
}

export function newPairingCode(): string {
  // 8 chars uppercase alnum, avoid ambiguous 0/O/1/I
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[raw[i] % alphabet.length];
  return out;
}

export function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify Authorization: Bearer <worker-token> and matching X-Worker-Id header.
 * Returns 401 Response on failure — callers should return it directly.
 */
export async function requireWorker(request: Request): Promise<WorkerAuth | Response> {
  const auth = request.headers.get("authorization") ?? "";
  const workerId = request.headers.get("x-worker-id") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ") || !workerId) {
    return json({ error: "missing_credentials" }, 401);
  }
  const token = auth.slice(7).trim();
  if (!token) return json({ error: "missing_token" }, 401);
  const hash = hashToken(token);

  const { data, error } = await supabaseAdmin
    .from("worker_tokens")
    .select("id,user_id,worker_id,revoked_at")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return json({ error: "invalid_token" }, 401);
  if (!safeEq(data.worker_id, workerId)) return json({ error: "worker_id_mismatch" }, 401);

  // touch last_used_at (best-effort)
  await supabaseAdmin
    .from("worker_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { userId: data.user_id, workerId: data.worker_id, tokenId: data.id };
}

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/** Simple in-memory rate limit per (tokenId, action). Not for production scale. */
const rlBuckets = new Map<string, { tokens: number; last: number }>();
export function rateLimit(key: string, ratePerSec = 10, burst = 20): boolean {
  const now = Date.now();
  const b = rlBuckets.get(key) ?? { tokens: burst, last: now };
  const elapsed = (now - b.last) / 1000;
  b.tokens = Math.min(burst, b.tokens + elapsed * ratePerSec);
  b.last = now;
  if (b.tokens < 1) {
    rlBuckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  rlBuckets.set(key, b);
  return true;
}
