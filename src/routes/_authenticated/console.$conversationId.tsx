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
import { listExternalModels, MODEL_PROVIDERS, type ModelProvider } from "@/lib/models.functions";
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
import { Cc6Panel } from "@/components/mcp/Cc6Panel";
import { PlaywrightRunner } from "@/components/chrome/PlaywrightRunner";
import { PlaywrightBeginner } from "@/components/chrome/PlaywrightBeginner";
import { FileBrowser } from "@/components/chrome/FileBrowser";
import type { SelectedFile } from "@/components/chrome/selected-file";
import { McpConnectionsPanel } from "@/components/mcp/McpConnectionsPanel";
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
  X,
  FolderOpen,
  ShieldCheck,
  Mic,
  ChevronDown,
  Search,
  Star,
  Monitor,
  Lightbulb,
  Box,
  UserCog,
  Database,
  Shield,
  FileSpreadsheet,
  Presentation,
  BarChart3,
  Github,
  MoreHorizontal,
  RefreshCw,
  Settings2,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  Plug,
  History,
  Download,
  Copy as CopyIcon,
  Upload,
  ShieldAlert,
  ScanText,
  FileText,
  Image as ImageIcon,
  BookOpen,
  Loader2,
  Wifi,
  WifiOff,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/$conversationId")({
  head: () => ({
    meta: [{ title: "控制台 · Sentinel OS" }],
  }),
  component: ConsolePage,
});

// ---- Local Helper bridge for browser_* tools ----
type HelperStep =
  | { type: "goto"; target: string }
  | { type: "wait"; target: string; value?: string }
  | { type: "click"; target: string }
  | { type: "fill"; target: string; value: string }
  | { type: "press"; target: string }
  | { type: "extract"; target: string; value?: string }
  | { type: "screenshot"; target: string }
  | { type: "eval"; target: string };

function browserToolToStep(name: string, args: Record<string, unknown>): HelperStep | null {
  const s = (k: string) => String(args[k] ?? "");
  switch (name) {
    case "browser_goto":
      return { type: "goto", target: s("url") };
    case "browser_wait_for":
      return {
        type: "wait",
        target: s("selector"),
        value: String(args.timeoutMs ?? 10000),
      };
    case "browser_click":
      return { type: "click", target: s("selector") };
    case "browser_fill":
      return { type: "fill", target: s("selector"), value: s("value") };
    case "browser_press":
      return { type: "press", target: s("key") };
    case "browser_extract":
      return { type: "extract", target: s("selector"), value: s("attr") };
    case "browser_screenshot":
      return { type: "screenshot", target: s("name") };
    case "browser_eval":
      return { type: "eval", target: s("expression") };
    default:
      return null;
  }
}

async function runHelperStep(
  helperUrl: string,
  cdpHost: string,
  cdpPort: number,
  step: HelperStep,
): Promise<{
  ok: boolean;
  logs: Array<{ level: string; message: string }>;
  result?: unknown;
  error?: string;
}> {
  let res: Response;
  try {
    res = await fetch(`${helperUrl}/playwright/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attach: { host: cdpHost, port: cdpPort },
        steps: [step],
      }),
    });
  } catch {
    throw new Error(
      `无法连接本地 Helper (${helperUrl})。请到 docs/sentinel-helper 目录运行 'npm start'，并在设置里启动 Chrome。`,
    );
  }
  if (!res.ok) {
    throw new Error(`Helper HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const { runId } = (await res.json()) as { runId: string };

  return new Promise((resolve, reject) => {
    const es = new EventSource(`${helperUrl}/playwright/logs/${runId}`);
    const logs: Array<{ level: string; message: string }> = [];
    let result: unknown;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        es.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    es.addEventListener("log", (e) => {
      try {
        logs.push(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("result", (e) => {
      try {
        const r = JSON.parse((e as MessageEvent).data) as { value: unknown };
        result = r.value;
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("done", () => finish(() => resolve({ ok: true, logs, result })));
    es.addEventListener("error-event", (e) => {
      let msg = "步骤失败";
      try {
        msg = JSON.parse((e as MessageEvent).data).message ?? msg;
      } catch {
        /* ignore */
      }
      finish(() => resolve({ ok: false, error: msg, logs }));
    });
    es.onerror = () => finish(() => reject(new Error("Helper SSE 中断")));
    // safety timeout: 65s
    setTimeout(() => finish(() => reject(new Error("Helper 步骤超时"))), 65000);
  });
}


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

type ExternalModel = { id: string };

const VENDOR_ORDER = [
  "gemini",
  "gpt",
  "claude",
  "grok",
  "qwen",
  "deepseek",
  "llama",
  "mistral",
  "kimi",
  "other",
];

const VENDOR_LABEL: Record<string, string> = {
  all: "全部",
  gemini: "Gemini",
  gpt: "GPT",
  claude: "Claude",
  grok: "Grok",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  llama: "Llama",
  mistral: "Mistral",
  kimi: "Kimi",
  other: "其它",
};

const VARIANT_TAG_RE = /-(thinking|high|medium|low|max|mini|nano|lite|pro|flash|preview)(?:-|$)/gi;

function vendorOf(id: string): string {
  const s = id.toLowerCase();
  for (const v of VENDOR_ORDER) {
    if (v !== "other" && s.includes(v)) return v;
  }
  return "other";
}

function variantsOf(id: string): string[] {
  const tags: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(VARIANT_TAG_RE.source, "gi");
  while ((m = re.exec(id.toLowerCase())) !== null) tags.push(m[1].toLowerCase());
  return Array.from(new Set(tags));
}

/** Strip trailing date + variant suffixes so siblings collapse into one family label. */
function familyOf(id: string): string {
  const bare = id.includes("/") ? id.split("/").pop()! : id;
  return bare
    .replace(/-(thinking|high|medium|low|max)$/i, "")
    .replace(/-\d{6,8}$/i, "");
}

function groupModels(
  models: ExternalModel[],
  search: string,
  vendor: string,
): Array<{ vendor: string; label: string; items: ExternalModel[] }> {
  const q = search.trim().toLowerCase();
  const filtered = models.filter((m) => {
    if (q && !m.id.toLowerCase().includes(q)) return false;
    if (vendor !== "all" && vendorOf(m.id) !== vendor) return false;
    return true;
  });
  const buckets = new Map<string, ExternalModel[]>();
  for (const m of filtered) {
    const v = vendorOf(m.id);
    const arr = buckets.get(v) ?? [];
    arr.push(m);
    buckets.set(v, arr);
  }
  for (const arr of buckets.values()) arr.sort((a, b) => a.id.localeCompare(b.id));
  return VENDOR_ORDER.filter((v) => buckets.has(v)).map((v) => ({
    vendor: v,
    label: VENDOR_LABEL[v] ?? v,
    items: buckets.get(v)!,
  }));
}

function formatCacheAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}





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

  // External model catalog (multi-provider) with localStorage cache
  const modelsFn = useServerFn(listExternalModels);
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => {
    if (typeof window === "undefined") return "llm-token";
    const v = localStorage.getItem("sentinel:modelProvider");
    return v === "minimax" ? "minimax" : "llm-token";
  });
  useEffect(() => {
    try {
      localStorage.setItem("sentinel:modelProvider", modelProvider);
    } catch {
      /* ignore */
    }
  }, [modelProvider]);

  const cacheKey = (p: ModelProvider) => `sentinel:modelsCache:${p}`;
  const readCache = (
    p: ModelProvider,
  ): { data: ExternalModel[]; updatedAt: number } | undefined => {
    if (typeof window === "undefined") return undefined;
    try {
      const raw = localStorage.getItem(cacheKey(p));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as {
        data?: ExternalModel[];
        updatedAt?: number;
      };
      if (!Array.isArray(parsed.data) || typeof parsed.updatedAt !== "number") return undefined;
      return { data: parsed.data, updatedAt: parsed.updatedAt };
    } catch {
      return undefined;
    }
  };
  const CACHE_TTL_MS = 60 * 60 * 1000; // 1h fresh window; older entries prime UI then refetch in background

  const { data: externalModels = [], isLoading: modelsLoading, error: modelsError, refetch: refetchModels, dataUpdatedAt } =
    useQuery({
      queryKey: ["external_models", modelProvider],
      queryFn: async () => {
        const list = await modelsFn({ data: { provider: modelProvider } });
        try {
          localStorage.setItem(
            cacheKey(modelProvider),
            JSON.stringify({ data: list, updatedAt: Date.now() }),
          );
        } catch {
          /* ignore quota */
        }
        return list;
      },
      staleTime: CACHE_TTL_MS,
      gcTime: 24 * 60 * 60 * 1000,
      retry: false,
      initialData: () => readCache(modelProvider)?.data,
      initialDataUpdatedAt: () => readCache(modelProvider)?.updatedAt,
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

  const [modelSearch, setModelSearch] = useState("");
  const [modelVendor, setModelVendor] = useState<string>("all");

  const [favModels, setFavModels] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem("sentinel:favModels");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("sentinel:favModels", JSON.stringify(favModels));
    } catch {
      /* ignore */
    }
  }, [favModels]);
  const favSet = useMemo(() => new Set(favModels), [favModels]);
  const toggleFav = (id: string) =>
    setFavModels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const favoriteItems = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    return favModels
      .filter((id) => externalModels.some((m) => m.id === id))
      .filter((id) => !q || id.toLowerCase().includes(q))
      .map((id) => ({ id }));
  }, [favModels, externalModels, modelSearch]);

  const groupedModels = useMemo(() => {
    return groupModels(externalModels, modelSearch, modelVendor);
  }, [externalModels, modelSearch, modelVendor]);

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
        provider: modelProvider,
      }),
    });
  }, [token, selectedIds, selectedModel, mode, modelProvider]);


  const helperUrl =
    (typeof window !== "undefined" && localStorage.getItem("helperUrl")) ||
    "http://127.0.0.1:9223";
  const cdpHost =
    (typeof window !== "undefined" && localStorage.getItem("cdpHost")) || "127.0.0.1";
  const cdpPort = Number(
    (typeof window !== "undefined" && localStorage.getItem("cdpPort")) || "9222",
  );

  const { messages, sendMessage, status, stop, setMessages, addToolResult } = useChat({
    transport,
    onError: (err) => toast.error(err.message ?? "Agent 错误"),
    onToolCall: async ({ toolCall }) => {
      const name = toolCall.toolName;
      if (!name.startsWith("browser_")) return;
      const args = toolCall.input as Record<string, unknown>;
      const step = browserToolToStep(name, args);
      if (!step) {
        addToolResult({
          tool: name,
          toolCallId: toolCall.toolCallId,
          output: { ok: false, error: `未知浏览器工具: ${name}` },
        });
        return;
      }
      try {
        const output = await runHelperStep(helperUrl, cdpHost, cdpPort, step);
        addToolResult({ tool: name, toolCallId: toolCall.toolCallId, output });
      } catch (e) {
        addToolResult({
          tool: name,
          toolCallId: toolCall.toolCallId,
          output: {
            ok: false,
            error:
              e instanceof Error
                ? e.message
                : "调用本地 Helper 失败，请确认 sentinel-helper 已启动并且 Chrome 处于监听状态。",
          },
        });
      }
    },
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

  const [lastRequest, setLastRequest] = useState<{
    provider: ModelProvider;
    model: string;
    at: number;
  } | null>(null);

  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const previewUrls = useMemo(() => {
    const map = new Map<File, string>();
    for (const f of attachments) {
      if (f.type.startsWith("image/")) map.set(f, URL.createObjectURL(f));
    }
    return map;
  }, [attachments]);
  useEffect(() => {
    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previewUrls]);

  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  const MAX_FILES = 10;

  function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files);
    const accepted: File[] = [];
    for (const f of incoming) {
      if (f.size > MAX_FILE_SIZE) {
        toast.error(`${f.name} 超过 20MB，已跳过`);
        continue;
      }
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    setAttachments((prev) => {
      const merged = [...prev, ...accepted];
      if (merged.length > MAX_FILES) {
        toast.error(`最多上传 ${MAX_FILES} 个文件`);
        return merged.slice(0, MAX_FILES);
      }
      return merged;
    });
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function filesToList(files: File[]): FileList {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    return dt.files;
  }

  async function handleSend(text?: string) {
    const value = (text ?? input).trim();
    if ((!value && attachments.length === 0) || isLoading) return;
    setInput("");
    if (!token) {
      toast.error("会话已过期，请重新登录");
      return;
    }
    setLastRequest({ provider: modelProvider, model: selectedModel, at: Date.now() });
    const pending = attachments;
    setAttachments([]);
    try {
      await sendMessage({
        text: value || " ",
        files: pending.length > 0 ? filesToList(pending) : undefined,
      });
    } catch (e) {
      // restore attachments on failure
      setAttachments(pending);
      throw e;
    }
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
  const [pluginMarketOpen, setPluginMarketOpen] = useState(false);
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
            label="插件"
            active={pluginMarketOpen}
            badge={activeCount > 0 ? `${activeCount}` : undefined}
            onClick={() => setPluginMarketOpen(true)}
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
        {lastRequest && (
          <div className="absolute top-3 right-4 z-10 pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-2 px-2.5 py-1 rounded-full border border-border/60 bg-surface-1/80 backdrop-blur text-[10px] font-mono">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isLoading ? "bg-signal animate-pulse-signal" : "bg-signal/50"
                }`}
              />
              <span className="uppercase tracking-widest text-muted-foreground">
                {MODEL_PROVIDERS.find((p) => p.id === lastRequest.provider)?.label ??
                  lastRequest.provider}
              </span>
              <span className="text-border">/</span>
              <span
                className="text-foreground max-w-[220px] truncate"
                title={`${lastRequest.model} · ${new Date(lastRequest.at).toLocaleTimeString()}`}
              >
                {lastRequest.model}
              </span>
            </div>
          </div>
        )}
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
          <div
            className={`relative bg-surface-2/95 rounded-2xl border shadow-2xl backdrop-blur-xl overflow-hidden transition ${
              isDragging ? "border-signal ring-2 ring-signal/40" : "border-border"
            }`}
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer?.types?.includes("Files")) {
                dragCounter.current += 1;
                setIsDragging(true);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounter.current -= 1;
              if (dragCounter.current <= 0) {
                dragCounter.current = 0;
                setIsDragging(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dragCounter.current = 0;
              setIsDragging(false);
              if (e.dataTransfer?.files?.length) {
                addFiles(e.dataTransfer.files);
              }
            }}
          >
            {isDragging && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-signal/10 backdrop-blur-sm pointer-events-none">
                <div className="text-signal text-sm font-medium">松开以添加文件</div>
              </div>
            )}
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

            {/* Attachments */}
            {attachments.length > 0 && (
              <div className="px-4 pt-3 flex flex-wrap gap-2">
                {attachments.map((f, i) => {
                  const imgUrl = previewUrls.get(f);
                  const sizeLabel =
                    f.size < 1024 * 1024
                      ? `${(f.size / 1024).toFixed(0)}KB`
                      : `${(f.size / 1024 / 1024).toFixed(1)}MB`;
                  if (imgUrl) {
                    return (
                      <div
                        key={`${f.name}-${i}`}
                        className="group relative w-16 h-16 rounded-lg overflow-hidden border border-border/60 bg-white/5"
                        title={`${f.name} · ${sizeLabel}`}
                      >
                        <button
                          type="button"
                          onClick={() => setPreviewImage({ url: imgUrl, name: f.name })}
                          className="block w-full h-full"
                        >
                          <img
                            src={imgUrl}
                            alt={f.name}
                            className="w-full h-full object-cover transition group-hover:scale-105"
                          />
                        </button>
                        <button
                          onClick={() => removeAttachment(i)}
                          className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-background border border-border shadow flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 opacity-0 group-hover:opacity-100 transition"
                          aria-label="移除附件"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`${f.name}-${i}`}
                      className="group flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md bg-white/5 border border-border/60 text-[11px] text-foreground/80 max-w-[220px] h-16"
                      title={`${f.name} · ${sizeLabel}`}
                    >
                      <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{f.name}</span>
                      <span className="text-muted-foreground shrink-0">{sizeLabel}</span>
                      <button
                        onClick={() => removeAttachment(i)}
                        className="ml-0.5 p-0.5 rounded hover:bg-white/10 text-muted-foreground hover:text-foreground transition"
                        aria-label="移除附件"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

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
                onPaste={(e) => {
                  if (e.clipboardData?.files?.length) {
                    addFiles(e.clipboardData.files);
                  }
                }}
                placeholder="随心输入，指令或目标...（可拖曳文件到此处）"
                rows={2}
                disabled={isLoading}
                className="w-full bg-transparent border-none resize-none focus:outline-none focus:ring-0 text-foreground placeholder:text-muted-foreground text-sm min-h-[52px]"
              />
            </div>

            {/* Bottom actions */}
            <div className="px-3 py-2 flex items-center justify-between border-t border-border/60">
              <div className="flex items-center gap-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition disabled:opacity-40"
                  title="添加附件（也可拖曳/粘贴文件）"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
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
                    className="w-[22rem] max-h-[520px] flex flex-col p-0 overflow-hidden"
                  >
                    <div className="px-3 pt-3 pb-2 border-b border-border/60 space-y-2 shrink-0">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                          模型供应商
                        </span>
                        <div className="flex items-center gap-2">
                          {dataUpdatedAt > 0 && (
                            <span
                              className="text-[10px] text-muted-foreground/60"
                              title={new Date(dataUpdatedAt).toLocaleString()}
                            >
                              {formatCacheAge(dataUpdatedAt)}
                            </span>
                          )}
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              refetchModels();
                            }}
                            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                          >
                            <RefreshCw className={`w-3 h-3 ${modelsLoading ? "animate-spin" : ""}`} /> 刷新
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-1 p-0.5 rounded-md bg-muted/30 border border-border/60">
                        {MODEL_PROVIDERS.map((p) => {
                          const active = modelProvider === p.id;
                          return (
                            <button
                              key={p.id}
                              onClick={(e) => {
                                e.preventDefault();
                                if (modelProvider !== p.id) {
                                  setModelProvider(p.id);
                                  setModelVendor("all");
                                  setModelSearch("");
                                }
                              }}
                              className={`flex-1 text-[10px] font-mono uppercase tracking-wider px-2 py-1 rounded transition ${
                                active
                                  ? "bg-signal/20 text-signal shadow-sm"
                                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                              }`}
                              title={p.host}
                            >
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="relative">
                        <Search className="w-3 h-3 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
                        <Input
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="搜索模型…"
                          className="h-7 pl-6 text-xs"
                        />
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {["all", ...VENDOR_ORDER.filter((v) =>
                          externalModels.some((m) => vendorOf(m.id) === v),
                        )].map((v) => {
                          const count =
                            v === "all"
                              ? externalModels.length
                              : externalModels.filter((m) => vendorOf(m.id) === v).length;
                          const active = modelVendor === v;
                          return (
                            <button
                              key={v}
                              onClick={() => setModelVendor(v)}
                              className={`text-[10px] px-1.5 py-0.5 rounded border transition ${
                                active
                                  ? "border-signal/60 bg-signal/15 text-signal"
                                  : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                              }`}
                            >
                              {VENDOR_LABEL[v] ?? v}
                              <span className="ml-1 opacity-60">{count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto py-1">
                      {modelsLoading && (
                        <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                          加载中…
                        </div>
                      )}
                      {modelsError && (
                        <div className="px-3 py-3 text-xs text-destructive break-all">
                          {(modelsError as Error).message}
                        </div>
                      )}
                      {!modelsLoading && !modelsError && externalModels.length === 0 && (
                        <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                          暂无可用模型
                        </div>
                      )}
                      {!modelsLoading && externalModels.length > 0 && groupedModels.length === 0 && (
                        <div className="px-3 py-6 text-xs text-muted-foreground text-center">
                          没有匹配的模型
                        </div>
                      )}
                      {(() => {
                        const sections: Array<{
                          key: string;
                          label: string;
                          items: Array<{ id: string }>;
                          isFav?: boolean;
                        }> = [];
                        if (favoriteItems.length > 0 && modelVendor === "all") {
                          sections.push({
                            key: "__fav__",
                            label: "常用",
                            items: favoriteItems,
                            isFav: true,
                          });
                        }
                        for (const g of groupedModels) {
                          sections.push({ key: g.vendor, label: g.label, items: g.items });
                        }
                        return sections.map((sec, si) => (
                          <div key={sec.key}>
                            {si > 0 && <DropdownMenuSeparator className="my-1" />}
                            <div className="px-3 py-1 flex items-center justify-between">
                              <span
                                className={`text-[10px] font-mono uppercase tracking-widest inline-flex items-center gap-1 ${
                                  sec.isFav ? "text-signal" : "text-muted-foreground"
                                }`}
                              >
                                {sec.isFav && (
                                  <Star className="w-3 h-3 fill-signal text-signal" />
                                )}
                                {sec.label}
                              </span>
                              <span className="text-[10px] text-muted-foreground/60">
                                {sec.items.length}
                              </span>
                            </div>
                            {sec.items.map((m) => {
                              const isActive = m.id === selectedModel;
                              const isFav = favSet.has(m.id);
                              const tags = variantsOf(m.id).slice(0, 3);
                              const family = familyOf(m.id);
                              return (
                                <DropdownMenuItem
                                  key={`${sec.key}:${m.id}`}
                                  onSelect={() => setSelectedModel(m.id)}
                                  className={`text-xs flex items-center gap-2 px-3 py-1.5 ${
                                    isActive ? "bg-signal/10" : ""
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      toggleFav(m.id);
                                    }}
                                    title={isFav ? "取消收藏" : "加入常用"}
                                    className={`shrink-0 rounded p-0.5 transition ${
                                      isFav
                                        ? "text-amber-400 hover:text-amber-300"
                                        : "text-muted-foreground/40 hover:text-amber-400"
                                    }`}
                                  >
                                    <Star
                                      className={`w-3.5 h-3.5 ${isFav ? "fill-amber-400" : ""}`}
                                    />
                                  </button>
                                  <div className="flex-1 min-w-0">
                                    <div className="font-mono truncate text-foreground">
                                      {family}
                                      {m.id !== family && (
                                        <span className="text-muted-foreground">
                                          {m.id.slice(family.length)}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  {tags.map((t) => (
                                    <span
                                      key={t}
                                      className="text-[9px] font-mono uppercase px-1 py-px rounded bg-muted/50 text-muted-foreground shrink-0"
                                    >
                                      {t}
                                    </span>
                                  ))}
                                  {isActive && (
                                    <CheckCircle2 className="w-3 h-3 text-signal shrink-0" />
                                  )}
                                </DropdownMenuItem>
                              );
                            })}
                          </div>
                        ));
                      })()}
                    </div>
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

      <PluginMarketplaceDialog
        open={pluginMarketOpen}
        onOpenChange={setPluginMarketOpen}
        onOpenMcpSheet={() => {
          setPluginMarketOpen(false);
          setMcpOpen(true);
        }}
      />

      {/* Image preview lightbox */}
      <Dialog open={!!previewImage} onOpenChange={(v) => !v && setPreviewImage(null)}>
        <DialogContent className="max-w-4xl p-0 bg-background/95 border-border">
          <DialogHeader className="px-4 py-2 border-b border-border/60 flex-row items-center justify-between gap-4 space-y-0">
            <DialogTitle className="text-sm font-mono truncate flex-1 min-w-0">
              <div className="truncate">{previewImage?.name}</div>
              <div className="text-[10px] font-sans text-muted-foreground font-normal">Image</div>
            </DialogTitle>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  if (!previewImage) return;
                  const a = document.createElement("a");
                  a.href = previewImage.url;
                  a.download = previewImage.name || "image";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }}
              >
                <Download className="w-3.5 h-3.5 mr-1" /> Download
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={async () => {
                  if (!previewImage) return;
                  try {
                    const res = await fetch(previewImage.url);
                    const blob = await res.blob();
                    if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
                      const type = blob.type || "image/png";
                      const item = new ClipboardItem({ [type]: blob });
                      await navigator.clipboard.write([item]);
                      toast.success("已复制图片");
                    } else {
                      throw new Error("剪贴板不支持");
                    }
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "复制失败");
                  }
                }}
              >
                <CopyIcon className="w-3.5 h-3.5 mr-1" /> Copy
              </Button>
            </div>
          </DialogHeader>
          {previewImage && (
            <div className="flex items-center justify-center p-4 max-h-[80vh] overflow-auto">
              <img
                src={previewImage.url}
                alt={previewImage.name}
                className="max-w-full max-h-[75vh] object-contain rounded"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
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

type ChromePermRule = "ask" | "allow" | "deny";
type SitePerm = { id: string; pattern: string; rule: ChromePermRule };
type ChromeCfg = {
  host: string;
  port: string;
  userDataDir: string;
  binaryPath: string;
  extraFlags: string;
  connected: boolean;
  permissions: {
    approval: ChromePermRule;
    history: ChromePermRule;
    download: ChromePermRule;
    upload: ChromePermRule;
  };
  sitePerms: SitePerm[];
  devFullCdp: boolean;
  helperBase?: string;
};


function ChromeManagePanel({
  cfg,
  onChange,
  launchCmd,
  saved,
  onSave,
  onReset,
  permOptions,
  newSitePattern,
  setNewSitePattern,
  newSiteRule,
  setNewSiteRule,
}: {
  cfg: ChromeCfg;
  onChange: (next: ChromeCfg) => void;
  launchCmd: string;
  saved: null | "ok" | "err";
  onSave: () => void;
  onReset: () => void;
  permOptions: { value: ChromePermRule; label: string }[];
  newSitePattern: string;
  setNewSitePattern: (v: string) => void;
  newSiteRule: ChromePermRule;
  setNewSiteRule: (v: ChromePermRule) => void;
}) {
  const permRows: Array<{ key: keyof ChromeCfg["permissions"]; icon: typeof Plug; title: string; hint: string }> = [
    { key: "approval", icon: ShieldCheck, title: "审批", hint: "Sentinel 在打开网站前是否请求批准" },
    { key: "history", icon: History, title: "历史记录", hint: "Sentinel 在访问你的浏览器历史记录前是否需要请求批准" },
    { key: "download", icon: Download, title: "下载", hint: "Sentinel 从网站下载文件前是否先询问" },
    { key: "upload", icon: Upload, title: "上传", hint: "Sentinel 在将文件上传到网站前是否先询问" },
  ];

  function addSite() {
    const pattern = newSitePattern.trim();
    if (!pattern) return;
    const next: ChromeCfg = {
      ...cfg,
      sitePerms: [
        ...cfg.sitePerms,
        { id: crypto.randomUUID(), pattern, rule: newSiteRule },
      ],
    };
    onChange(next);
    setNewSitePattern("");
    setNewSiteRule("ask");
  }

  function removeSite(id: string) {
    onChange({ ...cfg, sitePerms: cfg.sitePerms.filter((s) => s.id !== id) });
  }

  // ===== CDP 连接探测 =====
  type ProbeState =
    | { status: "idle" }
    | { status: "probing" }
    | { status: "ok"; latency: number; browser?: string; webSocketDebuggerUrl?: string; at: number }
    | { status: "err"; latency: number; message: string; at: number };
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const probeSeq = useRef(0);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  const endpointUrl = `http://${cfg.host || "127.0.0.1"}:${cfg.port || "9222"}/json/version`;
  const helperBase = (cfg.helperBase || "http://127.0.0.1:9223").replace(/\/+$/, "");

  async function probeOnce(silent = false): Promise<"ok" | "err"> {
    const seq = silent ? probeSeq.current : ++probeSeq.current;
    if (!silent) setProbe({ status: "probing" });
    const started = performance.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(endpointUrl, { signal: ctrl.signal, cache: "no-store" });
      const latency = Math.round(performance.now() - started);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as {
        Browser?: string;
        webSocketDebuggerUrl?: string;
      };
      if (!silent && seq !== probeSeq.current) return "ok";
      setProbe({
        status: "ok",
        latency,
        browser: data.Browser,
        webSocketDebuggerUrl: data.webSocketDebuggerUrl,
        at: Date.now(),
      });
      return "ok";
    } catch (e) {
      const latency = Math.round(performance.now() - started);
      if (!silent && seq !== probeSeq.current) return "err";
      const msg =
        e instanceof DOMException && e.name === "AbortError"
          ? "请求超时（3s）"
          : e instanceof TypeError
          ? "无法连接（网络/CORS 或端口未监听）"
          : e instanceof Error
          ? e.message
          : "未知错误";
      if (!silent) setProbe({ status: "err", latency, message: msg, at: Date.now() });
      return "err";
    } finally {
      clearTimeout(to);
    }
  }

  async function runProbe() {
    await probeOnce(false);
  }

  // ===== Chrome 一键启动/停止 =====
  type LaunchState =
    | { status: "idle" }
    | { status: "starting"; step: string }
    | { status: "verifying"; attempts: number }
    | { status: "started"; at: number }
    | { status: "stopping" }
    | { status: "stopped"; at: number }
    | { status: "failed"; message: string; at: number };
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });
  type HelperDiag = {
    url: string;
    httpStatus: number | null;
    browserError: string | null;
    latencyMs: number;
    json: unknown;
  };
  const [helperCheck, setHelperCheck] = useState<
    | { status: "idle" }
    | { status: "checking" }
    | { status: "ok"; latency: number; at: number; diag: HelperDiag }
    | { status: "err"; latency: number; message: string; at: number; diag: HelperDiag }
  >({ status: "idle" });

  async function checkHelper() {
    const url = `${helperBase.replace(/\/+$/, "")}/`;
    console.log("[helper-check] start", url);
    setHelperCheck({ status: "checking" });
    const tId = toast.loading(`正在探测 ${url} …`);
    const started = performance.now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    const diag: HelperDiag = {
      url,
      httpStatus: null,
      browserError: null,
      latencyMs: 0,
      json: null,
    };

    const finishErr = (message: string) => {
      diag.latencyMs = Math.round(performance.now() - started);
      setHelperCheck({ status: "err", latency: diag.latencyMs, message, at: Date.now(), diag });
      console.error("[helper-check] fail", { message, ...diag });
      toast.error(message, {
        id: tId,
        duration: 10000,
        description: `URL: ${url} · HTTP: ${diag.httpStatus ?? "—"} · ${diag.latencyMs}ms${
          diag.browserError ? ` · ${diag.browserError}` : ""
        }`,
      });
    };

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          signal: ctrl.signal,
        });
        diag.httpStatus = response.status;
      } catch (e) {
        diag.browserError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        if (e instanceof DOMException && e.name === "AbortError") {
          finishErr("请求超时 (8s) — 可能被防火墙拦截或未监听");
          return;
        }
        let portOpen = false;
        try {
          const ctrl2 = new AbortController();
          const to2 = setTimeout(() => ctrl2.abort(), 2500);
          await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store", signal: ctrl2.signal });
          clearTimeout(to2);
          portOpen = true;
        } catch {
          portOpen = false;
        }
        if (portOpen) {
          finishErr(
            "Private Network Access / CORS 预检失败 — Helper 端口可达但响应被浏览器拦截，请更新 Helper 到最新版（含 Access-Control-Allow-Private-Network 头）并重启 npm start",
          );
          return;
        }
        finishErr("请求被浏览器阻止或连接被拒绝 — 端口未监听 / 进程未运行 / 混合内容被拦");
        return;
      }

      if (!response.ok) {
        finishErr(`HTTP 状态异常: ${response.status} ${response.statusText}`);
        return;
      }
      let json: { ok?: boolean; name?: string; port?: number };
      try {
        json = await response.json();
        diag.json = json;
      } catch (e) {
        diag.browserError = e instanceof Error ? e.message : String(e);
        finishErr("JSON 响应格式错误 — 端点响应不是合法 JSON");
        return;
      }
      if (json.ok !== true || json.name !== "sentinel-helper" || json.port !== 9223) {
        finishErr(
          `响应结构不匹配: 期望 {ok:true, name:"sentinel-helper", port:9223}，实际收到 ${JSON.stringify(json)}`,
        );
        return;
      }
      diag.latencyMs = Math.round(performance.now() - started);
      setHelperCheck({ status: "ok", latency: diag.latencyMs, at: Date.now(), diag });
      console.log("[helper-check] ok", diag);
      toast.success(`Helper 可访问 · ${diag.latencyMs}ms`, {
        id: tId,
        description: `${url} · name=${json.name} · port=${json.port}`,
      });
    } finally {
      clearTimeout(to);
    }
  }




  async function callHelper(path: string, body?: unknown): Promise<Response> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    try {
      return await fetch(`${helperBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : "{}",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
  }

  async function pollUntilReachable(maxMs = 12000): Promise<boolean> {
    const start = performance.now();
    let attempts = 0;
    while (performance.now() - start < maxMs) {
      attempts += 1;
      setLaunch({ status: "verifying", attempts });
      const r = await probeOnce(false);
      if (r === "ok") return true;
      await new Promise((res) => setTimeout(res, 600));
    }
    return false;
  }

  async function startChrome() {
    setLaunch({ status: "starting", step: "请求本地 Helper 启动 Chrome…" });
    const tId = toast.loading("正在请求本地 Helper 启动 Chrome…");
    try {
      const res = await callHelper("/launch", {
        binaryPath: cfg.binaryPath || undefined,
        host: cfg.host || "127.0.0.1",
        port: cfg.port || "9222",
        userDataDir: cfg.userDataDir || undefined,
        extraFlags: cfg.extraFlags || undefined,
        remoteAllowOrigin: window.location.origin,
      });
      if (!res.ok) throw new Error(`Helper 返回 HTTP ${res.status}`);
    } catch (e) {
      const isNet = e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError");
      const msg = isNet
        ? `无法访问本地 Helper (${helperBase})。请先在本机运行 \`cd docs/sentinel-helper && npm start\``
        : e instanceof Error
        ? e.message
        : "启动失败";
      setLaunch({ status: "failed", message: msg, at: Date.now() });
      toast.error(msg, { id: tId });
      return;
    }
    const ok = await pollUntilReachable();
    if (ok) {
      setLaunch({ status: "started", at: Date.now() });
      toast.success("Chrome 已启动并可通过 DevTools 连接", { id: tId });
    } else {
      const msg = "已请求启动,但 DevTools 端点在 12s 内未响应";
      setLaunch({ status: "failed", message: msg, at: Date.now() });
      toast.error(msg, { id: tId });
    }
  }


  async function stopChrome() {
    setLaunch({ status: "stopping" });
    try {
      const res = await callHelper("/stop", { port: cfg.port || "9222" });
      if (!res.ok) throw new Error(`Helper 返回 HTTP ${res.status}`);
      setLaunch({ status: "stopped", at: Date.now() });
      setProbe({ status: "idle" });
    } catch (e) {
      const isNet = e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError");
      const msg = isNet
        ? `无法访问本地 Helper (${helperBase})`
        : e instanceof Error
        ? e.message
        : "停止失败";
      setLaunch({ status: "failed", message: msg, at: Date.now() });
    }
  }

  // 启用 CDP 或参数变化时自动测一次（去抖）
  useEffect(() => {
    if (!cfg.devFullCdp) {
      setProbe({ status: "idle" });
      return;
    }
    const t = setTimeout(() => {
      runProbe();
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.devFullCdp, cfg.host, cfg.port]);





  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Globe className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <div className="text-2xl font-semibold tracking-tight">Google Chrome</div>
            <div className="mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              {cfg.connected ? "已连接" : "未连接"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onSave}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            重新安装扩展程序
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onChange({ ...cfg, connected: false })}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            移除扩展程序
          </Button>
        </div>
      </div>

      {saved && (
        <div className={`text-[11px] ${saved === "ok" ? "text-emerald-400" : "text-destructive"}`}>
          {saved === "ok" ? "已保存" : "保存失败"}
        </div>
      )}

      {/* Permissions */}
      <section className="space-y-3">
        <div className="text-sm font-semibold text-foreground">权限</div>
        <div className="rounded-xl border border-border bg-surface-1 divide-y divide-border overflow-hidden">
          {permRows.map((row) => (
            <div key={row.key} className="flex items-center gap-3 p-4">
              <div className="w-8 h-8 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
                <row.icon className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{row.title}</div>
                <div className="text-xs text-muted-foreground">{row.hint}</div>
              </div>
              <Select
                value={cfg.permissions[row.key]}
                onValueChange={(v) =>
                  onChange({ ...cfg, permissions: { ...cfg.permissions, [row.key]: v as ChromePermRule } })
                }
              >
                <SelectTrigger className="w-32 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {permOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </section>

      {/* Site Permissions */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">网站权限</div>
            <div className="text-xs text-muted-foreground">为特定网站覆盖上述默认设置</div>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface-1 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={newSitePattern}
              onChange={(e) => setNewSitePattern(e.target.value)}
              placeholder="例如：https://github.com/*"
              className="h-8 text-xs flex-1"
              onKeyDown={(e) => e.key === "Enter" && addSite()}
            />
            <Select value={newSiteRule} onValueChange={(v) => setNewSiteRule(v as ChromePermRule)}>
              <SelectTrigger className="w-28 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {permOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={addSite}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              添加
            </Button>
          </div>

          {cfg.sitePerms.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">
              尚无网站专属权限
            </div>
          ) : (
            <div className="divide-y divide-border">
              {cfg.sitePerms.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-2">
                  <span className="text-xs font-mono flex-1 truncate">{s.pattern}</span>
                  <Select
                    value={s.rule}
                    onValueChange={(v) =>
                      onChange({
                        ...cfg,
                        sitePerms: cfg.sitePerms.map((x) => (x.id === s.id ? { ...x, rule: v as ChromePermRule } : x)),
                      })
                    }
                  >
                    <SelectTrigger className="w-28 h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {permOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    onClick={() => removeSite(s.id)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"
                    aria-label="移除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Developer Mode */}
      <section className="space-y-3">
        <div className="text-sm font-semibold text-foreground">开发者模式</div>
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.03] p-4 space-y-3">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5" />
            风险升高
          </div>
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">启用完整 CDP 访问权限</div>
              <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                允许 Sentinel 在已连接的 Browser Use 会话中使用完整的 Chrome DevTools Protocol (CDP) 访问权限。完整 CDP 访问权限可让 Sentinel 检查并控制敏感的浏览器内部功能，可能使你的数据面临风险。
              </div>
            </div>
            <Switch
              checked={cfg.devFullCdp}
              onCheckedChange={(v) => onChange({ ...cfg, devFullCdp: v })}
            />
          </div>

          {cfg.devFullCdp && (
            <div className="pt-3 border-t border-amber-500/20 space-y-3">
              <div className="text-xs text-muted-foreground">远程调试参数</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">监听地址 (host)</Label>
                  <Input
                    value={cfg.host}
                    onChange={(e) => onChange({ ...cfg, host: e.target.value })}
                    placeholder="127.0.0.1"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">调试端口 (port)</Label>
                  <Input
                    value={cfg.port}
                    onChange={(e) => onChange({ ...cfg, port: e.target.value.replace(/\D/g, "") })}
                    placeholder="9222"
                    inputMode="numeric"
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">用户数据目录 (--user-data-dir)</Label>
                <Input
                  value={cfg.userDataDir}
                  onChange={(e) => onChange({ ...cfg, userDataDir: e.target.value })}
                  placeholder="例如：C:\\ChromeDebug 或 /tmp/chrome-debug"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Chrome 可执行文件路径 (可选)</Label>
                <Input
                  value={cfg.binaryPath}
                  onChange={(e) => onChange({ ...cfg, binaryPath: e.target.value })}
                  placeholder="留空使用系统默认"
                  className="h-8 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">附加启动参数</Label>
                <Textarea
                  value={cfg.extraFlags}
                  onChange={(e) => onChange({ ...cfg, extraFlags: e.target.value })}
                  rows={2}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">启动命令预览</Label>
                <div className="p-2 rounded-md bg-surface-2 border border-border font-mono text-[11px] break-all">
                  {launchCmd}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  DevTools 端点:{" "}
                  <a
                    href={endpointUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline decoration-dotted hover:text-foreground"
                  >
                    {endpointUrl}
                  </a>
                </div>
              </div>

              {/* 一键启动 / 停止 */}
              <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 min-w-[180px]">
                    <div className="text-xs font-semibold text-foreground">一键启动 / 停止</div>
                    <div className="text-[11px] text-muted-foreground">
                      通过本地 Helper 启动 Chrome,启动后自动验证 DevTools 端点
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">

                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={checkHelper}
                      disabled={helperCheck.status === "checking"}
                      className="h-8 text-xs"
                      title="探测本地 Helper 是否可访问"
                    >
                      {helperCheck.status === "checking" ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                          检查中…
                        </>
                      ) : (
                        <>
                          {helperCheck.status === "ok" ? (
                            <Wifi className="w-3.5 h-3.5 mr-1 text-emerald-500" />
                          ) : helperCheck.status === "err" ? (
                            <WifiOff className="w-3.5 h-3.5 mr-1 text-destructive" />
                          ) : (
                            <Wifi className="w-3.5 h-3.5 mr-1" />
                          )}
                          检查 Helper
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      onClick={startChrome}
                      disabled={launch.status === "starting" || launch.status === "verifying" || launch.status === "stopping"}
                      className="h-8 text-xs"
                    >
                      {launch.status === "starting" || launch.status === "verifying" ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <Zap className="w-3.5 h-3.5 mr-1" />
                      )}
                      启动 Chrome
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={stopChrome}
                      disabled={launch.status === "starting" || launch.status === "verifying" || launch.status === "stopping"}
                      className="h-8 text-xs"
                    >
                      {launch.status === "stopping" ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <Square className="w-3.5 h-3.5 mr-1" />
                      )}
                      停止 Chrome
                    </Button>
                  </div>
                </div>

                {/* Helper 检查状态区（持续显示，不依赖 toast） */}
                <div
                  className={`rounded-md border p-2 text-[11px] space-y-1 ${
                    helperCheck.status === "ok"
                      ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
                      : helperCheck.status === "err"
                        ? "border-destructive/50 bg-destructive/5 text-destructive"
                        : helperCheck.status === "checking"
                          ? "border-border bg-surface-1/60 text-muted-foreground"
                          : "border-border/60 bg-surface-1/40 text-muted-foreground"
                  }`}
                  aria-live="polite"
                >
                  {helperCheck.status === "idle" && (
                    <div className="flex items-center gap-1.5">
                      <Wifi className="w-3 h-3" /> 尚未检查 — 点击「检查 Helper」进行探测
                    </div>
                  )}
                  {helperCheck.status === "checking" && (
                    <div className="flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> 正在检查 Helper…（超时 8s）
                    </div>
                  )}
                  {helperCheck.status === "ok" && (
                    <>
                      <div className="flex items-center gap-1.5 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Helper 已连接
                      </div>
                      <div className="font-mono text-[10px] opacity-80">地址：{helperCheck.diag.url}</div>
                      <div className="font-mono text-[10px] opacity-80">
                        状态：HTTP {helperCheck.diag.httpStatus} · 耗时 {helperCheck.latency}ms
                      </div>
                      <div className="font-mono text-[10px] opacity-80">
                        响应：name=sentinel-helper · ok=true · port=9223
                      </div>
                      <div className="text-[10px] opacity-70">
                        检查时间：{new Date(helperCheck.at).toLocaleTimeString()}
                      </div>
                    </>
                  )}
                  {helperCheck.status === "err" && (
                    <>
                      <div className="flex items-center gap-1.5 font-medium">
                        <XCircle className="w-3.5 h-3.5" /> Helper 连接失败
                      </div>
                      <div className="font-mono text-[10px] opacity-90">请求地址：{helperCheck.diag.url}</div>
                      <div className="opacity-90">错误：{helperCheck.message}</div>
                      {helperCheck.diag.browserError && (
                        <div className="font-mono text-[10px] opacity-80">
                          原始错误：{helperCheck.diag.browserError}
                        </div>
                      )}
                      <div className="font-mono text-[10px] opacity-80">
                        HTTP：{helperCheck.diag.httpStatus ?? "—"} · 耗时 {helperCheck.latency}ms · 时间{" "}
                        {new Date(helperCheck.at).toLocaleTimeString()}
                      </div>
                    </>
                  )}
                </div>


                <div className="space-y-1">
                  <Label className="text-xs">本地 Helper 地址</Label>
                  <Input
                    value={cfg.helperBase ?? "http://127.0.0.1:9223"}
                    onChange={(e) => onChange({ ...cfg, helperBase: e.target.value })}
                    placeholder="http://127.0.0.1:9223"
                    className="h-8 text-xs font-mono"
                  />
                  <div className="text-[11px] text-muted-foreground">
                    Helper 需暴露 <span className="font-mono">POST /launch</span> 与
                    <span className="font-mono"> POST /stop</span>，接收 JSON 参数并本地启动/结束 Chrome 进程
                  </div>
                </div>

                {launch.status !== "idle" && (
                  <div className="pt-2 border-t border-border/60 text-[11px]">
                    {launch.status === "starting" && (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> {launch.step}
                      </div>
                    )}
                    {launch.status === "verifying" && (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        正在验证 DevTools 端点… (第 {launch.attempts} 次)
                      </div>
                    )}
                    {launch.status === "started" && (
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Chrome 已启动并可通过 CDP 连接 · {new Date(launch.at).toLocaleTimeString()}
                      </div>
                    )}
                    {launch.status === "stopping" && (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> 正在停止 Chrome…
                      </div>
                    )}
                    {launch.status === "stopped" && (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Chrome 已停止 · {new Date(launch.at).toLocaleTimeString()}
                      </div>
                    )}
                    {launch.status === "failed" && (
                      <div className="flex items-start gap-1.5 text-destructive">
                        <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>{launch.message}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Playwright 执行 — 新手模式（默认） + 高级模式 */}
              <PwSection
                helperBase={helperBase}
                attach={{ host: cfg.host, port: cfg.port }}
                selectedFile={selectedFile}
              />


              {/* 本地文件浏览 / 上传 / 预览 */}
              <FileBrowser
                helperBase={helperBase}
                onSelect={setSelectedFile}
                selectedPath={selectedFile?.path ?? null}
              />


              {/* 连接状态 */}



              <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {probe.status === "probing" ? (
                      <>
                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                        <span className="text-xs text-muted-foreground">正在探测 DevTools 端点…</span>
                      </>
                    ) : probe.status === "ok" ? (
                      <>
                        <Wifi className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs text-emerald-400 font-medium">端点可达</span>
                        <span className="text-[11px] text-muted-foreground">
                          · 延迟 <span className="font-mono text-foreground">{probe.latency} ms</span>
                        </span>
                      </>
                    ) : probe.status === "err" ? (
                      <>
                        <WifiOff className="w-4 h-4 text-destructive" />
                        <span className="text-xs text-destructive font-medium">无法连接</span>
                        <span className="text-[11px] text-muted-foreground">
                          · 用时 <span className="font-mono">{probe.latency} ms</span>
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">尚未测试</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={runProbe}
                    disabled={probe.status === "probing"}
                    className="h-7 text-xs"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 mr-1 ${probe.status === "probing" ? "animate-spin" : ""}`} />
                    测试连接
                  </Button>
                </div>

                {probe.status === "ok" && (
                  <div className="space-y-1 pt-1 border-t border-border/60">
                    {probe.browser && (
                      <div className="text-[11px] text-muted-foreground">
                        浏览器: <span className="font-mono text-foreground">{probe.browser}</span>
                      </div>
                    )}
                    {probe.webSocketDebuggerUrl && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        WS: <span className="font-mono text-foreground">{probe.webSocketDebuggerUrl}</span>
                      </div>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      更新于 {new Date(probe.at).toLocaleTimeString()}
                    </div>
                  </div>
                )}

                {probe.status === "err" && (
                  <div className="space-y-1 pt-1 border-t border-border/60">
                    <div className="text-[11px] text-destructive">{probe.message}</div>
                    <div className="text-[11px] text-muted-foreground leading-relaxed">
                      提示：请确认 Chrome 已加参数启动，并允许当前源访问 —
                      追加 <span className="font-mono">--remote-allow-origins={window.location.origin}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={onReset}>恢复默认</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigator.clipboard?.writeText(launchCmd)}
                >
                  复制命令
                </Button>
              </div>

            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function PwSection({
  helperBase,
  attach,
  selectedFile,
}: {
  helperBase: string;
  attach: { host: string; port: string };
  selectedFile: SelectedFile | null;
}) {
  const [mode, setMode] = useState<"beginner" | "advanced">(() => {
    try {
      const v = localStorage.getItem("sentinel:playwright:mode");
      if (v === "advanced" || v === "beginner") return v;
    } catch { /* ignore */ }
    return "beginner";
  });
  useEffect(() => {
    try { localStorage.setItem("sentinel:playwright:mode", mode); } catch { /* ignore */ }
  }, [mode]);

  if (mode === "beginner") {
    return (
      <PlaywrightBeginner
        helperBase={helperBase}
        attach={attach}
        onOpenAdvanced={() => setMode("advanced")}
      />
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={() => setMode("beginner")}
        >
          ← 返回新手模式
        </Button>
      </div>
      <PlaywrightRunner helperBase={helperBase} attach={attach} selectedFile={selectedFile} />
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
  const [prefs, setPrefs] = useState({ plugins: true, browser: true, computer: false, chrome: true });
  const [section, setSection] = useState<SettingsSectionKey>("integrations");
  const [chromeOpen, setChromeOpen] = useState(false);
  type ChromePermRule = "ask" | "allow" | "deny";
  type SitePerm = { id: string; pattern: string; rule: ChromePermRule };
  type ChromeCfg = {
    host: string;
    port: string;
    userDataDir: string;
    binaryPath: string;
    extraFlags: string;
    connected: boolean;
    permissions: {
      approval: ChromePermRule;
      history: ChromePermRule;
      download: ChromePermRule;
      upload: ChromePermRule;
    };
    sitePerms: SitePerm[];
    devFullCdp: boolean;
    helperBase?: string;
  };
  const DEFAULT_CHROME: ChromeCfg = {
    host: "127.0.0.1",
    port: "9222",
    userDataDir: "",
    binaryPath: "",
    extraFlags: "--no-first-run --no-default-browser-check",
    connected: true,
    permissions: { approval: "ask", history: "ask", download: "ask", upload: "ask" },
    sitePerms: [],
    devFullCdp: false,
    helperBase: "http://127.0.0.1:9223",
  };

  const [chromeCfg, setChromeCfg] = useState<ChromeCfg>(DEFAULT_CHROME);
  const [chromeSaved, setChromeSaved] = useState<null | "ok" | "err">(null);
  const [newSitePattern, setNewSitePattern] = useState("");
  const [newSiteRule, setNewSiteRule] = useState<ChromePermRule>("ask");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("sentinel:integrations");
      if (saved) setPrefs((p) => ({ ...p, ...JSON.parse(saved) }));
      const c = localStorage.getItem("sentinel:chrome");
      if (c) setChromeCfg((prev) => ({ ...prev, ...JSON.parse(c) }));
    } catch {}
  }, []);

  function update(k: keyof typeof prefs, v: boolean) {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    try {
      localStorage.setItem("sentinel:integrations", JSON.stringify(next));
    } catch {}
  }

  function persistChrome(next: ChromeCfg) {
    setChromeCfg(next);
    try {
      localStorage.setItem("sentinel:chrome", JSON.stringify(next));
      setChromeSaved("ok");
    } catch {
      setChromeSaved("err");
    }
    setTimeout(() => setChromeSaved(null), 1500);
  }
  function saveChrome() { persistChrome(chromeCfg); }
  function resetChrome() { persistChrome(DEFAULT_CHROME); }

  const chromeLaunchCmd = useMemo(() => {
    const parts = [
      chromeCfg.binaryPath || "chrome",
      `--remote-debugging-port=${chromeCfg.port || "9222"}`,
      `--remote-debugging-address=${chromeCfg.host || "127.0.0.1"}`,
    ];
    if (chromeCfg.userDataDir) parts.push(`--user-data-dir="${chromeCfg.userDataDir}"`);
    if (chromeCfg.extraFlags?.trim()) parts.push(chromeCfg.extraFlags.trim());
    return parts.join(" ");
  }, [chromeCfg]);

  const PERM_OPTIONS: { value: ChromePermRule; label: string }[] = [
    { value: "ask", label: "始终询问" },
    { value: "allow", label: "始终允许" },
    { value: "deny", label: "始终拒绝" },
  ];

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
    {
      key: "chrome" as const,
      icon: Globe,
      title: "Google Chrome",
      hint: "已连接到浏览器扩展程序，可进行更多控制",
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      manage: true,
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
      <DialogContent className="!max-w-[min(1100px,95vw)] w-[min(1100px,95vw)] p-0 gap-0 overflow-hidden">
        <div className="flex flex-col sm:flex-row h-[min(85vh,720px)]">
          {/* Left nav */}
          <div className="w-full sm:w-52 shrink-0 border-b sm:border-b-0 sm:border-r border-border bg-surface-1/50 p-2 overflow-x-auto sm:overflow-y-auto flex sm:block gap-1 sm:gap-0">
            <div className="hidden sm:block px-2 py-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
              设置
            </div>
            {SETTINGS_SECTIONS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                className={`shrink-0 sm:w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition ${
                  section === s.key
                    ? "bg-signal/15 text-signal"
                    : "text-foreground/80 hover:bg-white/5"
                }`}
              >
                <s.icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
            <div className="hidden sm:block mt-3 pt-3 border-t border-border">
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
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">

            <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
              {section === "integrations" && chromeOpen ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => setChromeOpen(false)}
                    className="inline-flex items-center gap-1 hover:text-foreground transition"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    电脑操控
                  </button>
                  <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                  <span className="text-foreground">Google Chrome</span>
                </div>
              ) : (
                <>
                  <DialogTitle className="text-lg">
                    {SETTINGS_SECTIONS.find((s) => s.key === section)?.label}
                  </DialogTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {SETTINGS_SECTIONS.find((s) => s.key === section)?.hint}
                  </p>
                </>
              )}
            </DialogHeader>

            <div className="flex-1 overflow-y-auto p-6">
              {section === "integrations" && !chromeOpen && (
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
                      {"manage" in it && it.manage ? (
                        <button
                          type="button"
                          onClick={() => setChromeOpen(true)}
                          className="px-2.5 py-1 rounded-md text-xs border border-border bg-surface-2 hover:bg-white/5 text-foreground transition"
                        >
                          管理
                        </button>
                      ) : null}
                      <Switch
                        checked={prefs[it.key]}
                        onCheckedChange={(v) => update(it.key, v)}
                      />
                    </div>
                  ))}
                </div>
              )}

              {section === "integrations" && chromeOpen && (
                <ChromeManagePanel
                  cfg={chromeCfg}
                  onChange={persistChrome}
                  launchCmd={chromeLaunchCmd}
                  saved={chromeSaved}
                  onSave={saveChrome}
                  onReset={resetChrome}
                  permOptions={PERM_OPTIONS}
                  newSitePattern={newSitePattern}
                  setNewSitePattern={setNewSitePattern}
                  newSiteRule={newSiteRule}
                  setNewSiteRule={setNewSiteRule}
                />
              )}

              {section === "mcp" && <McpConnectionsPanel />}


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
                    { title: "默认模型", hint: "新会话默认使用的模型（可在合成器右下角切换）", action: "text", storeKey: "model:default", value: "gpt-image-2" },
                    { title: "温度 (Temperature)", hint: "较低更稳定，较高更有创造力", action: "text", storeKey: "model:temperature", value: "0.7" },
                    { title: "最大输出长度", hint: "单次响应的最大 Token 数", action: "text", storeKey: "model:maxTokens", value: "4096" },
                    { title: "流式响应", hint: "以流式方式逐步返回结果", action: "toggle", storeKey: "model:stream", defaultOn: true },
                  ]}
                />
              )}

              {section === "assistant" && (
                <SettingsPanel
                  rows={[
                    { title: "助理昵称", hint: "自定义 Sentinel 在对话中的称呼", action: "text", storeKey: "assistant:name", value: "Sentinel" },
                    { title: "系统提示词", hint: "追加到每次对话开头的指令", action: "text", storeKey: "assistant:system", value: "简洁、专业、可执行" },
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

type SettingsSectionKey = "integrations" | "mcp" | "memory" | "model" | "assistant" | "data" | "security";

const SETTINGS_SECTIONS: Array<{
  key: SettingsSectionKey;
  label: string;
  hint: string;
  icon: typeof Monitor;
}> = [
  { key: "integrations", label: "电脑操控", hint: "管理 Sentinel 如何使用你电脑上的其他应用程序", icon: Monitor },
  { key: "mcp", label: "MCP 连接", hint: "管理已授权访问 Sentinel OS 的外部客户端（ChatGPT / Claude / WorkBuddy 等）", icon: Plug },
  { key: "memory", label: "记忆", hint: "管理 Sentinel 记住的偏好与上下文", icon: Lightbulb },
  { key: "model", label: "模型", hint: "为新会话选择默认模型与生成参数", icon: Box },
  { key: "assistant", label: "助理设置", hint: "自定义助理的行为与个性", icon: UserCog },
  { key: "data", label: "数据管理", hint: "管理你分享的文件、任务与应用", icon: Database },
  { key: "security", label: "安全中心", hint: "账户安全、设备与密钥", icon: Shield },
];

type PanelRow =
  | { title: string; hint: string; action: "toggle"; storeKey: string; defaultOn: boolean }
  | { title: string; hint: string; action: "button"; buttonLabel: string; danger?: boolean }
  | { title: string; hint: string; action: "text"; storeKey: string; value: string };

function SettingsPanel({ rows }: { rows: PanelRow[] }) {
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  useEffect(() => {
    const nextT: Record<string, boolean> = {};
    const nextS: Record<string, string> = {};
    for (const r of rows) {
      if (r.action === "toggle") {
        try {
          const v = localStorage.getItem(`sentinel:${r.storeKey}`);
          nextT[r.storeKey] = v === null ? r.defaultOn : v === "1";
        } catch {
          nextT[r.storeKey] = r.defaultOn;
        }
      } else if (r.action === "text") {
        try {
          const v = localStorage.getItem(`sentinel:${r.storeKey}`);
          nextS[r.storeKey] = v === null ? r.value : v;
        } catch {
          nextS[r.storeKey] = r.value;
        }
      }
    }
    setToggles(nextT);
    setTexts(nextS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setToggle(key: string, v: boolean) {
    setToggles((t) => ({ ...t, [key]: v }));
    try {
      localStorage.setItem(`sentinel:${key}`, v ? "1" : "0");
    } catch {}
  }

  function setText(key: string, v: string) {
    setTexts((t) => ({ ...t, [key]: v }));
    try {
      localStorage.setItem(`sentinel:${key}`, v);
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
            <Input
              value={texts[r.storeKey] ?? ""}
              onChange={(e) => setText(r.storeKey, e.target.value)}
              className="h-8 text-xs font-mono max-w-[180px] bg-background/50"
            />
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

type PluginTab = "plugins" | "skills" | "mcp";
type PluginScope = "public" | "personal";

type MarketPlugin = {
  id: string;
  name: string;
  hint: string;
  icon: typeof Puzzle;
  color: string;
  bg: string;
  featured?: boolean;
  scope: PluginScope;
  installed?: boolean;
  description: string;
  capabilities: string[];
  permissions: Array<{ label: string; level: "read" | "write" | "system" }>;
  version?: string;
  author?: string;
};

const MARKET_PLUGINS: MarketPlugin[] = [
  {
    id: "computer-use", name: "Computer Use", hint: "从 Sentinel 控制 Windows 应用", icon: Monitor,
    color: "text-signal", bg: "bg-signal/15", featured: true, scope: "public", installed: true,
    version: "1.4.0", author: "Sentinel Labs",
    description: "让 Sentinel 直接操作你电脑上的桌面应用：定位窗口、点击控件、录入文本、读取屏幕内容并串联多步操作。适合把日常重复的桌面流程自动化。",
    capabilities: ["截屏与识别界面元素", "鼠标点击 / 拖拽 / 悬停", "键盘输入与快捷键", "跨应用多步自动化", "读取窗口标题与前台状态"],
    permissions: [
      { label: "读取屏幕内容", level: "read" },
      { label: "模拟鼠标与键盘操作", level: "system" },
      { label: "启动本地应用程序", level: "system" },
    ],
  },
  {
    id: "chrome", name: "Chrome", hint: "使用 Sentinel 控制 Chrome 浏览器", icon: Globe,
    color: "text-blue-400", bg: "bg-blue-500/15", featured: true, scope: "public", installed: true,
    version: "2.1.0", author: "Sentinel Labs",
    description: "通过浏览器扩展接管 Chrome：打开与切换标签、点击链接、填写表单、读取 DOM，把网页操作纳入 Sentinel 的工作流。",
    capabilities: ["打开、切换、关闭标签页", "点击、填写、提交网页元素", "读取页面 DOM 与网络请求", "抓取结构化数据", "跨站点多步任务"],
    permissions: [
      { label: "读取所有网站的浏览数据", level: "read" },
      { label: "修改页面内容", level: "write" },
      { label: "管理下载与 Cookie", level: "system" },
    ],
  },
  {
    id: "spreadsheets", name: "Spreadsheets", hint: "创建和编辑表格文件", icon: FileSpreadsheet,
    color: "text-emerald-400", bg: "bg-emerald-500/15", featured: true, scope: "public",
    version: "0.9.2", author: "Sentinel Labs",
    description: "生成、编辑与分析 Excel / CSV 表格。可写入公式、创建图表、批量清洗数据，并把结果保存到本地或云端。",
    capabilities: ["新建 / 打开 xlsx、csv 文件", "写入单元格、公式与样式", "创建数据透视表与图表", "批量清洗与转换", "导出 PDF"],
    permissions: [
      { label: "读取指定表格文件", level: "read" },
      { label: "写入并保存表格文件", level: "write" },
    ],
  },
  {
    id: "presentations", name: "Presentations", hint: "创建和编辑演示文稿", icon: Presentation,
    color: "text-orange-400", bg: "bg-orange-500/15", featured: true, scope: "public",
    version: "0.7.1", author: "Sentinel Labs",
    description: "起草与迭代 PPTX 演示文稿：结构化生成大纲、套用主题、插入图片与图表，并按修改建议自动调整版式。",
    capabilities: ["生成幻灯片大纲", "按主题排版并统一样式", "插入图片、图标与图表", "根据反馈迭代修改", "导出 PPTX / PDF"],
    permissions: [
      { label: "读取模板文件", level: "read" },
      { label: "写入演示文稿", level: "write" },
    ],
  },
  {
    id: "data-analytics", name: "Data Analytics", hint: "回答产品与业务分析问题", icon: BarChart3,
    color: "text-cyan-400", bg: "bg-cyan-500/15", featured: true, scope: "public",
    version: "1.0.3", author: "Sentinel Labs",
    description: "连接你的数据仓库，直接用自然语言提问：Sentinel 会写 SQL、跑查询、生成图表和摘要洞察。",
    capabilities: ["自然语言转 SQL", "运行只读查询", "自动生成图表与看板", "指标对比与异常检测", "导出报告"],
    permissions: [
      { label: "读取已连接数据库的表结构", level: "read" },
      { label: "执行只读 SQL 查询", level: "read" },
    ],
  },
  {
    id: "github", name: "GitHub", hint: "处理 PR、Issue、CI 与发布流程", icon: Github,
    color: "text-foreground", bg: "bg-white/10", featured: true, scope: "public", installed: true,
    version: "1.2.5", author: "Sentinel Labs",
    description: "在 Sentinel 中管理仓库：浏览 PR / Issue、审查代码、触发 CI、创建发布，并把上下文串到你的任务里。",
    capabilities: ["浏览仓库、分支与提交", "创建 / 审阅 / 合并 PR", "管理 Issue 与 Label", "查看与触发 GitHub Actions", "创建 Release 与 Tag"],
    permissions: [
      { label: "读取你的仓库、PR 与 Issue", level: "read" },
      { label: "创建评论、PR 与 Issue", level: "write" },
      { label: "触发 Actions 与发布", level: "system" },
    ],
  },
  {
    id: "notion", name: "Notion", hint: "把 Notion 页面作为上下文", icon: FileText,
    color: "text-foreground", bg: "bg-white/10", scope: "public",
    version: "0.6.0", author: "Community",
    description: "把 Notion 工作区接入 Sentinel：检索页面、追加内容、创建数据库条目，作为 Agent 的长期知识库。",
    capabilities: ["搜索页面与数据库", "创建 / 更新页面", "写入数据库条目", "抽取结构化字段"],
    permissions: [
      { label: "读取已授权的 Notion 页面", level: "read" },
      { label: "写入 Notion 页面与数据库", level: "write" },
    ],
  },
  {
    id: "linear", name: "Linear", hint: "把 Linear Issue 作为上下文", icon: Wrench,
    color: "text-violet-400", bg: "bg-violet-500/15", scope: "public",
    version: "0.5.2", author: "Community",
    description: "让 Sentinel 在 Linear 中查阅、创建与推进 Issue：按项目 / 团队筛选，自动补全描述，并同步状态与评论。",
    capabilities: ["查询团队与项目下的 Issue", "创建与更新 Issue", "撰写和回复评论", "变更状态与负责人"],
    permissions: [
      { label: "读取工作区的 Issue", level: "read" },
      { label: "创建与修改 Issue", level: "write" },
    ],
  },
];

const MARKET_SKILLS: MarketPlugin[] = [
  {
    id: "skill-image-gen", name: "Image Gen", hint: "为网站与文档生成或编辑图片", icon: ImageIcon,
    color: "text-sky-400", bg: "bg-sky-500/15", featured: true, scope: "public", installed: true,
    version: "1.0.0", author: "Sentinel Labs",
    description: "调用图像模型生成插画、封面、示意图,或对已有图片进行局部编辑、扩展和风格迁移。",
    capabilities: ["文本生成图片", "局部重绘 / 扩图", "风格化转换", "批量生成变体"],
    permissions: [
      { label: "读取参考图片", level: "read" },
      { label: "写入生成的图片", level: "write" },
    ],
  },
  {
    id: "skill-openai-docs", name: "OpenAI Docs", hint: "在回答前查阅 OpenAI 官方文档", icon: BookOpen,
    color: "text-emerald-400", bg: "bg-emerald-500/15", featured: true, scope: "public", installed: true,
    version: "0.8.1", author: "Sentinel Labs",
    description: "为 Agent 提供 OpenAI 官方文档检索能力,回答 API、模型、SDK 相关问题时优先引用最新文档。",
    capabilities: ["按关键字检索文档", "抽取代码示例", "对比不同模型能力", "引用带来源的答案"],
    permissions: [
      { label: "访问公开文档站点", level: "read" },
    ],
  },
  {
    id: "skill-plugin-creator", name: "Plugin Creator", hint: "脚手架化生成插件与市场条目", icon: PenSquare,
    color: "text-orange-400", bg: "bg-orange-500/15", featured: true, scope: "public", installed: true,
    version: "0.4.0", author: "Sentinel Labs",
    description: "按模板快速创建插件工程:生成清单、权限声明、示例工具和市场卡片,支持一键提交到插件市场。",
    capabilities: ["生成插件目录结构", "编写 manifest 与权限声明", "创建示例 tool handler", "生成市场卡片"],
    permissions: [
      { label: "读写本地工程文件", level: "write" },
    ],
  },
  {
    id: "skill-skill-creator", name: "Skill Creator", hint: "创建或更新一项技能", icon: PenSquare,
    color: "text-violet-400", bg: "bg-violet-500/15", featured: true, scope: "public", installed: true,
    version: "0.5.2", author: "Sentinel Labs",
    description: "以对话方式创建 / 修改技能:自动生成 SKILL.md、references 与 scripts,并校验命名与描述规范。",
    capabilities: ["生成 SKILL.md 骨架", "整理 references 目录", "写入示例脚本", "校验命名与描述"],
    permissions: [
      { label: "读取现有技能", level: "read" },
      { label: "写入技能目录", level: "write" },
    ],
  },
  {
    id: "skill-skill-installer", name: "Skill Installer", hint: "从技能仓库安装精选技能", icon: Puzzle,
    color: "text-rose-400", bg: "bg-rose-500/15", featured: true, scope: "public", installed: true,
    version: "0.3.4", author: "Sentinel Labs",
    description: "从官方技能仓库检索、下载并安装精选技能,自动完成依赖检查与激活。",
    capabilities: ["搜索技能仓库", "下载并解压技能包", "校验依赖与权限", "一键激活"],
    permissions: [
      { label: "访问官方技能仓库", level: "read" },
      { label: "写入技能目录", level: "write" },
    ],
  },
  {
    id: "skill-web-research", name: "Web Research", hint: "多源检索并汇总网页信息", icon: Globe,
    color: "text-cyan-400", bg: "bg-cyan-500/15", scope: "public",
    version: "0.2.0", author: "Community",
    description: "在多个搜索引擎与站点之间检索,并把结果去重、摘要为带引用的答案。",
    capabilities: ["多引擎检索", "网页抓取与清洗", "去重与摘要", "生成引用列表"],
    permissions: [
      { label: "访问公开网页", level: "read" },
    ],
  },
];

const MARKET_MCPS: MarketPlugin[] = [
  {
    id: "mcp-cc6", name: "cc6", hint: "接入 cc6 平台的对外 MCP 服务(每用户 OAuth)", icon: Server,
    color: "text-signal", bg: "bg-signal/15", featured: true, scope: "public",
    version: "0.1.0", author: "cc6",
    description: "通过 Streamable HTTP 连接 cc6 平台的 MCP Server:每个用户单独完成 OAuth 授权,后端代为调用 search_resources、list_categories 等只读工具,授权后可解锁个人能力查询。",
    capabilities: ["search_resources — 检索资源", "get_mcp_detail — 查看 MCP 详情", "list_categories — 分类列表", "list_ranking — 排行榜", "export_full_catalog — 导出目录", "授权后:search_my_capabilities 等"],
    permissions: [
      { label: "读取 cc6 公开目录", level: "read" },
      { label: "以你的身份调用 cc6 工具", level: "write" },
    ],
  },
  {
    id: "mcp-notion", name: "Notion", hint: "把 Notion 页面接入 Agent 上下文", icon: FileText,
    color: "text-foreground", bg: "bg-white/10", featured: true, scope: "public", installed: true,
    version: "1.0.0", author: "Notion",
    description: "通过官方 MCP Server 连接 Notion:检索页面、追加内容、写入数据库,让 Agent 把 Notion 作为长期知识库。",
    capabilities: ["搜索页面与数据库", "读取页面内容", "创建 / 更新页面", "写入数据库条目"],
    permissions: [
      { label: "读取已授权的 Notion 页面", level: "read" },
      { label: "写入 Notion 页面与数据库", level: "write" },
    ],
  },
  {
    id: "mcp-linear", name: "Linear", hint: "查询与推进 Linear Issue", icon: Wrench,
    color: "text-violet-400", bg: "bg-violet-500/15", featured: true, scope: "public", installed: true,
    version: "0.9.0", author: "Linear",
    description: "让 Agent 通过 MCP 直接读取和修改 Linear 工作区:按团队 / 项目筛选 Issue、创建任务、更新状态和评论。",
    capabilities: ["查询 Issue 与项目", "创建 / 修改 Issue", "撰写评论", "变更状态与负责人"],
    permissions: [
      { label: "读取工作区 Issue", level: "read" },
      { label: "创建与修改 Issue", level: "write" },
    ],
  },
  {
    id: "mcp-sentry", name: "Sentry", hint: "检索错误与性能事件", icon: Shield,
    color: "text-orange-400", bg: "bg-orange-500/15", featured: true, scope: "public",
    version: "0.6.2", author: "Sentry",
    description: "从 Sentry 拉取事件、堆栈、Release 与性能数据,辅助 Agent 定位线上问题。",
    capabilities: ["检索 Issue 与事件", "读取堆栈与面包屑", "查看 Release", "关联到源码"],
    permissions: [
      { label: "读取 Sentry 项目数据", level: "read" },
    ],
  },
  {
    id: "mcp-supabase", name: "Supabase", hint: "查询数据库与项目元数据", icon: Database,
    color: "text-emerald-400", bg: "bg-emerald-500/15", featured: true, scope: "public",
    version: "1.1.0", author: "Supabase",
    description: "通过 MCP 访问 Supabase 项目:执行只读 SQL、检查 schema、读取 Edge Function 日志。",
    capabilities: ["执行只读 SQL", "读取表结构", "查看日志", "列出 Edge Functions"],
    permissions: [
      { label: "读取项目元数据", level: "read" },
      { label: "执行只读 SQL 查询", level: "read" },
    ],
  },
  {
    id: "mcp-github", name: "GitHub", hint: "读取仓库、PR、Issue", icon: Github,
    color: "text-foreground", bg: "bg-white/10", scope: "public",
    version: "0.8.4", author: "GitHub",
    description: "官方 GitHub MCP Server:浏览仓库、检索 PR / Issue、读取文件内容。",
    capabilities: ["浏览仓库与分支", "检索 PR / Issue", "读取文件内容", "查看 Actions 状态"],
    permissions: [
      { label: "读取仓库与 PR", level: "read" },
    ],
  },
  {
    id: "mcp-slack", name: "Slack", hint: "读取频道消息与发送通知", icon: MessageCircle,
    color: "text-cyan-400", bg: "bg-cyan-500/15", scope: "public",
    version: "0.4.1", author: "Community",
    description: "让 Agent 读取指定频道的历史消息并向频道 / 用户发送通知。",
    capabilities: ["读取频道消息", "搜索历史消息", "发送频道消息", "发送私信"],
    permissions: [
      { label: "读取已授权的频道", level: "read" },
      { label: "发送消息", level: "write" },
    ],
  },
];





function PluginMarketplaceDialog({
  open,
  onOpenChange,
  onOpenMcpSheet,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenMcpSheet: () => void;
}) {
  const [tab, setTab] = useState<PluginTab>("plugins");
  const [scope, setScope] = useState<PluginScope>("public");
  const [q, setQ] = useState("");
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [installedSkills, setInstalledSkills] = useState<Record<string, boolean>>({});
  const [installedMcps, setInstalledMcps] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<MarketPlugin | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("sentinel:plugins:installed");
      if (raw) setInstalled(JSON.parse(raw));
      else {
        const seed: Record<string, boolean> = {};
        for (const p of MARKET_PLUGINS) if (p.installed) seed[p.id] = true;
        setInstalled(seed);
      }
      const rawSk = localStorage.getItem("sentinel:skills:installed");
      if (rawSk) setInstalledSkills(JSON.parse(rawSk));
      else {
        const seedSk: Record<string, boolean> = {};
        for (const s of MARKET_SKILLS) if (s.installed) seedSk[s.id] = true;
        setInstalledSkills(seedSk);
      }
      const rawMcp = localStorage.getItem("sentinel:mcps:installed");
      if (rawMcp) setInstalledMcps(JSON.parse(rawMcp));
      else {
        const seedMcp: Record<string, boolean> = {};
        for (const m of MARKET_MCPS) if (m.installed) seedMcp[m.id] = true;
        setInstalledMcps(seedMcp);
      }
    } catch {}
  }, []);

  function toggleInstall(id: string) {
    setInstalled((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem("sentinel:plugins:installed", JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function toggleInstallSkill(id: string) {
    setInstalledSkills((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem("sentinel:skills:installed", JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  function toggleInstallMcp(id: string) {
    setInstalledMcps((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem("sentinel:mcps:installed", JSON.stringify(next));
      } catch {}
      return next;
    });
  }

  const source = tab === "skills" ? MARKET_SKILLS : tab === "mcp" ? MARKET_MCPS : MARKET_PLUGINS;
  const installMap = tab === "skills" ? installedSkills : tab === "mcp" ? installedMcps : installed;
  const toggleFor = tab === "skills" ? toggleInstallSkill : tab === "mcp" ? toggleInstallMcp : toggleInstall;

  const filtered = source.filter((p) => {
    if (scope === "personal" && !installMap[p.id]) return false;
    if (q && !p.name.toLowerCase().includes(q.toLowerCase()) && !p.hint.includes(q)) return false;
    return true;
  });
  const featured = filtered.filter((p) => p.featured);
  const rest = filtered.filter((p) => !p.featured);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        <div className="flex flex-col h-[620px]">
          {/* Header */}
          <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
            <div className="flex items-center gap-1 bg-surface-1 rounded-lg p-1">
              <button
                onClick={() => setTab("plugins")}
                className={`px-3 py-1 rounded-md text-sm transition ${
                  tab === "plugins" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                插件
              </button>
              <button
                onClick={() => setTab("skills")}
                className={`px-3 py-1 rounded-md text-sm transition ${
                  tab === "skills" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                技能
              </button>
              <button
                onClick={() => setTab("mcp")}
                className={`px-3 py-1 rounded-md text-sm transition ${
                  tab === "mcp" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                MCP
              </button>
            </div>
            <div className="flex-1" />
            <button className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-white/5 transition" title="刷新">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={onOpenMcpSheet}
              className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-white/5 transition"
              title="MCP 设置"
            >
              <Settings2 className="w-4 h-4" />
            </button>
            <Button size="sm" onClick={onOpenMcpSheet} className="ml-1">
              <Plus className="w-3.5 h-3.5 mr-1" />
              创建
            </Button>
          </div>

          <DialogHeader className="sr-only">
            <DialogTitle>插件市场</DialogTitle>
          </DialogHeader>

          {/* Search + scope */}
          <div className="px-5 pt-4 pb-2 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={tab === "plugins" ? "搜索插件" : tab === "mcp" ? "搜索 MCP" : "搜索技能"}
                className="pl-9 bg-surface-1 border-border h-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setScope("public")}
                className={`px-3 py-1 rounded-md text-sm transition ${
                  scope === "public" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                公开
              </button>
              <button
                onClick={() => setScope("personal")}
                className={`px-3 py-1 rounded-md text-sm transition ${
                  scope === "personal" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                个人
              </button>
              <div className="flex-1" />
              <button className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-white/5 transition" title="筛选">
                <Wrench className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 pb-5">
            {featured.length > 0 && (
              <>
                <div className="text-sm font-semibold text-foreground/90 mt-3 mb-2">Featured</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {featured.map((p) => (
                    <PluginCard
                      key={p.id}
                      plugin={p}
                      installed={!!installMap[p.id]}
                      onToggle={() => toggleFor(p.id)}
                      onOpen={() => setDetail(p)}
                    />
                  ))}
                </div>
              </>
            )}

            {rest.length > 0 && (
              <>
                <div className="text-sm font-semibold text-foreground/90 mt-5 mb-2">更多</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {rest.map((p) => (
                    <PluginCard
                      key={p.id}
                      plugin={p}
                      installed={!!installMap[p.id]}
                      onToggle={() => toggleFor(p.id)}
                      onOpen={() => setDetail(p)}
                    />
                  ))}
                </div>
              </>
            )}

            {filtered.length === 0 && (
              <div className="text-sm text-muted-foreground py-16 text-center border border-dashed border-border rounded-lg">
                {tab === "skills" ? "没有匹配的技能" : tab === "mcp" ? "没有匹配的 MCP" : "没有匹配的插件"}
              </div>
            )}
          </div>
        </div>
      </DialogContent>

      <PluginDetailDialog
        plugin={detail}
        installed={detail ? !!(installed[detail.id] || installedSkills[detail.id] || installedMcps[detail.id]) : false}
        onOpenChange={(v) => !v && setDetail(null)}
        onToggle={() => {
          if (!detail) return;
          if (MARKET_SKILLS.some((s) => s.id === detail.id)) toggleInstallSkill(detail.id);
          else if (MARKET_MCPS.some((m) => m.id === detail.id)) toggleInstallMcp(detail.id);
          else toggleInstall(detail.id);
        }}
      />
    </Dialog>
  );
}

function PluginCard({
  plugin,
  installed,
  onToggle,
  onOpen,
}: {
  plugin: MarketPlugin;
  installed: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1 hover:border-signal/40 hover:bg-surface-2 transition"
    >
      <div className={`w-10 h-10 rounded-lg ${plugin.bg} flex items-center justify-center shrink-0`}>
        <plugin.icon className={`w-5 h-5 ${plugin.color}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground truncate">{plugin.name}</div>
        <div className="text-xs text-muted-foreground truncate">{plugin.hint}</div>
      </div>
      {installed ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/15 text-signal border border-signal/30">
            已安装
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            卸载
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          安装
        </Button>
      )}
      <span
        role="button"
        tabIndex={-1}
        className="text-muted-foreground hover:text-foreground p-1 rounded transition"
        title="更多"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <MoreHorizontal className="w-4 h-4" />
      </span>
    </button>
  );
}

function PluginDetailDialog({
  plugin,
  installed,
  onOpenChange,
  onToggle,
}: {
  plugin: MarketPlugin | null;
  installed: boolean;
  onOpenChange: (v: boolean) => void;
  onToggle: () => void;
}) {
  if (!plugin) return null;
  const permStyle: Record<string, string> = {
    read: "bg-blue-500/10 text-blue-300 border-blue-500/30",
    write: "bg-orange-500/10 text-orange-300 border-orange-500/30",
    system: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  };
  const permLabel: Record<string, string> = { read: "读取", write: "写入", system: "系统" };

  return (
    <Dialog open={!!plugin} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden">
        <div className="flex flex-col max-h-[80vh]">
          {/* Header */}
          <div className="flex items-start gap-4 p-6 border-b border-border">
            <div className={`w-14 h-14 rounded-xl ${plugin.bg} flex items-center justify-center shrink-0`}>
              <plugin.icon className={`w-7 h-7 ${plugin.color}`} />
            </div>
            <div className="min-w-0 flex-1">
              <DialogHeader className="text-left space-y-0.5">
                <DialogTitle className="text-lg flex items-center gap-2">
                  {plugin.name}
                  {installed && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-signal/15 text-signal border border-signal/30">
                      已安装
                    </span>
                  )}
                </DialogTitle>
              </DialogHeader>
              <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {plugin.author && <span>作者 · {plugin.author}</span>}
                {plugin.version && <span className="font-mono">v{plugin.version}</span>}
                <span className="capitalize">{plugin.scope === "public" ? "公开" : "个人"}</span>
              </div>
            </div>
            {installed ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onToggle}
                className="h-8 text-xs border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive shrink-0"
              >
                卸载
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={onToggle}
                className="h-8 text-xs shrink-0"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                安装
              </Button>
            )}
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <section>
              <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-2">
                描述
              </div>
              <p className="text-sm text-foreground/90 leading-relaxed">{plugin.description}</p>
            </section>

            <section>
              <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-2">
                支持的能力
              </div>
              <ul className="space-y-1.5">
                {plugin.capabilities.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-sm text-foreground/90">
                    <CheckCircle2 className="w-4 h-4 text-signal mt-0.5 shrink-0" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-widest mb-2">
                权限要求
              </div>
              <div className="space-y-2">
                {plugin.permissions.map((p) => (
                  <div
                    key={p.label}
                    className="flex items-center gap-3 p-2.5 rounded-md border border-border bg-surface-1"
                  >
                    <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-sm text-foreground/90 flex-1 min-w-0 truncate">{p.label}</span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${permStyle[p.level]}`}>
                      {permLabel[p.level]}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-2">
                安装后可在「电脑操控 · 集成」中随时禁用相关权限。
              </p>
            </section>

            {plugin.id === "mcp-cc6" && <Cc6Panel />}
          </div>


          {/* Footer */}
          <div className="px-6 py-3 border-t border-border flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              状态：
              <span className={installed ? "text-signal ml-1" : "text-muted-foreground ml-1"}>
                {installed ? "已安装并启用" : "未安装"}
              </span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
