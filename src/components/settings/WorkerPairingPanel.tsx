import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Terminal,
  CheckCircle2,
  XCircle,
  Circle,
} from "lucide-react";
import { toast } from "sonner";
import {
  generateWorkerPairingCode,
  listWorkersOverview,
  revokeWorkerToken,
  getReleaseReadiness,
} from "@/lib/worker-pairing.functions";

/**
 * 「电脑操控」→ Sentinel Helper 配对与发布准备状态面板。
 * - 只展示脱敏后的元数据；不会显示 Worker Token / API Key。
 * - 配对码 5 分钟倒计时后失效；一次性使用。
 */
export function WorkerPairingPanel() {
  const qc = useQueryClient();
  const genFn = useServerFn(generateWorkerPairingCode);
  const listFn = useServerFn(listWorkersOverview);
  const revokeFn = useServerFn(revokeWorkerToken);
  const readinessFn = useServerFn(getReleaseReadiness);

  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const workers = useQuery({
    queryKey: ["worker_overview"],
    queryFn: () => listFn(),
    refetchInterval: 10_000,
  });
  const readiness = useQuery({
    queryKey: ["release_readiness"],
    queryFn: () => readinessFn(),
    refetchInterval: 15_000,
  });

  const genMut = useMutation({
    mutationFn: () => genFn(),
    onSuccess: (r) => {
      setPairing(r);
      toast.success("配对码已生成，5 分钟内有效，只显示一次");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "生成失败"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Worker 已撤销");
      qc.invalidateQueries({ queryKey: ["worker_overview"] });
      qc.invalidateQueries({ queryKey: ["release_readiness"] });
      setConfirmRevoke(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "撤销失败"),
  });

  const remainSec = useMemo(() => {
    if (!pairing) return 0;
    return Math.max(0, Math.floor((new Date(pairing.expires_at).getTime() - now) / 1000));
  }, [pairing, now]);

  const codeExpired = pairing && remainSec <= 0;

  const minHelper = readiness.data?.versions.min_helper ?? "0.3.0";

  const installCmd = `powershell -ExecutionPolicy Bypass -File .\\helper\\install-helper.ps1`;
  const pairCmd = pairing
    ? `powershell -ExecutionPolicy Bypass -File .\\helper\\start-helper.ps1 -PairingCode ${pairing.code}`
    : `powershell -ExecutionPolicy Bypass -File .\\helper\\start-helper.ps1 -PairingCode <配对码>`;
  const statusCmd = `powershell -ExecutionPolicy Bypass -File .\\helper\\status-helper.ps1`;

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} 已复制`),
      () => toast.error("复制失败"),
    );
  }

  return (
    <div className="space-y-4">
      {/* ============ 配对码 ============ */}
      <section className="p-4 rounded-lg border border-border bg-surface-1 space-y-3">
        <header className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-signal" />
          <h3 className="text-sm font-semibold">Sentinel Helper 配对</h3>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground uppercase">
            要求 ≥ v{minHelper}
          </span>
        </header>
        <p className="text-xs text-muted-foreground leading-relaxed">
          在这台电脑生成一个一次性配对码，然后在 Windows PowerShell 里运行 Helper
          启动脚本并粘贴配对码。配对码 5 分钟内有效、只使用一次，服务器不会明文存储。
        </p>
        {!pairing || codeExpired ? (
          <button
            type="button"
            onClick={() => genMut.mutate()}
            disabled={genMut.isPending}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium bg-signal/15 hover:bg-signal/25 text-signal border border-signal/30 transition disabled:opacity-50"
          >
            {genMut.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {codeExpired ? "重新生成配对码" : "生成 Helper 配对码"}
          </button>
        ) : (
          <div className="flex items-center gap-3 p-3 rounded-md border border-signal/40 bg-signal/5">
            <div className="font-mono text-2xl tracking-[0.3em] text-signal select-all">
              {pairing.code}
            </div>
            <button
              type="button"
              onClick={() => copy(pairing.code, "配对码")}
              className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition"
              title="复制配对码"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <span className="ml-auto text-[11px] font-mono text-muted-foreground">
              {String(Math.floor(remainSec / 60)).padStart(2, "0")}:
              {String(remainSec % 60).padStart(2, "0")} 后失效
            </span>
          </div>
        )}
      </section>

      {/* ============ 已配对 Worker ============ */}
      <section className="p-4 rounded-lg border border-border bg-surface-1 space-y-3">
        <header className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">已配对 Worker</h3>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground">
            {workers.isFetching ? "刷新中…" : "每 10s 自动刷新"}
          </span>
        </header>

        {workers.isLoading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
          </div>
        ) : (workers.data ?? []).length === 0 ? (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-3">
            尚未配对任何 Worker。生成配对码，然后在这台电脑上启动 Helper。
          </div>
        ) : (
          <ul className="space-y-2">
            {(workers.data ?? []).map((w) => {
              const hb = w.heartbeat;
              const online =
                hb && Date.now() - new Date(hb.last_seen_at).getTime() < 60_000;
              const versionLow =
                hb?.version &&
                compareSemver(hb.version, minHelper) < 0;
              const revoked = Boolean(w.revoked_at);
              return (
                <li
                  key={w.id}
                  className={`p-3 rounded-md border ${
                    revoked
                      ? "border-border/50 bg-surface-2 opacity-60"
                      : online
                        ? "border-signal/30 bg-signal/5"
                        : "border-border bg-surface-2"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {w.label || w.worker_id}
                        </span>
                        <StatusBadge
                          online={!!online}
                          revoked={revoked}
                          state={hb?.state ?? null}
                        />
                        {versionLow && !revoked && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warn/15 text-warn border border-warn/30">
                            请升级到 ≥ v{minHelper}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono text-muted-foreground">
                        <div>worker_id: {w.worker_id}</div>
                        <div>version: {hb?.version ?? "—"}</div>
                        <div>platform: {hb?.platform ?? "—"}</div>
                        <div>
                          CDP:{" "}
                          {hb?.cdp_reachable === true
                            ? "可达"
                            : hb?.cdp_reachable === false
                              ? "不可达"
                              : "—"}
                        </div>
                        <div>
                          任务: {hb?.current_run_id ? hb.current_run_id.slice(0, 8) : "空闲"}
                        </div>
                        <div>
                          最后心跳:{" "}
                          {hb?.last_seen_at
                            ? formatRelative(hb.last_seen_at)
                            : w.last_used_at
                              ? formatRelative(w.last_used_at)
                              : "从未"}
                        </div>
                      </div>
                    </div>
                    {!revoked && (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmRevoke({ id: w.id, label: w.label || w.worker_id })
                        }
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
                        title="撤销该 Worker"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ============ Windows 命令 ============ */}
      <section className="p-4 rounded-lg border border-border bg-surface-1 space-y-3">
        <header className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Windows 安装与启动</h3>
        </header>
        <CommandRow label="安装 Helper" cmd={installCmd} onCopy={copy} />
        <CommandRow
          label={pairing ? "启动并配对（已嵌入配对码）" : "启动并配对"}
          cmd={pairCmd}
          onCopy={copy}
        />
        <CommandRow label="检查状态" cmd={statusCmd} onCopy={copy} />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          脚本位于项目根目录的 <code className="font-mono">helper/</code>
          文件夹。请以本机 Owner 身份运行；Helper 只在本地保存 Worker Token（受 ACL 保护），
          绝不保存 Supabase service_role 或数据库口令。
        </p>
      </section>

      {/* ============ 发布准备状态 ============ */}
      <ReleaseReadinessSection readiness={readiness} />

      {/* ============ 二次确认 ============ */}
      {confirmRevoke && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          onClick={() => setConfirmRevoke(null)}
        >
          <div
            className="max-w-sm w-[90%] p-5 rounded-lg border border-border bg-surface-1 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              <h4 className="text-sm font-semibold">撤销 Worker？</h4>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mb-4">
              撤销后 <span className="font-mono text-foreground">{confirmRevoke.label}</span>{" "}
              将立即无法认领任务。此操作不可撤销；如需继续使用请重新生成配对码并再次配对。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRevoke(null)}
                className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-white/5 transition"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => revokeMut.mutate(confirmRevoke.id)}
                disabled={revokeMut.isPending}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-destructive/90 hover:bg-destructive text-destructive-foreground transition disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {revokeMut.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommandRow({
  label,
  cmd,
  onCopy,
}: {
  label: string;
  cmd: string;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => onCopy(cmd, label)}
          className="text-[11px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition"
        >
          <Copy className="w-3 h-3" />
          复制
        </button>
      </div>
      <pre className="p-2 rounded-md bg-surface-2 border border-border text-[11px] font-mono text-foreground/90 overflow-x-auto whitespace-pre">
        {cmd}
      </pre>
    </div>
  );
}

function StatusBadge({
  online,
  revoked,
  state,
}: {
  online: boolean;
  revoked: boolean;
  state: string | null;
}) {
  if (revoked)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
        <XCircle className="w-3 h-3" /> 已撤销
      </span>
    );
  if (online)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/15 text-signal border border-signal/30">
        <CheckCircle2 className="w-3 h-3" /> 在线 {state ? `· ${state}` : ""}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-warn/15 text-warn border border-warn/30">
      <Circle className="w-3 h-3" /> 离线
    </span>
  );
}

function ReleaseReadinessSection({
  readiness,
}: {
  readiness: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getReleaseReadiness>>>>;
}) {
  const d = readiness.data;
  return (
    <section className="p-4 rounded-lg border border-border bg-surface-1 space-y-3">
      <header className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">发布准备状态</h3>
        <span className="ml-auto text-[10px] font-mono text-muted-foreground">
          DEPLOYED — AWAITING RUNTIME ACCEPTANCE
        </span>
      </header>
      {!d ? (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 检查中…
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-2 text-[11px]">
          <ReadinessRow ok={d.orchestrator.ready} label="Orchestrator" hint="已加载" />
          <ReadinessRow ok={d.worker_api.ready} label="Worker API" hint="/api/worker/v1/*" />
          <ReadinessRow ok label={`MCP 代码 v${d.versions.code}`} hint={`manifest v${d.versions.manifest}`} />
          <ReadinessRow ok label={`数据库 schema`} hint={d.versions.db_schema} />
          <ReadinessRow
            ok={d.helper.online === true ? true : d.helper.last_seen_at ? false : null}
            label="Helper 在线"
            hint={
              d.helper.online
                ? `v${d.helper.version ?? "?"} · CDP ${d.helper.cdp_reachable ? "可达" : "不可达"}`
                : `等待 Helper 上线 · 要求 ≥ v${d.versions.min_helper}`
            }
          />
          <ReadinessRow
            ok={d.helper.version ? d.helper.version_ok !== false : null}
            label="Helper 版本"
            hint={
              d.helper.version
                ? d.helper.version_ok
                  ? `v${d.helper.version} ≥ v${d.versions.min_helper}`
                  : `v${d.helper.version} < v${d.versions.min_helper} — 请升级`
                : `等待 Helper 上线 · 要求 ≥ v${d.versions.min_helper}`
            }
          />
          <ReadinessRow
            ok={d.secrets.MCP_TOKEN_ENC_KEY}
            label="Secret · MCP_TOKEN_ENC_KEY"
            hint={d.secrets.MCP_TOKEN_ENC_KEY ? "已配置" : "缺失 — 加密无法工作"}
          />
          <ReadinessRow
            ok={d.secrets.LOVABLE_API_KEY}
            label="Secret · LOVABLE_API_KEY"
            hint={d.secrets.LOVABLE_API_KEY ? "已配置" : "缺失"}
          />
          <ReadinessRow
            ok={d.browserbase.rotation_pending_count === 0}
            label="Browserbase 凭据"
            hint={
              d.browserbase.rotation_pending_count === 0
                ? "无待轮换连接"
                : `${d.browserbase.rotation_pending_count} 个连接待重新输入凭据`
            }
          />
        </div>
      )}
      {d && d.browserbase.rotation_pending_count > 0 && (
        <div className="mt-2 p-2 rounded-md border border-warn/40 bg-warn/5 text-[11px] text-warn">
          待轮换连接：
          {d.browserbase.connections.map((c) => c.name).join("、")} —
          请在「MCP 连接」中点击 <span className="font-mono">Rotate credential</span> 重新输入。
        </div>
      )}
    </section>
  );
}

function ReadinessRow({ ok, label, hint }: { ok: boolean | null; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-md bg-surface-2 border border-border">
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-signal shrink-0 mt-0.5" />
      ) : ok === false ? (
        <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
      ) : (
        <Circle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground truncate">{label}</div>
        <div className="text-[10px] text-muted-foreground truncate">{hint}</div>
      </div>
    </div>
  );
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s 前`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h 前`;
  return new Date(iso).toLocaleString();
}
