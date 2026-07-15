import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listMcpConnections,
  createMcpConnection,
  deleteMcpConnection,
  testMcpConnection,
} from "@/lib/mcp.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Send,
  Square,
  LogOut,
  Server,
  Sparkles,
  Wrench,
  MessageSquare,
  Zap,
  CheckCircle2,
  XCircle,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/console")({
  head: () => ({
    meta: [{ title: "控制台 · Sentinel OS" }],
  }),
  component: ConsolePage,
});

function ConsolePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const listFn = useServerFn(listMcpConnections);
  const createFn = useServerFn(createMcpConnection);
  const deleteFn = useServerFn(deleteMcpConnection);
  const testFn = useServerFn(testMcpConnection);

  const { data: connections = [] } = useQuery({
    queryKey: ["mcp_connections"],
    queryFn: () => listFn(),
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Auto-select all ready connections on load
    setSelectedIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(connections.map((c) => c.id));
    });
  }, [connections]);

  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setToken(s?.access_token ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: "/api/agent",
      headers: (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
      body: () => ({ connectionIds: Array.from(selectedIds) }),
    });
  }, [token, selectedIds]);

  const { messages, sendMessage, status, stop, setMessages } = useChat({
    transport,
    onError: (err) => toast.error(err.message ?? "Agent 错误"),
  });

  const [input, setInput] = useState("");
  const isLoading = status === "submitted" || status === "streaming";
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!isLoading) inputRef.current?.focus();
  }, [isLoading]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    if (!token) {
      toast.error("会话已过期，请重新登录");
      return;
    }
    await sendMessage({ text });
  }

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["mcp_connections"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <header className="h-14 border-b border-border flex items-center justify-between px-6 shrink-0 bg-surface-1/60 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className={`signal-dot ${isLoading ? "animate-pulse-signal" : ""}`} />
          <span className="font-mono text-xs tracking-[0.25em] uppercase text-muted-foreground">
            Sentinel OS · Console
          </span>
          <span className="ml-4 text-xs font-mono text-signal">
            {isLoading ? "AGENT RUNNING" : "READY"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="w-4 h-4 mr-1.5" /> 退出
          </Button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[320px_1fr] overflow-hidden">
        {/* Sidebar — MCP servers */}
        <aside className="border-r border-border overflow-y-auto bg-surface-1/30">
          <div className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-signal" />
              <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                MCP Servers
              </span>
            </div>
            <AddConnectionDialog
              onCreated={() => qc.invalidateQueries({ queryKey: ["mcp_connections"] })}
              createFn={createFn}
            />
          </div>

          <div className="px-4 pb-6 space-y-2">
            {connections.length === 0 ? (
              <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded p-4">
                还没有连接。<br />添加你的第一个 MCP 服务器。
              </div>
            ) : (
              connections.map((c) => {
                const selected = selectedIds.has(c.id);
                return (
                  <div
                    key={c.id}
                    className={`panel p-3 cursor-pointer transition-all ${
                      selected ? "border-signal/60 shadow-signal" : "hover:border-border/80"
                    }`}
                    onClick={() =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{c.name}</div>
                        <div className="text-[10px] font-mono text-muted-foreground truncate mt-0.5">
                          {c.url}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {c.transport}
                          </span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              c.state === "ready"
                                ? "bg-signal/15 text-signal"
                                : "bg-warn/15 text-warn"
                            }`}
                          >
                            {c.state}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`删除 ${c.name}？`)) deleteMut.mutate(c.id);
                        }}
                        className="text-muted-foreground hover:text-destructive transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="px-4 pb-4 text-[10px] font-mono text-muted-foreground border-t border-border pt-4">
            {selectedIds.size} / {connections.length} 已激活
          </div>
        </aside>

        {/* Main — Agent timeline */}
        <main className="flex flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 ? (
              <div className="max-w-xl mx-auto text-center py-16">
                <div className="inline-flex p-3 rounded-full bg-signal/10 mb-4">
                  <Sparkles className="w-6 h-6 text-signal" />
                </div>
                <h2 className="text-2xl font-semibold">下达任务</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  给 Sentinel 一个目标 —— 它会自主思考、调用工具、纠错，直到完成。
                </p>
                <div className="mt-6 grid gap-2 text-left">
                  {[
                    "打开 example.com 并总结页面主要内容",
                    "帮我检查最近 3 条 GitHub issue 并写摘要",
                    "登录我的 Linear 抓出所有 In Progress 的任务",
                  ].map((s) => (
                    <button
                      key={s}
                      onClick={() => setInput(s)}
                      className="text-left text-sm text-muted-foreground hover:text-foreground border border-border rounded px-3 py-2 hover:border-signal/50 transition"
                    >
                      → {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m) => <MessageBlock key={m.id} message={m} />)
            )}
            {isLoading && (
              <div className="flex items-center gap-2 text-xs font-mono text-signal">
                <span className="signal-dot animate-pulse-signal" />
                {status === "submitted" ? "AGENT.THINKING…" : "AGENT.STREAMING…"}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-border p-4 bg-surface-1/40">
            <div className="max-w-3xl mx-auto flex gap-2 items-end">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="给 Sentinel 下达指令…  (Shift+Enter 换行)"
                rows={2}
                className="resize-none font-mono text-sm"
                disabled={isLoading}
              />
              {isLoading ? (
                <Button size="lg" variant="destructive" onClick={() => stop()} className="h-[68px]">
                  <Square className="w-4 h-4" />
                </Button>
              ) : (
                <Button size="lg" onClick={handleSend} disabled={!input.trim()} className="h-[68px]">
                  <Send className="w-4 h-4" />
                </Button>
              )}
            </div>
            {messages.length > 0 && !isLoading && (
              <div className="max-w-3xl mx-auto mt-2 flex justify-end">
                <button
                  onClick={() => setMessages([])}
                  className="text-[10px] font-mono uppercase text-muted-foreground hover:text-foreground"
                >
                  清空对话
                </button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

type UIMsg = ReturnType<typeof useChat>["messages"][number];

function MessageBlock({ message }: { message: UIMsg }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg border ${
          isUser ? "bg-primary/10 border-primary/30" : "bg-surface-1 border-border"
        } p-4 space-y-3`}
      >
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          {isUser ? (
            <>
              <MessageSquare className="w-3 h-3" /> Operator
            </>
          ) : (
            <>
              <Sparkles className="w-3 h-3 text-signal" /> Sentinel
            </>
          )}
        </div>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div key={i} className="text-sm whitespace-pre-wrap leading-relaxed">
                {part.text}
              </div>
            );
          }
          if (part.type === "reasoning") {
            return (
              <details key={i} className="text-xs text-muted-foreground border-l-2 border-accent/50 pl-3">
                <summary className="cursor-pointer font-mono uppercase tracking-widest">
                  思考过程
                </summary>
                <div className="mt-1 whitespace-pre-wrap">{part.text}</div>
              </details>
            );
          }
          if (part.type?.startsWith("tool-")) {
            const toolName = part.type.replace(/^tool-/, "");
            const p = part as unknown as {
              state?: string;
              input?: unknown;
              output?: unknown;
              errorText?: string;
            };
            return (
              <div key={i} className="border border-border rounded bg-background/60 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border-b border-border text-xs font-mono">
                  <Wrench className="w-3 h-3 text-signal" />
                  <span className="text-signal">{toolName}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground uppercase">
                    {p.state ?? "…"}
                  </span>
                </div>
                {p.input !== undefined && (
                  <pre className="p-3 text-[11px] font-mono text-muted-foreground overflow-x-auto border-b border-border/50">
                    {JSON.stringify(p.input, null, 2)}
                  </pre>
                )}
                {p.errorText && (
                  <div className="p-3 text-[11px] font-mono text-destructive">
                    {p.errorText}
                  </div>
                )}
                {p.output !== undefined && (
                  <pre className="p-3 text-[11px] font-mono text-foreground/80 overflow-x-auto max-h-64">
                    {typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2)}
                  </pre>
                )}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function AddConnectionDialog({
  onCreated,
  createFn,
}: {
  onCreated: () => void;
  createFn: (args: { data: unknown }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [authType, setAuthType] = useState<"none" | "bearer">("none");
  const [authToken, setAuthToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await createFn({ data: { name, url, transport, auth_type: authType, auth_token: authToken } });
      toast.success("已添加 MCP 服务器");
      setOpen(false);
      setName("");
      setUrl("");
      setAuthToken("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 w-7 p-0">
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>接入 MCP 服务器</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="text-muted-foreground self-center">预设:</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              onClick={() => {
                setName("Browserbase");
                setUrl("https://mcp.browserbase.com/mcp?browserbaseApiKey=<YOUR_BROWSERBASE_API_KEY>");
                setTransport("http");
                setAuthType("none");
              }}
            >
              Browserbase (托管)
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 text-xs"
              onClick={() => {
                setName("Playwright (自建)");
                setUrl("http://127.0.0.1:8931/mcp");
                setTransport("http");
                setAuthType("none");
              }}
            >
              Playwright 自建
            </Button>
          </div>
          <div>
            <Label>名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Playwright" className="mt-1.5" />
          </div>
          <div>
            <Label>URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
              placeholder="https://your-mcp-server.example.com/mcp"
              className="mt-1.5 font-mono text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Browserbase: 把 URL 里的 <code>&lt;YOUR_BROWSERBASE_API_KEY&gt;</code> 替换成你在
              <a href="https://www.browserbase.com/overview" target="_blank" rel="noreferrer" className="underline mx-1">Dashboard</a>
              获取的 API Key。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>传输</Label>
              <Select value={transport} onValueChange={(v) => setTransport(v as "http" | "sse")}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">Streamable HTTP</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>认证</Label>
              <Select value={authType} onValueChange={(v) => setAuthType(v as "none" | "bearer")}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">无</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {authType === "bearer" && (
            <div>
              <Label>Token</Label>
              <Input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                required
                className="mt-1.5 font-mono"
              />
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? "连接中…" : "接入"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
