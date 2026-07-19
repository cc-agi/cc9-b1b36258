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
import { isAcceptanceRunGoal } from "@/lib/orchestrator.server";

/**
 * P0-R3.2 Final Repair — append-only Acceptance Lab evidence.
 *
 * Writes lab-only `acceptance.*` events on lifecycle transitions so the
 * Runtime Acceptance matrix can derive PASS conclusions from persisted
 * evidence rather than from `agent_runs` live state (which loses `worker_id`
 * on finalize and can roll back to PENDING after a successful retry).
 *
 * No-op for non-lab runs; every call is best-effort and swallows insert
 * errors so it never affects the response the Helper depends on.
 */
async function insertAcceptanceEvent(
  runId: string,
  userId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: run } = await supabaseAdmin
      .from("agent_runs")
      .select("goal,attempts")
      .eq("id", runId)
      .maybeSingle();
    if (!run || !isAcceptanceRunGoal(run.goal)) return;
    const { data: seqRow } = await supabaseAdmin
      .from("agent_events")
      .select("sequence")
      .eq("run_id", runId)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = (seqRow?.sequence ?? 0) + 1;
    const fullPayload = { attempt: run.attempts ?? 1, ...payload };
    await supabaseAdmin.from("agent_events").insert({
      run_id: runId,
      user_id: userId,
      event_type: eventType,
      step_index: next,
      sequence: next,
      payload: fullPayload,
    });
  } catch {
    /* best-effort */
  }
}

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
  computer_name: z.string().max(128).optional(),
  chrome_version: z.string().max(64).optional(),
  // P0-R5 0.4.1: typed, bounded desktop session field. Replaces the prior
  // hack of stuffing JSON.stringify(desktopMeta) into `platform` (which
  // overflowed the max(64) cap and returned HTTP 400 invalid_input).
  // NEVER carries the local bridge port or bearer secret.
  desktop_session: z
    .object({
      active: z.boolean(),
      session_id: z.string().max(64).optional().nullable(),
      started_at: z.number().int().nullable().optional(),
      last_activity_at: z.number().int().nullable().optional(),
      idle_ttl_ms: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
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
      .from("runtime_config")
      .select("value")
      .eq("key", "min_helper_version")
      .maybeSingle();
    const v = data?.value;
    return typeof v === "string" ? v : MIN_HELPER_VERSION_FALLBACK;
  } catch {
    return MIN_HELPER_VERSION_FALLBACK;
  }
}

async function bumpPairFailure(ip: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  const now = new Date();
  const { data: row } = await supabaseAdmin
    .from("worker_pair_attempts")
    .select("*")
    .eq("ip", ip)
    .maybeSingle();
  if (!row) {
    await supabaseAdmin
      .from("worker_pair_attempts")
      .insert({ ip, window_start: now.toISOString(), failures: 1 });
    return { locked: false };
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) {
    return {
      locked: true,
      retryAfterSec: Math.ceil((new Date(row.locked_until).getTime() - now.getTime()) / 1000),
    };
  }
  const windowMs = 5 * 60 * 1000;
  const withinWindow = now.getTime() - new Date(row.window_start).getTime() < windowMs;
  const nextFailures = withinWindow ? row.failures + 1 : 1;
  const lockedUntil =
    nextFailures >= 10 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
  await supabaseAdmin
    .from("worker_pair_attempts")
    .update({
      window_start: withinWindow ? row.window_start : now.toISOString(),
      failures: nextFailures,
      locked_until: lockedUntil,
    })
    .eq("ip", ip);
  return { locked: !!lockedUntil, retryAfterSec: lockedUntil ? 15 * 60 : undefined };
}
async function clearPairFailure(ip: string) {
  await supabaseAdmin.from("worker_pair_attempts").delete().eq("ip", ip);
}

async function handlePair(req: Request): Promise<Response> {
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  // DB-level lockout check first (survives serverless multi-instance)
  const { data: attempt } = await supabaseAdmin
    .from("worker_pair_attempts")
    .select("locked_until")
    .eq("ip", ip)
    .maybeSingle();
  if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > Date.now()) {
    return json({ error: "pair_locked" }, 429, { ...CORS, "retry-after": "900" });
  }

  const input = await readJson(req, pairSchema);
  if (input instanceof Response) return input;

  // Helper version gate (block old Helpers at pairing time too)
  const minVer = await loadMinHelperVersion();
  if (input.version && cmpVersion(input.version, minVer) < 0) {
    return json(
      {
        error: "helper_too_old",
        min_helper_version: minVer,
        upgrade: "Update helper/ and re-run pair",
      },
      426,
      CORS,
    );
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
    if (bump.locked)
      return json({ error: "pair_locked" }, 429, {
        ...CORS,
        "retry-after": String(bump.retryAfterSec ?? 900),
      });
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
    .eq("user_id", code.user_id)
    .eq("worker_id", input.worker_id)
    .is("revoked_at", null);

  const { error: insErr } = await supabaseAdmin.from("worker_tokens").insert({
    user_id: code.user_id,
    worker_id: input.worker_id,
    token_hash: tokenHash,
    label: input.label ?? null,
  });
  if (insErr) return json({ error: "token_insert_failed", detail: insErr.message }, 500, CORS);

  await supabaseAdmin
    .from("worker_pairing_codes")
    .update({ used_at: new Date().toISOString(), used_by_worker_id: input.worker_id })
    .eq("code_hash", codeHash);

  await supabaseAdmin.from("worker_heartbeats").upsert(
    {
      user_id: code.user_id,
      worker_id: input.worker_id,
      version: input.version ?? null,
      platform: input.platform ?? null,
      state: "idle",
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,worker_id" },
  );

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
      computer_name: input.computer_name ?? null,
      chrome_version: input.chrome_version ?? null,
      // Types auto-generated: cast until types regenerate after migration.
      ...({
        desktop_session_active: input.desktop_session?.active ?? false,
        desktop_session_id: input.desktop_session?.session_id ?? null,
      } as Record<string, unknown>),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id,worker_id" },
  );

  // P0-R3.3: Active-run lease renewal.
  // If Helper reports a current_run_id, extend that Run's lease by 120s
  // via a strict RPC that verifies user_id + worker_id + status. Any
  // failure (another Worker took over, run terminal) surfaces to Helper
  // as lease_lost so it stops executing immediately. This prevents
  // pg_cron from timing out long-running Runs (e.g. the ~3-min
  // Acceptance Lab script) while the Helper is still healthy.
  let lease_renewed = false;
  let lease_expires_at: string | null = null;
  let lease_lost = false;
  if (input.current_run_id) {
    const { data: renewed, error: renewErr } = await supabaseAdmin.rpc("renew_agent_run_lease", {
      _run_id: input.current_run_id,
      _user_id: auth.userId,
      _worker_id: auth.workerId,
      _lease_seconds: 120,
    });
    if (renewErr) {
      lease_lost = true;
    } else if (renewed) {
      lease_renewed = true;
      const row = Array.isArray(renewed) ? renewed[0] : renewed;
      lease_expires_at = (row as { lease_expires_at?: string })?.lease_expires_at ?? null;
    }
  }

  return json({ ok: true, lease_renewed, lease_expires_at, lease_lost }, 200, CORS);
}

async function handleClaim(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  if (!rateLimit(`claim:${auth.tokenId}`, 2, 5)) return json({ error: "rate_limited" }, 429);
  const input = await readJson(req, claimSchema);
  if (input instanceof Response) return input;

  // Helper version gate: refuse to hand out work to stale Helpers
  const helperVersion = req.headers.get("x-helper-version") ?? "";
  const minVer = await loadMinHelperVersion();
  if (helperVersion && cmpVersion(helperVersion, minVer) < 0) {
    return json({ error: "helper_too_old", min_helper_version: minVer }, 426, CORS);
  }

  const { data, error } = await supabaseAdmin.rpc("claim_next_agent_run", {
    _user_id: auth.userId,
    _worker_id: auth.workerId,
    _lease_seconds: input.lease_seconds,
  });
  if (error) return json({ error: "claim_failed", detail: error.message }, 500);
  const row = Array.isArray(data) ? data[0] : data;
  // Move claimed -> running so orchestrator turns are allowed
  if (row) {
    await supabaseAdmin
      .from("agent_runs")
      .update({ status: "running", started_at: row.started_at ?? new Date().toISOString() })
      .eq("id", row.id)
      .eq("worker_id", auth.workerId)
      .eq("status", "claimed");
    // Persist helper-online evidence for the Acceptance Lab matrix.
    await insertAcceptanceEvent(row.id, auth.userId, "acceptance.helper_online_verified", {
      worker_id: auth.workerId,
      helper_version: helperVersion || null,
      heartbeat_at: new Date().toISOString(),
      cdp_reachable: null,
    });
  }
  return json({ run: row ?? null, min_helper_version: minVer }, 200, CORS);
}

// ----- P0-R2c: intent-driven orchestrator handshake -----

const nextIntentSchema = z.object({ run_id: z.string().uuid() });
const stepResultSchema = z.object({
  intent_id: z.string().uuid(),
  run_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(120),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.string().max(64).optional(),
  error_message: z.string().max(2000).optional(),
  latency_ms: z.number().int().nonnegative().max(600000).optional(),
});

async function handleNextIntent(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, nextIntentSchema);
  if (input instanceof Response) return input;

  const { advanceOrchestrator } = await import("@/lib/orchestrator.server");
  const outcome = await advanceOrchestrator({
    runId: input.run_id,
    userId: auth.userId,
    workerId: auth.workerId,
  });

  if (outcome.kind === "final") {
    // 0.4.22-A Final Outcome Truthfulness Guard — inspect the model's
    // final_output for explicit failure declarations (error codes, status
    // lines, verified=false, desktop-tool refusals). When failed, we MUST
    // finalize as `failed` with the classified error_code instead of writing
    // status='succeeded' with a payload that self-declares failure.
    const { classifyFinalOutputFailure } = await import("@/lib/orchestrator/validate-final-output");
    const truncatedFinal = outcome.final_output.slice(0, 20000);
    const classification = classifyFinalOutputFailure(truncatedFinal);
    if (classification.failed && classification.error_code) {
      // Best-effort audit event so the failure classification is inspectable
      // in agent_events even after the run is finalized.
      try {
        const { data: seqRow } = await supabaseAdmin
          .from("agent_events")
          .select("sequence")
          .eq("run_id", input.run_id)
          .order("sequence", { ascending: false })
          .limit(1)
          .maybeSingle();
        const nextSeq = (seqRow?.sequence ?? 0) + 1;
        await supabaseAdmin.from("agent_events").insert({
          run_id: input.run_id,
          user_id: auth.userId,
          event_type: "orchestrator.final_output_failure_classified",
          step_index: nextSeq,
          sequence: nextSeq,
          payload: {
            worker_id: auth.workerId,
            error_code: classification.error_code,
            reason: classification.reason,
            final_output_length: truncatedFinal.length,
          },
        });
      } catch {
        /* audit best-effort */
      }
      await finalizeRun(
        auth,
        input.run_id,
        {
          status: "failed",
          error_code: classification.error_code,
          last_error: redactText(classification.reason ?? classification.error_code),
          final_output: truncatedFinal,
        },
        ["claimed", "running"],
      );
      return json(
        {
          kind: "failed",
          error_code: classification.error_code,
          reason: classification.reason,
        },
        200,
        CORS,
      );
    }
    await finalizeRun(auth, input.run_id, { status: "succeeded", final_output: truncatedFinal }, [
      "claimed",
      "running",
    ]);
    return json({ kind: "final", final_output: outcome.final_output }, 200, CORS);
  }

  if (outcome.kind === "blocked") {
    if (outcome.error_code === "CANCEL_REQUESTED") {
      await finalizeRun(
        auth,
        input.run_id,
        { status: "cancelled", error_code: "OWNER_CANCELLED", last_error: null },
        ["claimed", "running"],
      );
      return json({ kind: "cancelled" }, 200, CORS);
    }
    await finalizeRun(
      auth,
      input.run_id,
      {
        status: "blocked",
        error_code: outcome.error_code,
        last_error: redactText(outcome.message),
      },
      ["claimed", "running"],
    );
    return json({ kind: "blocked", error_code: outcome.error_code }, 200, CORS);
  }
  if (outcome.kind === "failed") {
    await finalizeRun(
      auth,
      input.run_id,
      {
        status: "failed",
        error_code: outcome.error_code,
        last_error: redactText(outcome.message),
      },
      ["claimed", "running"],
    );
    return json({ kind: "failed", error_code: outcome.error_code }, 200, CORS);
  }
  return json({ kind: "intent", intent: outcome.intent }, 200, CORS);
}

async function handleStepResult(req: Request): Promise<Response> {
  const auth = await requireWorker(req);
  if (auth instanceof Response) return auth;
  const input = await readJson(req, stepResultSchema);
  if (input instanceof Response) return input;

  // Verify intent + ownership + lease
  const { data: intent } = await supabaseAdmin
    .from("agent_step_intents")
    .select("id,run_id,user_id,worker_id,attempt,idempotency_key,status")
    .eq("id", input.intent_id)
    .maybeSingle();
  if (!intent || intent.user_id !== auth.userId || intent.run_id !== input.run_id) {
    return json({ error: "intent_not_found" }, 404, CORS);
  }
  if (intent.worker_id && !safeEq(intent.worker_id, auth.workerId)) {
    return json({ error: "not_lease_holder" }, 409, CORS);
  }
  if (intent.idempotency_key && intent.idempotency_key !== input.idempotency_key) {
    return json({ error: "idempotency_mismatch" }, 409, CORS);
  }
  // Idempotent insert: unique on intent_id
  const { error: insErr } = await supabaseAdmin.from("agent_step_results").insert({
    intent_id: input.intent_id,
    run_id: input.run_id,
    user_id: auth.userId,
    attempt: intent.attempt ?? 1,
    idempotency_key: input.idempotency_key,
    ok: input.ok,
    result: (input.result ?? null) as never,
    error_code: input.error_code ?? null,
    error_message: input.error_message ? redactText(input.error_message) : null,
    latency_ms: input.latency_ms ?? null,
  });
  if (insErr && !/duplicate key/i.test(insErr.message)) {
    return json({ error: "result_insert_failed", detail: insErr.message }, 500, CORS);
  }
  await supabaseAdmin
    .from("agent_step_intents")
    .update({ status: input.ok ? "completed" : "failed", completed_at: new Date().toISOString() })
    .eq("id", input.intent_id);
  return json({ ok: true }, 200, CORS);
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

  // Deep-redact nested diagnostics (for example PowerShell -> Helper Win32
  // failure evidence) before persisting the event.
  const payload = input.payload ?? {};
  const redactPayload = (value: unknown): unknown => {
    if (typeof value === "string") return redactText(value).slice(0, 2000);
    if (Array.isArray(value)) return value.slice(0, 100).map(redactPayload);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 100)
          .map(([key, nested]) => [key, redactPayload(nested)]),
      );
    }
    return value;
  };
  const safePayload = redactPayload(payload) as Record<string, unknown>;

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
  if (!legalFromStatuses.includes(run.status))
    return json({ error: "invalid_state", status: run.status }, 409);

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
  // Persist retry-succeeded evidence AFTER the row transitions to succeeded.
  // The pre-null worker_id is captured on the event payload so the matrix
  // can attribute the successful attempt to the correct Helper even after
  // agent_runs.worker_id is cleared.
  if (patch.status === "succeeded") {
    await insertAcceptanceEvent(runId, auth.userId, "acceptance.retry_succeeded", {
      worker_id: auth.workerId,
      completed_at: new Date().toISOString(),
      final_output_present: patch.final_output != null && String(patch.final_output).length > 0,
    });
  }
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
    {
      status: "blocked",
      error_code: input.error_code,
      last_error: redactText(input.message ?? ""),
    },
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
            case "pair":
              return await handlePair(request);
            case "heartbeat":
              return await handleHeartbeat(request);
            case "claim":
              return await handleClaim(request);
            case "next-intent":
              return await handleNextIntent(request);
            case "step-result":
              return await handleStepResult(request);
            case "event":
              return await handleEvent(request);
            case "complete":
              return await handleComplete(request);
            case "fail":
              return await handleFail(request);
            case "block":
              return await handleBlock(request);
            case "sweep":
              return await handleSweep(request);
            default:
              return json({ error: "unknown_action", action }, 404, CORS);
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
