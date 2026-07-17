/**
 * P0-R3.2 Runtime Acceptance Lab (Owner-only, deterministic, read-only).
 *
 * - Every server fn is gated by `requireSentinelOwner`. `requireSentinelOwner`
 *   alone is NOT sufficient; the email claim must strictly equal
 *   SENTINEL_OWNER_EMAIL. RLS is a second layer, not the primary check.
 * - Acceptance Lab runs are executed by the Cloud orchestrator's deterministic
 *   branch (no model influence). The fixed script is:
 *      1) browser_goto https://example.com
 *      2) acceptance_wait 60000
 *      3) acceptance_wait 60000
 *      4) acceptance_wait 60000
 *      5) browser_extract h1
 *      6) fixed final_output
 * - The acceptance matrix is derived strictly from persisted evidence
 *   (`agent_runs`, `agent_step_intents`, `agent_step_results`, `agent_events`,
 *   and the *specific* Worker heartbeat referenced by the run). It never
 *   reads the "latest global Worker" state, and it never marks static
 *   history rows as PASS — they are surfaced as VERIFIED_IN_P0_R3_1.
 * - `fully_accepted` requires PASS on all five dynamic criteria AND
 *   evidence-preserved retry (attempt 1 intents & results survive attempt 2).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { z } from "zod";
import { ACCEPTANCE_GOAL_PREFIX } from "@/lib/orchestrator.server";

const ACCEPTANCE_GOAL = `${ACCEPTANCE_GOAL_PREFIX} P0-R3.2 运行时可靠性验收 — 只读浏览（确定性脚本）。
Cloud orchestrator 会在专用分支中固定执行以下 6 步，模型不参与决策：
1) browser_goto https://example.com
2) acceptance_wait duration_ms=60000
3) acceptance_wait duration_ms=60000
4) acceptance_wait duration_ms=60000
5) browser_extract selector="h1"
6) 生成固定 final_output（页面 URL / 标题 / h1）
每次 wait 都是 Helper 侧的本地计时，不访问文件、不点击、不输入、不提交、不登录、不执行脚本。
整个 Run 预计运行约 3 分 5 秒。`;

export { ACCEPTANCE_GOAL_PREFIX };

/** Wall-clock cutoff after which a still-running Acceptance Lab attempt is a FAIL. */
const ATTEMPT_HARD_LIMIT_MS = 6 * 60 * 1000; // 6 min (script ~3m + margin)
/** Heartbeat age above which we consider the Run's Worker offline. */
const HELPER_OFFLINE_THRESHOLD_MS = 2 * 60 * 1000;

export const createAcceptanceRun = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("agent_runs")
      .insert({
        user_id: context.userId,
        goal: ACCEPTANCE_GOAL,
        status: "queued",
      })
      .select("id,status,created_at,goal")
      .single();
    if (error) throw new Error(error.message);
    return data;
  });

export const listAcceptanceRuns = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("agent_runs")
      .select(
        "id,goal,status,error_code,last_error,attempts,worker_id,created_at,queued_at,started_at,heartbeat_at,lease_expires_at,completed_at,timed_out_at,cancel_requested_at,final_output",
      )
      .like("goal", `${ACCEPTANCE_GOAL_PREFIX}%`)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/** Matrix values: static history uses VERIFIED_IN_P0_R3_1 with evidence citation. */
export type MatrixValue = "PASS" | "FAIL" | "PENDING" | "VERIFIED_IN_P0_R3_1";

export type AcceptanceMatrix = {
  helper_online_detection: MatrixValue;
  helper_offline_detection: MatrixValue;
  running_to_timed_out: MatrixValue;
  timed_out_to_retry: MatrixValue;
  retry_to_succeeded: MatrixValue;
  stale_pid_protection: MatrixValue;
  dependency_bootstrap: MatrixValue;
  utf8_output: MatrixValue;
  fully_accepted: boolean;
};

export type AttemptGroup = {
  attempt: number;
  intents: Array<{
    id: string;
    sequence: number;
    tool_name: string;
    arguments_json: string;
    status: string | null;
  }>;
  results: Array<{
    intent_id: string;
    ok: boolean;
    error_code: string | null;
    latency_ms: number | null;
  }>;
  events: Array<{
    id: string;
    event_type: string;
    sequence: number;
    created_at: string;
  }>;
};

export const getAcceptanceRun = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: run, error: runErr } = await context.supabase
      .from("agent_runs")
      .select(
        "id,goal,status,error_code,last_error,attempts,worker_id,created_at,queued_at,started_at,heartbeat_at,lease_expires_at,completed_at,timed_out_at,cancel_requested_at,final_output",
      )

      .eq("id", data.id)
      .maybeSingle();
    if (runErr) throw new Error(runErr.message);
    if (!run) throw new Error("run_not_found");

    const [evRes, intentsRes] = await Promise.all([
      context.supabase
        .from("agent_events")
        .select("id,event_type,sequence,step_index,payload,created_at")
        .eq("run_id", data.id)
        .order("sequence", { ascending: true }),
      context.supabase
        .from("agent_step_intents")
        .select("id,sequence,attempt,tool_name,arguments,status,delivered_at,completed_at")
        .eq("run_id", data.id)
        .order("attempt", { ascending: true })
        .order("sequence", { ascending: true }),
    ]);
    if (evRes.error) throw new Error(evRes.error.message);
    if (intentsRes.error) throw new Error(intentsRes.error.message);
    const events = evRes.data ?? [];
    const intents = intentsRes.data ?? [];

    const intentIds = intents.map((i) => i.id);
    const { data: results } =
      intentIds.length > 0
        ? await context.supabase
            .from("agent_step_results")
            .select("intent_id,attempt,ok,error_code,latency_ms")
            .in("intent_id", intentIds)
        : {
            data: [] as Array<{
              intent_id: string;
              attempt: number;
              ok: boolean;
              error_code: string | null;
              latency_ms: number | null;
            }>,
          };

    // Look up ONLY the heartbeat that belongs to this Run's worker_id.
    let helper: null | {
      worker_id: string;
      last_seen_at: string;
      version: string | null;
      state: string | null;
      cdp_reachable: boolean | null;
      age_seconds: number;
      online: boolean;
    } = null;
    if (run.worker_id) {
      const { data: hbs } = await context.supabase
        .from("worker_heartbeats")
        .select("worker_id,last_seen_at,version,state,cdp_reachable")
        .eq("worker_id", run.worker_id)
        .order("last_seen_at", { ascending: false })
        .limit(1);
      const hb = hbs?.[0] ?? null;
      if (hb) {
        const age = Date.now() - new Date(hb.last_seen_at).getTime();
        helper = {
          worker_id: hb.worker_id,
          last_seen_at: hb.last_seen_at,
          version: hb.version,
          state: hb.state,
          cdp_reachable: hb.cdp_reachable,
          age_seconds: Math.floor(age / 1000),
          online: age < 60_000,
        };
      }
    }

    // Group intents/results/events by attempt.
    const attemptsSeen = new Set<number>(intents.map((i) => i.attempt ?? 1));
    if ((run.attempts ?? 1) >= 1) attemptsSeen.add(run.attempts ?? 1);
    const attempts_summary: AttemptGroup[] = [...attemptsSeen]
      .sort((a, b) => a - b)
      .map((att) => ({
        attempt: att,
        intents: intents
          .filter((i) => (i.attempt ?? 1) === att)
          .map((i) => ({
            id: i.id,
            sequence: i.sequence,
            tool_name: i.tool_name,
            arguments_json: JSON.stringify(i.arguments ?? {}),
            status: i.status,
          })),
        results: (results ?? [])
          .filter((r) => (r.attempt ?? 1) === att)
          .map((r) => ({
            intent_id: r.intent_id,
            ok: r.ok,
            error_code: r.error_code,
            latency_ms: r.latency_ms,
          })),
        events: events
          .filter((e) => {
            // retry_requested events carry attempt in payload; other events are attempt-agnostic
            const p = (e.payload ?? {}) as Record<string, unknown>;
            const evAtt = typeof p.attempt === "number" ? (p.attempt as number) : null;
            return evAtt === att || evAtt === null;
          })
          .map((e) => ({
            id: e.id,
            event_type: e.event_type,
            sequence: e.sequence,
            created_at: e.created_at,
          })),
      }));

    // ---- Derive matrix from PERSISTED evidence (events + intents) ----
    const matrix = deriveAcceptanceMatrix({
      run: {
        status: run.status,
        error_code: run.error_code,
        attempts: run.attempts,
        final_output: run.final_output,
        started_at: run.started_at,
      },
      events: events.map((e) => ({
        event_type: e.event_type,
        payload: (e.payload ?? {}) as Record<string, unknown>,
        created_at: e.created_at,
      })),
      attempts_summary,
      now: Date.now(),
    });

    return {
      run,
      events,
      helper,
      timeline: {
        created_at: run.created_at,
        queued_at: (run as { queued_at?: string | null }).queued_at ?? run.created_at,
        claimed_at: events.find((e) => e.event_type === "run.claimed")?.created_at ?? null,
        running_at:
          events.find((e) => e.event_type === "run.started")?.created_at ?? run.started_at ?? null,
        last_progress_at:
          events.filter((e) => !e.event_type.startsWith("run.retry")).slice(-1)[0]?.created_at ??
          null,
        heartbeat_at: run.heartbeat_at,
        lease_expires_at: run.lease_expires_at,
        timed_out_at: run.timed_out_at,
        completed_at: run.completed_at,
        cancel_requested_at: run.cancel_requested_at,
        attempts: run.attempts,
        worker_id: run.worker_id,
      },

      attempts_summary,
      matrix,
      retry_strategy: "same_run_id_multi_attempt" as const,
      sweeper: await getSweeperStatus(),
    };
  });

async function getSweeperStatus() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("get_sweeper_cron_status");
  const base = {
    deployment: "supabase_pg_cron" as const,
    job_name: "sentinel-sweep-stale-runs",
    schedule: "* * * * *",
    note: "在数据库内部每分钟运行；不依赖 Helper、浏览器窗口或 Owner 手动点击。",
  };
  if (error || !data) {
    return {
      ...base,
      active: null as boolean | null,
      last_runs: [] as Array<{
        status: string;
        return_message: string | null;
        start_time: string;
        end_time: string | null;
      }>,
      error: error?.message ?? "no_data",
    };
  }
  const payload = data as unknown as {
    job: { active: boolean; schedule: string; jobname: string } | null;
    runs: Array<{
      status: string;
      return_message: string | null;
      start_time: string;
      end_time: string | null;
    }>;
  };
  return {
    ...base,
    active: payload.job?.active ?? false,
    schedule: payload.job?.schedule ?? base.schedule,
    last_runs: payload.runs ?? [],
    error: null as string | null,
  };
}

export const listStaleWorkers = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { MIN_HELPER_VERSION } = await import("./mcp/version");
    const [tokens, hbs] = await Promise.all([
      context.supabase
        .from("worker_tokens")
        .select("id,worker_id,label,revoked_at,last_used_at,created_at"),
      context.supabase.from("worker_heartbeats").select("worker_id,version,last_seen_at"),
    ]);
    if (tokens.error) throw new Error(tokens.error.message);
    if (hbs.error) throw new Error(hbs.error.message);
    const hbMap = new Map<string, { version: string | null; last_seen_at: string }>();
    for (const h of hbs.data ?? []) {
      const prev = hbMap.get(h.worker_id);
      if (!prev || new Date(h.last_seen_at) > new Date(prev.last_seen_at)) {
        hbMap.set(h.worker_id, { version: h.version, last_seen_at: h.last_seen_at });
      }
    }
    const now = Date.now();
    const stale = (tokens.data ?? [])
      .filter((t) => !t.revoked_at)
      .map((t) => {
        const hb = hbMap.get(t.worker_id);
        const offline = !hb || now - new Date(hb.last_seen_at).getTime() > 5 * 60_000;
        const versionLow = hb?.version ? cmpSemver(hb.version, MIN_HELPER_VERSION) < 0 : false;
        return {
          id: t.id,
          worker_id: t.worker_id,
          label: t.label,
          last_used_at: t.last_used_at,
          version: hb?.version ?? null,
          last_seen_at: hb?.last_seen_at ?? null,
          offline,
          version_low: versionLow,
          safe_to_delete: offline && (versionLow || !hb),
        };
      });
    return { workers: stale, min_version: MIN_HELPER_VERSION };
  });

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ------------------------------------------------------------------
// P0-R3.2 Final Repair — pure, testable acceptance matrix.
//
// Derives the five dynamic PASS/FAIL/PENDING criteria from APPEND-ONLY
// evidence (events + step_intents), NOT from `agent_runs` live state.
//
// Key property: because the sweeper writes `run.timed_out` and
// `acceptance.helper_offline_verified` events before `agent_runs.worker_id`
// is nulled, AND `finalizeRun` writes `acceptance.retry_succeeded` when a
// second attempt completes, PASS conclusions accumulate across attempts.
// A successful retry no longer rolls attempt-1 evidence back to PENDING.
// ------------------------------------------------------------------

export type MatrixEvent = {
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export function deriveAcceptanceMatrix(input: {
  run: {
    status: string;
    error_code: string | null;
    attempts: number | null;
    final_output: string | null;
    started_at: string | null;
  };
  events: MatrixEvent[];
  attempts_summary: AttemptGroup[];
  now?: number;
}): AcceptanceMatrix {
  const { run, events, attempts_summary } = input;
  const now = input.now ?? Date.now();
  const attempts = run.attempts ?? 1;

  const hasEvent = (t: string) => events.some((e) => e.event_type === t);
  const findEvent = (t: string) => events.find((e) => e.event_type === t);

  const onlineVerified = events.filter((e) => e.event_type === "acceptance.helper_online_verified");
  const offlineVerified = findEvent("acceptance.helper_offline_verified");
  const timedOutEvent = events.find(
    (e) =>
      e.event_type === "run.timed_out" &&
      (e.payload?.error_code === "LEASE_EXPIRED" || run.error_code === "LEASE_EXPIRED"),
  );
  const retryRequested = hasEvent("run.retry_requested");
  const retrySucceededEvent = events.find(
    (e) =>
      e.event_type === "acceptance.retry_succeeded" &&
      typeof e.payload?.attempt === "number" &&
      (e.payload.attempt as number) >= 2,
  );

  const attempt1 = attempts_summary.find((g) => g.attempt === 1);
  const attempt1Preserved = !!attempt1 && attempt1.intents.length > 0;

  const startedAt = run.started_at ? new Date(run.started_at).getTime() : null;
  const runAgeMs = startedAt ? now - startedAt : null;
  const isRunning = run.status === "running" || run.status === "claimed";

  // 1) helper_online_detection — persisted online evidence in ANY attempt.
  const helper_online_detection: MatrixValue = onlineVerified.length > 0 ? "PASS" : "PENDING";

  // 2) helper_offline_detection — offline evidence + LEASE_EXPIRED timeout event.
  const helper_offline_detection: MatrixValue =
    offlineVerified && timedOutEvent
      ? "PASS"
      : run.status === "timed_out" && run.error_code && run.error_code !== "LEASE_EXPIRED"
        ? "FAIL"
        : "PENDING";

  // 3) running_to_timed_out — persisted run.timed_out event OR live FAIL condition.
  const running_to_timed_out: MatrixValue = timedOutEvent
    ? "PASS"
    : isRunning && runAgeMs !== null && runAgeMs > ATTEMPT_HARD_LIMIT_MS
      ? "FAIL"
      : "PENDING";

  // 4) timed_out_to_retry — timeout event + retry event + attempts advanced
  //    + attempt-1 intents preserved (never overwritten by retry).
  const timed_out_to_retry: MatrixValue =
    timedOutEvent && retryRequested && attempts >= 2 && attempt1Preserved
      ? "PASS"
      : retryRequested && !attempt1Preserved
        ? "FAIL"
        : "PENDING";

  // 5) retry_to_succeeded — persisted retry-succeeded event (attempt >= 2)
  //    with final_output_present flag AND attempt-1 evidence still intact.
  const finalOutputPresent =
    !!retrySucceededEvent && retrySucceededEvent.payload?.final_output_present === true;
  const retry_to_succeeded: MatrixValue =
    retrySucceededEvent && finalOutputPresent && attempt1Preserved
      ? "PASS"
      : attempts >= 2 && (run.status === "failed" || run.status === "blocked")
        ? "FAIL"
        : "PENDING";

  const staticFromR31: MatrixValue = "VERIFIED_IN_P0_R3_1";
  const matrix: AcceptanceMatrix = {
    helper_online_detection,
    helper_offline_detection,
    running_to_timed_out,
    timed_out_to_retry,
    retry_to_succeeded,
    stale_pid_protection: staticFromR31,
    dependency_bootstrap: staticFromR31,
    utf8_output: staticFromR31,
    fully_accepted: false,
  };
  matrix.fully_accepted =
    helper_online_detection === "PASS" &&
    helper_offline_detection === "PASS" &&
    running_to_timed_out === "PASS" &&
    timed_out_to_retry === "PASS" &&
    retry_to_succeeded === "PASS";
  return matrix;
}
