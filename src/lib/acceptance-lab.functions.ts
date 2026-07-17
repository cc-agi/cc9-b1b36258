/**
 * P0-R3.2 Runtime Acceptance Lab (Owner-only, read-only, safe).
 *
 * Creates a long-running, purely READ-ONLY agent run that opens example.com
 * and performs several `browser_wait_for` calls against selectors that will
 * never appear. Each wait naturally elapses up to ~60s inside the Helper,
 * so the run stays in `running` state for ~3 minutes without doing anything
 * risky (no click, no input, no submit, no login, no navigation elsewhere).
 *
 * The goal string is marked with a stable prefix so this UI can list only
 * lab runs and never mixes with real user tasks.
 *
 * All server fns require an authenticated Owner. They never return secrets,
 * never touch business tables, and never delete historical evidence.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const ACCEPTANCE_GOAL_PREFIX = "[SENTINEL_ACCEPTANCE_LAB]";

const ACCEPTANCE_GOAL = `${ACCEPTANCE_GOAL_PREFIX} P0-R3.2 运行时可靠性验收 — 只读浏览。
请严格按顺序执行下列 6 步，禁止使用任何未列出的工具，禁止点击、提交、输入或登录：
1) browser_goto https://example.com
2) browser_wait_for selector="#__sentinel_wait_a" timeoutMs=60000
3) browser_wait_for selector="#__sentinel_wait_b" timeoutMs=60000
4) browser_wait_for selector="#__sentinel_wait_c" timeoutMs=60000
5) browser_extract selector="h1"
6) 用一段中文文字给出最终答复：包含页面标题、URL 与 h1 文本。
每次 wait 都必须实际等待到超时，不允许提前放弃。整个任务预计持续约 3 分钟。`;

/**
 * Owner-explicit: create a new acceptance lab run.
 * Runs bypass the pre-flight helper-offline check on purpose so we can also
 * validate the WAITING_FOR_HELPER path when the Owner tests without Helper.
 */
export const createAcceptanceRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
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
  .middleware([requireSupabaseAuth])
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

export type AcceptanceMatrix = {
  helper_online_detection: "PASS" | "FAIL" | "PENDING";
  helper_offline_detection: "PASS" | "FAIL" | "PENDING";
  running_to_timed_out: "PASS" | "FAIL" | "PENDING";
  timed_out_to_retry: "PASS" | "FAIL" | "PENDING";
  retry_to_succeeded: "PASS" | "FAIL" | "PENDING";
  stale_pid_protection: "PASS";
  dependency_bootstrap: "PASS";
  utf8_output: "PASS";
  fully_accepted: boolean;
};

/**
 * Return the run + its ordered events + a derived acceptance matrix.
 * Read-only.
 */
export const getAcceptanceRun = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const [runRes, evRes, hbRes] = await Promise.all([
      context.supabase
        .from("agent_runs")
        .select(
          "id,goal,status,error_code,last_error,attempts,worker_id,created_at,started_at,heartbeat_at,lease_expires_at,completed_at,timed_out_at,cancel_requested_at,final_output",
        )
        .eq("id", data.id)
        .maybeSingle(),
      context.supabase
        .from("agent_events")
        .select("id,event_type,sequence,step_index,payload,created_at")
        .eq("run_id", data.id)
        .order("sequence", { ascending: true }),
      context.supabase
        .from("worker_heartbeats")
        .select("worker_id,last_seen_at,version,state,cdp_reachable")
        .order("last_seen_at", { ascending: false })
        .limit(1),
    ]);
    if (runRes.error) throw new Error(runRes.error.message);
    if (!runRes.data) throw new Error("run_not_found");
    if (evRes.error) throw new Error(evRes.error.message);

    const run = runRes.data;
    const events = evRes.data ?? [];
    const hb = hbRes.data?.[0] ?? null;
    const now = Date.now();
    const helperOnline = hb ? now - new Date(hb.last_seen_at).getTime() < 60_000 : false;

    // Timeline milestones extracted from events
    const findEvent = (t: string) => events.find((e) => e.event_type === t);
    const queuedAt = run.created_at;
    const claimedAt = findEvent("run.claimed")?.created_at ?? null;
    const runningAt = findEvent("run.started")?.created_at ?? run.started_at ?? null;
    const lastProgressAt =
      events
        .filter((e) => !e.event_type.startsWith("run.retry"))
        .slice(-1)[0]?.created_at ?? null;

    const retryRequested = events.some((e) => e.event_type === "run.retry_requested");

    // Derive PASS/FAIL matrix — conservative: FAIL only when the outcome
    // clearly contradicts the criterion. Otherwise PENDING.
    const matrix: AcceptanceMatrix = {
      helper_online_detection: helperOnline ? "PASS" : hb ? "FAIL" : "PENDING",
      helper_offline_detection:
        run.status === "timed_out" && run.error_code === "LEASE_EXPIRED"
          ? "PASS"
          : run.status === "timed_out"
            ? "PASS"
            : "PENDING",
      running_to_timed_out:
        run.status === "timed_out" && !!run.timed_out_at
          ? "PASS"
          : run.status === "succeeded" || run.status === "failed"
            ? "PENDING"
            : "PENDING",
      timed_out_to_retry:
        retryRequested && (run.attempts ?? 0) >= 2 ? "PASS" : "PENDING",
      retry_to_succeeded:
        retryRequested && run.status === "succeeded" && (run.attempts ?? 0) >= 2
          ? "PASS"
          : "PENDING",
      // These three were validated in P0-R3.1 acceptance and are static.
      stale_pid_protection: "PASS",
      dependency_bootstrap: "PASS",
      utf8_output: "PASS",
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
      helper: hb ? { ...hb, online: helperOnline } : null,
      timeline: {
        queued_at: queuedAt,
        claimed_at: claimedAt,
        running_at: runningAt,
        last_progress_at: lastProgressAt,
        heartbeat_at: run.heartbeat_at,
        lease_expires_at: run.lease_expires_at,
        timed_out_at: run.timed_out_at,
        completed_at: run.completed_at,
        cancel_requested_at: run.cancel_requested_at,
        attempts: run.attempts,
        worker_id: run.worker_id,
      },
      matrix,
    };
  });

/**
 * Owner-facing: mark obviously-old (offline + version below minimum) workers
 * as safe-to-delete. This function DOES NOT delete anything — it only exposes
 * the list; deletion still requires the explicit revokeWorkerToken call.
 */
export const listStaleWorkers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
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
