import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Plug,
  RefreshCw,
  Trash2,
  ShieldAlert,
  Zap,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { testMcpConnection } from "@/lib/mcp/test-connection.functions";

type TestResult = Awaited<ReturnType<typeof testMcpConnection>>;

type Grant = {
  client: {
    id: string;
    name: string;
    uri?: string;
    logo_uri?: string;
  };
  scopes: string[];
  granted_at: string;
};

type ConfirmState = { clientId: string; name: string } | null;

export function McpConnectionsPanel() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const runTest = useServerFn(testMcpConnection);

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    try {
      const result = await runTest();
      setTestResult(result);
    } catch (e) {
      setTestError(e instanceof Error ? e.message : String(e));
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // supabase.auth.oauth is beta; typed via a local shim.
      const api = (
        supabase.auth as unknown as {
          oauth: {
            listGrants: () => Promise<{ data: Grant[] | null; error: { message: string } | null }>;
            revokeGrant: (o: {
              clientId: string;
            }) => Promise<{ error: { message: string } | null }>;
          };
        }
      ).oauth;
      const { data, error: err } = await api.listGrants();
      if (err) throw new Error(err.message);
      setGrants(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(clientId: string, name: string) {
    setRevokingId(clientId);
    setError(null);
    try {
      const api = (
        supabase.auth as unknown as {
          oauth: {
            revokeGrant: (o: {
              clientId: string;
            }) => Promise<{ error: { message: string } | null }>;
          };
        }
      ).oauth;
      const { error: err } = await api.revokeGrant({ clientId });
      if (err) throw new Error(err.message);
      setGrants((prev) => (prev ?? []).filter((g) => g.client.id !== clientId));
      setNotice(`已撤销 ${name} 的授权，其访问令牌已失效。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingId(null);
      setConfirm(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-muted-foreground leading-relaxed max-w-xl">
          这里列出所有通过 OAuth 授权访问 Sentinel OS MCP（
          <code className="text-foreground/80">/mcp</code>）的外部客户端， 例如
          ChatGPT、Claude、WorkBuddy。撤销后，该客户端的会话与刷新令牌会立即失效，
          需要重新走一次授权流程才能再次连接。
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-signal/40 bg-signal/10 hover:bg-signal/20 text-signal transition disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {loading ? "刷新中…" : "刷新列表"}
        </button>
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 transition disabled:opacity-50"
          title="以你本人身份实际调用 MCP 服务器，验证工具是否可用"
        >
          {testing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Zap className="w-3.5 h-3.5" />
          )}
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>

      {(testResult || testError) && (
        <div
          className={`text-xs rounded-md border p-3 space-y-2 ${
            testError || !testResult?.ok
              ? "border-destructive/40 bg-destructive/10"
              : "border-emerald-500/30 bg-emerald-500/10"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              {testError || !testResult?.ok ? (
                <>
                  <XCircle className="w-4 h-4 text-destructive" />
                  <span className="text-destructive">测试失败</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-emerald-300">MCP 服务器可用</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setTestResult(null);
                setTestError(null);
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              关闭
            </button>
          </div>
          {testError ? (
            <div className="text-destructive break-all">{testError}</div>
          ) : testResult ? (
            <div className="space-y-1.5 text-muted-foreground">
              <div>
                <span className="text-foreground">服务器</span>：{testResult.server.title} v
                {testResult.server.version}
                <span className="ml-2 text-[10px]">({testResult.elapsedMs} ms)</span>
              </div>
              <div>
                <span className="text-foreground">身份</span>：
                {testResult.user.email ?? testResult.user.id}
              </div>
              <div>
                <span className="text-foreground">数据库</span>：
                {testResult.dbCheck.ok
                  ? `可访问，已保存 ${testResult.dbCheck.mcpConnectionsCount} 个 MCP 连接`
                  : `失败 — ${testResult.dbCheck.error}`}
              </div>
              <div>
                <span className="text-foreground">工具</span>：共 {testResult.toolCount}{" "}
                个可供客户端调用
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-foreground/70 hover:text-foreground">
                  查看工具清单
                </summary>
                <ul className="mt-1.5 space-y-0.5 max-h-48 overflow-auto">
                  {testResult.tools.map((t) => (
                    <li key={t.name} className="flex items-start gap-1.5">
                      <code className="text-foreground/80 shrink-0">{t.name}</code>
                      {t.destructive && (
                        <span className="text-[9px] px-1 rounded bg-destructive/20 text-destructive shrink-0">
                          写
                        </span>
                      )}
                      {t.readOnly && (
                        <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300 shrink-0">
                          读
                        </span>
                      )}
                      <span className="text-muted-foreground truncate">{t.title}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <div className="text-[10px] text-muted-foreground/70 pt-1 border-t border-border/50">
                说明：本测试用你本人的登录会话直接调用 MCP 后端，验证工具清单与数据库可达性。
                已授权的 ChatGPT / Claude / WorkBuddy 通过 OAuth 走的是同一套工具与 RLS。
              </div>
            </div>
          ) : null}
        </div>
      )}

      {notice && (
        <div className="text-xs px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
          {notice}
        </div>
      )}
      {error && (
        <div className="text-xs px-3 py-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive flex items-start gap-2">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {loading && grants === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> 正在加载已授权的客户端…
        </div>
      ) : grants && grants.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-border rounded-lg">
          <Plug className="w-6 h-6 mx-auto text-muted-foreground/70" />
          <div className="mt-2 text-sm text-foreground">还没有已授权的 MCP 客户端</div>
          <div className="mt-1 text-xs text-muted-foreground">
            在 ChatGPT / Claude / WorkBuddy 中添加连接：
            <code className="ml-1 text-foreground/80">https://cc9.lovable.app/mcp</code>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {(grants ?? []).map((g) => {
            const isRevoking = revokingId === g.client.id;
            return (
              <div
                key={g.client.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1"
              >
                <div className="w-10 h-10 rounded-lg bg-signal/10 flex items-center justify-center shrink-0 overflow-hidden">
                  {g.client.logo_uri ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={g.client.logo_uri}
                      alt=""
                      className="w-10 h-10 object-cover"
                      onError={(e) => (e.currentTarget.style.display = "none")}
                    />
                  ) : (
                    <Plug className="w-5 h-5 text-signal" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground truncate">
                    {g.client.name || "未命名客户端"}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {g.client.uri || `client_id: ${g.client.id}`}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(g.scopes ?? []).map((s) => (
                      <span
                        key={s}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-border text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                    <span className="text-[10px] text-muted-foreground ml-1">
                      授权于 {formatDate(g.granted_at)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setConfirm({ clientId: g.client.id, name: g.client.name || "该客户端" })
                  }
                  disabled={isRevoking}
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-destructive/40 text-destructive hover:bg-destructive/10 transition disabled:opacity-50"
                >
                  {isRevoking ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  撤销并删除
                </button>
              </div>
            );
          })}
        </div>
      )}

      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirm(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-destructive text-sm font-medium">
              <ShieldAlert className="w-4 h-4" />
              撤销 {confirm.name} 的访问？
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              撤销后，{confirm.name} 将无法再以你的身份调用 Sentinel OS 的 MCP 工具。
              该客户端已有的访问令牌和刷新令牌会立即失效，若要再次连接需要重新走 OAuth 授权流程。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="px-2.5 py-1.5 rounded-md text-xs border border-border bg-surface-2 hover:bg-white/5 transition"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => revoke(confirm.clientId, confirm.name)}
                disabled={revokingId !== null}
                className="px-2.5 py-1.5 rounded-md text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90 transition disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {revokingId ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
