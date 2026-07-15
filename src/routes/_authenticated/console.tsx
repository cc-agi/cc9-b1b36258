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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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
  PenSquare,
  Clock,
  Puzzle,
  Globe,
  MessageCircle,
  PanelLeftClose,
  PanelLeft,
  Paperclip,
  FolderOpen,
  ShieldCheck,
  Mic,
  ChevronDown,
  Search,
  ScanText,
  Zap as ZapIcon,
  FileText,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/console")({
  head: () => ({
    meta: [{ title: "控制台 · Sentinel OS" }],
  }),
  component: ConsolePage,
});

const STARTER_PROMPTS = [
  { icon: Globe, color: "text-blue-400", title: "浏览网页", hint: "打开 example.com 并总结主要内容" },
  { icon: ScanText, color: "text-purple-400", title: "抓取分析", hint: "抓取 Hacker News 头条并按热度排序" },
  { icon: ZapIcon, color: "text-emerald-400", title: "自动化操作", hint: "登录我的 GitHub 检查最近 3 条 issue" },
  { icon: FileText, color: "text-orange-400", title: "汇总报告", hint: "整理今日新闻，生成日报" },
];

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
    setSelectedIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(connections.map((c) => c.id));
    });
  }, [connections]);

  const [token, setToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
      setUserEmail(data.session?.user.email ?? "");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setToken(s?.access_token ?? null);
      setUserEmail(s?.user.email ?? "");
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

  async function handleSend(text?: string) {
    const value = (text ?? input).trim();
    if (!value || isLoading) return;
    setInput("");
    if (!token) {
      toast.error("会话已过期，请重新登录");
      return;
    }
    await sendMessage({ text: value });
  }

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["mcp_connections"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  type TestResult =
    | { ok: true; handshakeMs: number; toolCount: number; tools: string[] }
    | { ok: false; handshakeMs: number; error: string };
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  async function handleTest(id: string, name: string) {
    setTestingId(id);
    try {
      const r = (await testFn({ data: { id } })) as TestResult;
      setTestResults((prev) => ({ ...prev, [id]: r }));
      if (r.ok) toast.success(`${name} · ${r.toolCount} 工具 · ${r.handshakeMs}ms`);
      else toast.error(`${name} 连接失败: ${r.error}`);
      qc.invalidateQueries({ queryKey: ["mcp_connections"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "测试失败";
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, handshakeMs: 0, error: message } }));
      toast.error(message);
    } finally {
      setTestingId(null);
    }
  }

  async function handleSignOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const [collapsed, setCollapsed] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

  const activeCount = selectedIds.size;

  return (
    <div className="h-screen w-full flex bg-background text-foreground select-none">
      {/* Sidebar */}
      <aside
        className={`${collapsed ? "w-14" : "w-64"} shrink-0 border-r border-border flex flex-col bg-surface-1/40 transition-[width] duration-200`}
      >
        {/* Brand + collapse */}
        <div className="h-14 px-3 flex items-center justify-between border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`signal-dot shrink-0 ${isLoading ? "animate-pulse-signal" : ""}`} />
            {!collapsed && (
              <span className="font-mono text-xs tracking-[0.2em] uppercase text-foreground truncate">
                Sentinel OS
              </span>
            )}
          </div>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-muted-foreground hover:text-foreground p-1 rounded transition"
            title={collapsed ? "展开" : "折叠"}
          >
            {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
          <NavItem
            collapsed={collapsed}
            icon={PenSquare}
            label="新建任务"
            active
            onClick={() => setMessages([])}
          />
          <NavItem collapsed={collapsed} icon={Clock} label="已安排" disabled />
          <NavItem
            collapsed={collapsed}
            icon={Puzzle}
            label="插件 (MCP)"
            badge={activeCount > 0 ? `${activeCount}` : undefined}
            onClick={() => setMcpOpen(true)}
          />
          <NavItem collapsed={collapsed} icon={Globe} label="站点" disabled />
          <NavItem collapsed={collapsed} icon={MessageCircle} label="聊天" disabled />

          {!collapsed && (
            <>
              <SectionLabel>项目</SectionLabel>
              <div className="px-3 text-xs text-muted-foreground/60 italic py-1">暂无项目</div>

              <SectionLabel>任务</SectionLabel>
              {messages.length === 0 ? (
                <div className="px-3 text-xs text-muted-foreground/60 italic py-1">
                  还没有任务
                </div>
              ) : (
                <div className="px-3 py-1.5 text-sm text-foreground/80 hover:bg-white/5 rounded-md cursor-pointer truncate">
                  当前会话 · {messages.length} 条
                </div>
              )}
            </>
          )}
        </nav>

        {/* Footer: user */}
        <div className="border-t border-border p-3">
          {collapsed ? (
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-center text-muted-foreground hover:text-destructive transition p-2 rounded-md hover:bg-white/5"
              title="退出"
            >
              <LogOut className="w-4 h-4" />
            </button>
          ) : (
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-signal/20 border border-signal/40 flex items-center justify-center text-xs font-bold text-signal shrink-0">
                {(userEmail[0] ?? "S").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-foreground truncate">
                  {userEmail || "Sentinel Operator"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {isLoading ? "运行中" : "就绪"}
                </div>
              </div>
              <button
                onClick={handleSignOut}
                className="text-muted-foreground hover:text-destructive p-1 rounded transition"
                title="退出"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col relative min-w-0">
        {messages.length === 0 ? (
          // Empty state
          <div className="flex-1 flex flex-col items-center justify-center px-6 pb-56">
            <div className="w-16 h-16 rounded-2xl border border-signal/25 bg-signal/5 flex items-center justify-center mb-6">
              <Sparkles className="w-7 h-7 text-signal" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight mb-2">我们该构建什么？</h1>
            <p className="text-sm text-muted-foreground mb-10">
              给 Sentinel 一个目标 —— 它会自主思考、调用工具、纠错，直到完成。
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-3xl">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p.title}
                  onClick={() => setInput(p.hint)}
                  className="p-4 rounded-xl bg-surface-1 border border-border hover:border-signal/40 hover:bg-surface-2 transition-all text-left group h-32 flex flex-col"
                >
                  <p.icon className={`w-5 h-5 mb-auto ${p.color} group-hover:scale-110 transition-transform`} />
                  <p className="text-sm font-medium text-foreground">{p.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{p.hint}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          // Message timeline
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pt-6 pb-56">
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((m) => (
                <MessageBlock key={m.id} message={m} />
              ))}
              {isLoading && (
                <div className="flex items-center gap-2 text-xs font-mono text-signal">
                  <span className="signal-dot animate-pulse-signal" />
                  {status === "submitted" ? "AGENT.THINKING…" : "AGENT.STREAMING…"}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Bottom composer */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-3rem)] max-w-3xl">
          <div className="bg-surface-2/95 rounded-2xl border border-border shadow-2xl backdrop-blur-xl overflow-hidden">
            {/* Top chips */}
            <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2">
              <button
                onClick={() => setMcpOpen(true)}
                className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 text-xs font-medium text-foreground/80 transition"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                插件 · {activeCount}/{connections.length}
              </button>
            </div>

            {/* Textarea */}
            <div className="px-4 py-3">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="随心输入，指令或目标..."
                rows={2}
                disabled={isLoading}
                className="w-full bg-transparent border-none resize-none focus:outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground text-sm min-h-[52px]"
              />
            </div>

            {/* Bottom actions */}
            <div className="px-3 py-2 flex items-center justify-between border-t border-border/60">
              <div className="flex items-center gap-1">
                <button
                  className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition"
                  title="附件（未开放）"
                  disabled
                >
                  <Paperclip className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-border/60">
                  <ShieldCheck className="w-3.5 h-3.5 text-signal" />
                  自动执行
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono hover:text-foreground transition px-1.5 py-1 rounded">
                  Sentinel-4o
                  <ChevronDown className="w-3 h-3" />
                </button>
                <button
                  className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition"
                  title="语音（未开放）"
                  disabled
                >
                  <Mic className="w-4 h-4" />
                </button>
                {isLoading ? (
                  <button
                    onClick={() => stop()}
                    className="w-8 h-8 rounded-lg bg-destructive text-destructive-foreground flex items-center justify-center hover:opacity-90 transition"
                    title="停止"
                  >
                    <Square className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => handleSend()}
                    disabled={!input.trim()}
                    className="w-8 h-8 rounded-lg bg-signal text-primary-foreground flex items-center justify-center hover:bg-signal-glow transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="发送"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {messages.length > 0 && !isLoading && (
            <div className="mt-2 flex justify-end">
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

      {/* MCP Sheet */}
      <Sheet open={mcpOpen} onOpenChange={setMcpOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <SheetHeader className="px-6 py-4 border-b border-border">
            <SheetTitle className="flex items-center gap-2">
              <Server className="w-4 h-4 text-signal" />
              MCP 插件
            </SheetTitle>
            <SheetDescription>
              选中的插件将作为工具提供给 Agent。已激活 {activeCount} / {connections.length}
            </SheetDescription>
          </SheetHeader>

          <div className="px-6 py-3 border-b border-border">
            <AddConnectionDialog
              onCreated={() => qc.invalidateQueries({ queryKey: ["mcp_connections"] })}
              createFn={createFn}
            />
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {connections.length === 0 ? (
              <div className="text-xs text-muted-foreground py-10 text-center border border-dashed border-border rounded p-4">
                还没有连接。<br />添加你的第一个 MCP 服务器。
              </div>
            ) : (
              connections.map((c) => {
                const selected = selectedIds.has(c.id);
                const result = testResults[c.id];
                return (
                  <div
                    key={c.id}
                    className={`p-3 rounded-lg border cursor-pointer transition ${
                      selected
                        ? "border-signal/60 bg-signal/5"
                        : "border-border bg-surface-1 hover:border-border/80"
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
                      <div className="flex flex-col items-end gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTest(c.id, c.name);
                          }}
                          disabled={testingId === c.id}
                          title="测试连接"
                          className="text-muted-foreground hover:text-signal transition disabled:opacity-50"
                        >
                          <Zap className={`w-3.5 h-3.5 ${testingId === c.id ? "animate-pulse text-signal" : ""}`} />
                        </button>
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
                    {result && (
                      <details
                        className={`mt-2 pt-2 border-t text-[10px] font-mono ${
                          result.ok ? "border-signal/30" : "border-destructive/40"
                        }`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <summary className="cursor-pointer list-none flex items-center gap-1.5 select-none">
                          {result.ok ? (
                            <>
                              <CheckCircle2 className="w-3 h-3 text-signal" />
                              <span className="text-signal">
                                握手 OK · {result.handshakeMs}ms
                                <span className="text-muted-foreground ml-1">
                                  · {result.toolCount} 工具
                                </span>
                              </span>
                            </>
                          ) : (
                            <>
                              <XCircle className="w-3 h-3 text-destructive" />
                              <span className="text-destructive">
                                失败 · {result.handshakeMs}ms
                              </span>
                            </>
                          )}
                          <span className="ml-auto text-muted-foreground text-[9px]">展开</span>
                        </summary>
                        <div className="mt-2 space-y-1">
                          {result.ok ? (
                            <>
                              <div className="text-muted-foreground">工具 ({result.toolCount}):</div>
                              <div className="text-foreground/70 break-all leading-relaxed">
                                {result.tools.slice(0, 6).join(", ")}
                                {result.toolCount > 6 && " …"}
                              </div>
                            </>
                          ) : (
                            <div className="text-destructive/80 break-all leading-relaxed">
                              {result.error}
                            </div>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  collapsed,
  active,
  disabled,
  badge,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  collapsed: boolean;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={collapsed ? label : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
        active
          ? "bg-white/5 text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5"
      } ${disabled ? "opacity-40 cursor-not-allowed hover:bg-transparent" : ""} ${
        collapsed ? "justify-center px-0" : ""
      }`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="truncate">{label}</span>
          {badge && (
            <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/15 text-signal">
              {badge}
            </span>
          )}
        </>
      )}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 mt-6 mb-1 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
      {children}
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
        <Button size="sm" variant="outline" className="w-full">
          <Plus className="w-3.5 h-3.5 mr-1.5" /> 接入新的 MCP 服务器
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
