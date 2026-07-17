/**
 * Worker HTTP API (P0-R2b)
 * Path: /api/worker/v1/:action
 *
 * Actions:
 *   POST /pair            { code, worker_id, version, platform } -> { token, worker_id }
 *   POST /heartbeat       { state, cdp_reachable, current_run_id?, last_error_code?, version?, platform? }
 *   POST /claim           { lease_seconds? } -> { run: null | {...} }
 *   POST /event           { run_id, event_type, payload? }
 *   GET  /cancel-status?run_id=...  -> { cancel_requested: boolean }
 *   POST /complete        { run_id, final_output? }
 *   POST /fail            { run_id, error_code, message? }
 *   POST /block           { run_id, error_code, message? }
 *   POST /sweep           -> { swept: N }
 *
 * All except /pair require: Authorization: Bearer <workerToken>, X-Worker-Id: <id>.
 * /pair uses one-time pairing code from public.worker_pairing_codes.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  hashToken,
  newRawToken,
  requireWorker,
  json,
  rateLimit,
  safeEq,
} from "@/lib/worker-api.server";
import { redactText } from "@/lib/mcp/redact";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Worker-Id",
  "access-control-max-age": "86400",
};

async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_input", detail: parsed.error.issues }, 400);
  return parsed.data;
}

// ---------- Schemas ----------
const pairSchema = z.object({
  code: z.string().trim().min(6).max(16),
  worker_id: z.string().trim().min(3).max(128),
  version: z.string().max(32).optional(),
  platform: z.string().max(64).optional(),
  label: z.string().max(64).optional(),
});

const heartbeatSchema = z.object({
  state: z.enum(["idle", "working", "error", "offline"]).default("idle"),
  cdp_reachable: z.boolean().optional(),
  current_run_id: z.string().uuid().nullable().optional(),
  last_error_code: z.string().max(64).nullable().optional(),
  version: z.string().max(32).optional(),
  platform: z.string().max(64).optional(),
});

const claimSchema = z.object({ lease_seconds: z.number().int().min(30).max(1800).default(120) });
const eventSchema = z.object({
  run_id: z.string().uuid(),
  event_type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const runIdOnlySchema = z.object({ run_id: z.string().uuid() });
const completeSchema = z.object({
  run_id: z.string().uuid(),
  final_output: z.string().max(20000).optional(),
});
const failBlockSchema = z.object({
  run_id: z.string().uuid(),
  error_code: z.string().min(1).max(64),
  message: z.string().max(1000).optional(),
});

// ---------- Handlers ----------
const MIN_HELPER_VERSION_FALLBACK = "0.3.0";

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
async function loadMinHelperVersion(): Promise<string> {
  try {
    const { data } = await supabaseAdmin
      .from("runtime_config").select("value").eq("key", "min_helper_version").maybeSingle();
    const v = data?.value;
    return typeof v === "string" ? v : MIN_HELPER_VERSION_FALLBACK;
  } catch { return MIN_HELPER_VERSION_FALLBACK; }
}

async function bumpPairFailure(ip: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  const now = new Date();
  const { data: row } = await supabaseAdmin
    .from("worker_pair_attempts").select("*").eq("ip", ip).maybeSingle();
  if (!row) {
    await supabaseAdmin.from("worker_pair_attempts").insert({ ip, window_start: now.toISOString(), failures: 1 });
    return { locked: false };
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) {
    return { locked: true, retryAfterSec: Math.ceil((new Date(row.locked_until).getTime() - now.getTime()) / 1000) };
  }
  const windowMs = 5 * 60 * 1000;
  const withinWindow = now.getTime() - new Date(row.window_start).getTime() < windowMs;
  const nextFailures = withinWindow ? row.failures + 1 : 1;
  const lockedUntil = nextFailures >= 10
    ? new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    : null;
  await supabaseAdmin.from("worker_pair_attempts").update({
    window_start: withinWindow ? row.window_start : now.toISOString(),
    failures: nextFailures,
    locked_until: lockedUntil,
  }).eq("ip", ip);
  return { locked: !!lockedUntil, retryAfterSec: lockedUntil ? 15 * 60 : undefined };
}
async function clearPairFailure(ip: string) {
  await supabaseAdmin.from("worker_pair_attempts").delete().eq("ip", ip);
}

async function handlePair(req: Request): Promise<Response> {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // DB-level lockout check first (survives serverless multi-instance)
  const { data: attempt } = await supabaseAdmin
    .from("worker_pair_attempts").select("locked_until").eq("ip", ip).maybeSingle();
  if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
    return json({ error: "pair_locked" }, 429, { ...CORS, "retry-after": "900" });
  }

  const input = await readJson(req, pairSchema);
  if (input instanceof Response) return input;

  // Helper version gate (block old Helpers at pairing time too)
  const minVer = await loadMinHelperVersion();
  if (input.version && cmpVersion(input.version, minVer) < 0) {
    return json({ error: "helper_too_old", min_helper_version: minVer, upgrade: "Update helper/ and re-run pair" }, 426, CORS);
  }

  // Look up by hash ONLY (plaintext column is legacy)
  const codeHash = hashToken(input.code);
  const { data: code, error: codeErr } = await supabaseAdmin
    .from("worker_pairing_codes")
    .select("code_hash,user_id,expires_at,used_at")
    .eq("code_hash", codeHash)
    .maybeSingle();
  if (codeErr || !code) {
    const bump = await bumpPairFailure(ip);
    if (bump.locked) return json({ error: "pair_locked" }, 429, { ...CORS, "retry-after": String(bump.retryAfterSec ?? 900) });
    return json({ error: "invalid_pairing_code" }, 401, CORS);
  }
  if (code.used_at) return json({ error: "pairing_code_already_used" }, 409, CORS);
  if (new Date(code.expires_at).getTime() < Date.now())
    return json({ error: "pairing_code_expired" }, 410, CORS);

  const token = newRawToken();
  const tokenHash = hashToken(token);

  // Revoke previous tokens for same worker_id
  await supabaseAdmin
    .from("worker_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", code.user_id).eq("worker_id", input.worker_id).is("revoked_at", null);

  const { error: insErr } = await supabaseAdmin.from("worker_tokens").insert({
    user_id: code.user_id, worker_id: input.worker_id, token_hash: tokenHash, label: input.label ?? null,
  });
  if (insErr) return json({ error: "token_insert_failed", detail: insErr.message }, 500, CORS);

  await supabaseAdmin
    .from("worker_pairing_codes")
    .update({ used_at: new Date().toISOString(), used_by_worker_id: input.worker_id })
    .eq("code_hash", codeHash);

  await supabaseAdmin.from("worker_heartbeats").upsert({
    user_id: code.user_id, worker_id: input.worker_id,
    version: input.version ?? null, platform: input.platform ?? null,
    state: "idle", last_seen_at: new Date().toISOString(),
  }, { onConflict: "user_id,worker_id" });

  await clearPairFailure(ip);
  return json({ token, worker_id: input.worker_id, min_helper_version: minVer }, 200, CORS);
}

async function handleHeartbeat(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  if (!rateLimit(`hb:${auth.tokenId}`, 5, 20)) return json({ error: "rate_limited" }, 429);
  const input = await readJson(req, heartbeatSchema);
  if (input instanceof Response) return input;

  await supabaseAdmin.from("worker_heartbeats").upsert(
    {
      user_id: auth.userId,
      worker_id: auth.workerId,
      state: input.state,
      cdp_reachable: input.cdp_reachable ?? null,
      current_run_id: input.current_run_id ?? null,
      last_error_code: input.last_error_code ?? null,
      version: input.version ?? null,
      platform: input.platform ?? null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,worker_id" },
  );
  return json({ ok: true }, 200, CORS);
}

async function handleClaim(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  if (!rateLimit(`claim:${auth.tokenId}`, 2, 5)) return json({ error: "rate_limited" }, 429);
  const input = await readJson(req, claimSchema);
  if (input instanceof Response) return input;

  const { data, error } = await supabaseAdmin.rpc("claim_next_agent_run", {
    _user_id: auth.userId,
    _worker_id: auth.workerId,
    _lease_seconds: input.lease_seconds,
  });
  if (error) return json({ error: "claim_failed", detail: error.message }, 500);
  const row = Array.isArray(data) ? data[0] : data;
  return json({ run: row ?? null }, 200, CORS);
}

async function handleEvent(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, eventSchema);
  if (input instanceof Response) return input;

  // Verify run ownership + worker matches
  const { data: run } = await supabaseAdmin
    .from("agent_runs")
    .select("id,user_id,worker_id,status")
    .eq("id", input.run_id)
    .maybeSingle();
  if (!run || run.user_id !== auth.userId) return json({ error: "run_not_found" }, 404);
  if (run.worker_id && !safeEq(run.worker_id, auth.workerId))
    return json({ error: "not_lease_holder" }, 409);

  // Next sequence
  const { data: seqRow } = await supabaseAdmin
    .from("agent_events")
    .select("sequence")
    .eq("run_id", input.run_id)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  const next = (seqRow?.sequence ?? 0) + 1;

  // Redact payload strings
  const payload = input.payload ?? {};
  const safePayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    safePayload[k] = typeof v === "string" ? redactText(v) : v;
  }

  const { error } = await supabaseAdmin.from("agent_events").insert({
    run_id: input.run_id,
    user_id: auth.userId,
    event_type: input.event_type,
    step_index: next,
    sequence: next,
    payload: JSON.parse(JSON.stringify(safePayload)),
  });
  if (error) return json({ error: "event_insert_failed", detail: error.message }, 500);
  return json({ ok: true, sequence: next }, 200, CORS);
}

async function handleCancelStatus(url: URL, req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const runId = url.searchParams.get("run_id");
  if (!runId) return json({ error: "run_id required" }, 400);
  const { data } = await supabaseAdmin
    .from("agent_runs")
    .select("cancel_requested_at,worker_id,user_id,status")
    .eq("id", runId)
    .maybeSingle();
  if (!data || data.user_id !== auth.userId) return json({ error: "run_not_found" }, 404);
  return json(
    {
      cancel_requested: Boolean(data.cancel_requested_at),
      status: data.status,
      lease_holder: data.worker_id === auth.workerId,
    },
    200,
    CORS,
  );
}

async function finalizeRun(
  auth: { userId: string; workerId: string },
  runId: string,
  patch: Record<string, unknown>,
  legalFromStatuses: string[],
): Promise<Response> {
  const { data: run } = await supabaseAdmin
    .from("agent_runs")
    .select("worker_id,user_id,status")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.user_id !== auth.userId) return json({ error: "run_not_found" }, 404);
  if (run.worker_id && !safeEq(run.worker_id, auth.workerId))
    return json({ error: "not_lease_holder" }, 409);
  if (!legalFromStatuses.includes(run.status)) return json({ error: "invalid_state", status: run.status }, 409);

  const { data, error } = await supabaseAdmin
    .from("agent_runs")
    .update({
      ...patch,
      completed_at: new Date().toISOString(),
      lease_expires_at: null,
      worker_id: null,
    })
    .eq("id", runId)
    .select()
    .maybeSingle();
  if (error) return json({ error: "finalize_failed", detail: error.message }, 500);
  return json({ run: data }, 200, CORS);
}

async function handleComplete(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, completeSchema);
  if (input instanceof Response) return input;
  return finalizeRun(
    auth,
    input.run_id,
    { status: "succeeded", final_output: input.final_output ?? null },
    ["claimed", "running"],
  );
}

async function handleFail(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, failBlockSchema);
  if (input instanceof Response) return input;
  return finalizeRun(
    auth,
    input.run_id,
    { status: "failed", error_code: input.error_code, last_error: redactText(input.message ?? "") },
    ["claimed", "running"],
  );
}

async function handleBlock(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, failBlockSchema);
  if (input instanceof Response) return input;
  return finalizeRun(
    auth,
    input.run_id,
    { status: "blocked", error_code: input.error_code, last_error: redactText(input.message ?? "") },
    ["claimed", "running"],
  );
}

async function handleSweep(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const { data, error } = await supabaseAdmin.rpc("sweep_stale_agent_runs");
  if (error) return json({ error: "sweep_failed", detail: error.message }, 500);
  return json({ swept: Array.isArray(data) ? data.length : 0 }, 200, CORS);
}

// ---------- Dispatcher ----------
export const Route = createFileRoute("/api/worker/v1/$action")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request, params }) => {
        const action = String(params.action);
        try {
          switch (action) {
            case "pair":         return await handlePair(request);
            case "heartbeat":    return await handleHeartbeat(request);
            case "claim":        return await handleClaim(request);
            case "event":        return await handleEvent(request);
            case "complete":     return await handleComplete(request);
            case "fail":         return await handleFail(request);
            case "block":        return await handleBlock(request);
            case "sweep":        return await handleSweep(request);
            default:             return json({ error: "unknown_action", action }, 404, CORS);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: "internal", detail: redactText(msg) }, 500, CORS);
        }
      },
      GET: async ({ request, params }) => {
        const action = String(params.action);
        const url = new URL(request.url);
        if (action === "cancel-status") return handleCancelStatus(url, request);
        return json({ error: "unknown_action", action }, 404, CORS);
      },
    },
  },
});
