/**
 * Owner-facing server fns for Worker pairing management.
 * The Owner generates a one-time pairing code, then runs the Helper
 * `install/pair` script with it. The code is stored server-side and
 * expires in 5 minutes; only its plain value is shown once.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const generateWorkerPairingCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { newPairingCode, hashToken } = await import("./worker-api.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const code = newPairingCode();
    const code_hash = hashToken(code);
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    // Legacy `code` column stores hash too (never plaintext); we only ever look up by code_hash.
    const { error } = await supabaseAdmin.from("worker_pairing_codes").insert({
      code: code_hash,
      code_hash,
      user_id: context.userId,
      expires_at: expires.toISOString(),
    });
    if (error) throw new Error(error.message);
    return { code, expires_at: expires.toISOString() };
  });

export const listWorkerTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("worker_tokens")
      .select("id,worker_id,label,revoked_at,last_used_at,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const revokeWorkerToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("worker_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const requestAgentRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase.rpc("retry_agent_run", {
      _run_id: data.id,
    });
    if (error) throw new Error(error.message);
    return row;
  });

/**
 * 列出该用户全部 Worker：合并 worker_tokens 与最近一次 heartbeat。
 * 返回内容不包含 token 本体，只包含 worker_id、label、状态、心跳等元数据。
 */
export const listWorkersOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [tokensRes, hbRes] = await Promise.all([
      context.supabase
        .from("worker_tokens")
        .select("id,worker_id,label,revoked_at,last_used_at,created_at")
        .order("created_at", { ascending: false }),
      context.supabase
        .from("worker_heartbeats")
        .select("worker_id,version,platform,state,cdp_reachable,current_run_id,last_seen_at")
        .order("last_seen_at", { ascending: false }),
    ]);
    if (tokensRes.error) throw new Error(tokensRes.error.message);
    if (hbRes.error) throw new Error(hbRes.error.message);
    const hbByWorker = new Map<string, (typeof hbRes.data)[number]>();
    for (const h of hbRes.data ?? []) {
      if (!hbByWorker.has(h.worker_id)) hbByWorker.set(h.worker_id, h);
    }
    return (tokensRes.data ?? []).map((t) => ({
      ...t,
      heartbeat: hbByWorker.get(t.worker_id) ?? null,
    }));
  });

/**
 * 为一个 rotation_required 的 MCP 连接重新写入凭据。
 * 只接受完整 URL 或 auth_token；写入加密 Secret 后更新 base_url 和 secret_ref，
 * 并清除 rotation_required / disabled_reason。
 */
const RotateInput = z.object({
  id: z.string().uuid(),
  url: z
    .string()
    .trim()
    .url("URL 格式不正确")
    .refine((u) => !/[<>]/.test(u), { message: "URL 里仍有占位符 <...>" }),
  auth_token: z.string().trim().optional(),
});

export const rotateMcpConnectionCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RotateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // 校验连接归属
    const { data: conn, error: qErr } = await context.supabase
      .from("mcp_connections")
      .select("id,name")
      .eq("id", data.id)
      .maybeSingle();
    if (qErr) throw new Error(qErr.message);
    if (!conn) throw new Error("连接不存在或不属于当前用户");

    // 计算 base_url（去掉 query，避免把 API Key 泄露到明文列）
    let base_url: string;
    try {
      const u = new URL(data.url);
      u.search = "";
      base_url = u.toString();
    } catch {
      throw new Error("URL 无法解析");
    }

    // 写入加密 Secret（保留完整 URL 与可选 headers）
    const { storeConnectionSecret } = await import("./mcp/secrets.server");
    const headers: Record<string, string> = {};
    if (data.auth_token) headers.Authorization = `Bearer ${data.auth_token}`;
    const secret_ref = await storeConnectionSecret(context.userId, data.id, {
      full_url: data.url,
      headers: Object.keys(headers).length ? headers : undefined,
    });

    const { error: uErr } = await supabaseAdmin
      .from("mcp_connections")
      .update({
        base_url,
        url: base_url, // 冗余同步：明文列不再包含凭据
        secret_ref,
        has_credentials: true,
        rotation_required: false,
        disabled_reason: null,
        state: "ready",
        last_error: null,
      })
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (uErr) throw new Error(uErr.message);
    return { ok: true as const };
  });

/**
 * 发布准备状态：只返回布尔/字符串，不含任何凭据。
 */
export const getReleaseReadiness = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { MCP_CODE_VERSION, MCP_MANIFEST_VERSION, MCP_DB_SCHEMA_VERSION, MIN_HELPER_VERSION } =
      await import("./mcp/version");

    const [hb, rot, tokens] = await Promise.all([
      context.supabase
        .from("worker_heartbeats")
        .select("worker_id,version,state,last_seen_at,cdp_reachable")
        .order("last_seen_at", { ascending: false })
        .limit(1),
      context.supabase
        .from("mcp_connections")
        .select("id,name,rotation_required,disabled_reason")
        .eq("rotation_required", true),
      context.supabase
        .from("worker_tokens")
        .select("id")
        .is("revoked_at", null),
    ]);

    const latest = hb.data?.[0] ?? null;
    const helperOnline = latest
      ? Date.now() - new Date(latest.last_seen_at).getTime() < 60_000
      : false;

    // Secret 配置：读取 env 名称是否存在（不返回值）
    // 服务端 process.env 只能在 handler 内读取
    const secretsConfigured = {
      MCP_SECRET_ENC_KEY: Boolean(process.env.MCP_SECRET_ENC_KEY),
      LOVABLE_API_KEY: Boolean(process.env.LOVABLE_API_KEY),
    };

    return {
      versions: {
        code: MCP_CODE_VERSION,
        manifest: MCP_MANIFEST_VERSION,
        db_schema: MCP_DB_SCHEMA_VERSION,
        min_helper: MIN_HELPER_VERSION,
      },
      orchestrator: { ready: true },
      worker_api: { ready: true },
      helper: {
        online: helperOnline,
        version: latest?.version ?? null,
        cdp_reachable: latest?.cdp_reachable ?? null,
        state: latest?.state ?? null,
        last_seen_at: latest?.last_seen_at ?? null,
        active_tokens: tokens.data?.length ?? 0,
        version_ok:
          latest?.version && MIN_HELPER_VERSION
            ? compareSemver(latest.version, MIN_HELPER_VERSION) >= 0
            : null,
      },
      secrets: secretsConfigured,
      browserbase: {
        rotation_pending_count: rot.data?.length ?? 0,
        connections: (rot.data ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          disabled_reason: r.disabled_reason,
        })),
      },
    };
  });

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
