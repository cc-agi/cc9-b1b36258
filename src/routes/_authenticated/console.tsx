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
import { listExternalModels } from "@/lib/models.functions";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
  Monitor,
  Lightbulb,
  Box,
  UserCog,
  Database,
  Shield,


  ScanText,
  FileText,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/console")({
  head: () => ({
    meta: [{ title: "控制台 · Sentinel OS" }],
  }),
  component: ConsolePage,
});

type Mode = "task" | "chat";

const STARTER_PROMPTS: Record<Mode, Array<{ icon: typeof Globe; color: string; title: string; hint: string }>> = {
  task: [
    { icon: Globe, color: "text-blue-400", title: "浏览网页", hint: "打开 example.com 并总结主要内容" },
    { icon: ScanText, color: "text-purple-400", title: "抓取分析", hint: "抓取 Hacker News 头条并按热度排序" },
    { icon: Zap, color: "text-emerald-400", title: "自动化操作", hint: "登录我的 GitHub 检查最近 3 条 issue" },
    { icon: FileText, color: "text-orange-400", title: "汇总报告", hint: "整理今日新闻，生成日报" },
  ],
  chat: [
    { icon: MessageCircle, color: "text-blue-400", title: "聊聊", hint: "帮我构思一份周末的城市徒步路线" },
    { icon: Sparkles, color: "text-purple-400", title: "生成图片", hint: "画一张赛博朋克风格的东京雨夜巷子" },
    { icon: FileText, color: "text-emerald-400", title: "写作助手", hint: "帮我把这段话改得更简洁：..." },
    { icon: Zap, color: "text-orange-400", title: "生成视频", hint: "生成一段 5 秒的海浪日落慢镜头" },
  ],
};

const MODE_TITLES: Record<Mode, { title: string; subtitle: string }> = {
  task: { title: "我们该构建什么？", subtitle: "给 Sentinel 一个目标 —— 它会自主思考、调用工具、纠错，直到完成。" },
  chat: { title: "想聊什么？", subtitle: "自由对话、生成图片、生成视频 —— 让 Sentinel 陪你创作。" },
};


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

  // External model catalog (llm-token.cn)
  const modelsFn = useServerFn(listExternalModels);
  const { data: externalModels = [], isLoading: modelsLoading, error: modelsError, refetch: refetchModels } =
    useQuery({
      queryKey: ["external_models"],
      queryFn: () => modelsFn(),
      staleTime: 5 * 60 * 1000,
      retry: false,
    });

  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window === "undefined") return "google/gemini-3.5-flash";
    return localStorage.getItem("sentinel:model") || "google/gemini-3.5-flash";
  });
  useEffect(() => {
    try {
      localStorage.setItem("sentinel:model", selectedModel);
    } catch {
      /* ignore */
    }
  }, [selectedModel]);

  const [mode, setMode] = useState<Mode>(() => {
    if (typeof window === "undefined") return "task";
    return (localStorage.getItem("sentinel:mode") as Mode) === "chat" ? "chat" : "task";
  });
  useEffect(() => {
    try {
      localStorage.setItem("sentinel:mode", mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

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
      body: () => ({
        connectionIds: Array.from(selectedIds),
        model: selectedModel,
        mode,
      }),
    });
  }, [token, selectedIds, selectedModel, mode]);


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
  const [sidebarWidth, setSidebarWidth] = usePersistedWidth("sentinel:sidebarW", 256, 180, 420);
  const [sheetWidth, setSheetWidth] = usePersistedWidth("sentinel:sheetW", 448, 320, 720);
  const [dragging, setDragging] = useState<null | "sidebar" | "sheet">(null);

  const activeCount = selectedIds.size;

  return (
    <div className="h-screen w-full flex bg-background text-foreground select-none">
      {/* Sidebar */}
      <aside
        style={collapsed ? undefined : { width: sidebarWidth }}
        className={`${collapsed ? "w-14" : ""} shrink-0 border-r border-border flex flex-col bg-surface-1/40 relative ${dragging ? "" : "transition-[width] duration-200"}`}
      >
        {!collapsed && (
          <ResizeHandle
            side="right"
            onStart={() => setDragging("sidebar")}
            onEnd={() => setDragging(null)}
            getBase={() => sidebarWidth}
            setValue={setSidebarWidth}
            dir={1}
            min={180}
            max={420}
          />
        )}
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
            active={mode === "task"}
            onClick={() => {
              setMode("task");
              setMessages([]);
            }}
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
          <NavItem
            collapsed={collapsed}
            icon={MessageCircle}
            label="聊天"
            active={mode === "chat"}
            onClick={() => {
              setMode("chat");
              setMessages([]);
            }}
          />

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
          <UserSettingsDialog
            collapsed={collapsed}
            userEmail={userEmail}
            isLoading={isLoading}
            onSignOut={handleSignOut}
          />
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
            <h1 className="text-3xl font-semibold tracking-tight mb-2">{MODE_TITLES[mode].title}</h1>
            <p className="text-sm text-muted-foreground mb-10">
              {MODE_TITLES[mode].subtitle}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 w-full max-w-3xl">
              {STARTER_PROMPTS[mode].map((p) => (
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
              {mode === "task" ? (
                <button
                  onClick={() => setMcpOpen(true)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 text-xs font-medium text-foreground/80 transition"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  插件 · {activeCount}/{connections.length}
                </button>
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-foreground/80">
                  <MessageCircle className="w-3.5 h-3.5 text-signal" />
                  聊天 · 生图 / 生视频
                </div>
              )}
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="flex items-center gap-1 max-w-[180px] text-[11px] text-foreground/80 font-mono hover:text-foreground hover:bg-white/5 transition px-2 py-1 rounded border border-border/60"
                      title={selectedModel}
                    >
                      <span className="truncate">{selectedModel}</span>
                      <ChevronDown className="w-3 h-3 shrink-0" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-72 max-h-[420px] overflow-y-auto"
                  >
                    <DropdownMenuLabel className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest">
                      <span>模型 · llm-token.cn</span>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          refetchModels();
                        }}
                        className="text-muted-foreground hover:text-foreground normal-case tracking-normal"
                      >
                        刷新
                      </button>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {modelsLoading && (
                      <div className="px-2 py-4 text-xs text-muted-foreground text-center">
                        加载中…
                      </div>
                    )}
                    {modelsError && (
                      <div className="px-2 py-3 text-xs text-destructive break-all">
                        {(modelsError as Error).message}
                      </div>
                    )}
                    {!modelsLoading && !modelsError && externalModels.length === 0 && (
                      <div className="px-2 py-3 text-xs text-muted-foreground">
                        暂无可用模型
                      </div>
                    )}
                    {externalModels.map((m) => (
                      <DropdownMenuItem
                        key={m.id}
                        onSelect={() => setSelectedModel(m.id)}
                        className="text-xs font-mono flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{m.id}</span>
                        {m.id === selectedModel && (
                          <CheckCircle2 className="w-3 h-3 text-signal shrink-0" />
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
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
        <SheetContent
          side="right"
          style={{ width: sheetWidth, maxWidth: "100vw" }}
          className="!max-w-none p-0 flex flex-col"
        >
          <ResizeHandle
            side="left"
            onStart={() => setDragging("sheet")}
            onEnd={() => setDragging(null)}
            getBase={() => sheetWidth}
            setValue={setSheetWidth}
            dir={-1}
            min={320}
            max={720}
          />
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

function UserSettingsDialog({
  collapsed,
  userEmail,
  isLoading,
  onSignOut,
}: {
  collapsed: boolean;
  userEmail: string;
  isLoading: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState({ plugins: true, browser: true, computer: false });

  useEffect(() => {
    try {
      const saved = localStorage.getItem("sentinel:integrations");
      if (saved) setPrefs((p) => ({ ...p, ...JSON.parse(saved) }));
    } catch {}
  }, []);

  function update(k: keyof typeof prefs, v: boolean) {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    try {
      localStorage.setItem("sentinel:integrations", JSON.stringify(next));
    } catch {}
  }

  const items = [
    {
      key: "plugins" as const,
      icon: Puzzle,
      title: "插件",
      hint: "允许 Sentinel 使用已连接的 MCP 插件",
      color: "text-violet-400",
      bg: "bg-violet-500/10",
    },
    {
      key: "browser" as const,
      icon: Globe,
      title: "浏览器",
      hint: "允许通过浏览器扩展进行网页操作",
      color: "text-blue-400",
      bg: "bg-blue-500/10",
    },
    {
      key: "computer" as const,
      icon: Monitor,
      title: "电脑操控",
      hint: "允许 Sentinel 控制您电脑上的其他应用",
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {collapsed ? (
          <button
            className="w-full flex items-center justify-center p-1.5 rounded-md hover:bg-white/5 transition"
            title={userEmail || "账户"}
          >
            <div className="w-8 h-8 rounded-full bg-signal/20 border border-signal/40 flex items-center justify-center text-xs font-bold text-signal">
              {(userEmail[0] ?? "S").toUpperCase()}
            </div>
          </button>
        ) : (
          <button className="w-full flex items-center gap-2.5 p-1 rounded-md hover:bg-white/5 transition text-left">
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
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <div className="flex h-[520px]">
          {/* Left nav */}
          <div className="w-52 shrink-0 border-r border-border bg-surface-1/50 p-2 overflow-y-auto">
            <div className="px-2 py-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
              设置
            </div>
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition ${
                  section === s.key
                    ? "bg-signal/15 text-signal"
                    : "text-foreground/80 hover:bg-white/5"
                }`}
              >
                <s.icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
            <div className="mt-3 pt-3 border-t border-border">
              <button
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-white/5 transition"
              >
                <LogOut className="w-4 h-4 shrink-0" />
                <span className="truncate">退出登录</span>
              </button>
            </div>
          </div>

          {/* Right content */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
              <DialogTitle className="text-lg">
                {SETTINGS_SECTIONS.find((s) => s.key === section)?.label}
              </DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {SETTINGS_SECTIONS.find((s) => s.key === section)?.hint}
              </p>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto p-6">
              {section === "integrations" && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-3">
                    集成
                  </div>
                  {items.map((it) => (
                    <div
                      key={it.key}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1"
                    >
                      <div className={`w-10 h-10 rounded-lg ${it.bg} flex items-center justify-center shrink-0`}>
                        <it.icon className={`w-5 h-5 ${it.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{it.title}</div>
                        <div className="text-xs text-muted-foreground truncate">{it.hint}</div>
                      </div>
                      <Switch
                        checked={prefs[it.key]}
                        onCheckedChange={(v) => update(it.key, v)}
                      />
                    </div>
                  ))}
                </div>
              )}

              {section === "memory" && (
                <SettingsPanel
                  rows={[
                    { title: "启用记忆", hint: "让 Sentinel 记住你的偏好与上下文", action: "toggle", storeKey: "memory:enabled", defaultOn: true },
                    { title: "跨会话记忆", hint: "在不同任务之间共享长期记忆", action: "toggle", storeKey: "memory:cross", defaultOn: false },
                    { title: "管理记忆", hint: "查看、编辑或删除已保存的记忆条目", action: "button", buttonLabel: "打开" },
                    { title: "清除全部记忆", hint: "永久删除所有已保存的记忆", action: "button", buttonLabel: "清除", danger: true },
                  ]}
                />
              )}

              {section === "model" && (
                <SettingsPanel
                  rows={[
                    { title: "默认模型", hint: "新会话默认使用的模型（可在合成器右下角切换）", action: "text", value: "gpt-image-2" },
                    { title: "温度 (Temperature)", hint: "较低更稳定，较高更有创造力", action: "text", value: "0.7" },
                    { title: "最大输出长度", hint: "单次响应的最大 Token 数", action: "text", value: "4096" },
                    { title: "流式响应", hint: "以流式方式逐步返回结果", action: "toggle", storeKey: "model:stream", defaultOn: true },
                  ]}
                />
              )}

              {section === "assistant" && (
                <SettingsPanel
                  rows={[
                    { title: "助理昵称", hint: "自定义 Sentinel 在对话中的称呼", action: "text", value: "Sentinel" },
                    { title: "系统提示词", hint: "追加到每次对话开头的指令", action: "text", value: "简洁、专业、可执行" },
                    { title: "自动执行", hint: "对可逆的工具调用自动放行", action: "toggle", storeKey: "assistant:autorun", defaultOn: true },
                    { title: "语音回复", hint: "使用 TTS 朗读助手回复", action: "toggle", storeKey: "assistant:tts", defaultOn: false },
                  ]}
                />
              )}

              {section === "data" && (
                <SettingsPanel
                  rows={[
                    { title: "我分享的文件", hint: "管理你上传给 Sentinel 的文件", action: "button", buttonLabel: "管理" },
                    { title: "我分享的任务", hint: "查看你分享出去的任务链接", action: "button", buttonLabel: "管理" },
                    { title: "我发布的应用", hint: "管理你构建并发布的小应用", action: "button", buttonLabel: "管理" },
                    { title: "已归档任务", hint: "查看历史归档的任务", action: "button", buttonLabel: "管理" },
                    { title: "导出全部数据", hint: "导出你的会话、记忆和设置", action: "button", buttonLabel: "导出" },
                  ]}
                />
              )}

              {section === "security" && (
                <SettingsPanel
                  rows={[
                    { title: "两步验证", hint: "为登录添加额外一层保护", action: "toggle", storeKey: "sec:2fa", defaultOn: false },
                    { title: "登录活动", hint: "查看最近的登录设备与地点", action: "button", buttonLabel: "查看" },
                    { title: "会话与设备", hint: "撤销其他设备上的登录", action: "button", buttonLabel: "管理" },
                    { title: "API 密钥", hint: "管理用于访问 Sentinel 的密钥", action: "button", buttonLabel: "管理" },
                    { title: "删除账户", hint: "永久删除账户及所有关联数据", action: "button", buttonLabel: "删除", danger: true },
                  ]}
                />
              )}
            </div>

            <div className="px-6 py-3 border-t border-border text-xs text-muted-foreground truncate">
              {userEmail || "未登录"}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SettingsSectionKey = "integrations" | "memory" | "model" | "assistant" | "data" | "security";

const SETTINGS_SECTIONS: Array<{
  key: SettingsSectionKey;
  label: string;
  hint: string;
  icon: typeof Monitor;
}> = [
  { key: "integrations", label: "电脑操控", hint: "管理 Sentinel 如何使用你电脑上的其他应用程序", icon: Monitor },
  { key: "memory", label: "记忆", hint: "管理 Sentinel 记住的偏好与上下文", icon: Lightbulb },
  { key: "model", label: "模型", hint: "为新会话选择默认模型与生成参数", icon: Box },
  { key: "assistant", label: "助理设置", hint: "自定义助理的行为与个性", icon: UserCog },
  { key: "data", label: "数据管理", hint: "管理你分享的文件、任务与应用", icon: Database },
  { key: "security", label: "安全中心", hint: "账户安全、设备与密钥", icon: Shield },
];

type PanelRow =
  | { title: string; hint: string; action: "toggle"; storeKey: string; defaultOn: boolean }
  | { title: string; hint: string; action: "button"; buttonLabel: string; danger?: boolean }
  | { title: string; hint: string; action: "text"; value: string };

function SettingsPanel({ rows }: { rows: PanelRow[] }) {
  const [toggles, setToggles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const r of rows) {
      if (r.action === "toggle") {
        try {
          const v = localStorage.getItem(`sentinel:${r.storeKey}`);
          next[r.storeKey] = v === null ? r.defaultOn : v === "1";
        } catch {
          next[r.storeKey] = r.defaultOn;
        }
      }
    }
    setToggles(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setToggle(key: string, v: boolean) {
    setToggles((t) => ({ ...t, [key]: v }));
    try {
      localStorage.setItem(`sentinel:${key}`, v ? "1" : "0");
    } catch {}
  }

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{r.title}</div>
            <div className="text-xs text-muted-foreground">{r.hint}</div>
          </div>
          {r.action === "toggle" && (
            <Switch
              checked={!!toggles[r.storeKey]}
              onCheckedChange={(v) => setToggle(r.storeKey, v)}
            />
          )}
          {r.action === "button" && (
            <Button
              variant={r.danger ? "ghost" : "outline"}
              size="sm"
              className={r.danger ? "text-destructive hover:text-destructive" : ""}
            >
              {r.buttonLabel}
            </Button>
          )}
          {r.action === "text" && (
            <div className="text-xs font-mono text-muted-foreground bg-background/50 border border-border rounded px-2 py-1 max-w-[160px] truncate">
              {r.value}
            </div>
          )}
        </div>
      ))}
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
                {p.output !== undefined && (() => {
                  const out = p.output as { imageUrl?: string; note?: string; ok?: boolean; error?: string };
                  if (out && typeof out === "object" && out.imageUrl) {
                    return (
                      <div className="p-3 space-y-2">
                        <img
                          src={out.imageUrl}
                          alt="生成图片"
                          className="rounded-md border border-border max-w-full max-h-[480px]"
                        />
                        {out.note && (
                          <div className="text-[11px] text-muted-foreground whitespace-pre-wrap">
                            {out.note}
                          </div>
                        )}
                        <a
                          href={out.imageUrl}
                          download={`sentinel-${Date.now()}.png`}
                          className="inline-block text-[10px] font-mono text-signal hover:underline"
                        >
                          下载图片 ↓
                        </a>
                      </div>
                    );
                  }
                  return (
                    <pre className="p-3 text-[11px] font-mono text-foreground/80 overflow-x-auto max-h-64">
                      {typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2)}
                    </pre>
                  );
                })()}
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

function usePersistedWidth(key: string, defaultW: number, min: number, max: number) {
  const [width, setWidth] = useState<number>(defaultW);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? Number(raw) : NaN;
      if (Number.isFinite(v) && v >= min && v <= max) setWidth(v);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: number) => {
    const clamped = Math.min(max, Math.max(min, v));
    setWidth(clamped);
    try {
      localStorage.setItem(key, String(clamped));
    } catch {
      /* ignore */
    }
  };
  return [width, set] as const;
}

function ResizeHandle({
  side,
  onStart,
  onEnd,
  getBase,
  setValue,
  dir,
  min,
  max,
}: {
  side: "left" | "right";
  onStart: () => void;
  onEnd: () => void;
  getBase: () => number;
  setValue: (v: number) => void;
  dir: 1 | -1;
  min: number;
  max: number;
}) {
  return (
    <div
      onMouseDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const base = getBase();
        onStart();
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const move = (ev: MouseEvent) => {
          const delta = (ev.clientX - startX) * dir;
          const next = Math.min(max, Math.max(min, base + delta));
          setValue(next);
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          onEnd();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
      onDoubleClick={() => setValue(getBase())}
      className={`absolute top-0 bottom-0 z-30 w-1.5 cursor-col-resize group ${
        side === "right" ? "-right-[3px]" : "-left-[3px]"
      }`}
      title="拖拽调整宽度"
    >
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-transparent group-hover:bg-signal/60 transition-colors" />
    </div>
  );
}
