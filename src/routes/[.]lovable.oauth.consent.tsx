import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

// Beta namespace not yet in the SDK's public types — narrow local wrapper.
type OAuthDetails = {
  client?: { name?: string; client_uri?: string; redirect_uri?: string };
  scope?: string;
  redirect_url?: string;
  redirect_to?: string;
};
type OAuthResp<T> = { data: T | null; error: { message: string } | null };
type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<OAuthResp<OAuthDetails>>;
  approveAuthorization: (id: string) => Promise<OAuthResp<OAuthDetails>>;
  denyAuthorization: (id: string) => Promise<OAuthResp<OAuthDetails>>;
};
const oauthApi = () =>
  (supabase.auth as unknown as { oauth: OAuthApi }).oauth;

export const Route = createFileRoute("/.lovable/oauth/consent")({
  // Browser-only: session lives in localStorage; SSR would 401 signed-in users.
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id:
      typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const next = location.pathname + location.searchStr;
      throw redirect({ to: "/auth", search: { next } });
    }
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get(
      "authorization_id",
    )!;
    const { data, error } = await oauthApi().getAuthorizationDetails(
      authorizationId,
    );
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: ConsentPage,
  errorComponent: ({ error }) => (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md panel p-6 text-sm">
        <div className="font-medium text-destructive mb-2">
          无法加载此授权请求
        </div>
        <div className="text-muted-foreground">
          {String((error as Error)?.message ?? error)}
        </div>
      </div>
    </main>
  ),
});

function ConsentPage() {
  const details = Route.useLoaderData();
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function decide(approve: boolean) {
    setBusy(true);
    setErr(null);
    const { data, error } = approve
      ? await oauthApi().approveAuthorization(authorization_id)
      : await oauthApi().denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setErr(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      setBusy(false);
      setErr("授权服务器未返回跳转地址");
      return;
    }
    window.location.href = target;
  }

  const clientName = details?.client?.name ?? "外部应用";
  const scopes = (details?.scope ?? "").split(/\s+/).filter(Boolean);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md panel p-8 space-y-5">
        <div className="flex items-center gap-3">
          <span className="signal-dot animate-pulse-signal" />
          <span className="font-mono text-xs tracking-[0.3em] text-muted-foreground uppercase">
            Sentinel OS · OAuth 授权
          </span>
        </div>
        <div>
          <h1 className="text-2xl font-semibold">
            将 {clientName} 连接到你的 Sentinel OS 账号
          </h1>
          <p className="text-sm text-muted-foreground mt-2">
            允许后，{clientName} 可以以你的身份调用 Sentinel OS 的 MCP 工具，
            读取和创建你的 Agent 任务、MCP 连接与已导入资源。
          </p>
        </div>

        {details?.client?.redirect_uri && (
          <div className="text-xs text-muted-foreground font-mono break-all rounded border border-border bg-surface-1 p-2">
            回调地址：{details.client.redirect_uri}
          </div>
        )}

        {scopes.length > 0 && (
          <div className="text-xs space-y-1">
            <div className="text-muted-foreground">请求的权限：</div>
            <ul className="list-disc list-inside">
              {scopes.map((s: string) => (
                <li key={s} className="font-mono">{s}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="text-[11px] text-muted-foreground border-t border-border pt-3">
          该授权不会绕过 Sentinel OS 的行级安全策略；
          {clientName} 仅能访问你自己的数据。
        </div>

        {err && (
          <div role="alert" className="text-xs text-destructive">
            {err}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            type="button"
            className="flex-1 h-11"
            disabled={busy}
            onClick={() => decide(true)}
          >
            批准并连接
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1 h-11"
            disabled={busy}
            onClick={() => decide(false)}
          >
            拒绝
          </Button>
        </div>
      </div>
    </main>
  );
}
