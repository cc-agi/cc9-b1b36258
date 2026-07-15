import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, PlugZap, Unplug, Play, RefreshCw, Download, Trash2, Search, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  callCc6Tool,
  disconnectCc6,
  getCc6Status,
  installCc6Resource,
  listCc6Tools,
  listInstalledResources,
  searchCc6Resources,
  startCc6Connect,
  syncInstalledResources,
  uninstallResource,
  type Cc6Resource,
  type Cc6ToolInfo,
  type InstalledResource,
} from "@/lib/mcp/cc6.functions";



export function Cc6Panel() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getCc6Status);
  const startFn = useServerFn(startCc6Connect);
  const disconnectFn = useServerFn(disconnectCc6);
  const listFn = useServerFn(listCc6Tools);
  const callFn = useServerFn(callCc6Tool);

  const status = useQuery({
    queryKey: ["cc6-status"],
    queryFn: () => statusFn(),
    staleTime: 10_000,
  });

  const tools = useQuery({
    queryKey: ["cc6-tools"],
    queryFn: () => listFn(),
    enabled: !!status.data?.connected,
  });

  // Listen for the callback popup postMessage.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data && typeof e.data === "object" && (e.data as { type?: string }).type === "cc6-connected") {
        qc.invalidateQueries({ queryKey: ["cc6-status"] });
        qc.invalidateQueries({ queryKey: ["cc6-tools"] });
        toast.success("cc6 已连接");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [qc]);

  const connect = useMutation({
    mutationFn: async () => startFn({ data: { origin: window.location.origin } }),
    onSuccess: (res) => {
      const w = window.open(res.authorizeUrl, "cc6-oauth", "width=520,height=680,noopener=no");
      if (!w) toast.error("弹窗被拦截,请允许弹窗后重试");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const disconnect = useMutation({
    mutationFn: async () => disconnectFn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cc6-status"] });
      qc.removeQueries({ queryKey: ["cc6-tools"] });
      toast.success("已断开 cc6");
    },
  });

  return (
    <section>
      <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-2">
        cc6 连接
      </div>
      <div className="rounded-md border border-border bg-surface-1 p-3">
        {status.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载连接状态…
          </div>
        ) : status.data?.connected ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-signal/15 text-signal border border-signal/30">
              已连接
            </span>
            <span className="text-xs text-muted-foreground">
              最近更新 {status.data.updated_at ? new Date(status.data.updated_at).toLocaleString() : "—"}
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Unplug className="w-3 h-3 mr-1" />}
              断开
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground flex-1">
              点击授权后会打开 cc6 的登录页,授权完成后即可调用其工具。
            </span>
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {connect.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <PlugZap className="w-3 h-3 mr-1" />}
              连接 cc6
            </Button>
          </div>
        )}
      </div>

      {status.data?.connected && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest">
              可用工具
            </div>
            <button
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              title="刷新"
              onClick={() => qc.invalidateQueries({ queryKey: ["cc6-tools"] })}
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          {tools.isLoading ? (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> 拉取工具列表…
            </div>
          ) : !tools.data ? null : !tools.data.ok ? (
            <div className="text-xs text-destructive">{tools.data.error}</div>
          ) : tools.data.tools.length === 0 ? (
            <div className="text-xs text-muted-foreground">对方没有暴露任何工具。</div>
          ) : (
            <div className="max-h-80 overflow-y-auto pr-1 space-y-2">
              {tools.data.tools.map((t) => (
                <ToolRunner key={t.name} tool={t} call={callFn} />
              ))}
              <div className="text-[10px] text-muted-foreground text-center pt-1">
                共 {tools.data.tools.length} 个工具
              </div>
            </div>
          )}
        </div>
      )}

      {status.data?.connected && <BrowseAndInstall />}
      <InstalledList />
    </section>
  );
}

function BrowseAndInstall() {
  const qc = useQueryClient();
  const searchFn = useServerFn(searchCc6Resources);
  const installFn = useServerFn(installCc6Resource);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "mcp" | "plugin" | "skill">("all");

  const search = useMutation({
    mutationFn: async () => searchFn({ data: { query: query || undefined, kind } }),
  });

  const install = useMutation({
    mutationFn: async (r: Cc6Resource) => installFn({ data: r }),
    onSuccess: (_res, r) => {
      toast.success(`已安装 ${r.kind}:${r.name}`);
      qc.invalidateQueries({ queryKey: ["installed-resources"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const items = search.data?.ok ? search.data.items : [];

  return (
    <div className="mt-4">
      <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-2">
        从 cc6 导入 (MCP / 插件 / Skill)
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索关键词(可空)"
          className="h-8 text-xs"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="h-8 text-xs bg-surface-1 border border-border rounded px-2"
        >
          <option value="all">全部</option>
          <option value="mcp">MCP</option>
          <option value="plugin">插件</option>
          <option value="skill">Skill</option>
        </select>
        <Button size="sm" disabled={search.isPending} onClick={() => search.mutate()}>
          {search.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Search className="w-3 h-3 mr-1" />}
          搜索
        </Button>
      </div>
      {search.data && !search.data.ok && (
        <div className="text-xs text-destructive">{search.data.error}</div>
      )}
      {search.data?.ok && items.length === 0 && (
        <div className="text-xs text-muted-foreground">没有匹配的资源。</div>
      )}
      {items.length > 0 && (
        <div className="max-h-64 overflow-y-auto pr-1 space-y-1.5">
          {items.map((r) => (
            <div key={`${r.kind}:${r.id}`} className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2">
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/10 text-signal border border-signal/30 uppercase">
                {r.kind}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground truncate">{r.name}</div>
                {r.description && (
                  <div className="text-[11px] text-muted-foreground truncate">{r.description}</div>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={install.isPending}
                onClick={() => install.mutate(r)}
              >
                <Download className="w-3 h-3 mr-1" /> 安装
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InstalledList() {
  const qc = useQueryClient();
  const listFn = useServerFn(listInstalledResources);
  const removeFn = useServerFn(uninstallResource);
  const syncFn = useServerFn(syncInstalledResources);
  const installed = useQuery({
    queryKey: ["installed-resources"],
    queryFn: () => listFn(),
    staleTime: 5_000,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => removeFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installed-resources"] });
      toast.success("已卸载");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sync = useMutation({
    mutationFn: async (ids?: string[]) => syncFn({ data: { ids } }),
    onSuccess: (reports) => {
      qc.invalidateQueries({ queryKey: ["installed-resources"] });
      const updated = reports.filter((r) => r.status === "updated").length;
      const same = reports.filter((r) => r.status === "up-to-date").length;
      const missing = reports.filter((r) => r.status === "missing").length;
      const failed = reports.filter((r) => r.status === "error").length;
      toast.success(`同步完成:更新 ${updated} · 已最新 ${same} · 缺失 ${missing} · 失败 ${failed}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const rows: InstalledResource[] = installed.data ?? [];
  if (rows.length === 0 && !installed.isLoading) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest flex-1">
          已安装
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={sync.isPending || rows.length === 0}
          onClick={() => sync.mutate(undefined)}
        >
          {sync.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RotateCw className="w-3 h-3 mr-1" />}
          检查更新
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto pr-1 space-y-1.5">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2">
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/10 text-signal border border-signal/30 uppercase">
              {r.kind}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground truncate flex items-center gap-2">
                <span className="truncate">{r.name}</span>
                {r.version && (
                  <span className="text-[10px] font-mono text-muted-foreground shrink-0">v{r.version}</span>
                )}
              </div>
              {r.description && (
                <div className="text-[11px] text-muted-foreground truncate">{r.description}</div>
              )}
              {r.synced_at && (
                <div className="text-[10px] text-muted-foreground/70">
                  上次同步 {new Date(r.synced_at).toLocaleString()}
                </div>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={sync.isPending}
              onClick={() => sync.mutate([r.id])}
              title="同步此项"
            >
              <RotateCw className="w-3 h-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(r.id)}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}


function ToolRunner({
  tool,
  call,
}: {
  tool: Cc6ToolInfo;
  call: ReturnType<typeof useServerFn<typeof callCc6Tool>>;
}) {
  const [argsJson, setArgsJson] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const properties = useMemo(() => {
    try {
      const s = JSON.parse(tool.inputSchema) as { properties?: Record<string, unknown> };
      return s?.properties && typeof s.properties === "object" ? Object.keys(s.properties) : [];
    } catch {
      return [];
    }
  }, [tool.inputSchema]);

  const run = useMutation({
    mutationFn: async () => {
      let args: Record<string, unknown> = {};
      try {
        args = argsJson.trim() ? JSON.parse(argsJson) : {};
      } catch {
        throw new Error("参数不是合法的 JSON");
      }
      return call({ data: { name: tool.name, args } });
    },
    onSuccess: (res) => {
      if (res.ok) {
        setResult(res.result);
        setError(null);
      } else {
        setError(res.error);
        setResult(null);
      }
    },
    onError: (e) => {
      setError((e as Error).message);
      setResult(null);
    },
  });

  return (
    <div className="rounded-md border border-border bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-sm font-mono text-foreground">{tool.name}</span>
        {tool.description && (
          <span className="text-xs text-muted-foreground truncate flex-1">{tool.description}</span>
        )}
        <span className="text-[10px] text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="p-3 border-t border-border space-y-2">
          {properties.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              字段:{properties.join(", ")}
            </div>
          )}
          <Input
            value={argsJson}
            onChange={(e) => setArgsJson(e.target.value)}
            placeholder='{"query": "..."}'
            className="font-mono text-xs h-8"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
              调用
            </Button>
          </div>
          {error && <pre className="text-xs text-destructive whitespace-pre-wrap">{error}</pre>}
          {result && (
            <pre className="text-xs text-foreground/90 bg-black/30 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
              {tryPretty(result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function tryPretty(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
