/**
 * P0-R3.2 Runtime Acceptance Lab (Owner-only, deterministic, read-only).
 *
 * - Every server fn is gated by `requireSentinelOwner`. `requireSupabaseAuth`
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
        "id,goal,status,error_code,last_error,attempts,worker_id,created_at,started_at,heartbeat_at,lease_expires_at,completed_at,timed_out_at,cancel_requested_at,final_output",
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
        "id,goal,status,error_code,last_error,attempts,worker_id,created_at,started_at,heartbeat_at,lease_expires_at,completed_at,timed_out_at,cancel_requested_at,final_output",
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
        : { data: [] as Array<{ intent_id: string; attempt: number; ok: boolean; error_code: string | null; latency_ms: number | null }> };

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
          .map((e) => ({ id: e.id, event_type: e.event_type, sequence: e.sequence, created_at: e.created_at })),
      }));

    // ---- Derive matrix from persisted evidence ONLY ----
    const now = Date.now();
    const startedAt = run.started_at ? new Date(run.started_at).getTime() : null;
    const runAgeMs = startedAt ? now - startedAt : null;
    const attempts = run.attempts ?? 1;
    const retryRequested = events.some((e) => e.event_type === "run.retry_requested");
    const isTimedOut = run.status === "timed_out";
    const isRunning = run.status === "running" || run.status === "claimed";
    const isSucceeded = run.status === "succeeded";

    // helper_online_detection: bound to THIS run's worker, not the global latest.
    const helperOnlineDetection: MatrixValue = !run.worker_id
      ? "PENDING"
      : helper?.online
        ? "PASS"
        : helper
          ? "FAIL"
          : "PENDING";

    // helper_offline_detection: PASS only if this run's Worker heartbeat aged
    // past threshold AND the run is timed_out with LEASE_EXPIRED.
    const helperOffAge = helper ? Date.now() - new Date(helper.last_seen_at).getTime() : null;
    const helperOfflineDetection: MatrixValue =
      isTimedOut && run.error_code === "LEASE_EXPIRED" &&
      helper && helperOffAge !== null && helperOffAge > HELPER_OFFLINE_THRESHOLD_MS
        ? "PASS"
        : isTimedOut && run.error_code !== "LEASE_EXPIRED"
          ? "FAIL"
          : "PENDING";

    // running_to_timed_out: PASS iff the run reached timed_out; FAIL iff it
    // has been running past ATTEMPT_HARD_LIMIT_MS without ever transitioning.
    const runningToTimedOut: MatrixValue = isTimedOut
      ? "PASS"
      : isRunning && runAgeMs !== null && runAgeMs > ATTEMPT_HARD_LIMIT_MS
        ? "FAIL"
        : "PENDING";

    // timed_out_to_retry: PASS iff a retry event exists AND attempts advanced
    // from 1 -> 2, AND attempt 1 evidence is preserved.
    const attempt1 = attempts_summary.find((g) => g.attempt === 1);
    const attempt2 = attempts_summary.find((g) => g.attempt === 2);
    const attempt1Preserved = !!attempt1 && attempt1.intents.length > 0;
    const timedOutToRetry: MatrixValue =
      retryRequested && attempts >= 2 && attempt1Preserved
        ? "PASS"
        : retryRequested && !attempt1Preserved
          ? "FAIL"
          : "PENDING";

    // retry_to_succeeded: PASS iff attempts>=2 AND succeeded AND final_output
    // present AND attempt-1 evidence still present.
    const retryToSucceeded: MatrixValue =
      attempts >= 2 && isSucceeded && !!run.final_output && attempt1Preserved
        ? "PASS"
        : attempts >= 2 && run.status === "failed"
          ? "FAIL"
          : "PENDING";

    // Static history from P0-R3.1 — never counted toward automatic PASS.
    const staticFromR31: MatrixValue = "VERIFIED_IN_P0_R3_1";

    const matrix: AcceptanceMatrix = {
      helper_online_detection: helperOnlineDetection,
      helper_offline_detection: helperOfflineDetection,
      running_to_timed_out: runningToTimedOut,
      timed_out_to_retry: timedOutToRetry,
      retry_to_succeeded: retryToSucceeded,
      stale_pid_protection: staticFromR31,
      dependency_bootstrap: staticFromR31,
      utf8_output: staticFromR31,
      fully_accepted: false,
    };
    matrix.fully_accepted =
      matrix.helper_online_detection === "PASS" &&
      matrix.helper_offline_detection === "PASS" &&
      matrix.running_to_timed_out === "PASS" &&
      matrix.timed_out_to_retry === "PASS" &&
      matrix.retry_to_succeeded === "PASS";

    return {
      run,
      events,
      helper,
      timeline: {
        queued_at: run.created_at,
        claimed_at: events.find((e) => e.event_type === "run.claimed")?.created_at ?? null,
        running_at: events.find((e) => e.event_type === "run.started")?.created_at ?? run.started_at ?? null,
        last_progress_at:
          events.filter((e) => !e.event_type.startsWith("run.retry")).slice(-1)[0]?.created_at ?? null,
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
      sweeper: {
        deployment: "supabase_pg_cron",
        job_name: "sentinel-sweep-stale-runs",
        schedule: "* * * * *",
        note: "在数据库内部每分钟运行；不依赖 Helper、浏览器窗口或 Owner 手动点击。",
      },
    };
  });

export const listStaleWorkers = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { MIN_HELPER_VERSION } = await import("./mcp/version");
    const [tokens, hbs] = await Promise.all([
      context.supabase
        .from("worker_tokens")
        .select("id,worker_id,label,revoked_at,last_used_at,created_at"),
      context.supabase
        .from("worker_heartbeats")
        .select("worker_id,version,last_seen_at"),
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
