/**
 * P0-R3.2 Runtime Acceptance Lab UI (Owner-only).
 *
 * - "创建运行时断线测试" 按钮：新建一个长时只读 Run。
 * - 实时时间线：queued / claimed / running / last_progress / worker / lease /
 *   timed_out。
 * - Owner 指引：等待 running → 在 Windows 上执行 stop-sentinel.bat →
 *   等 2–3 分钟 → 观察 Run 自动进入 timed_out → 重启 Helper → 点「重试」→
 *   期待 succeeded。
 * - 自动验收矩阵：Helper online/offline detection、running→timed_out、
 *   timed_out→retry、retry→succeeded、stale PID protection、dependency
 *   bootstrap、UTF-8 output。全部通过后显示
 *   「SENTINEL RUNTIME RELIABILITY — FULLY ACCEPTED」。
 * - 完全只读；不删除任何历史 Run、事件、审计记录。
 */
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  Circle,
  FlaskConical,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  createAcceptanceRun,
  getAcceptanceRun,
  listAcceptanceRuns,
  type AcceptanceMatrix,
} from "@/lib/acceptance-lab.functions";
import { retryRun } from "@/lib/diagnostics.functions";
import { explainError } from "@/lib/error-catalog";

type MatrixKey = keyof AcceptanceMatrix;

const MATRIX_LABELS: Record<Exclude<MatrixKey, "fully_accepted">, string> = {
  helper_online_detection: "Helper online detection",
  helper_offline_detection: "Helper offline detection",
  running_to_timed_out: "running → timed_out",
  timed_out_to_retry: "timed_out → retry",
  retry_to_succeeded: "retry → succeeded",
  stale_pid_protection: "stale PID protection",
  dependency_bootstrap: "dependency bootstrap",
  utf8_output: "UTF-8 output",
};

const AUTO_REFRESH_MS = 3000;

export function AcceptanceLabPanel() {
  const qc = useQueryClient();
  const createFn = useServerFn(createAcceptanceRun);
  const listFn = useServerFn(listAcceptanceRuns);
  const getFn = useServerFn(getAcceptanceRun);
  const retryFn = useServerFn(retryRun);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const list = useQuery({
    queryKey: ["acceptance_runs"],
    queryFn: () => listFn(),
    refetchInterval: AUTO_REFRESH_MS,
  });

  // Default to newest run if none selected.
  useEffect(() => {
    if (!selectedId && list.data && list.data.length > 0) {
      setSelectedId(list.data[0].id);
    }
  }, [list.data, selectedId]);

  const detail = useQuery({
    queryKey: ["acceptance_run", selectedId],
    queryFn: () => (selectedId ? getFn({ data: { id: selectedId } }) : null),
    enabled: !!selectedId,
    refetchInterval: AUTO_REFRESH_MS,
  });

  // Track sync status for the header indicator.
  useEffect(() => {
    if (detail.isFetching) return;
    if (detail.isError) {
      setConsecutiveFailures((n) => n + 1);
    } else if (detail.dataUpdatedAt) {
      setLastSyncAt(detail.dataUpdatedAt);
      setConsecutiveFailures(0);
    }
  }, [detail.isFetching, detail.isError, detail.dataUpdatedAt]);

  const createMut = useMutation({
    mutationFn: () => createFn(),
    onSuccess: (r) => {
      toast.success("已创建运行时断线测试 Run（只读、无提交）");
      setSelectedId(r.id);
      qc.invalidateQueries({ queryKey: ["acceptance_runs"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "创建失败"),
  });

  const retryMut = useMutation({
    mutationFn: (id: string) => retryFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已请求重试；预期 timed_out → queued → running → succeeded");
      qc.invalidateQueries({ queryKey: ["acceptance_runs"] });
      qc.invalidateQueries({ queryKey: ["acceptance_run", selectedId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "重试失败"),
  });

  const [manualRefreshing, setManualRefreshing] = useState(false);
  const handleManualRefresh = async () => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    try {
      await Promise.all([list.refetch(), selectedId ? detail.refetch() : Promise.resolve()]);
      toast.success("已刷新", { description: `同步于 ${new Date().toLocaleTimeString()}` });
    } catch (e) {
      toast.error(e instanceof Error ? `刷新失败：${e.message}` : "刷新失败");
    } finally {
      setManualRefreshing(false);
    }
  };

  const d = detail.data ?? null;
  const run = d?.run ?? null;

  const runAgeSec = useMemo(() => {
    if (!run?.started_at) return null;
    return Math.floor((now - new Date(run.started_at).getTime()) / 1000);
  }, [run, now]);

  const syncStatus: "idle" | "fetching" | "error" =
    detail.isFetching || list.isFetching || manualRefreshing
      ? "fetching"
      : detail.isError || list.isError
        ? "error"
        : "idle";
  const lastSyncLabel = lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : "—";
  const refreshing = detail.isFetching || list.isFetching || manualRefreshing;

  return (
    <section className="p-4 rounded-lg border border-border bg-surface-1 space-y-3">
      <header className="flex items-center gap-2 flex-wrap">
        <FlaskConical className="w-4 h-4 text-signal" />
        <h3 className="text-sm font-semibold">运行时验收实验室 · Runtime Acceptance Lab</h3>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground uppercase">
          Owner-only · read-only
        </span>
      </header>

      {/* 自动刷新状态条 */}
      <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              syncStatus === "fetching"
                ? "bg-signal animate-pulse"
                : syncStatus === "error"
                  ? "bg-destructive"
                  : "bg-signal/60"
            }`}
          />
          自动刷新：开启（每 {AUTO_REFRESH_MS / 1000}s）
        </span>
        <span>· 状态：{syncStatus}</span>
        <span>· 最后同步：{lastSyncLabel}</span>
        {consecutiveFailures > 0 && (
          <span className="text-destructive">· 连续失败：{consecutiveFailures}</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        创建一个只读长时任务：打开 <span className="font-mono">example.com</span>， 然后连续做 3 次{" "}
        <span className="font-mono">acceptance_wait</span> 纯本地计时 （每次 60s，无网络请求、无 DOM
        交互），最后抽取 <span className="font-mono">h1</span>。 整个 Run 预计运行 3
        分钟以上，不会点击、输入、登录、提交或修改任何页面。 用它来验证 Helper 离线检测、running →
        timed_out 自动降级、以及 retry → succeeded。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-signal/15 hover:bg-signal/25 text-signal border border-signal/30 transition disabled:opacity-50"
        >
          {createMut.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FlaskConical className="w-3.5 h-3.5" />
          )}
          创建运行时断线测试
        </button>
        {list.data && list.data.length > 0 && (
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
            className="text-[11px] font-mono bg-surface-2 border border-border rounded-md px-2 py-1"
          >
            {list.data.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 8)} · {r.status} · attempts {r.attempts ?? 1}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={refreshing}
          className="ml-auto text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-surface-2 hover:bg-surface-3 text-muted-foreground hover:text-foreground transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {/* Owner 指引 */}
      <ol className="text-[11px] text-muted-foreground list-decimal pl-4 leading-relaxed space-y-0.5">
        <li>点击「创建运行时断线测试」，等待 Run 从 queued → claimed → running。</li>
        <li>
          在 Windows 上执行 <code className="font-mono">helper\stop-sentinel.bat</code>，
          <span className="text-warn"> 不要立即重启</span>。
        </li>
        <li>
          等待约 2–3 分钟；系统应自动把 Run 标记为 <code className="font-mono">timed_out</code>。
        </li>
        <li>
          在 Windows 重新执行 <code className="font-mono">helper\start-sentinel.bat</code>， 确认
          Helper 恢复在线。
        </li>
        <li>回到本页点击「重试」；期望流转 timed_out → queued → running → succeeded。</li>
      </ol>

      {/* 时间线 + 详情 */}
      {!selectedId ? (
        <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">
          还未创建测试 Run。
        </div>
      ) : !d ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
        </div>
      ) : (
        <>
          <div className="p-3 rounded-md border border-border bg-surface-2 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono">{run?.id.slice(0, 8)}</span>
              <StatusPill status={run?.status ?? "unknown"} />
              <span className="text-[10px] font-mono text-muted-foreground">
                attempts={run?.attempts ?? 1}
              </span>
              {runAgeSec !== null && run?.status === "running" && (
                <span className="text-[10px] font-mono text-muted-foreground">
                  · running {runAgeSec}s
                </span>
              )}
              {run?.status === "timed_out" && (
                <button
                  type="button"
                  onClick={() => retryMut.mutate(run.id)}
                  disabled={retryMut.isPending}
                  className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-warn/15 hover:bg-warn/25 text-warn border border-warn/30 transition disabled:opacity-50"
                >
                  {retryMut.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3 h-3" />
                  )}
                  重试
                </button>
              )}
            </div>
            <TimelineGrid t={d.timeline} />
            {run?.error_code && (
              <div className="mt-1 text-[11px] text-warn">
                <span className="font-mono">{run.error_code}</span> ·{" "}
                {explainError(run.error_code).title} — {explainError(run.error_code).action}
              </div>
            )}
            {run?.final_output && (
              <div className="mt-1 text-[11px] text-foreground/90">
                <span className="text-muted-foreground">final_output：</span>
                <span className="whitespace-pre-wrap">{run.final_output.slice(0, 400)}</span>
              </div>
            )}
          </div>

          {/* Events */}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              事件日志（{d.events.length}）
            </summary>
            <ul className="mt-2 space-y-0.5 max-h-56 overflow-y-auto pr-1">
              {d.events.map((e) => (
                <li key={e.id} className="flex gap-2 font-mono text-muted-foreground">
                  <span className="shrink-0 w-4 text-right">{e.sequence}</span>
                  <span className="shrink-0 text-foreground/80">{e.event_type}</span>
                  <span className="shrink-0">{new Date(e.created_at).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          </details>

          {/* 独立云端 sweeper 部署证据 + 最近执行历史 */}
          <div className="p-2 rounded-md border border-border bg-surface-2 text-[10px] font-mono text-muted-foreground space-y-1">
            <div>
              云端独立 sweeper：{d.sweeper.deployment} · job=
              <span className="text-foreground/80">{d.sweeper.job_name}</span> · cron=
              <span className="text-foreground/80">{d.sweeper.schedule}</span> · active=
              <span className={d.sweeper.active ? "text-signal" : "text-destructive"}>
                {String(d.sweeper.active)}
              </span>
            </div>
            <div className="text-[10px]">{d.sweeper.note}</div>
            {d.sweeper.error && (
              <div className="text-destructive">读取 cron 状态失败：{d.sweeper.error}</div>
            )}
            {d.sweeper.last_runs.length > 0 && (
              <details>
                <summary className="cursor-pointer hover:text-foreground">
                  最近 {d.sweeper.last_runs.length} 次执行（
                  <span className="text-signal">
                    {d.sweeper.last_runs.filter((r) => r.status === "succeeded").length} succ
                  </span>{" "}
                  /{" "}
                  <span className="text-destructive">
                    {d.sweeper.last_runs.filter((r) => r.status !== "succeeded").length} fail
                  </span>
                  ）
                </summary>
                <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto pr-1">
                  {d.sweeper.last_runs.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span
                        className={`shrink-0 ${r.status === "succeeded" ? "text-signal" : "text-destructive"}`}
                      >
                        {r.status}
                      </span>
                      <span className="shrink-0">
                        {new Date(r.start_time).toLocaleTimeString()}
                      </span>
                      {r.status !== "succeeded" && r.return_message && (
                        <span className="text-destructive/80 truncate" title={r.return_message}>
                          {r.return_message.split("\n")[0]}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/* Same Run Retry 证据分组 */}
          {d.attempts_summary.length > 1 && (
            <div className="p-2 rounded-md border border-warn/30 bg-warn/5">
              <div className="text-[11px] font-medium text-warn mb-1">
                Same Run Retry · attempt 1 证据保留，attempt 2 在同一 run_id 下追加
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {d.attempts_summary.map((g) => (
                  <div
                    key={g.attempt}
                    className="p-2 rounded border border-border bg-surface-2 text-[10px] font-mono"
                  >
                    <div className="mb-1 text-foreground/80">
                      attempt {g.attempt} · intents={g.intents.length} · results={g.results.length}
                    </div>
                    <ul className="space-y-0.5 max-h-32 overflow-y-auto">
                      {g.intents.map((it) => {
                        const r = g.results.find((x) => x.intent_id === it.id);
                        return (
                          <li key={it.id} className="text-muted-foreground truncate">
                            {it.sequence}. {it.tool_name}
                            {r
                              ? r.ok
                                ? " · ok"
                                : ` · fail(${r.error_code ?? "?"})`
                              : " · pending"}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 矩阵 */}
          <AcceptanceMatrixGrid matrix={d.matrix} />
        </>
      )}
    </section>
  );
}

function TimelineGrid({
  t,
}: {
  t: {
    created_at?: string | null;
    queued_at: string | null;
    claimed_at: string | null;
    running_at: string | null;
    last_progress_at: string | null;
    heartbeat_at: string | null;
    lease_expires_at: string | null;
    timed_out_at: string | null;
    completed_at: string | null;
    cancel_requested_at: string | null;
    attempts: number | null;
    worker_id: string | null;
  };
}) {
  const nowMs = Date.now();
  const leaseAt = t.lease_expires_at ? new Date(t.lease_expires_at).getTime() : null;
  const hbAt = t.heartbeat_at ? new Date(t.heartbeat_at).getTime() : null;
  const leaseInSec = leaseAt !== null ? Math.round((leaseAt - nowMs) / 1000) : null;
  const hbAgeSec = hbAt !== null ? Math.max(0, Math.round((nowMs - hbAt) / 1000)) : null;
  const rows: [string, string | null][] = [
    ["created_at (immutable)", t.created_at ?? null],
    ["queued_at (last requeue)", t.queued_at],

    ["claimed_at", t.claimed_at],
    ["running_at", t.running_at],
    ["last_progress_at", t.last_progress_at],
    ["heartbeat_at", t.heartbeat_at],
    ["heartbeat_age", hbAgeSec !== null ? `${hbAgeSec}s ago` : null],
    ["lease_expires_at", t.lease_expires_at],
    [
      "lease_in",
      leaseInSec !== null
        ? leaseInSec >= 0
          ? `${leaseInSec}s remaining`
          : `expired ${-leaseInSec}s ago`
        : null,
    ],
    ["timed_out_at", t.timed_out_at],
    ["completed_at", t.completed_at],
    ["cancel_requested_at", t.cancel_requested_at],
    ["worker_id", t.worker_id],
  ];
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <span className="text-muted-foreground">{k}:</span>
          <span className="text-foreground/85 truncate">{v ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

function AcceptanceMatrixGrid({ matrix }: { matrix: AcceptanceMatrix }) {
  return (
    <div className="p-3 rounded-md border border-border bg-surface-2 space-y-2">
      <div className="flex items-center gap-2">
        <Activity className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">自动验收结论</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-1.5 text-[11px]">
        {(Object.keys(MATRIX_LABELS) as (keyof typeof MATRIX_LABELS)[]).map((k) => {
          const v = matrix[k];
          const isPass = v === "PASS";
          const isFail = v === "FAIL";
          const isVerified = v === "VERIFIED_IN_P0_R3_1";
          return (
            <div key={k} className="flex items-center gap-2">
              {isPass || isVerified ? (
                <CheckCircle2
                  className={`w-3.5 h-3.5 shrink-0 ${isPass ? "text-signal" : "text-muted-foreground"}`}
                />
              ) : isFail ? (
                <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              )}
              <span className="text-foreground/90">{MATRIX_LABELS[k]}</span>
              <span
                className={`ml-auto font-mono text-[10px] ${
                  isPass ? "text-signal" : isFail ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {v}
              </span>
            </div>
          );
        })}
      </div>
      {matrix.fully_accepted ? (
        <div className="mt-1 p-2 rounded-md bg-signal/15 border border-signal/40 text-signal text-[11px] font-mono text-center">
          SENTINEL RUNTIME RELIABILITY — FULLY ACCEPTED
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground">
          尚有未通过项；按照上方步骤继续验收即可。VERIFIED_IN_P0_R3_1 是历史静态验收结论，
          不计入自动 FULLY ACCEPTED 判断。
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-signal/15 text-signal border-signal/30"
      : status === "running" || status === "claimed"
        ? "bg-signal/10 text-signal border-signal/20"
        : status === "timed_out" || status === "blocked" || status === "failed"
          ? "bg-warn/15 text-warn border-warn/30"
          : status === "cancelled"
            ? "bg-muted text-muted-foreground border-border"
            : "bg-surface-2 text-muted-foreground border-border";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`}
    >
      {status}
    </span>
  );
}
