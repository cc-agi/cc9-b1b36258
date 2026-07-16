import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listMcpConnections,
  createMcpConnection,
  deleteMcpConnection,
  testMcpConnection,
} from "@/lib/mcp.functions";
import {
  listConversations,
  createConversation,
  deleteConversation,
  getConversationMessages,
  saveConversationMessages,
} from "@/lib/conversations.functions";
import {
  listMemories as memoriesListFn,
  addMemory as memoriesAddFn,
  updateMemory as memoriesUpdateFn,
  deleteMemory as memoriesDeleteFn,
  clearAllMemories as memoriesClearFn,
  autoGenerateMemories as memoriesAutoGenFn,
  importMemoriesFromText as memoriesImportFn,
  getMemoryProfile as profileGetFn,
  saveMemoryProfile as profileSaveFn,
  clearMemoryProfile as profileClearFn,
  regenerateMemoryProfile as profileRegenFn,
} from "@/lib/memories.functions";



import { listExternalModels, MODEL_PROVIDERS, type ModelProvider } from "@/lib/models.functions";
import { regenerateRecoveryCodes, getRecoveryCodesStatus } from "@/lib/recovery-codes.functions";
import {
  listWorkspaces,
  createWorkspace,
  setActiveWorkspace,
  deleteWorkspace,
  listCloudFiles,
  createCloudSignedUploadUrl,
  createCloudSignedDownloadUrl,
  deleteCloudFile,
} from "@/lib/workspaces.functions";
import {
  useWorkspaceContext,
  getWorkspaceContext,
  setWorkspaceContext,
  clearWorkspaceContext,
  collectLocalFolderContext,
  collectCloudFolderContext,
  buildContextPreamble,
  WS_CONTEXT_BUDGET,
} from "@/lib/workspace-context";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
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
  Wand2,
  Eye,
  EyeOff,
  Edit3,
  Target,
  ClipboardList,
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
  | { type: "inspectCandidates"; target: string }
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
    case "browser_inspect_candidates":
      return { type: "inspectCandidates", target: s("textOrSelector") || s("selector") };
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

const HELPER_GOTO_HARD_TIMEOUT_MS = 25000; // matches server 20s + margin
const HELPER_DEFAULT_TIMEOUT_MS = 30000;

async function runHelperStep(
  helperUrl: string,
  cdpHost: string,
  cdpPort: number,
  step: HelperStep,
  opts: { signal?: AbortSignal } = {},
): Promise<{
  ok: boolean;
  logs: Array<{ level: string; message: string }>;
  result?: unknown;
  error?: string;
  errorCode?: string;
}> {
  // 1. Preflight CDP so we fail fast when Chrome isn't running.
  try {
    const preflight = await fetch(
      `${helperUrl}/cdp/status?host=${encodeURIComponent(cdpHost)}&port=${cdpPort}`,
      { signal: opts.signal ?? AbortSignal.timeout(3000) },
    );
    if (preflight.ok) {
      const j = (await preflight.json()) as { connected?: boolean; error?: string };
      if (!j.connected) {
        return {
          ok: false,
          logs: [],
          errorCode: "CDP_UNREACHABLE",
          error:
            j.error ??
            `Chrome CDP 未在 ${cdpHost}:${cdpPort} 响应，请在设置里启动 Chrome。`,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      logs: [],
      errorCode: "HELPER_UNREACHABLE",
      error: `无法连接本地 Helper (${helperUrl})：${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // 2. Start the run.
  let res: Response;
  try {
    res = await fetch(`${helperUrl}/playwright/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        attach: { host: cdpHost, port: cdpPort },
        steps: [step],
      }),
      signal: opts.signal,
    });
  } catch (e) {
    return {
      ok: false,
      logs: [],
      errorCode: "HELPER_UNREACHABLE",
      error: `无法连接本地 Helper (${helperUrl})。请到 docs/sentinel-helper 目录运行 'npm start'。${
        e instanceof Error ? " " + e.message : ""
      }`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      logs: [],
      errorCode: `HELPER_HTTP_${res.status}`,
      error: `Helper HTTP ${res.status}: ${await res.text().catch(() => "")}`,
    };
  }
  const { runId } = (await res.json()) as { runId: string };

  const hardTimeoutMs =
    step.type === "goto" ? HELPER_GOTO_HARD_TIMEOUT_MS : HELPER_DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const es = new EventSource(`${helperUrl}/playwright/logs/${runId}`);
    const logs: Array<{ level: string; message: string }> = [];
    let result: unknown;
    let settled = false;
    const cleanup = () => {
      try { es.close(); } catch { /* ignore */ }
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (payload: {
      ok: boolean;
      result?: unknown;
      error?: string;
      errorCode?: string;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timer);
      resolve({ ...payload, logs });
    };
    const onAbort = () => {
      // Best-effort cancel on the helper side; then settle locally.
      fetch(`${helperUrl}/playwright/cancel/${runId}`, { method: "POST" }).catch(() => {});
      finish({ ok: false, errorCode: "CANCELLED", error: "已取消" });
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => {
      fetch(`${helperUrl}/playwright/cancel/${runId}`, { method: "POST" }).catch(() => {});
      finish({
        ok: false,
        errorCode: "CLIENT_TIMEOUT",
        error: `Helper 步骤在 ${hardTimeoutMs}ms 内未完成`,
        result,
      });
    }, hardTimeoutMs);

    es.addEventListener("log", (e) => {
      try { logs.push(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
    });
    es.addEventListener("result", (e) => {
      try {
        const r = JSON.parse((e as MessageEvent).data) as { value: unknown };
        result = r.value;
      } catch { /* ignore */ }
    });
    es.addEventListener("done", () => finish({ ok: true, result }));
    es.addEventListener("error-event", (e) => {
      let msg = "步骤失败";
      let errorCode: string | undefined;
      try {
        const p = JSON.parse((e as MessageEvent).data) as {
          message?: string;
          errorCode?: string;
        };
        msg = p.message ?? msg;
        errorCode = p.errorCode;
      } catch { /* ignore */ }
      finish({ ok: false, error: msg, errorCode, result });
    });
    es.onerror = () => {
      // Only treat SSE drop as failure if we haven't already settled.
      if (!settled) finish({ ok: false, errorCode: "SSE_DISCONNECTED", error: "Helper SSE 中断" });
    };
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





const HIDE_REASONING_KEY = "sentinel.hideReasoning"; // "1" | "0" | "auto" | missing
const NEW_USER_DEFAULT_HIDDEN = true;

function readReasoningPref(): "1" | "0" | "auto" {
  if (typeof window === "undefined") return "auto";
  const v = window.localStorage.getItem(HIDE_REASONING_KEY);
  if (v === "1" || v === "0" || v === "auto") return v;
  return "auto";
}

function hasReasoningInMessages(msgs: readonly unknown[]): boolean {
  for (const m of msgs) {
    const parts = (m as { parts?: Array<{ type?: string }> }).parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) if (p?.type === "reasoning") return true;
  }
  return false;
}

// ---------- Workspace Selector (backend-backed) ----------

type WorkspaceRow = {
  id: string;
  name: string;
  kind: "cloud" | "gdrive" | "local" | "custom";
  path: string | null;
  is_active: boolean;
  sort_index: number;
  updated_at: string;
};

type CloudFile = {
  name: string;
  id: string | null;
  size: number;
  mime: string | null;
  updated_at: string | null;
  is_folder: boolean;
};

// ---- IndexedDB helpers to persist FileSystemDirectoryHandle for "local" workspaces ----
const LOCAL_DB = "sentinel-workspaces";
const LOCAL_STORE = "dir-handles";
function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(LOCAL_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key: string, value: unknown) {
  const db = await openLocalDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(LOCAL_STORE, "readwrite");
    tx.objectStore(LOCAL_STORE).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openLocalDb();
  return await new Promise((res, rej) => {
    const tx = db.transaction(LOCAL_STORE, "readonly");
    const req = tx.objectStore(LOCAL_STORE).get(key);
    req.onsuccess = () => res(req.result as T | undefined);
    req.onerror = () => rej(req.error);
  });
}
async function idbDel(key: string) {
  const db = await openLocalDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(LOCAL_STORE, "readwrite");
    tx.objectStore(LOCAL_STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

type LocalEntry = { name: string; kind: "file" | "directory"; size?: number };

type LocalFolderSnapshot = {
  type: "folder-upload";
  name: string;
  files: File[];
  entries: LocalEntry[];
};

async function listLocalFolder(id: string): Promise<LocalEntry[]> {
  const stored = await idbGet<FileSystemDirectoryHandle | LocalFolderSnapshot>(id);
  if (!stored) throw new Error("本地目录访问记录已丢失,请重新选择文件夹");
  if ("type" in stored && stored.type === "folder-upload") return stored.entries;

  const handle = stored as
    FileSystemDirectoryHandle & {
      queryPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
      requestPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
    };
  if (handle.queryPermission) {
    let perm = await handle.queryPermission({ mode: "read" });
    if (perm !== "granted" && handle.requestPermission) {
      perm = await handle.requestPermission({ mode: "read" });
    }
    if (perm !== "granted") throw new Error("未获得读取权限");
  }
  const out: LocalEntry[] = [];
  // FileSystemDirectoryHandle is async-iterable via .values() in modern browsers.
  const iter = (handle as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values();
  for await (const entry of iter) {
    if (entry.kind === "file") {
      try {
        const f = await (entry as FileSystemFileHandle).getFile();
        out.push({ name: entry.name, kind: "file", size: f.size });
      } catch {
        out.push({ name: entry.name, kind: "file" });
      }
    } else {
      out.push({ name: entry.name, kind: "directory" });
    }
    if (out.length >= 200) break;
  }
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function humanSize(n: number) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function WorkspaceSelector() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const localFolderInputRef = useRef<HTMLInputElement | null>(null);

  const list = useServerFn(listWorkspaces);
  const createFn = useServerFn(createWorkspace);
  const setActiveFn = useServerFn(setActiveWorkspace);
  const deleteFn = useServerFn(deleteWorkspace);
  const listCloudFn = useServerFn(listCloudFiles);
  const signUploadFn = useServerFn(createCloudSignedUploadUrl);
  const signDownloadFn = useServerFn(createCloudSignedDownloadUrl);
  const deleteCloudFn = useServerFn(deleteCloudFile);

  const wsQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => list(),
    staleTime: 60_000,
  });
  const workspaces: WorkspaceRow[] = (wsQuery.data ?? []) as WorkspaceRow[];
  const active = workspaces.find((w) => w.is_active) ?? workspaces[0];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["workspaces"] });

  const filtered = workspaces.filter((w) =>
    w.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const iconFor = (kind: WorkspaceRow["kind"]) => {
    switch (kind) {
      case "cloud":
        return <Database className="w-3.5 h-3.5 text-signal" />;
      case "gdrive":
        return <Globe className="w-3.5 h-3.5 text-blue-400" />;
      case "local":
        return <FolderOpen className="w-3.5 h-3.5 text-amber-400" />;
      default:
        return <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />;
    }
  };

  const switchTo = async (id: string) => {
    try {
      await setActiveFn({ data: { id } });
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "切换失败");
    }
  };

  const pickLocalFolder = async () => {
    const w = window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    };
    const inIframe = (() => { try { return window.self !== window.top; } catch { return true; } })();

    // Native directory handles are blocked inside cross-origin previews. A directory
    // file input still opens the real system picker there and gives us readable files.
    if (inIframe || !w.showDirectoryPicker) {
      localFolderInputRef.current?.click();
      return;
    }
    try {
      const handle = await w.showDirectoryPicker({ mode: "readwrite" });
      const row = await createFn({
        data: { name: handle.name, kind: "local", path: handle.name },
      });
      await idbPut(row.id, handle);
      await setActiveFn({ data: { id: row.id } });
      toast.success(`已连接本地文件夹: ${handle.name}`);
      invalidate();
    } catch (e) {
      const err = e as Error;
      if (err?.name === "AbortError") return;
      if (err?.name === "SecurityError") {
        localFolderInputRef.current?.click();
        return;
      }
      console.error("[pickLocalFolder]", err);
      toast.error(`打开失败: ${err?.message || err?.name || "未知错误"}`);
    }
  };

  const onLocalFolderSelected = async (selected: FileList | null) => {
    if (!selected?.length) return;
    const files = Array.from(selected);
    const firstPath = files[0]?.webkitRelativePath || files[0]?.name || "本地文件夹";
    const folderName = firstPath.split("/")[0] || "本地文件夹";
    const topLevel = new Map<string, LocalEntry>();

    for (const file of files) {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split("/").filter(Boolean);
      const itemParts = parts[0] === folderName ? parts.slice(1) : parts;
      if (!itemParts.length) continue;
      const name = itemParts[0];
      topLevel.set(
        name,
        itemParts.length > 1
          ? { name, kind: "directory" }
          : { name, kind: "file", size: file.size },
      );
    }

    const entries = Array.from(topLevel.values()).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    try {
      const row = await createFn({
        data: { name: folderName, kind: "local", path: folderName },
      });
      await idbPut(row.id, {
        type: "folder-upload",
        name: folderName,
        files,
        entries,
      } satisfies LocalFolderSnapshot);
      await setActiveFn({ data: { id: row.id } });
      setLocalFiles(entries);
      setLocalErr(null);
      setPanelOpen(true);
      toast.success(`已打开本地文件夹: ${folderName}`);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "打开本地文件夹失败");
    } finally {
      if (localFolderInputRef.current) localFolderInputRef.current.value = "";
    }
  };

  const createCustom = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const row = await createFn({ data: { name, kind: "custom" } });
      await setActiveFn({ data: { id: row.id } });
      setNewName("");
      setCreating(false);
      toast.success(`已创建工作空间: ${name}`);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建失败");
    }
  };

  const removeWs = async (id: string, kind: WorkspaceRow["kind"]) => {
    try {
      await deleteFn({ data: { id } });
      if (kind === "local") await idbDel(id).catch(() => {});
      toast.success("已移除");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "移除失败");
    }
  };

  /* ---- Inline file panel state ---- */
  const [panelOpen, setPanelOpen] = useState(false);
  const activeKind = active?.kind;
  const cloudFilesQuery = useQuery({
    queryKey: ["cloud-files", active?.id],
    queryFn: () => listCloudFn({ data: {} }),
    enabled: panelOpen && activeKind === "cloud",
    staleTime: 15_000,
  });
  const [localFiles, setLocalFiles] = useState<LocalEntry[]>([]);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [localLoading, setLocalLoading] = useState(false);

  /* ---- Workspace-as-context state ---- */
  const wsCtx = useWorkspaceContext();
  const [ctxLoading, setCtxLoading] = useState(false);
  const isCtxActive = wsCtx.enabled && active?.id === wsCtx.workspaceId;

  // Clear the context snapshot whenever the active workspace changes or is
  // deleted — the previous scope is no longer meaningful.
  useEffect(() => {
    if (!active) {
      if (wsCtx.enabled) clearWorkspaceContext();
      return;
    }
    if (wsCtx.enabled && wsCtx.workspaceId !== active.id) {
      clearWorkspaceContext();
    }
  }, [active?.id]);

  // Local file listing for the browse panel.
  useEffect(() => {
    if (!panelOpen || activeKind !== "local" || !active) return;
    setLocalLoading(true);
    setLocalErr(null);
    listLocalFolder(active.id)
      .then(setLocalFiles)
      .catch((e) => setLocalErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLocalLoading(false));
  }, [panelOpen, activeKind, active?.id]);

  const enableLocalContext = async () => {
    if (!active) return;
    setCtxLoading(true);
    try {
      const stored = await idbGet<FileSystemDirectoryHandle | LocalFolderSnapshot>(active.id);
      if (!stored) throw new Error("本地目录访问记录已丢失,请重新打开本地文件夹");
      let files: File[] = [];
      let name = active.name;
      if ("type" in stored && stored.type === "folder-upload") {
        files = stored.files;
        name = stored.name;
      } else {
        // FileSystemDirectoryHandle: walk it recursively into File[]
        const handle = stored as FileSystemDirectoryHandle & {
          queryPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
          requestPermission?: (o: { mode: "read" }) => Promise<PermissionState>;
        };
        if (handle.queryPermission) {
          let perm = await handle.queryPermission({ mode: "read" });
          if (perm !== "granted" && handle.requestPermission)
            perm = await handle.requestPermission({ mode: "read" });
          if (perm !== "granted") throw new Error("未获得读取权限");
        }
        name = handle.name;
        const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
          const iter = (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values();
          for await (const entry of iter) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.kind === "file") {
              try {
                const f = await (entry as FileSystemFileHandle).getFile();
                // Rebuild a File with a webkitRelativePath-compatible name
                const rebuilt = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
                Object.defineProperty(rebuilt, "webkitRelativePath", { value: `${name}/${rel}` });
                files.push(rebuilt);
              } catch { /* skip */ }
            } else {
              await walk(entry as FileSystemDirectoryHandle, rel);
            }
            if (files.length >= 500) break;
          }
        };
        await walk(handle, "");
      }
      const collected = await collectLocalFolderContext(files, name);
      setWorkspaceContext({
        enabled: true,
        workspaceId: active.id,
        workspaceName: name,
        kind: "local",
        files: collected.files,
        totalBytes: collected.totalBytes,
        skipped: collected.skipped,
        updatedAt: Date.now(),
      });
      toast.success(`已启用工作区上下文 · ${collected.files.length} 个文件`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "启用上下文失败");
    } finally {
      setCtxLoading(false);
    }
  };

  const enableCloudContext = async () => {
    if (!active) return;
    setCtxLoading(true);
    try {
      const list = await listCloudFn({ data: {} });
      const rows = list as CloudFile[];
      const files = rows.filter((r) => !r.is_folder);
      const sizes: Record<string, number> = {};
      for (const r of files) sizes[r.name] = r.size;
      const collected = await collectCloudFolderContext(
        files.map((f) => f.name),
        (name) => signDownloadFn({ data: { name } }),
        sizes,
      );
      setWorkspaceContext({
        enabled: true,
        workspaceId: active.id,
        workspaceName: active.name,
        kind: "cloud",
        files: collected.files,
        totalBytes: collected.totalBytes,
        skipped: collected.skipped,
        updatedAt: Date.now(),
      });
      toast.success(`已启用工作区上下文 · ${collected.files.length} 个文件`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "启用上下文失败");
    } finally {
      setCtxLoading(false);
    }
  };

  const disableContext = () => {
    clearWorkspaceContext();
    toast.info("已关闭工作区上下文");
  };

  // Auto-load the workspace context whenever the active workspace changes to
  // a local/cloud kind and isn't already loaded. Users kept switching folders
  // and asking the model about them without realizing they had to click
  // "启用" first, so scope is now opt-out instead of opt-in.
  const autoLoadRef = useRef<{ local: typeof enableLocalContext; cloud: typeof enableCloudContext }>({
    local: enableLocalContext,
    cloud: enableCloudContext,
  });
  autoLoadRef.current.local = enableLocalContext;
  autoLoadRef.current.cloud = enableCloudContext;
  useEffect(() => {
    if (!active) return;
    if (active.kind !== "local" && active.kind !== "cloud") return;
    const snap = getWorkspaceContext();
    if (snap.enabled && snap.workspaceId === active.id) return;
    if (active.kind === "local") void autoLoadRef.current.local();
    else void autoLoadRef.current.cloud();
  }, [active?.id, active?.kind]);


  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const onUpload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const { signedUrl } = await signUploadFn({ data: { filename: file.name } });
        const res = await fetch(signedUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!res.ok) throw new Error(`上传失败 ${file.name}: ${res.status}`);
      }
      toast.success(`已上传 ${files.length} 个文件`);
      qc.invalidateQueries({ queryKey: ["cloud-files", active?.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const downloadCloud = async (name: string) => {
    try {
      const { signedUrl } = await signDownloadFn({ data: { name } });
      window.open(signedUrl, "_blank");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "下载失败");
    }
  };
  const removeCloud = async (name: string) => {
    if (!confirm(`删除 ${name}?`)) return;
    try {
      await deleteCloudFn({ data: { name } });
      toast.success("已删除");
      qc.invalidateQueries({ queryKey: ["cloud-files", active?.id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <input
        ref={(node) => {
          localFolderInputRef.current = node;
          node?.setAttribute("webkitdirectory", "");
          node?.setAttribute("directory", "");
        }}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void onLocalFolderSelected(event.target.files)}
      />
      <DropdownMenuTrigger asChild>
        <button
          className={`flex items-center gap-1.5 px-2 py-1 rounded hover:bg-white/5 text-xs font-medium transition border ${
            isCtxActive
              ? "border-signal/50 bg-signal/10 text-foreground"
              : "border-border/40 text-foreground/80"
          }`}
        >
          {iconFor(active?.kind ?? "cloud")}
          <span className="max-w-[140px] truncate">
            {wsQuery.isLoading ? "加载中…" : active?.name ?? "选择工作空间"}
          </span>
          {isCtxActive && (
            <span className="px-1 rounded bg-signal/20 text-signal text-[9px] font-semibold uppercase tracking-wide">
              {wsCtx.files.length}
            </span>
          )}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-2">
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索工作空间"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md bg-muted/40 border border-border/50 outline-none focus:border-signal/50"
          />
        </div>
        <div className="max-h-52 overflow-y-auto space-y-0.5">
          {wsQuery.isLoading && (
            <div className="flex items-center gap-2 justify-center py-3 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载工作空间…
            </div>
          )}
          {!wsQuery.isLoading && filtered.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-3">未找到工作空间</div>
          )}
          {filtered.map((w) => (
            <div
              key={w.id}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/5 transition ${
                w.is_active ? "bg-white/5 text-foreground" : "text-foreground/80"
              }`}
            >
              <button
                onClick={() => switchTo(w.id)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                {iconFor(w.kind)}
                <span className="flex-1 truncate">{w.name}</span>
                {w.is_active && <CheckCircle2 className="w-3.5 h-3.5 text-signal" />}
              </button>
              {w.kind !== "cloud" && w.kind !== "gdrive" ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeWs(w.id, w.kind);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 transition"
                  title="移除"
                >
                  <X className="w-3 h-3" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        <DropdownMenuSeparator className="my-2" />
        {creating ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createCustom();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              placeholder="工作空间名称"
              className="w-full px-2 py-1.5 text-xs rounded-md bg-muted/40 border border-border/50 outline-none focus:border-signal/50"
            />
            <div className="flex gap-1.5">
              <button
                onClick={createCustom}
                className="flex-1 px-2 py-1 text-xs rounded bg-signal text-signal-foreground hover:opacity-90"
              >
                创建
              </button>
              <button
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                }}
                className="px-2 py-1 text-xs rounded hover:bg-white/5"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/80 transition"
            >
              <Plus className="w-3.5 h-3.5" />
              新建工作空间
            </button>
            <button
              onClick={pickLocalFolder}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/80 transition"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              打开本地文件夹
            </button>
            <button
              onClick={() => setPanelOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/80 transition"
            >
              <FileText className="w-3.5 h-3.5" />
              {panelOpen ? "隐藏文件" : "浏览当前工作区文件"}
              <ChevronDown
                className={`ml-auto w-3 h-3 transition ${panelOpen ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        )}

        {panelOpen && active && (
          <div className="mt-2 border-t border-border/40 pt-2">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                {iconFor(active.kind)}
                <span className="truncate max-w-[180px]">{active.name}</span>
              </div>
              {active.kind === "cloud" && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => uploadInputRef.current?.click()}
                    disabled={uploading}
                    className="p-1 rounded hover:bg-white/5 disabled:opacity-50"
                    title="上传文件"
                  >
                    {uploading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() =>
                      qc.invalidateQueries({ queryKey: ["cloud-files", active.id] })
                    }
                    className="p-1 rounded hover:bg-white/5"
                    title="刷新"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => onUpload(e.target.files)}
                  />
                </div>
              )}
              {active.kind === "local" && (
                <button
                  onClick={() => {
                    setLocalLoading(true);
                    setLocalErr(null);
                    listLocalFolder(active.id)
                      .then(setLocalFiles)
                      .catch((e) =>
                        setLocalErr(e instanceof Error ? e.message : String(e)),
                      )
                      .finally(() => setLocalLoading(false));
                  }}
                  className="p-1 rounded hover:bg-white/5"
                  title="刷新"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {(active.kind === "local" || active.kind === "cloud") && (
              <div
                className={`mb-2 p-2 rounded-md border text-[11px] leading-relaxed ${
                  isCtxActive
                    ? "border-signal/40 bg-signal/5 text-foreground"
                    : "border-border/40 bg-muted/20 text-muted-foreground"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <FileText className="w-3.5 h-3.5 text-signal" />
                    工作区上下文
                  </div>
                  <button
                    onClick={() =>
                      isCtxActive
                        ? disableContext()
                        : active.kind === "local"
                          ? enableLocalContext()
                          : enableCloudContext()
                    }
                    disabled={ctxLoading}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition ${
                      isCtxActive
                        ? "bg-signal text-signal-foreground hover:opacity-90"
                        : "bg-white/5 hover:bg-white/10 text-foreground/80"
                    } disabled:opacity-50`}
                  >
                    {ctxLoading ? (
                      <span className="flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> 读取中
                      </span>
                    ) : isCtxActive ? (
                      "已启用 · 关闭"
                    ) : (
                      "启用"
                    )}
                  </button>
                </div>
                {isCtxActive ? (
                  <div className="space-y-0.5">
                    <div>
                      对话将限定在 <span className="text-foreground font-medium">{wsCtx.workspaceName}</span> 内的{" "}
                      <span className="text-signal font-medium">{wsCtx.files.length}</span> 个文件 ·{" "}
                      {humanSize(wsCtx.totalBytes)} / {humanSize(WS_CONTEXT_BUDGET)}
                    </div>
                    {wsCtx.skipped.length > 0 && (
                      <div className="text-muted-foreground">
                        已省略 {wsCtx.skipped.length} 个非文本或超出预算的文件
                      </div>
                    )}
                    <button
                      onClick={
                        active.kind === "local" ? enableLocalContext : enableCloudContext
                      }
                      className="text-signal underline"
                    >
                      重新读取
                    </button>
                  </div>
                ) : (
                  <div>
                    启用后,模型只会基于此文件夹的文本文件进行代码优化 / 内容创作,不会引用工作区之外的内容。
                  </div>
                )}
              </div>
            )}



            <div className="max-h-64 overflow-y-auto space-y-0.5 text-xs">
              {active.kind === "cloud" && (
                <>
                  {cloudFilesQuery.isLoading && (
                    <div className="flex items-center gap-2 justify-center py-3 text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中…
                    </div>
                  )}
                  {cloudFilesQuery.error && (
                    <div className="text-destructive px-2 py-1.5">
                      {(cloudFilesQuery.error as Error).message}
                    </div>
                  )}
                  {cloudFilesQuery.data && cloudFilesQuery.data.length === 0 && (
                    <div className="text-muted-foreground text-center py-3">
                      还没有文件。点击 <Upload className="inline w-3 h-3 mx-0.5" /> 上传。
                    </div>
                  )}
                  {(cloudFilesQuery.data as CloudFile[] | undefined)?.map((f) => (
                    <div
                      key={f.name}
                      className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5"
                    >
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="flex-1 truncate">{f.name}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {humanSize(f.size)}
                      </span>
                      <button
                        onClick={() => downloadCloud(f.name)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-signal"
                        title="下载"
                      >
                        <Download className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => removeCloud(f.name)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {active.kind === "local" && (
                <>
                  {localLoading && (
                    <div className="flex items-center gap-2 justify-center py-3 text-muted-foreground">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> 读取中…
                    </div>
                  )}
                  {localErr && (
                    <div className="space-y-1.5 px-2 py-1.5">
                      <div className="text-destructive">{localErr}</div>
                      <button
                        onClick={pickLocalFolder}
                        className="text-signal underline text-[11px]"
                      >
                        重新选择本地文件夹
                      </button>
                    </div>
                  )}
                  {!localLoading && !localErr && localFiles.length === 0 && (
                    <div className="text-muted-foreground text-center py-3">目录为空</div>
                  )}
                  {localFiles.map((f) => (
                    <div
                      key={f.name}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5"
                    >
                      {f.kind === "directory" ? (
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                      )}
                      <span className="flex-1 truncate">{f.name}</span>
                      {f.size ? (
                        <span className="text-muted-foreground text-[10px]">
                          {humanSize(f.size)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </>
              )}

              {active.kind === "gdrive" && (
                <div className="px-2 py-3 text-muted-foreground space-y-1.5">
                  <div>Google Drive 需要工作区管理员先在 Lovable App User Connectors 里配置 google_drive 客户端。</div>
                  <div className="text-[10px]">配置完成后,此处将支持 OAuth 授权并读取你的 Drive 文件。</div>
                </div>
              )}

              {active.kind === "custom" && (
                <div className="px-2 py-3 text-muted-foreground text-center">
                  自定义工作区不含文件浏览器
                </div>
              )}
            </div>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}



function ConsolePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { conversationId } = Route.useParams();
  const listFn = useServerFn(listMcpConnections);
  const createFn = useServerFn(createMcpConnection);
  const deleteFn = useServerFn(deleteMcpConnection);
  const testFn = useServerFn(testMcpConnection);

  // Preference mode: "auto" until the user makes an explicit choice.
  // On first visit (missing key) the mode is "auto" and reasoning defaults to hidden
  // (per NEW_USER_DEFAULT_HIDDEN); once history is loaded it auto-switches to shown
  // if no past message has a reasoning part (nothing to hide).
  const [reasoningMode, setReasoningMode] = useState<"1" | "0" | "auto">(() =>
    readReasoningPref(),
  );
  const [autoResolved, setAutoResolved] = useState<boolean | null>(null);
  const hideReasoning =
    reasoningMode === "1"
      ? true
      : reasoningMode === "0"
        ? false
        : (autoResolved ?? NEW_USER_DEFAULT_HIDDEN);

  const setHideReasoning = (next: boolean | ((v: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(hideReasoning) : next;
    setReasoningMode(resolved ? "1" : "0");
    try {
      window.localStorage.setItem(HIDE_REASONING_KEY, resolved ? "1" : "0");
    } catch {
      /* ignore */
    }
  };




  // ---- Conversations (history) ----
  const convListFn = useServerFn(listConversations);
  const convCreateFn = useServerFn(createConversation);
  const convDeleteFn = useServerFn(deleteConversation);
  const msgsGetFn = useServerFn(getConversationMessages);
  const msgsSaveFn = useServerFn(saveConversationMessages);

  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => convListFn(),
  });
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === conversationId),
    [conversations, conversationId],
  );

  const { data: initialMessages = [], isFetched: initialMessagesFetched, dataUpdatedAt: initialMessagesUpdatedAt } = useQuery({
    queryKey: ["conversation_messages", conversationId],
    queryFn: () => msgsGetFn({ data: { id: conversationId } }),
    staleTime: Infinity,
    enabled: Boolean(conversationId),
  });

  // Auto-resolve default when the preference is still "auto":
  // - if past messages contain any reasoning parts → keep hidden (noisy history)
  // - if no reasoning present at all → show (nothing to hide, less friction)
  // First-ever visit (no key, no history yet) falls through to NEW_USER_DEFAULT_HIDDEN.
  useEffect(() => {
    if (reasoningMode !== "auto") return;
    if (!Array.isArray(initialMessages) || initialMessages.length === 0) return;
    setAutoResolved(hasReasoningInMessages(initialMessages));
  }, [reasoningMode, initialMessages]);



  async function openNewConversation(kind: "task" | "chat") {
    try {
      const row = await convCreateFn({ data: { kind } });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      navigate({
        to: "/console/$conversationId",
        params: { conversationId: row.id },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "创建会话失败");
    }
  }

  async function removeConversation(id: string) {
    try {
      await convDeleteFn({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      if (id === conversationId) {
        const rest = conversations.filter((c) => c.id !== id);
        if (rest[0]) {
          navigate({
            to: "/console/$conversationId",
            params: { conversationId: rest[0].id },
            replace: true,
          });
        } else {
          const row = await convCreateFn({ data: { kind: "task" } });
          await qc.invalidateQueries({ queryKey: ["conversations"] });
          navigate({
            to: "/console/$conversationId",
            params: { conversationId: row.id },
            replace: true,
          });
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "删除会话失败");
    }
  }



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
  // Sync mode with the active conversation's kind
  useEffect(() => {
    if (activeConversation?.kind === "task" || activeConversation?.kind === "chat") {
      setMode(activeConversation.kind);
    }
  }, [activeConversation?.kind]);

  // ============================================================
  // 计划模式 (Plan) & 目标模式 (Goal) — 两套后台 AI 运行逻辑
  // ------------------------------------------------------------
  // 用户仅需在下拉里点选开启, 真正的目标/计划内容由 用户在对话框中自然表达,
  // 系统通过 preamble 告诉后台 AI 用哪一套运行逻辑处理这段输入。
  // 两个模式互斥 (同一时刻只能选择一种运行策略), 也可都关闭 = 普通对话。
  // 按会话 id 持久化, 切换会话不会串。
  // ============================================================
  type RunMode = "none" | "goal" | "plan";
  const runModeStorageKey = conversationId ? `sentinel:runMode:${conversationId}` : "";
  const [runMode, setRunModeState] = useState<RunMode>("none");
  useEffect(() => {
    if (!runModeStorageKey) {
      setRunModeState("none");
      return;
    }
    try {
      const v = localStorage.getItem(runModeStorageKey);
      setRunModeState(v === "goal" || v === "plan" ? v : "none");
    } catch {
      setRunModeState("none");
    }
  }, [runModeStorageKey]);
  const setRunMode = useCallback(
    (m: RunMode) => {
      setRunModeState(m);
      if (!runModeStorageKey) return;
      try {
        if (m === "none") localStorage.removeItem(runModeStorageKey);
        else localStorage.setItem(runModeStorageKey, m);
      } catch {
        /* ignore */
      }
    },
    [runModeStorageKey],
  );

  function buildPlanGoalPreamble(): string {
    if (runMode === "goal") {
      return (
        `<<<SYSTEM_OVERLAY:GOAL_MODE>>>\n` +
        `【目标模式】用户接下来的输入 = 一个需要持续追求的目标。请按以下逻辑处理:\n` +
        `1. 复述你对目标的理解 (一句话)。\n` +
        `2. 拆解 3-7 个可衡量的里程碑, 每个里程碑标注成功标准。\n` +
        `3. 给出"本周/今天可以立刻推进的第一步", 尽量具体、可执行。\n` +
        `4. 主动询问缺失的关键约束 (时间/预算/资源/能力), 一次最多 3 个。\n` +
        `5. 在会话中持续记住该目标, 后续每次回答都在末尾追加一行:「目标进度: <本次贡献> · 下一步: <建议动作>」。\n` +
        `<<<END>>>\n\n用户输入:\n`
      );
    }
    if (runMode === "plan") {
      return (
        `<<<SYSTEM_OVERLAY:PLAN_MODE>>>\n` +
        `【计划模式】在任何执行动作 (调用工具/写代码/生成正式产物/下单/发消息) 之前, 必须先输出结构化计划并等待用户确认:\n` +
        `## 目标解读   一句话复述用户真实意图\n` +
        `## 步骤拆解   编号步骤 · 每步预期产出\n` +
        `## 所需资源   工具 / MCP / 文件 / 权限\n` +
        `## 风险与假设 可能失败的点 & 回退方案\n` +
        `## 交付物     最终形态 & 验收标准\n\n` +
        `输出计划后以问句结尾: "确认执行吗? 回复 '继续' 开始, 或指出需要修改之处。"\n` +
        `只有当用户回复 继续/执行/开始/go/approve 或给出具体修改后, 才进入执行阶段。\n` +
        `<<<END>>>\n\n用户输入:\n`
      );
    }
    return "";
  }





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
      body: () => {
        let memoryEnabled = true;
        let memoryCross = false;
        try {
          const e = localStorage.getItem("sentinel:memory:enabled");
          const c = localStorage.getItem("sentinel:memory:cross");
          if (e !== null) memoryEnabled = e === "1";
          if (c !== null) memoryCross = c === "1";
        } catch {}
        return {
          connectionIds: Array.from(selectedIds),
          model: selectedModel,
          mode,
          provider: modelProvider,
          memory: { enabled: memoryEnabled, cross: memoryCross },
        };
      },
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

  const browserAbortersRef = useRef<Map<string, AbortController>>(new Map());
  const [pendingBrowserCount, setPendingBrowserCount] = useState(0);
  const bumpPending = (n: number) => setPendingBrowserCount((c) => Math.max(0, c + n));
  // When the user hits Stop, suppress the automatic tool-result → next-turn
  // continuation. Otherwise `sendAutomaticallyWhen` would re-fire a new
  // request the moment we settle pending tool cards with CANCELLED, which
  // is exactly why the previous Stop button seemed to do nothing.
  const cancelledRef = useRef(false);

  const { messages, sendMessage, status, stop, setMessages, addToolResult } = useChat({
    id: conversationId,
    transport,
    sendAutomaticallyWhen: (opts) => {
      if (cancelledRef.current) return false;
      return lastAssistantMessageIsCompleteWithToolCalls(opts);
    },

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
          output: { ok: false, errorCode: "UNKNOWN_TOOL", error: `未知浏览器工具: ${name}` },
        });
        return;
      }
      const controller = new AbortController();
      browserAbortersRef.current.set(toolCall.toolCallId, controller);
      bumpPending(1);
      try {
        const output = await runHelperStep(helperUrl, cdpHost, cdpPort, step, {
          signal: controller.signal,
        });
        // For browser_goto specifically, hoist requestedUrl/finalUrl/title/durationMs
        // so the tool card can always render them, success OR failure.
        if (name === "browser_goto") {
          const r =
            (output.result as
              | {
                  requestedUrl?: string;
                  finalUrl?: string;
                  title?: string;
                  durationMs?: number;
                  navigationState?: string;
                }
              | undefined) ?? {};
          addToolResult({
            tool: name,
            toolCallId: toolCall.toolCallId,
            output: {
              ok: output.ok,
              errorCode: output.errorCode,
              error: output.error,
              requestedUrl: r.requestedUrl ?? (step.type === "goto" ? step.target : undefined),
              finalUrl: r.finalUrl ?? "",
              title: r.title ?? "",
              durationMs: r.durationMs ?? 0,
              navigationState: r.navigationState,
              logs: output.logs,
            },
          });
        } else {
          const r =
            output.result && typeof output.result === "object" && !Array.isArray(output.result)
              ? (output.result as Record<string, unknown>)
              : { result: output.result };
          addToolResult({
            tool: name,
            toolCallId: toolCall.toolCallId,
            output: {
              ok: output.ok,
              errorCode: output.errorCode,
              error: output.error,
              logs: output.logs,
              ...r,
            },
          });
        }
      } catch (e) {
        addToolResult({
          tool: name,
          toolCallId: toolCall.toolCallId,
          output: {
            ok: false,
            errorCode: "CLIENT_EXCEPTION",
            error:
              e instanceof Error
                ? e.message
                : "调用本地 Helper 失败，请确认 sentinel-helper 已启动并且 Chrome 处于监听状态。",
          },
        });
      } finally {
        browserAbortersRef.current.delete(toolCall.toolCallId);
        bumpPending(-1);
      }
    },
  });

  // Cancel a specific tool call: abort local helper (if any) and settle the
  // tool card with a CANCELLED result so the UI exits its loading state.
  const cancelToolCall = useCallback(
    (toolCallId: string, toolName: string) => {
      const ctrl = browserAbortersRef.current.get(toolCallId);
      if (ctrl) {
        try { ctrl.abort(); } catch { /* ignore */ }
        browserAbortersRef.current.delete(toolCallId);
      }
      try {
        addToolResult({
          tool: toolName,
          toolCallId,
          output: { ok: false, errorCode: "CANCELLED", error: "用户已取消该工具调用" },
        });
      } catch { /* ignore */ }
    },
    [addToolResult],
  );

  // Cancel every tool call that is still pending across all messages.
  const cancelAllPendingTools = useCallback(() => {
    for (const m of messages) {
      for (const p of (m.parts ?? []) as Array<{
        type?: string;
        state?: string;
        output?: unknown;
        errorText?: string;
        toolCallId?: string;
      }>) {
        if (!p.type?.startsWith("tool-")) continue;
        const running =
          p.state === "input-streaming" ||
          p.state === "input-available" ||
          (!p.state && p.output === undefined && !p.errorText);
        if (!running || !p.toolCallId) continue;
        cancelToolCall(p.toolCallId, p.type.replace(/^tool-/, ""));
      }
    }
  }, [messages, cancelToolCall]);


  // Load persisted messages when the conversation switches.
  // Gate on the query actually having fetched for this conversationId — otherwise
  // we'd set an empty array from a stale/loading query result and never re-apply
  // the real data when it arrives.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationId) return;
    if (!initialMessagesFetched) return;
    const marker = `${conversationId}:${initialMessagesUpdatedAt}`;
    if (loadedForRef.current === marker) return;
    loadedForRef.current = marker;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMessages((initialMessages as any[]) ?? []);
  }, [conversationId, initialMessages, initialMessagesFetched, initialMessagesUpdatedAt, setMessages]);

  // Persist messages after each streaming turn completes
  const savedSigRef = useRef<string>("");
  useEffect(() => {
    if (!conversationId) return;
    if (status !== "ready") return;
    if (!messages.length) return;
    const sig = `${messages.length}:${messages[messages.length - 1]?.id ?? ""}`;
    if (sig === savedSigRef.current) return;
    savedSigRef.current = sig;

    // derive a short title from the first user text
    const firstUser = messages.find((m) => m.role === "user");
    let title: string | undefined;
    if (firstUser) {
      const text = (firstUser.parts ?? [])
        .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
        .join(" ")
        .trim();
      if (text) title = text.length > 40 ? text.slice(0, 40) + "…" : text;
    }

    msgsSaveFn({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { id: conversationId, messages: messages as any[], title },
    })
      .then(() => qc.invalidateQueries({ queryKey: ["conversations"] }))
      .catch(() => {
        /* toast noise not helpful during streaming; swallow */
      });
  }, [status, messages, conversationId, msgsSaveFn, qc]);




  const [input, setInput] = useState("");
  const isStreaming = status === "submitted" || status === "streaming";
  // Any tool call in messages that has no output yet counts as "in-flight" —
  // this covers MCP tools whose result hasn't come back, not just local
  // browser_* helper calls.
  const hasPendingToolCall = useMemo(() => {
    for (const m of messages) {
      for (const p of (m.parts ?? []) as Array<{
        type?: string; state?: string; output?: unknown; errorText?: string;
      }>) {
        if (!p.type?.startsWith("tool-")) continue;
        const running =
          p.state === "input-streaming" ||
          p.state === "input-available" ||
          (!p.state && p.output === undefined && !p.errorText);
        if (running) return true;
      }
    }
    return false;
  }, [messages]);
  const isLoading = isStreaming || pendingBrowserCount > 0 || hasPendingToolCall;

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
    // Manual send resets the "user cancelled" gate so the agent loop can
    // resume auto-continuing on future tool calls.
    cancelledRef.current = false;

    const pending = attachments;
    setAttachments([]);
    // Prepend the workspace-context preamble so the model stays scoped to the
    // active workspace's files (see src/lib/workspace-context.ts).
    const wsSnap = getWorkspaceContext();
    const wsPreamble = buildContextPreamble(wsSnap);
    // 叠加 计划模式 / 目标 语义层
    const planGoalPreamble = buildPlanGoalPreamble();
    const finalText = `${wsPreamble}${planGoalPreamble}${value || " "}`;
    try {
      await sendMessage({
        text: finalText,
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
    navigate({ to: "/auth", search: {}, replace: true });
  }

  const [collapsed, setCollapsed] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [pluginMarketOpen, setPluginMarketOpen] = useState(false);
  const [pluginMarketTab, setPluginMarketTab] = useState<PluginTab>("plugins");
  const openMarket = useCallback((t: PluginTab) => {
    setPluginMarketTab(t);
    setPluginMarketOpen(true);
  }, []);

  // ============================================================
  // 插件 (Plugins) 快捷子菜单 —— 从对话框直接开关已安装的插件
  // ------------------------------------------------------------
  // - installedPluginIds: 从市场安装的插件 (localStorage: sentinel:plugins:installed)
  // - activePluginIds   : 当前会话启用的插件子集 (localStorage: sentinel:plugins:active)
  // 打开 + 号菜单时会重新读取, 且监听 storage 事件以便市场里增删同步。
  // ============================================================
  const [installedPluginMap, setInstalledPluginMap] = useState<Record<string, boolean>>({});
  const [activePluginIds, setActivePluginIds] = useState<Set<string>>(new Set());
  const [pluginSubOpen, setPluginSubOpen] = useState(false);
  const [pluginSubQuery, setPluginSubQuery] = useState("");

  const [installedSkillMap, setInstalledSkillMap] = useState<Record<string, boolean>>({});
  const [activeSkillIds, setActiveSkillIds] = useState<Set<string>>(new Set());
  const [skillSubOpen, setSkillSubOpen] = useState(false);
  const [skillSubQuery, setSkillSubQuery] = useState("");

  const [mcpSubOpen, setMcpSubOpen] = useState(false);
  const [mcpSubQuery, setMcpSubQuery] = useState("");
  const filteredConnections = useMemo(() => {
    const q = mcpSubQuery.trim().toLowerCase();
    if (!q) return connections;
    return connections.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.url?.toLowerCase().includes(q),
    );
  }, [connections, mcpSubQuery]);
  const toggleConnectionActive = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const refreshPluginState = useCallback(() => {
    try {
      const raw = localStorage.getItem("sentinel:plugins:installed");
      if (raw) {
        setInstalledPluginMap(JSON.parse(raw));
      } else {
        const seed: Record<string, boolean> = {};
        for (const p of MARKET_PLUGINS) if (p.installed) seed[p.id] = true;
        setInstalledPluginMap(seed);
      }
      const rawA = localStorage.getItem("sentinel:plugins:active");
      if (rawA) setActivePluginIds(new Set(JSON.parse(rawA) as string[]));
    } catch {
      /* ignore */
    }
  }, []);
  const refreshSkillState = useCallback(() => {
    try {
      const raw = localStorage.getItem("sentinel:skills:installed");
      if (raw) {
        setInstalledSkillMap(JSON.parse(raw));
      } else {
        const seed: Record<string, boolean> = {};
        for (const s of MARKET_SKILLS) if (s.installed) seed[s.id] = true;
        setInstalledSkillMap(seed);
      }
      const rawA = localStorage.getItem("sentinel:skills:active");
      if (rawA) setActiveSkillIds(new Set(JSON.parse(rawA) as string[]));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    refreshPluginState();
    refreshSkillState();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sentinel:plugins:installed" || e.key === "sentinel:plugins:active") {
        refreshPluginState();
      }
      if (e.key === "sentinel:skills:installed" || e.key === "sentinel:skills:active") {
        refreshSkillState();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshPluginState, refreshSkillState]);

  const togglePluginActive = useCallback((id: string) => {
    setActivePluginIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("sentinel:plugins:active", JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const toggleSkillActive = useCallback((id: string) => {
    setActiveSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("sentinel:skills:active", JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const installedPluginList = useMemo(
    () => MARKET_PLUGINS.filter((p) => installedPluginMap[p.id]),
    [installedPluginMap],
  );
  const filteredPluginList = useMemo(() => {
    const q = pluginSubQuery.trim().toLowerCase();
    if (!q) return installedPluginList;
    return installedPluginList.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.hint.toLowerCase().includes(q),
    );
  }, [installedPluginList, pluginSubQuery]);
  const activePluginCount = installedPluginList.filter((p) => activePluginIds.has(p.id)).length;

  const installedSkillList = useMemo(
    () => MARKET_SKILLS.filter((s) => installedSkillMap[s.id]),
    [installedSkillMap],
  );
  const filteredSkillList = useMemo(() => {
    const q = skillSubQuery.trim().toLowerCase();
    if (!q) return installedSkillList;
    return installedSkillList.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.hint.toLowerCase().includes(q),
    );
  }, [installedSkillList, skillSubQuery]);
  const activeSkillCount = installedSkillList.filter((s) => activeSkillIds.has(s.id)).length;



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
            onClick={() => openNewConversation("task")}
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
            label="新建聊天"
            onClick={() => openNewConversation("chat")}
          />

          {!collapsed && (
            <>
              <SectionLabel>项目</SectionLabel>
              <div className="px-3 text-xs text-muted-foreground/60 italic py-1">暂无项目</div>

              <ConversationList
                title="任务"
                icon={PenSquare}
                items={conversations.filter((c) => c.kind === "task")}
                activeId={conversationId}
                onOpen={(id) =>
                  navigate({ to: "/console/$conversationId", params: { conversationId: id } })
                }
                onDelete={removeConversation}
                emptyLabel="还没有任务"
              />

              <ConversationList
                title="聊天"
                icon={MessageCircle}
                items={conversations.filter((c) => c.kind === "chat")}
                activeId={conversationId}
                onOpen={(id) =>
                  navigate({ to: "/console/$conversationId", params: { conversationId: id } })
                }
                onDelete={removeConversation}
                emptyLabel="还没有聊天"
              />
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
        <div className="absolute top-3 right-4 z-10 pointer-events-none flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHideReasoning((v) => !v)}
            title={hideReasoning ? "显示思考过程" : "隐藏思考过程"}
            className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border/60 bg-surface-1/80 backdrop-blur text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground hover:border-border transition-colors"
          >
            {hideReasoning ? (
              <EyeOff className="w-3 h-3" />
            ) : (
              <Eye className="w-3 h-3 text-accent" />
            )}
            <span>{hideReasoning ? "思考已隐藏" : "显示思考"}</span>
          </button>
          {lastRequest && (
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
          )}
        </div>

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
                <MessageBlock key={m.id} message={m} hideReasoning={hideReasoning} onCancelTool={cancelToolCall} />
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
            <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2 flex-wrap">
              {mode !== "task" && (
                <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-foreground/80">
                  <MessageCircle className="w-3.5 h-3.5 text-signal" />
                  聊天 · 生图 / 生视频
                </div>
              )}
              <WorkspaceSelector />
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className="p-1.5 rounded-md hover:bg-white/5 text-muted-foreground hover:text-foreground transition disabled:opacity-40 border border-border/60 hover:border-signal/40"
                      title="添加内容:文件 / 模式 / 插件 / 技能 / 连接器"
                      disabled={isLoading}
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-52 p-1">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-white/5 text-foreground/90 transition"
                    >
                      <span>添加文件</span>
                      <span className="text-[10px] text-muted-foreground">拖拽 / 粘贴</span>
                    </button>
                    <DropdownMenuSeparator className="my-0.5" />
                    {/* 目标模式 / 计划模式 — 简单点选, 内容在对话框自然表达 */}
                    {(
                      [
                        {
                          key: "goal" as const,
                          label: "目标",
                          desc: "把接下来说的当作要持续追求的目标",
                          color: "text-emerald-400",
                          ring: "ring-emerald-400/50 bg-emerald-500/10",
                        },
                        {
                          key: "plan" as const,
                          label: "计划模式",
                          desc: "先出结构化计划,确认后再执行",
                          color: "text-sky-400",
                          ring: "ring-sky-400/50 bg-sky-500/10",
                        },
                      ] as const
                    ).map((item) => {
                      const active = runMode === item.key;
                      return (
                        <button
                          key={item.key}
                          onClick={(e) => {
                            // 单击 = 启用 (若已启用则忽略, 由双击取消)
                            if (e.detail > 1) return; // 忽略双击的第二次 click
                            if (active) return;
                            setRunMode(item.key);
                            if (item.key === "goal") toast.success("目标模式:下一条消息将作为长期目标");
                            else toast.success("计划模式:先出计划,回复'继续'再执行");
                          }}
                          onDoubleClick={() => {
                            if (!active) return;
                            setRunMode("none");
                            toast.success("已关闭 " + item.label);
                          }}
                          title={active ? "双击取消" : "单击启用"}
                          className={`group w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs transition ${
                            active
                              ? `${item.ring} ring-1 text-foreground`
                              : "text-foreground/90 hover:bg-white/5"
                          }`}
                        >
                          <span className="flex flex-col items-start leading-tight min-w-0">
                            <span className="flex items-center gap-1.5">
                              <span>{item.label}</span>
                              {!active && (
                                <span className="text-[9px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition">
                                  单击启用
                                </span>
                              )}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-normal truncate">
                              {item.desc}
                            </span>
                          </span>
                          {active && (
                            <span className="shrink-0 flex items-center gap-1">
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-mono uppercase tracking-wider ${item.color} bg-current/10 ring-1 ring-current/30`}
                              >
                                <span className="w-1 h-1 rounded-full bg-current animate-pulse" />
                                <span>ON</span>
                              </span>
                              <span className="text-[9px] text-muted-foreground/70 hidden group-hover:inline">
                                双击取消
                              </span>
                            </span>
                          )}
                        </button>


                      );
                    })}
                    <DropdownMenuSeparator className="my-0.5" />




                    <DropdownMenuSub
                      open={pluginSubOpen}
                      onOpenChange={(v) => {
                        setPluginSubOpen(v);
                        if (v) refreshPluginState();
                        else setPluginSubQuery("");
                      }}
                    >
                      <DropdownMenuSubTrigger className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-white/5 text-foreground/90 cursor-pointer">
                        <span>插件</span>
                        <span className="text-[10px] text-muted-foreground font-normal">
                          {installedPluginList.length === 0
                            ? "尚未安装"
                            : `${activePluginCount}/${installedPluginList.length} 启用`}
                        </span>
                      </DropdownMenuSubTrigger>

                      <DropdownMenuSubContent collisionPadding={16} avoidCollisions
                        className="w-72 p-1 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-hidden flex flex-col"
                        sideOffset={4}
                      >
                        {/* 顶部 标题 + 计数 + 全部启用/停用 */}
                        <div className="px-2 pt-1.5 pb-1 flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                            已安装的插件
                          </span>
                          {installedPluginList.length > 0 && (
                            <button
                              onClick={() => {
                                const allOn = activePluginCount === installedPluginList.length;
                                const next = new Set(
                                  allOn ? [] : installedPluginList.map((p) => p.id),
                                );
                                setActivePluginIds(next);
                                try {
                                  localStorage.setItem(
                                    "sentinel:plugins:active",
                                    JSON.stringify([...next]),
                                  );
                                } catch {
                                  /* ignore */
                                }
                              }}
                              className="text-[10px] text-muted-foreground hover:text-foreground transition"
                            >
                              {activePluginCount === installedPluginList.length ? "全部停用" : "全部启用"}
                            </button>
                          )}
                        </div>

                        {/* 搜索框 - 已安装多于 4 个时才显示 */}
                        {installedPluginList.length > 4 && (
                          <div className="px-1.5 pb-1.5">
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40 border border-border/60 focus-within:border-signal/50">
                              <Search className="w-3 h-3 text-muted-foreground" />
                              <input
                                value={pluginSubQuery}
                                onChange={(e) => setPluginSubQuery(e.target.value)}
                                placeholder="搜索插件…"
                                className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                              />
                            </div>
                          </div>
                        )}

                        {/* 插件列表 - 可滚动 */}
                        <div className="flex-1 overflow-y-auto max-h-[280px] pr-0.5">
                          {installedPluginList.length === 0 ? (
                            <div className="px-3 py-6 text-center">
                              <Wrench className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
                              <div className="text-[11px] text-muted-foreground mb-2">
                                你还没有安装任何插件
                              </div>
                              <div className="text-[10px] text-muted-foreground/70">
                                前往市场安装以在对话中调用
                              </div>
                            </div>
                          ) : filteredPluginList.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                              没有匹配 "{pluginSubQuery}" 的插件
                            </div>
                          ) : (
                            filteredPluginList.map((p) => {
                              const active = activePluginIds.has(p.id);
                              const Icon = p.icon;
                              return (
                                <button
                                  key={p.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    togglePluginActive(p.id);
                                  }}
                                  className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left transition group ${
                                    active
                                      ? "bg-amber-500/10 hover:bg-amber-500/15"
                                      : "hover:bg-white/5"
                                  }`}
                                >
                                  <span
                                    className={`shrink-0 w-6 h-6 rounded flex items-center justify-center ${
                                      active ? p.bg : "bg-muted/40"
                                    }`}
                                  >
                                    <Icon
                                      className={`w-3.5 h-3.5 ${active ? p.color : "text-muted-foreground"}`}
                                    />
                                  </span>
                                  <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                      <span className="text-xs text-foreground/90 truncate">
                                        {p.name}
                                      </span>
                                      {active && (
                                        <span className="text-[9px] font-mono uppercase text-amber-400">
                                          ON
                                        </span>
                                      )}
                                    </span>
                                    <span className="block text-[10px] text-muted-foreground truncate">
                                      {p.hint}
                                    </span>
                                  </span>
                                  {/* toggle switch */}
                                  <span
                                    className={`shrink-0 mt-1 relative inline-flex h-3.5 w-6 items-center rounded-full transition ${
                                      active ? "bg-amber-500/60" : "bg-muted/60"
                                    }`}
                                  >
                                    <span
                                      className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition ${
                                        active ? "translate-x-3" : "translate-x-0.5"
                                      }`}
                                    />
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>

                        {/* 底部 - 浏览市场 / 管理 */}
                        <DropdownMenuSeparator className="my-1" />
                        <button
                          onClick={() => {
                            setPluginSubOpen(false);
                            openMarket("plugins");
                          }}
                          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/90 transition"
                        >
                          <span className="flex items-center gap-2">
                            <Plus className="w-3.5 h-3.5 text-signal" />
                            浏览插件市场
                          </span>
                          <ChevronDown className="w-3 h-3 -rotate-90 opacity-60" />
                        </button>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuSub
                      open={skillSubOpen}
                      onOpenChange={(v) => {
                        setSkillSubOpen(v);
                        if (v) refreshSkillState();
                        else setSkillSubQuery("");
                      }}
                    >
                      <DropdownMenuSubTrigger className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-white/5 text-foreground/90 cursor-pointer">
                        <span>技能</span>
                        <span className="text-[10px] text-muted-foreground font-normal">
                          {installedSkillList.length === 0
                            ? "尚未安装"
                            : `${activeSkillCount}/${installedSkillList.length} 启用`}
                        </span>
                      </DropdownMenuSubTrigger>

                      <DropdownMenuSubContent collisionPadding={16} avoidCollisions
                        className="w-72 p-1 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-hidden flex flex-col"
                        sideOffset={4}
                      >
                        <div className="px-2 pt-1.5 pb-1 flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                            已安装的技能
                          </span>
                          {installedSkillList.length > 0 && (
                            <button
                              onClick={() => {
                                const allOn = activeSkillCount === installedSkillList.length;
                                const next = new Set(
                                  allOn ? [] : installedSkillList.map((s) => s.id),
                                );
                                setActiveSkillIds(next);
                                try {
                                  localStorage.setItem(
                                    "sentinel:skills:active",
                                    JSON.stringify([...next]),
                                  );
                                } catch {
                                  /* ignore */
                                }
                              }}
                              className="text-[10px] text-muted-foreground hover:text-foreground transition"
                            >
                              {activeSkillCount === installedSkillList.length ? "全部停用" : "全部启用"}
                            </button>
                          )}
                        </div>

                        {installedSkillList.length > 4 && (
                          <div className="px-1.5 pb-1.5">
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40 border border-border/60 focus-within:border-signal/50">
                              <Search className="w-3 h-3 text-muted-foreground" />
                              <input
                                value={skillSubQuery}
                                onChange={(e) => setSkillSubQuery(e.target.value)}
                                placeholder="搜索技能…"
                                className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                              />
                            </div>
                          </div>
                        )}

                        <div className="flex-1 overflow-y-auto max-h-[280px] pr-0.5">
                          {installedSkillList.length === 0 ? (
                            <div className="px-3 py-6 text-center">
                              <Puzzle className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
                              <div className="text-[11px] text-muted-foreground mb-2">
                                你还没有安装任何技能
                              </div>
                              <div className="text-[10px] text-muted-foreground/70">
                                前往市场安装以在对话中调用
                              </div>
                            </div>
                          ) : filteredSkillList.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                              没有匹配 "{skillSubQuery}" 的技能
                            </div>
                          ) : (
                            filteredSkillList.map((s) => {
                              const active = activeSkillIds.has(s.id);
                              const Icon = s.icon;
                              return (
                                <button
                                  key={s.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    toggleSkillActive(s.id);
                                  }}
                                  className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left transition group ${
                                    active
                                      ? "bg-purple-500/10 hover:bg-purple-500/15"
                                      : "hover:bg-white/5"
                                  }`}
                                >
                                  <span
                                    className={`shrink-0 w-6 h-6 rounded flex items-center justify-center ${
                                      active ? s.bg : "bg-muted/40"
                                    }`}
                                  >
                                    <Icon
                                      className={`w-3.5 h-3.5 ${active ? s.color : "text-muted-foreground"}`}
                                    />
                                  </span>
                                  <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                      <span className="text-xs text-foreground/90 truncate">
                                        {s.name}
                                      </span>
                                      {active && (
                                        <span className="text-[9px] font-mono uppercase text-purple-400">
                                          ON
                                        </span>
                                      )}
                                    </span>
                                    <span className="block text-[10px] text-muted-foreground truncate">
                                      {s.hint}
                                    </span>
                                  </span>
                                  <span
                                    className={`shrink-0 mt-1 relative inline-flex h-3.5 w-6 items-center rounded-full transition ${
                                      active ? "bg-purple-500/60" : "bg-muted/60"
                                    }`}
                                  >
                                    <span
                                      className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition ${
                                        active ? "translate-x-3" : "translate-x-0.5"
                                      }`}
                                    />
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>

                        <DropdownMenuSeparator className="my-1" />
                        <button
                          onClick={() => {
                            setSkillSubOpen(false);
                            openMarket("skills");
                          }}
                          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/90 transition"
                        >
                          <span className="flex items-center gap-2">
                            <Plus className="w-3.5 h-3.5 text-signal" />
                            浏览技能市场
                          </span>
                          <ChevronDown className="w-3 h-3 -rotate-90 opacity-60" />
                        </button>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuSub
                      open={mcpSubOpen}
                      onOpenChange={(v) => {
                        setMcpSubOpen(v);
                        if (!v) setMcpSubQuery("");
                      }}
                    >
                      <DropdownMenuSubTrigger className="w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-xs hover:bg-white/5 text-foreground/90 cursor-pointer">
                        <span>连接器 (MCP)</span>
                        <span className="text-[10px] text-muted-foreground font-normal">
                          {connections.length === 0
                            ? "尚未连接"
                            : `${activeCount}/${connections.length} 启用`}
                        </span>
                      </DropdownMenuSubTrigger>

                      <DropdownMenuSubContent collisionPadding={16} avoidCollisions
                        className="w-72 p-1 max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] overflow-hidden flex flex-col"
                        sideOffset={4}
                      >
                        <div className="px-2 pt-1.5 pb-1 flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
                            已连接的 MCP
                          </span>
                          {connections.length > 0 && (
                            <button
                              onClick={() => {
                                const allOn = activeCount === connections.length;
                                setSelectedIds(
                                  new Set(allOn ? [] : connections.map((c) => c.id)),
                                );
                              }}
                              className="text-[10px] text-muted-foreground hover:text-foreground transition"
                            >
                              {activeCount === connections.length ? "全部停用" : "全部启用"}
                            </button>
                          )}
                        </div>

                        {connections.length > 4 && (
                          <div className="px-1.5 pb-1.5">
                            <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40 border border-border/60 focus-within:border-signal/50">
                              <Search className="w-3 h-3 text-muted-foreground" />
                              <input
                                value={mcpSubQuery}
                                onChange={(e) => setMcpSubQuery(e.target.value)}
                                placeholder="搜索连接器…"
                                className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                              />
                            </div>
                          </div>
                        )}

                        <div className="flex-1 overflow-y-auto max-h-[280px] pr-0.5">
                          {connections.length === 0 ? (
                            <div className="px-3 py-6 text-center">
                              <FolderOpen className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
                              <div className="text-[11px] text-muted-foreground mb-2">
                                你还没有连接任何 MCP 服务器
                              </div>
                              <div className="text-[10px] text-muted-foreground/70">
                                前往市场或手动添加以在对话中调用
                              </div>
                            </div>
                          ) : filteredConnections.length === 0 ? (
                            <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                              没有匹配 "{mcpSubQuery}" 的连接器
                            </div>
                          ) : (
                            filteredConnections.map((c) => {
                              const active = selectedIds.has(c.id);
                              const errored = c.state === "error";
                              return (
                                <button
                                  key={c.id}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    toggleConnectionActive(c.id);
                                  }}
                                  className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left transition group ${
                                    active
                                      ? "bg-blue-500/10 hover:bg-blue-500/15"
                                      : "hover:bg-white/5"
                                  }`}
                                >
                                  <span
                                    className={`shrink-0 w-6 h-6 rounded flex items-center justify-center ${
                                      active ? "bg-blue-500/20" : "bg-muted/40"
                                    }`}
                                  >
                                    <Plug
                                      className={`w-3.5 h-3.5 ${
                                        active ? "text-blue-400" : "text-muted-foreground"
                                      }`}
                                    />
                                  </span>
                                  <span className="flex-1 min-w-0">
                                    <span className="flex items-center gap-1.5">
                                      <span className="text-xs text-foreground/90 truncate">
                                        {c.name}
                                      </span>
                                      {active && (
                                        <span className="text-[9px] font-mono uppercase text-blue-400">
                                          ON
                                        </span>
                                      )}
                                      {errored && (
                                        <span className="text-[9px] font-mono uppercase text-red-400">
                                          ERR
                                        </span>
                                      )}
                                    </span>
                                    <span className="block text-[10px] text-muted-foreground truncate">
                                      {c.url}
                                    </span>
                                  </span>
                                  <span
                                    className={`shrink-0 mt-1 relative inline-flex h-3.5 w-6 items-center rounded-full transition ${
                                      active ? "bg-blue-500/60" : "bg-muted/60"
                                    }`}
                                  >
                                    <span
                                      className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition ${
                                        active ? "translate-x-3" : "translate-x-0.5"
                                      }`}
                                    />
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </div>

                        <DropdownMenuSeparator className="my-1" />
                        <button
                          onClick={() => {
                            setMcpSubOpen(false);
                            openMarket("mcp");
                          }}
                          className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded text-xs hover:bg-white/5 text-foreground/90 transition"
                        >
                          <span className="flex items-center gap-2">
                            <Plus className="w-3.5 h-3.5 text-signal" />
                            浏览 MCP 市场
                          </span>
                          <ChevronDown className="w-3 h-3 -rotate-90 opacity-60" />
                        </button>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
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
                    onClick={() => {
                      // Latch the cancel gate FIRST so the tool-result
                      // auto-continue can't re-fire a new request when we
                      // settle pending cards below.
                      cancelledRef.current = true;
                      // Stop the current model stream immediately.
                      stop();
                      // Abort any in-flight browser_* helper calls so their
                      // tool cards exit the loading state immediately.
                      for (const c of browserAbortersRef.current.values()) {
                        try { c.abort(); } catch { /* ignore */ }
                      }
                      browserAbortersRef.current.clear();
                      // Settle every pending tool call (including MCP tools
                      // that never got a client-side handler) with CANCELLED
                      // so no card stays stuck spinning.
                      cancelAllPendingTools();
                    }}


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
        defaultTab={pluginMarketTab}
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

type ConversationItem = {
  id: string;
  title: string;
  updated_at: string;
};

function ConversationList({
  title,
  icon: Icon,
  items,
  activeId,
  onOpen,
  onDelete,
  emptyLabel,
}: {
  title: string;
  icon: typeof PenSquare;
  items: ConversationItem[];
  activeId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  emptyLabel: string;
}) {
  return (
    <>
      <SectionLabel>{title}</SectionLabel>
      {items.length === 0 ? (
        <div className="px-3 text-xs text-muted-foreground/60 italic py-1">{emptyLabel}</div>
      ) : (
        <div className="space-y-0.5">
          {items.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                className={`group relative flex items-center gap-2 px-3 py-1.5 mx-0 rounded-md cursor-pointer transition text-sm ${
                  isActive
                    ? "bg-signal/10 text-foreground"
                    : "text-foreground/80 hover:bg-white/5"
                }`}
                onClick={() => onOpen(c.id)}
              >
                <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-signal" : "text-muted-foreground"}`} />
                <span className="truncate flex-1" title={c.title}>
                  {c.title || "未命名"}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`删除 "${c.title || "未命名"}"？此操作不可撤销。`)) onDelete(c.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition p-0.5 rounded"
                  title="删除"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
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

  // ===== CDP 连接探测（经由 Helper，禁止浏览器直连 9222） =====
  type ProbeStatus =
    | "idle"
    | "checking"
    | "connected"
    | "cdp_not_started"
    | "helper_offline"
    | "timeout"
    | "error";
  type ProbeState =
    | { status: "idle" }
    | { status: "checking"; startedAt: number }
    | {
        status: "connected";
        latency: number;
        browser?: string;
        protocolVersion?: string;
        webSocketDebuggerUrl?: string;
        at: number;
      }
    | {
        status: "cdp_not_started" | "helper_offline" | "timeout" | "error";
        latency: number;
        message: string;
        at: number;
      };
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [flash, setFlash] = useState(false);
  const probeSeq = useRef(0);
  const probeCtrl = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      probeCtrl.current?.abort();
    };
  }, []);

  // Brief highlight after each new result
  useEffect(() => {
    if (probe.status === "idle" || probe.status === "checking") return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe.status === "checking" || probe.status === "idle" ? null : (probe as { at: number }).at]);

  const helperBase = (cfg.helperBase || "http://127.0.0.1:9223").replace(/\/+$/, "");
  const endpointUrl = `${helperBase}/cdp/status?host=${encodeURIComponent(
    cfg.host || "127.0.0.1",
  )}&port=${encodeURIComponent(cfg.port || "9222")}`;

  async function probeOnce(silent = false): Promise<"ok" | "err"> {
    const seq = ++probeSeq.current;
    // Cancel any in-flight probe
    probeCtrl.current?.abort();
    const ctrl = new AbortController();
    probeCtrl.current = ctrl;
    if (!silent) setProbe({ status: "checking", startedAt: Date.now() });
    const started = performance.now();
    const to = setTimeout(() => ctrl.abort(), 5000);
    const stale = () => unmountedRef.current || seq !== probeSeq.current;
    try {
      const res = await fetch(endpointUrl, { signal: ctrl.signal, cache: "no-store" });
      const latency = Math.round(performance.now() - started);
      if (stale()) return "ok";
      if (!res.ok) throw new Error(`Helper HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as {
        connected?: boolean;
        browser?: string;
        protocolVersion?: string;
        webSocketDebuggerUrl?: string;
        error?: string;
      };
      if (stale()) return "ok";
      if (data.connected) {
        if (!silent)
          setProbe({
            status: "connected",
            latency,
            browser: data.browser,
            protocolVersion: data.protocolVersion,
            webSocketDebuggerUrl: data.webSocketDebuggerUrl,
            at: Date.now(),
          });
        return "ok";
      }
      if (!silent)
        setProbe({
          status: "cdp_not_started",
          latency,
          message: data.error || "Helper 已连接，但目标 CDP 端口无响应",
          at: Date.now(),
        });
      return "err";
    } catch (e) {
      const latency = Math.round(performance.now() - started);
      if (stale()) return "err";
      const isAbort = e instanceof DOMException && e.name === "AbortError";
      const isNetwork = e instanceof TypeError;
      const status: ProbeStatus = isAbort
        ? "timeout"
        : isNetwork
        ? "helper_offline"
        : "error";
      const msg = isAbort
        ? "Helper 请求超时（5s 未响应）"
        : isNetwork
        ? `无法访问 Helper (${helperBase})，请确认 sentinel-helper 已启动`
        : e instanceof Error
        ? e.message
        : "未知错误";
      if (!silent) setProbe({ status, latency, message: msg, at: Date.now() });
      return "err";
    } finally {
      clearTimeout(to);
      if (probeCtrl.current === ctrl) probeCtrl.current = null;
    }
  }

  async function runProbe() {
    await probeOnce(false);
  }

  // ===== Chrome 一键启动/停止 =====
  type CdpInfo = {
    browser?: string;
    protocolVersion?: string;
    webSocketDebuggerUrl?: string;
    binary?: string;
    pid?: number | null;
    alreadyRunning?: boolean;
    external?: boolean;
  };
  type LaunchState =
    | { status: "idle" }
    | { status: "checking"; step: string }
    | { status: "starting"; step: string }
    | { status: "verifying"; attempts: number }
    | { status: "connected"; at: number; info: CdpInfo }
    | { status: "stopping" }
    | { status: "stopped"; at: number }
    | { status: "error"; message: string; at: number };
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });
  const [detected, setDetected] = useState<
    | { status: "idle" }
    | { status: "checking" }
    | { status: "ok"; path: string | null; candidates: { path: string; exists: boolean }[] }
    | { status: "err"; message: string }
  >({ status: "idle" });
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

  async function detectBrowserPath() {
    setDetected({ status: "checking" });
    try {
      const res = await fetch(`${helperBase}/detect-browser`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as {
        detected: string | null;
        candidates: { path: string; exists: boolean }[];
      };
      setDetected({ status: "ok", path: j.detected, candidates: j.candidates ?? [] });
      if (j.detected && !cfg.binaryPath) {
        onChange({ ...cfg, binaryPath: j.detected });
        toast.success(`已自动填入: ${j.detected}`);
      } else if (!j.detected) {
        toast.warning("未在默认路径下检测到 Chrome / Edge / Chromium");
      } else {
        toast.info(`检测到浏览器: ${j.detected}（未覆盖当前设置）`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "自动检测失败";
      setDetected({ status: "err", message: msg });
      toast.error(msg);
    }
  }

  async function startChrome() {
    // 1) Pre-check /json/version — if CDP is already up, reuse it.
    setLaunch({ status: "checking", step: "检查 CDP 端点…" });
    const preprobe = await fetch(endpointUrl, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as Record<string, string>) : null))
      .catch(() => null);
    if (preprobe && preprobe.webSocketDebuggerUrl) {
      setLaunch({
        status: "connected",
        at: Date.now(),
        info: {
          browser: preprobe.Browser,
          protocolVersion: preprobe["Protocol-Version"],
          webSocketDebuggerUrl: preprobe.webSocketDebuggerUrl,
          alreadyRunning: true,
          external: true,
        },
      });
      setProbe({
        status: "connected",
        latency: 0,
        browser: preprobe.Browser,
        webSocketDebuggerUrl: preprobe.webSocketDebuggerUrl,
        at: Date.now(),
      });
      toast.success(`CDP 已运行 · ${preprobe.Browser ?? ""}`);
      return;
    }

    // 2) Ask Helper to launch using the configured binaryPath (never a bare `chrome`).
    setLaunch({ status: "starting", step: "请求本地 Helper 启动浏览器…" });
    const tId = toast.loading("正在请求本地 Helper 启动浏览器…");
    type LaunchResp = {
      ok?: boolean;
      error?: string;
      browser?: string;
      protocolVersion?: string;
      webSocketDebuggerUrl?: string;
      binary?: string;
      pid?: number | null;
      alreadyRunning?: boolean;
      external?: boolean;
    };
    let launchJson: LaunchResp = {};
    try {
      const res = await callHelper("/launch", {
        binaryPath: cfg.binaryPath || undefined,
        host: cfg.host || "127.0.0.1",
        port: cfg.port || "9222",
        userDataDir: cfg.userDataDir || undefined,
        extraFlags: cfg.extraFlags || undefined,
        remoteAllowOrigin: window.location.origin,
      });
      launchJson = ((await res.json().catch(() => ({}))) as LaunchResp) || {};
      if (!res.ok || !launchJson.ok) {
        throw new Error(launchJson.error || `Helper 返回 HTTP ${res.status}`);
      }
    } catch (e) {
      const isNet = e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError");
      const msg = isNet
        ? `无法访问本地 Helper (${helperBase})。请先在本机运行 \`cd docs/sentinel-helper && npm start\``
        : e instanceof Error
        ? e.message
        : "启动失败";
      setLaunch({ status: "error", message: msg, at: Date.now() });
      toast.error(msg, { id: tId });
      return;
    }

    // 3) Poll /json/version to confirm CDP responds.
    setLaunch({ status: "verifying", attempts: 0 });
    const ok = await pollUntilReachable();
    if (!ok) {
      const msg = "已请求启动,但 DevTools 端点在 12s 内未响应";
      setLaunch({ status: "error", message: msg, at: Date.now() });
      toast.error(msg, { id: tId });
      return;
    }
    setLaunch({
      status: "connected",
      at: Date.now(),
      info: {
        browser: launchJson.browser,
        protocolVersion: launchJson.protocolVersion,
        webSocketDebuggerUrl: launchJson.webSocketDebuggerUrl,
        binary: launchJson.binary,
        pid: launchJson.pid ?? null,
        alreadyRunning: launchJson.alreadyRunning,
        external: launchJson.external,
      },
    });
    toast.success(
      launchJson.alreadyRunning ? "CDP 已运行,已复用" : "浏览器已启动并连接 CDP",
      { id: tId },
    );
  }


  async function stopChrome() {
    setLaunch({ status: "stopping" });
    try {
      const res = await callHelper("/stop", { port: cfg.port || "9222" });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        wasRunning?: boolean;
        external?: boolean;
        message?: string;
      };
      if (!res.ok) throw new Error(`Helper 返回 HTTP ${res.status}`);
      if (j.external) {
        toast.info(j.message || "外部 Chrome 未由 Helper 启动,已跳过");
      } else if (j.wasRunning) {
        toast.success("已停止 Helper 启动的浏览器");
      } else {
        toast.info("Helper 未记录到运行中的浏览器");
      }
      setLaunch({ status: "stopped", at: Date.now() });
      setProbe({ status: "idle" });
    } catch (e) {
      const isNet = e instanceof TypeError || (e instanceof DOMException && e.name === "AbortError");
      const msg = isNet
        ? `无法访问本地 Helper (${helperBase})`
        : e instanceof Error
        ? e.message
        : "停止失败";
      setLaunch({ status: "error", message: msg, at: Date.now() });
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
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">浏览器可执行文件路径</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={detectBrowserPath}
                    disabled={detected.status === "checking"}
                    className="h-6 text-[11px] px-2"
                    title="通过本地 Helper 扫描常见 Chrome / Edge / Chromium 安装位置"
                  >
                    {detected.status === "checking" ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <Wand2 className="w-3 h-3 mr-1" />
                    )}
                    自动检测
                  </Button>
                </div>
                <Input
                  value={cfg.binaryPath}
                  onChange={(e) => onChange({ ...cfg, binaryPath: e.target.value })}
                  placeholder="例如 C:\\Users\\you\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe"
                  className="h-8 text-xs font-mono"
                />
                <div className="text-[11px] text-muted-foreground leading-relaxed">
                  留空时 Helper 会自动尝试：
                  <span className="font-mono"> Program Files\\Google\\Chrome</span>、
                  <span className="font-mono">LOCALAPPDATA\\Google\\Chrome</span>、
                  <span className="font-mono">LOCALAPPDATA\\ms-playwright\\chromium-*\\chrome-win64\\chrome.exe</span>
                  、Microsoft Edge 常见路径。绝不再回退到 PATH 上的 <span className="font-mono">chrome</span> 命令。
                </div>
                {detected.status === "ok" && (
                  <div className="rounded-md border border-border/60 bg-surface-1/60 p-2 text-[10px] font-mono space-y-0.5 max-h-32 overflow-auto">
                    <div className="text-[11px] font-medium text-foreground/80 mb-1 font-sans">
                      检测结果 {detected.path ? `· 命中: ${detected.path}` : "· 未找到"}
                    </div>
                    {detected.candidates.map((c) => (
                      <div
                        key={c.path}
                        className={c.exists ? "text-emerald-400" : "text-muted-foreground/60"}
                      >
                        {c.exists ? "✔" : "·"} {c.path}
                      </div>
                    ))}
                  </div>
                )}
                {detected.status === "err" && (
                  <div className="text-[11px] text-destructive">检测失败：{detected.message}</div>
                )}
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
                      type="button"
                      size="sm"
                      onClick={startChrome}
                      disabled={launch.status === "checking" || launch.status === "starting" || launch.status === "verifying" || launch.status === "stopping"}
                      className="h-8 text-xs"
                    >
                      {launch.status === "checking" || launch.status === "starting" || launch.status === "verifying" ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <Zap className="w-3.5 h-3.5 mr-1" />
                      )}
                      启动 Chrome
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={stopChrome}
                      disabled={launch.status === "checking" || launch.status === "starting" || launch.status === "verifying" || launch.status === "stopping"}
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
                  <div className="pt-2 border-t border-border/60 text-[11px] space-y-1">
                    {launch.status === "checking" && (
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> {launch.step}
                      </div>
                    )}
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
                    {launch.status === "connected" && (
                      <>
                        <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          CDP 已连接 · {new Date(launch.at).toLocaleTimeString()}
                          {launch.info.alreadyRunning && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30">
                              CDP 已运行
                            </span>
                          )}
                          {launch.info.external && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">
                              外部进程
                            </span>
                          )}
                        </div>
                        {launch.info.browser && (
                          <div className="font-mono text-[10px] opacity-80">
                            浏览器：{launch.info.browser}
                            {launch.info.protocolVersion && (
                              <> · Protocol {launch.info.protocolVersion}</>
                            )}
                          </div>
                        )}
                        {launch.info.webSocketDebuggerUrl && (
                          <div className="font-mono text-[10px] opacity-80 break-all">
                            ws: {launch.info.webSocketDebuggerUrl}
                          </div>
                        )}
                        {launch.info.binary && (
                          <div className="font-mono text-[10px] opacity-70 break-all">
                            binary: {launch.info.binary}
                            {launch.info.pid ? ` · pid ${launch.info.pid}` : ""}
                          </div>
                        )}
                      </>
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
                    {launch.status === "error" && (
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



              {(() => {
                const s = probe.status;
                const isChecking = s === "checking";
                const isOk = s === "connected";
                const isWarn = s === "cdp_not_started";
                const isErr = s === "helper_offline" || s === "timeout" || s === "error";
                const cardTone = isChecking
                  ? "border-sky-500/60 bg-sky-500/5 ring-1 ring-sky-500/30"
                  : isOk
                  ? "border-emerald-500/60 bg-emerald-500/5"
                  : isWarn
                  ? "border-amber-500/60 bg-amber-500/5"
                  : isErr
                  ? "border-destructive/60 bg-destructive/5"
                  : "border-border bg-surface-2/60";
                const flashRing = flash
                  ? isOk
                    ? "ring-2 ring-emerald-400/70"
                    : isWarn
                    ? "ring-2 ring-amber-400/70"
                    : isErr
                    ? "ring-2 ring-destructive/70"
                    : ""
                  : "";
                const headline = isChecking
                  ? "正在通过 Helper 检查 CDP 连接…"
                  : isOk
                  ? "Helper 已连接 · CDP 已连接"
                  : s === "cdp_not_started"
                  ? "Helper 已连接，CDP 未启动"
                  : s === "helper_offline"
                  ? "Helper 未连接"
                  : s === "timeout"
                  ? "Helper 请求超时"
                  : s === "error"
                  ? "检测失败"
                  : "尚未测试";
                const HeadIcon = isChecking
                  ? Loader2
                  : isOk
                  ? CheckCircle2
                  : isWarn
                  ? AlertTriangle
                  : isErr
                  ? WifiOff
                  : Wifi;
                const headTone = isChecking
                  ? "text-sky-400"
                  : isOk
                  ? "text-emerald-400"
                  : isWarn
                  ? "text-amber-400"
                  : isErr
                  ? "text-destructive"
                  : "text-muted-foreground";
                return (
                  <div
                    className={`rounded-lg border p-3 space-y-2 transition-all duration-300 ${cardTone} ${flashRing}`}
                    aria-live="polite"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <HeadIcon
                          className={`w-4 h-4 shrink-0 ${headTone} ${isChecking ? "animate-spin" : ""}`}
                          aria-hidden="true"
                        />
                        <span className={`text-xs font-medium truncate ${headTone}`}>
                          {headline}
                        </span>
                        {(isOk || isWarn || isErr) && (
                          <span className="text-[11px] text-muted-foreground shrink-0">
                            · 耗时 <span className="font-mono">{probe.latency} ms</span>
                          </span>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        onClick={runProbe}
                        disabled={isChecking}
                        aria-busy={isChecking}
                        className="h-8 text-xs font-medium shrink-0"
                      >
                        {isChecking ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" aria-hidden="true" />
                            检测中…
                          </>
                        ) : (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                            {s === "idle" ? "测试连接" : "重新检测"}
                          </>
                        )}
                      </Button>
                    </div>

                    {isOk && (
                      <div className="space-y-1 pt-1 border-t border-emerald-500/20">
                        {probe.browser && (
                          <div className="text-[11px] text-muted-foreground">
                            浏览器: <span className="font-mono text-foreground">{probe.browser}</span>
                          </div>
                        )}
                        {probe.protocolVersion && (
                          <div className="text-[11px] text-muted-foreground">
                            Protocol-Version:{" "}
                            <span className="font-mono text-foreground">{probe.protocolVersion}</span>
                          </div>
                        )}
                        {probe.webSocketDebuggerUrl && (
                          <div className="text-[11px] text-muted-foreground truncate">
                            WebSocket:{" "}
                            <span className="font-mono text-foreground">
                              {probe.webSocketDebuggerUrl}
                            </span>
                          </div>
                        )}
                        <div className="text-[11px] text-muted-foreground">
                          最后检测：{new Date(probe.at).toLocaleTimeString()} · 通过 Helper{" "}
                          <span className="font-mono">{helperBase}</span>
                        </div>
                      </div>
                    )}

                    {isWarn && (
                      <div className="space-y-2 pt-1 border-t border-amber-500/20">
                        <div className="text-[11px] text-amber-300/90">{probe.message}</div>
                        <div className="text-[11px] text-muted-foreground leading-relaxed">
                          请点击上方「启动 Chrome」由 Helper 拉起浏览器（CDP 全部由 Helper
                          在本机代为发起，网页不会直连 9222）。
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            onClick={startChrome}
                            className="h-7 text-xs"
                          >
                            <Zap className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                            启动 Chrome
                          </Button>
                          <span className="text-[11px] text-muted-foreground">
                            最后检测：{new Date(probe.at).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    )}

                    {isErr && (
                      <div className="space-y-2 pt-1 border-t border-destructive/20">
                        <div className="text-[11px] text-destructive">{probe.message}</div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            onClick={runProbe}
                            className="h-7 text-xs"
                          >
                            <RefreshCw className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
                            重试检测
                          </Button>
                          <span className="text-[11px] text-muted-foreground">
                            最后检测：{new Date(probe.at).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

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
      chromeCfg.binaryPath || "<Helper 自动检测>",
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


              {section === "memory" && <MemoryPanel />}

              {section === "model" && <CustomModelsPanel />}

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
                <div className="space-y-2">
                  <SettingsPanel
                    rows={[
                      { title: "默认工作空间存储路径", hint: "新建任务、工作空间时将自动保存在该路径下。修改后不影响已有数据。", action: "text", storeKey: "data:workspacePath", value: "D:\\2.project\\lovable-create\\cc9-data" },
                    ]}
                  />
                  <LocalBackupRow />
                  <SettingsPanel
                    rows={[
                      { title: "导出全部数据", hint: "导出你的会话、记忆和设置", action: "button", buttonLabel: "导出" },
                    ]}
                  />
                </div>
              )}


              {section === "security" && (
                <div className="space-y-2">
                  <TwoFactorRow />
                  <SettingsPanel
                    rows={[
                      { title: "登录活动", hint: "查看最近的登录设备与地点", action: "button", buttonLabel: "查看" },
                      { title: "会话与设备", hint: "撤销其他设备上的登录", action: "button", buttonLabel: "管理" },
                      { title: "API 密钥", hint: "管理用于访问 Sentinel 的密钥", action: "button", buttonLabel: "管理" },
                      { title: "删除账户", hint: "永久删除账户及所有关联数据", action: "button", buttonLabel: "删除", danger: true },
                    ]}
                  />
                </div>
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

function formatRelativeZh(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return "刚刚";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

function MemoryPanel() {
  const qc = useQueryClient();
  const listFn = useServerFn(memoriesListFn);
  const addFn = useServerFn(memoriesAddFn);
  const updateFn = useServerFn(memoriesUpdateFn);
  const deleteFn = useServerFn(memoriesDeleteFn);
  const clearFn = useServerFn(memoriesClearFn);
  const autoGenFn = useServerFn(memoriesAutoGenFn);
  const importFn = useServerFn(memoriesImportFn);
  const profileGet = useServerFn(profileGetFn);
  const profileSave = useServerFn(profileSaveFn);
  const profileClear = useServerFn(profileClearFn);
  const profileRegen = useServerFn(profileRegenFn);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["user_memories"],
    queryFn: () => listFn(),
  });

  const { data: profile } = useQuery({
    queryKey: ["user_memory_profile"],
    queryFn: () => profileGet(),
  });
  const profileContent = (profile as { content?: string } | undefined)?.content ?? "";
  const profileUpdatedAt = (profile as { updated_at?: string | null } | undefined)?.updated_at ?? null;

  const [editingProfile, setEditingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);


  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("sentinel:memory:enabled");
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const [autoGen, setAutoGen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("sentinel:memory:autogen");
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  });
  const [cross, setCross] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("sentinel:memory:cross");
      return v === null ? false : v === "1";
    } catch {
      return false;
    }
  });
  function persistToggle(key: string, v: boolean) {
    try {
      localStorage.setItem(`sentinel:${key}`, v ? "1" : "0");
    } catch {}
  }

  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["user_memories"] });

  const addMut = useMutation({
    mutationFn: (content: string) => addFn({ data: { content } }),
    onSuccess: () => {
      setDraft("");
      setShowAdd(false);
      invalidate();
      toast.success("已保存记忆");
    },
    onError: (e: Error) => toast.error(e.message ?? "保存失败"),
  });
  const updateMut = useMutation({
    mutationFn: (v: { id: string; content: string }) => updateFn({ data: v }),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
      toast.success("已更新");
    },
    onError: (e: Error) => toast.error(e.message ?? "更新失败"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("已删除");
    },
    onError: (e: Error) => toast.error(e.message ?? "删除失败"),
  });
  const clearMut = useMutation({
    mutationFn: () => clearFn(),
    onSuccess: () => {
      invalidate();
      toast.success("已清除全部记忆");
    },
    onError: (e: Error) => toast.error(e.message ?? "清除失败"),
  });
  const autoGenMut = useMutation({
    mutationFn: () => autoGenFn(),
    onSuccess: (r: { added?: number; reason?: string }) => {
      invalidate();
      if ((r?.added ?? 0) > 0) {
        toast.success(`AI 已从历史对话新增 ${r.added} 条记忆`);
      } else if (r?.reason === "empty_history" || r?.reason === "no_text") {
        toast.info("暂无可分析的历史对话，先聊几句再试");
      } else {
        toast.info("没有发现新的可记忆内容");
      }
    },
    onError: (e: Error) => toast.error(e.message ?? "AI 分析失败"),
  });
  const importMut = useMutation({
    mutationFn: (text: string) => importFn({ data: { text } }),
    onSuccess: (r: { added?: number }) => {
      invalidate();
      if ((r?.added ?? 0) > 0) {
        toast.success(`已导入 ${r.added} 条记忆`);
        setImportText("");
        setImportOpen(false);
      } else {
        toast.info("没有识别出新的可导入记忆");
      }
    },
    onError: (e: Error) => toast.error(e.message ?? "导入失败"),
  });

  const invalidateProfile = () => qc.invalidateQueries({ queryKey: ["user_memory_profile"] });
  const profileRegenMut = useMutation({
    mutationFn: () => profileRegen(),
    onSuccess: (r: { ok?: boolean; reason?: string }) => {
      invalidateProfile();
      if (r?.ok) toast.success("已重新生成整体记忆档案");
      else if (r?.reason === "empty") toast.info("暂无可分析的内容，先聊几句或添加记忆再试");
      else toast.info("暂未生成新的档案");
    },
    onError: (e: Error) => toast.error(e.message ?? "生成失败"),
  });
  const profileSaveMut = useMutation({
    mutationFn: (content: string) => profileSave({ data: { content } }),
    onSuccess: () => {
      invalidateProfile();
      setEditingProfile(false);
      toast.success("已保存档案");
    },
    onError: (e: Error) => toast.error(e.message ?? "保存失败"),
  });
  const profileClearMut = useMutation({
    mutationFn: () => profileClear(),
    onSuccess: () => {
      invalidateProfile();
      toast.success("已删除档案");
    },
    onError: (e: Error) => toast.error(e.message ?? "删除失败"),
  });


  const latestUpdatedAt = items.length
    ? (items[0] as { updated_at?: string }).updated_at ?? null
    : null;

  return (
    <div className="space-y-3">
      {/* 顶部说明 */}
      <div className="text-xs text-muted-foreground leading-relaxed px-1">
        记忆让 Sentinel 记住你的偏好和习惯，对话越多，它就越懂你。记忆内容仅你本人可见。
      </div>

      {/* 主开关：启用记忆 */}
      <div className="p-3 rounded-lg border border-border bg-surface-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">启用记忆</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              开启后，Sentinel 每次回答/执行前会读取下方保存的记忆条目
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              setEnabled(v);
              persistToggle("memory:enabled", v);
            }}
          />
        </div>
      </div>

      {/* 生成对话记忆 */}
      <div className="p-3 rounded-lg border border-signal/40 bg-signal/5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-signal" />
              <div className="text-sm font-medium text-foreground">生成对话记忆</div>
            </div>
            <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
              允许 Sentinel 从对话中自动提炼并记住相关上下文（身份、偏好、工作对象、技术栈等），以便未来对话中提供更连贯、个性化的回应。
            </div>
          </div>
          <Switch
            checked={autoGen}
            onCheckedChange={(v) => {
              setAutoGen(v);
              persistToggle("memory:autogen", v);
            }}
          />
        </div>

        {/* 关于你的记忆 — 整体档案（可叠加优化） */}
        <div className="mt-3 rounded-md border border-border bg-background/40 overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-background/60 transition-colors"
            onClick={() => setProfileOpen((v) => !v)}
          >
            <div className="min-w-0 flex-1 text-left">
              <div className="text-xs font-medium text-foreground">关于你的记忆</div>
              <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                {profileContent
                  ? `${profileContent.replace(/[#*\-\n]+/g, " ").trim().slice(0, 60)}…`
                  : "还没有生成整体档案，点「立即重新生成」开始"}
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground shrink-0">
              {profileUpdatedAt ? formatRelativeZh(profileUpdatedAt) + "更新" : "未生成"}
            </div>
          </button>

          {profileOpen && (
            <div className="border-t border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  由 AI 整合「历史对话 + 手动记忆 + 上一版档案」生成的整体档案，每次重新生成会在原基础上叠加优化。
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {profileContent && !editingProfile && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        title="编辑档案"
                        onClick={() => {
                          setProfileDraft(profileContent);
                          setEditingProfile(true);
                        }}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        title="删除档案"
                        disabled={profileClearMut.isPending}
                        onClick={() => {
                          if (confirm("确定删除整体记忆档案？下次可重新生成。")) {
                            profileClearMut.mutate();
                          }
                        }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {editingProfile ? (
                <div className="space-y-2">
                  <Textarea
                    value={profileDraft}
                    onChange={(e) => setProfileDraft(e.target.value)}
                    rows={14}
                    className="text-sm font-mono"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingProfile(false)}>
                      取消
                    </Button>
                    <Button
                      size="sm"
                      disabled={profileSaveMut.isPending}
                      onClick={() => profileSaveMut.mutate(profileDraft)}
                    >
                      保存
                    </Button>
                  </div>
                </div>
              ) : profileContent ? (
                <div className="text-sm whitespace-pre-wrap break-words leading-relaxed max-h-80 overflow-y-auto p-2 rounded bg-background/60 border border-border/60">
                  {profileContent}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-4 text-center">
                  还没有档案。点下方「立即重新生成」由 AI 从你的历史对话与已保存记忆中整合出一份。
                </div>
              )}

              <div className="flex items-center justify-between pt-1">
                <div className="text-[11px] text-muted-foreground">
                  来源：对话历史 · {items.length} 条手动记忆
                </div>
                <Button
                  size="sm"
                  disabled={profileRegenMut.isPending || !autoGen}
                  onClick={() => profileRegenMut.mutate()}
                  title={!autoGen ? "请先开启「生成对话记忆」" : "在现有档案上叠加优化"}
                >
                  {profileRegenMut.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                  ) : (
                    <Wand2 className="w-3.5 h-3.5 mr-1" />
                  )}
                  {profileRegenMut.isPending
                    ? "生成中…"
                    : profileContent
                      ? "立即重新生成"
                      : "立即生成"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>


      {/* 从其他AI导入记忆 */}
      <div className="p-3 rounded-lg border border-border bg-surface-1">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-muted-foreground" />
              <div className="text-sm font-medium text-foreground">从其他 AI 导入记忆</div>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              粘贴 ChatGPT / Claude / WorkBuddy 等其他 AI 的记忆内容，一键同步你的使用习惯
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setImportOpen((v) => !v)}
          >
            {importOpen ? "收起" : "导入"}
          </Button>
        </div>
        {importOpen && (
          <div className="mt-3 space-y-2">
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="将你在其他 AI 上导出的记忆内容粘贴到这里，Sentinel 会自动清洗并合并到你的记忆库…"
              rows={5}
              className="text-sm"
            />
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground">
                导入前会由 AI 清洗、去重、剔除敏感信息
              </div>
              <Button
                size="sm"
                disabled={!importText.trim() || importMut.isPending}
                onClick={() => importMut.mutate(importText.trim())}
              >
                {importMut.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5 mr-1" />
                )}
                {importMut.isPending ? "导入中…" : "开始导入"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 跨会话（次要） */}
      <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">跨会话共享</div>
          <div className="text-xs text-muted-foreground">
            所有会话共享同一份记忆库（关闭仅作为标记，暂不隔离）
          </div>
        </div>
        <Switch
          checked={cross}
          onCheckedChange={(v) => {
            setCross(v);
            persistToggle("memory:cross", v);
          }}
        />
      </div>

      {/* 已保存的记忆 */}
      <div className="p-3 rounded-lg border border-border bg-surface-1">
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="text-sm font-medium text-foreground">
            已保存的记忆 ({items.length})
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowAdd((v) => !v)}
            >
              <Plus className="w-3.5 h-3.5 mr-1" />
              {showAdd ? "收起" : "手动添加"}
            </Button>
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                disabled={clearMut.isPending}
                onClick={() => {
                  if (confirm("确定要永久删除全部记忆？此操作不可撤销。")) {
                    clearMut.mutate();
                  }
                }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                清除全部
              </Button>
            )}
          </div>
        </div>

        {showAdd && (
          <div className="mb-3 p-2.5 rounded-md border border-border bg-background/40 space-y-2">
            <div className="text-xs text-muted-foreground">
              例如："我是外贸卖家，主营阿里国际站"、"代码统一用 TypeScript"、"回答先给结论再给理由"。
            </div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="写一条希望 Sentinel 长期记住的信息…"
              rows={2}
              className="text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setDraft(""); }}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={!draft.trim() || addMut.isPending}
                onClick={() => addMut.mutate(draft.trim())}
              >
                保存
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-xs text-muted-foreground py-4 text-center">加载中…</div>
        ) : items.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">
            还没有保存记忆。开启「生成对话记忆」或点「手动添加」，Sentinel 会在下次回答/任务时自动参考。
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map((m: { id: string; content: string; updated_at?: string; created_at?: string }) => (
              <li
                key={m.id}
                className="p-2 rounded-md border border-border bg-background/40"
              >
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      rows={2}
                      className="text-sm"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                        取消
                      </Button>
                      <Button
                        size="sm"
                        disabled={!editingText.trim() || updateMut.isPending}
                        onClick={() =>
                          updateMut.mutate({ id: m.id, content: editingText.trim() })
                        }
                      >
                        保存
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0 text-sm whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setEditingId(m.id);
                            setEditingText(m.content);
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          disabled={deleteMut.isPending}
                          onClick={() => deleteMut.mutate(m.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    {(m.updated_at || m.created_at) && (
                      <div className="text-[11px] text-muted-foreground">
                        {formatRelativeZh(m.updated_at ?? m.created_at)}更新
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
  { key: "model", label: "模型", hint: "管理自定义模型与本地配置文件", icon: Box },
  { key: "assistant", label: "助理设置", hint: "自定义助理的行为与个性", icon: UserCog },
  { key: "data", label: "数据管理", hint: "管理你分享的文件、任务与应用", icon: Database },
  { key: "security", label: "安全中心", hint: "账户安全、设备与密钥", icon: Shield },
];

type PanelRow =
  | { title: string; hint: string; action: "toggle"; storeKey: string; defaultOn: boolean }
  | { title: string; hint: string; action: "button"; buttonLabel: string; danger?: boolean }
  | { title: string; hint: string; action: "text"; storeKey: string; value: string };

function LocalBackupRow() {
  const [saving, setSaving] = useState(false);
  const DEFAULT_PATH = "D:\\2.project\\lovable-create\\cc9-data";

  async function handleSave() {
    setSaving(true);
    try {
      // 1) 汇总所有本地键值
      const localData: Record<string, string> = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (k.startsWith("sentinel:") || k.startsWith("sb-") || k.startsWith("cc9:")) {
            localData[k] = localStorage.getItem(k) ?? "";
          }
        }
      } catch {}

      // 2) 拉取云端记忆 / 档案（尽力而为）
      let memories: unknown = null;
      let profile: unknown = null;
      try {
        const [m, p] = await Promise.all([
          supabase.from("user_memories").select("*"),
          supabase.from("user_memory_profile").select("*").maybeSingle(),
        ]);
        memories = m.data ?? null;
        profile = p.data ?? null;
      } catch {}

      const payload = {
        exportedAt: new Date().toISOString(),
        version: 1,
        localStorage: localData,
        memories,
        memoryProfile: profile,
      };

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `cc9-backup-${ts}.json`;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });

      // 优先使用 File System Access API 让用户直接落到指定目录
      const w = window as unknown as {
        showSaveFilePicker?: (opts: {
          suggestedName: string;
          types?: Array<{ description: string; accept: Record<string, string[]> }>;
        }) => Promise<{
          createWritable: () => Promise<{
            write: (b: Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      };

      if (w.showSaveFilePicker) {
        try {
          const handle = await w.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          toast.success("已保存到你选择的位置", {
            description: `文件名 ${filename}，默认路径 ${DEFAULT_PATH}`,
          });
          return;
        } catch (err) {
          if ((err as { name?: string })?.name === "AbortError") {
            setSaving(false);
            return;
          }
          // 回退到普通下载
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("已导出备份文件", {
        description: `已下载 ${filename}，请手动移动到 ${DEFAULT_PATH}`,
      });
    } catch (e) {
      toast.error((e as Error).message ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-signal/40 bg-signal/5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">一键保存当前数据到本地</div>
        <div className="text-xs text-muted-foreground truncate">
          将会话记忆、档案与本地设置打包为 JSON，默认路径 {DEFAULT_PATH}
        </div>
      </div>
      <Button size="sm" disabled={saving} onClick={handleSave}>
        {saving ? (
          <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5 mr-1" />
        )}
        {saving ? "保存中…" : "一键保存"}
      </Button>
    </div>
  );
}

type CustomModel = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
  createdAt: string;
};

const MODELS_STORE_KEY = "sentinel:model:custom-list";
const MODELS_LOCAL_PATH = "%USERPROFILE%\\.sentinel\\models.json";

function TwoFactorRow() {
  const regenCodesFn = useServerFn(regenerateRecoveryCodes);
  const getCodesStatusFn = useServerFn(getRecoveryCodesStatus);

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<{
    factorId: string;
    qr: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  // 恢复码状态
  const [codesRemaining, setCodesRemaining] = useState<number | null>(null);
  const [codesTotal, setCodesTotal] = useState<number | null>(null);
  const [codesOpen, setCodesOpen] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      const verified = (data?.totp ?? []).find((f) => f.status === "verified");
      const isOn = !!verified;
      setEnabled(isOn);
      if (isOn) {
        try {
          const s = await getCodesStatusFn();
          setCodesTotal(s.total);
          setCodesRemaining(s.remaining);
        } catch {
          setCodesTotal(null);
          setCodesRemaining(null);
        }
      } else {
        setCodesTotal(null);
        setCodesRemaining(null);
      }
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startEnroll() {
    try {
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.totp ?? []) {
        if (f.status !== "verified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Sentinel TOTP ${new Date().toLocaleDateString()}`,
      });
      if (error) throw error;
      setEnrollment({
        factorId: data.id,
        qr: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setCode("");
      setOpen(true);
    } catch (e) {
      toast.error("启用失败", { description: (e as Error).message });
    }
  }

  async function verify() {
    if (!enrollment) return;
    if (code.replace(/\s/g, "").length !== 6) {
      toast.error("请输入 6 位验证码");
      return;
    }
    setVerifying(true);
    try {
      const { data: chall, error: cErr } = await supabase.auth.mfa.challenge({
        factorId: enrollment.factorId,
      });
      if (cErr) throw cErr;
      const { error: vErr } = await supabase.auth.mfa.verify({
        factorId: enrollment.factorId,
        challengeId: chall.id,
        code: code.replace(/\s/g, ""),
      });
      if (vErr) throw vErr;

      // 绑定成功后生成一组恢复码
      let generated: string[] = [];
      try {
        const r = await regenCodesFn();
        generated = r.codes;
      } catch (e) {
        toast.error("恢复码生成失败", { description: (e as Error).message });
      }

      toast.success("两步验证已启用");
      setOpen(false);
      setEnrollment(null);
      setCode("");
      if (generated.length > 0) {
        setFreshCodes(generated);
        setCodesOpen(true);
      }
      await refresh();
    } catch (e) {
      toast.error("验证失败", { description: (e as Error).message });
    } finally {
      setVerifying(false);
    }
  }

  async function handleToggle(on: boolean) {
    if (on) {
      await startEnroll();
      return;
    }
    if (!confirm("确定要关闭两步验证吗？关闭后恢复码也将一并作废。")) return;
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of data?.totp ?? []) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      // 清空恢复码（重新生成 0 条不合适，直接由后端负责失效——通过重新生成覆盖旧的仅在启用状态下才做，这里用 supabase 客户端直接删）
      try {
        const uid = (await supabase.auth.getUser()).data.user?.id;
        if (uid) {
          await supabase.from("user_recovery_codes").delete().eq("user_id", uid);
        }
      } catch {}
      toast.success("已关闭两步验证");
      await refresh();
    } catch (e) {
      toast.error("关闭失败", { description: (e as Error).message });
    }
  }

  async function cancelEnroll() {
    if (enrollment) {
      try {
        await supabase.auth.mfa.unenroll({ factorId: enrollment.factorId });
      } catch {}
    }
    setOpen(false);
    setEnrollment(null);
    setCode("");
  }

  async function handleRegenerate() {
    if (!confirm("重新生成后旧的恢复码将立即作废，是否继续？")) return;
    setRegenerating(true);
    try {
      const r = await regenCodesFn();
      setFreshCodes(r.codes);
      setCodesOpen(true);
      await refresh();
      toast.success("已生成新的恢复码");
    } catch (e) {
      toast.error("生成失败", { description: (e as Error).message });
    } finally {
      setRegenerating(false);
    }
  }

  function copyAllCodes() {
    if (!freshCodes) return;
    navigator.clipboard?.writeText(freshCodes.join("\n"));
    toast.success("已复制全部恢复码");
  }

  function downloadCodes() {
    if (!freshCodes) return;
    const header = `Sentinel OS · 两步验证恢复码\n生成时间: ${new Date().toLocaleString()}\n\n每个恢复码只能使用一次，请妥善保存。\n\n`;
    const blob = new Blob([header + freshCodes.join("\n") + "\n"], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentinel-recovery-codes-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("已下载恢复码文件");
  }

  return (
    <>
      <div className="rounded-lg border border-border bg-surface-1">
        <div className="flex items-center gap-3 p-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">两步验证</div>
            <div className="text-xs text-muted-foreground">
              使用 Google Authenticator / Authy 等 TOTP 应用为登录添加额外一层保护
            </div>
          </div>
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <Switch checked={enabled} onCheckedChange={handleToggle} />
          )}
        </div>
        {enabled && !loading && (
          <div className="flex items-center gap-3 p-3 border-t border-border">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">恢复码</div>
              <div className="text-xs text-muted-foreground">
                {codesTotal === null
                  ? "无法读取恢复码状态"
                  : codesTotal === 0
                    ? "尚未生成恢复码，建议立即生成并妥善保管"
                    : `剩余 ${codesRemaining ?? 0} / ${codesTotal} 个可用，用于在无法访问 TOTP 应用时找回账号`}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={regenerating}
              onClick={handleRegenerate}
            >
              {regenerating ? (
                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 mr-1" />
              )}
              {codesTotal ? "重新生成" : "生成恢复码"}
            </Button>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={(v) => { if (!v) cancelEnroll(); else setOpen(v); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>启用两步验证</DialogTitle>
          </DialogHeader>
          {enrollment && (
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground leading-relaxed">
                1. 打开 Google Authenticator / Authy / 1Password 等 TOTP 应用<br />
                2. 扫描下方二维码，或手动输入密钥<br />
                3. 输入应用生成的 6 位验证码完成绑定
              </div>
              <div className="flex justify-center p-4 bg-white rounded-lg">
                <img src={enrollment.qr} alt="TOTP QR" className="w-44 h-44" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">手动密钥</Label>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={enrollment.secret}
                    className="font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard?.writeText(enrollment.secret);
                      toast.success("已复制密钥");
                    }}
                  >
                    <CopyIcon className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">6 位验证码</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="font-mono text-lg tracking-widest text-center"
                  maxLength={6}
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={cancelEnroll} disabled={verifying}>取消</Button>
            <Button onClick={verify} disabled={verifying || code.length !== 6}>
              {verifying && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              验证并启用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={codesOpen}
        onOpenChange={(v) => {
          setCodesOpen(v);
          if (!v) setFreshCodes(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>保存你的恢复码</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground leading-relaxed">
              这些恢复码<span className="text-destructive font-medium">只显示这一次</span>。请立即复制或下载并妥善保管：当你无法访问 TOTP 应用时，可用其中任意一个登录（每个只能使用一次）。
            </div>
            <div className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-border bg-background/50 font-mono text-sm">
              {freshCodes?.map((c, i) => (
                <div
                  key={i}
                  className="px-2 py-1.5 rounded bg-surface-1 text-foreground text-center tracking-wider"
                >
                  {c}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" onClick={copyAllCodes}>
                <CopyIcon className="w-3.5 h-3.5 mr-1" />
                复制全部
              </Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={downloadCodes}>
                <Download className="w-3.5 h-3.5 mr-1" />
                下载为文本
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => { setCodesOpen(false); setFreshCodes(null); }}>
              我已妥善保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}



function loadCustomModels(): CustomModel[] {
  try {
    const raw = localStorage.getItem(MODELS_STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomModels(list: CustomModel[]) {
  try {
    localStorage.setItem(MODELS_STORE_KEY, JSON.stringify(list));
  } catch {}
}

function CustomModelsPanel() {
  const [models, setModels] = useState<CustomModel[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomModel | null>(null);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setModels(loadCustomModels());
  }, []);

  function persist(next: CustomModel[]) {
    setModels(next);
    saveCustomModels(next);
    try {
      localStorage.setItem(
        "sentinel:model:custom-list:lastSyncedAt",
        new Date().toISOString(),
      );
    } catch {}
  }

  function openAdd() {
    setEditing({
      id: `m_${Date.now().toString(36)}`,
      name: "",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      contextWindow: 128000,
      supportsVision: false,
      supportsTools: true,
      createdAt: new Date().toISOString(),
    });
    setOpen(true);
  }

  function openEdit(m: CustomModel) {
    setEditing({ ...m });
    setOpen(true);
  }

  function handleSave() {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error("请填写模型名称");
      return;
    }
    const exists = models.some((m) => m.id === editing.id);
    const next = exists
      ? models.map((m) => (m.id === editing.id ? editing : m))
      : [...models, editing];
    persist(next);
    setOpen(false);
    setEditing(null);
    toast.success(exists ? "已更新自定义模型" : "已添加到本地 models.json", {
      description: MODELS_LOCAL_PATH,
    });
  }

  function handleDelete(id: string) {
    const next = models.filter((m) => m.id !== id);
    persist(next);
    toast.success("已删除模型");
  }

  const isEditingExisting = editing ? models.some((m) => m.id === editing.id) : false;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
          自定义模型
        </div>
        <div className="flex items-start gap-3 p-4 rounded-lg border border-border bg-surface-1">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">本地配置文件</div>
            <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
              管理写入到{" "}
              <a
                className="text-signal underline underline-offset-2 break-all"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  navigator.clipboard?.writeText(MODELS_LOCAL_PATH);
                  toast.success("已复制路径");
                }}
              >
                {MODELS_LOCAL_PATH}
              </a>{" "}
              的本地自定义模型配置。
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <input
              type="file"
              accept="application/json,.json"
              id="models-import-input"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  try {
                    const parsed = JSON.parse(String(reader.result));
                    const raw: unknown[] = Array.isArray(parsed)
                      ? parsed
                      : Array.isArray((parsed as { models?: unknown[] })?.models)
                        ? (parsed as { models: unknown[] }).models
                        : [];
                    if (raw.length === 0) throw new Error("文件中没有模型条目");
                    const now = new Date().toISOString();
                    const imported: CustomModel[] = raw.map((r, i) => {
                      const o = (r ?? {}) as Partial<CustomModel>;
                      return {
                        id: o.id || `m_${Date.now().toString(36)}_${i}`,
                        name: String(o.name ?? "未命名模型"),
                        provider: String(o.provider ?? "custom"),
                        baseUrl: String(o.baseUrl ?? ""),
                        apiKey: String(o.apiKey ?? ""),
                        contextWindow: Number(o.contextWindow ?? 128000) || 0,
                        supportsVision: Boolean(o.supportsVision),
                        supportsTools: o.supportsTools !== false,
                        createdAt: o.createdAt || now,
                      };
                    });
                    const map = new Map<string, CustomModel>();
                    for (const m of models) map.set(m.id, m);
                    for (const m of imported) map.set(m.id, m);
                    const merged = Array.from(map.values());
                    persist(merged);
                    toast.success(`已导入 ${imported.length} 个模型`, {
                      description: `当前共 ${merged.length} 个自定义模型`,
                    });
                  } catch (err) {
                    toast.error("导入失败", { description: (err as Error).message });
                  }
                };
                reader.readAsText(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => document.getElementById("models-import-input")?.click()}
            >
              <Upload className="w-3.5 h-3.5 mr-1" />
              导入
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={models.length === 0}
              onClick={() => {
                const payload = {
                  exportedAt: new Date().toISOString(),
                  version: 1,
                  models,
                };
                const blob = new Blob([JSON.stringify(payload, null, 2)], {
                  type: "application/json",
                });
                const ts = new Date().toISOString().replace(/[:.]/g, "-");
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `sentinel-models-${ts}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                toast.success(`已导出 ${models.length} 个模型`);
              }}
            >
              <Download className="w-3.5 h-3.5 mr-1" />
              导出
            </Button>
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              添加模型
            </Button>
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">
          已保存模型
        </div>
        {models.length === 0 ? (
          <div className="p-8 rounded-lg border border-dashed border-border bg-surface-1 text-center">
            <div className="text-sm font-medium text-foreground">还没有配置自定义模型</div>
            <div className="text-xs text-muted-foreground mt-2 leading-relaxed">
              添加后会自动写入本地 models.json，并出现在聊天模型下拉的"自定义模型"分组中。
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {models.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface-1"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-sm font-medium text-foreground truncate">{m.name}</div>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-signal/10 text-signal border border-signal/30">
                      {m.provider}
                    </span>
                    {m.supportsVision && (
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border">
                        vision
                      </span>
                    )}
                    {m.supportsTools && (
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border">
                        tools
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5 font-mono">
                    {m.baseUrl} · {m.contextWindow.toLocaleString()} ctx
                  </div>
                  <div className="text-[11px] text-muted-foreground/70 truncate mt-0.5 font-mono">
                    key: {showKey[m.id] ? (m.apiKey || "(空)") : (m.apiKey ? "•".repeat(Math.min(m.apiKey.length, 20)) : "(未设置)")}
                    <button
                      type="button"
                      onClick={() => setShowKey((s) => ({ ...s, [m.id]: !s[m.id] }))}
                      className="ml-2 text-signal hover:underline"
                    >
                      {showKey[m.id] ? "隐藏" : "查看"}
                    </button>
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>
                  <Edit3 className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(m.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isEditingExisting ? "编辑模型" : "添加模型"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">模型名称</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如 gpt-4o-mini"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">供应商</Label>
                  <Select
                    value={editing.provider}
                    onValueChange={(v) => setEditing({ ...editing, provider: v })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="google">Google</SelectItem>
                      <SelectItem value="deepseek">DeepSeek</SelectItem>
                      <SelectItem value="qwen">Qwen</SelectItem>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                      <SelectItem value="ollama">Ollama</SelectItem>
                      <SelectItem value="custom">自定义</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">上下文窗口</Label>
                  <Input
                    type="number"
                    value={editing.contextWindow}
                    onChange={(e) => setEditing({ ...editing, contextWindow: Number(e.target.value) || 0 })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Base URL</Label>
                <Input
                  value={editing.baseUrl}
                  onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">API Key</Label>
                <Input
                  type="password"
                  value={editing.apiKey}
                  onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="font-mono text-xs"
                />
              </div>
              <div className="flex items-center justify-between p-2 rounded border border-border bg-background/40">
                <div>
                  <div className="text-xs font-medium">支持视觉输入</div>
                  <div className="text-[11px] text-muted-foreground">允许发送图片给该模型</div>
                </div>
                <Switch
                  checked={editing.supportsVision}
                  onCheckedChange={(v) => setEditing({ ...editing, supportsVision: v })}
                />
              </div>
              <div className="flex items-center justify-between p-2 rounded border border-border bg-background/40">
                <div>
                  <div className="text-xs font-medium">支持工具调用</div>
                  <div className="text-[11px] text-muted-foreground">启用 function calling / tools</div>
                </div>
                <Switch
                  checked={editing.supportsTools}
                  onCheckedChange={(v) => setEditing({ ...editing, supportsTools: v })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setOpen(false); setEditing(null); }}>取消</Button>
            <Button onClick={handleSave}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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

function MessageBlock({
  message,
  hideReasoning,
  onCancelTool,
}: {
  message: UIMsg;
  hideReasoning?: boolean;
  onCancelTool?: (toolCallId: string, toolName: string) => void;
}) {

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
        {(() => {
          // Build map of toolCallId → latest progress pct emitted by the server
          // via data-tool-progress parts (real events, not fake easing).
          const progressById: Record<string, number> = {};
          for (const p of message.parts) {
            const anyP = p as { type?: string; id?: string; data?: { pct?: number } };
            if (anyP.type === "data-tool-progress" && anyP.id && typeof anyP.data?.pct === "number") {
              progressById[anyP.id] = anyP.data.pct;
            }
          }
          return message.parts.map((part, i) => {
            if (part.type === "text") {
              return <TextWithMedia key={i} text={(part as { text: string }).text} />;
            }
            if (part.type === "reasoning") {
              if (hideReasoning) return null;
              const rp = part as unknown as { text: string; state?: string };
              return <ReasoningPart key={i} text={rp.text} state={rp.state} />;
            }
            if (part.type?.startsWith("tool-")) {
              const toolName = part.type.replace(/^tool-/, "");
              const p = part as unknown as {
                state?: string;
                input?: unknown;
                output?: unknown;
                errorText?: string;
                toolCallId?: string;
              };
              const pct = p.toolCallId ? progressById[p.toolCallId] : undefined;
              return (
                <ToolCallPart
                  key={i}
                  name={toolName}
                  state={p.state}
                  input={p.input}
                  output={p.output}
                  errorText={p.errorText}
                  progressPct={pct}
                  onCancel={
                    onCancelTool && p.toolCallId
                      ? () => onCancelTool(p.toolCallId!, toolName)
                      : undefined
                  }
                />
              );

            }
            return null;
          });
        })()}
      </div>
    </div>
  );
}

// ---- ChatGPT-style reasoning ("Thinking…") block ----
function ReasoningPart({ text, state }: { text: string; state?: string }) {
  const streaming = state === "streaming" || (!state && !text);
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    // When streaming ends, collapse; when it starts, expand.
    if (wasStreaming.current && !streaming) setOpen(false);
    if (!wasStreaming.current && streaming) setOpen(true);
    wasStreaming.current = streaming;
  }, [streaming]);
  const label = streaming ? "思考中" : "已完成思考";
  return (
    <div className="rounded-md border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {streaming ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
        ) : (
          <Lightbulb className="w-3.5 h-3.5 text-accent" />
        )}
        <span className={`font-medium ${streaming ? "text-accent" : ""}`}>
          {label}
        </span>
        {streaming && (
          <span className="flex gap-0.5 ml-0.5">
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:0ms]" />
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:150ms]" />
            <span className="w-1 h-1 rounded-full bg-accent animate-pulse [animation-delay:300ms]" />
          </span>
        )}
        <ChevronDown
          className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && text && (
        <div className="px-3 pb-3 pt-1 border-t border-border/40">
          <div className="text-xs leading-relaxed text-muted-foreground/90 whitespace-pre-wrap italic">
            {text}
            {streaming && (
              <span className="inline-block w-1.5 h-3 ml-0.5 -mb-0.5 bg-accent/70 animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- ChatGPT-style tool activity card ----
const TOOL_META: Record<string, { label: string; summaryKey?: string }> = {
  browser_goto: { label: "打开网页", summaryKey: "url" },
  browser_fill: { label: "填写输入框", summaryKey: "value" },
  browser_press: { label: "按键", summaryKey: "key" },
  browser_click: { label: "点击元素", summaryKey: "selector" },
  browser_wait_for: { label: "等待元素", summaryKey: "selector" },
  browser_extract: { label: "读取内容", summaryKey: "selector" },
  browser_screenshot: { label: "截图", summaryKey: "name" },
  browser_eval: { label: "执行脚本", summaryKey: "expression" },
  generate_image: { label: "生成图片", summaryKey: "prompt" },
  generate_video: { label: "生成视频", summaryKey: "prompt" },
};

const MEDIA_TOOLS = new Set(["generate_image", "generate_video"]);


function summarizeInput(input: unknown, key?: string): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const v = key ? rec[key] : Object.values(rec)[0];
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

function ToolCallPart({
  name,
  state,
  input,
  output,
  errorText,
  progressPct,
  onCancel,
}: {
  name: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  progressPct?: number;
  onCancel?: () => void;
}) {
  const meta = TOOL_META[name] ?? { label: name };
  const running =
    state === "input-streaming" ||
    state === "input-available" ||
    (!state && output === undefined && !errorText);
  const hasError =
    !!errorText ||
    (output !== null &&
      typeof output === "object" &&
      (output as { ok?: boolean; error?: unknown }).ok === false);
  const done = !running && !hasError && output !== undefined;
  const [open, setOpen] = useState(false);
  const summary = summarizeInput(input, meta.summaryKey);

  const out = output as { imageUrl?: string; note?: string } | undefined;
  const hasImage = !!out && typeof out === "object" && !!out.imageUrl;

  return (
    <div className="rounded-md border border-border/60 bg-background/40 overflow-hidden">
      <div className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface-2/50 transition-colors">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 min-w-0 flex items-center gap-2 text-left"
        >
          {running && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />}
          {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
          {hasError && <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />}
          <span className="font-medium text-foreground">{meta.label}</span>
          {summary && (
            <span className="text-muted-foreground truncate font-mono text-[11px]">
              {summary}
            </span>
          )}
          <ChevronDown
            className={`w-3.5 h-3.5 ml-auto shrink-0 text-muted-foreground transition-transform ${
              open ? "rotate-180" : ""
            }`}
          />
        </button>
        {/* per-card cancel removed — merged into the composer send button */}

      </div>

      {running && MEDIA_TOOLS.has(name) && (
        <MediaGenerationSkeleton
          kind={name === "generate_video" ? "video" : "image"}
          pct={progressPct}
        />
      )}
      {hasImage && (
        <div className="px-3 pb-3">
          <img
            src={out!.imageUrl}
            alt="生成图片"
            className="rounded-md border border-border max-w-full max-h-[480px]"
          />
          {out!.note && (
            <div className="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap">
              {out!.note}
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="border-t border-border/40 divide-y divide-border/40">
          {input !== undefined && (
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                参数
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {errorText && (
            <div className="px-3 py-2 text-[11px] font-mono text-destructive whitespace-pre-wrap">
              {errorText}
            </div>
          )}
          {output !== undefined && !hasImage && (
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                结果
              </div>
              <pre className="text-[11px] font-mono text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all max-h-64">
                {typeof output === "string"
                  ? output
                  : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Media generation loading skeleton with progress bar ----
// Progress binds to `pct` (real server-emitted data-tool-progress events).
// When the tool hasn't reported yet we show an indeterminate 3% pulse so
// the bar still moves visibly, but we never fake forward motion beyond it.
function MediaGenerationSkeleton({
  kind,
  pct,
}: {
  kind: "image" | "video";
  pct?: number;
}) {
  const hasReal = typeof pct === "number" && pct > 0;
  const displayPct = hasReal ? Math.max(3, Math.min(99, pct!)) : 3;
  return (
    <div className="px-3 pb-3 pt-1">
      <div
        className={`relative w-full ${kind === "video" ? "aspect-video" : "aspect-square max-w-sm"} rounded-md border border-border/60 bg-gradient-to-br from-surface-2 via-background to-surface-2 overflow-hidden`}
      >
        <div className="absolute inset-0 bg-[linear-gradient(110deg,transparent_30%,rgba(255,255,255,0.05)_50%,transparent_70%)] bg-[length:200%_100%] animate-[shimmer_1.8s_linear_infinite]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          {kind === "video" ? (
            <Wand2 className="w-6 h-6 text-accent animate-pulse" />
          ) : (
            <ImageIcon className="w-6 h-6 text-accent animate-pulse" />
          )}
          <div className="text-[11px] font-mono uppercase tracking-widest">
            {kind === "video" ? "视频生成中" : "图片生成中"}
          </div>
        </div>
      </div>
      <div className="mt-2 h-1 w-full rounded-full bg-border/60 overflow-hidden">
        <div
          className={`h-full bg-gradient-to-r from-accent via-signal to-accent transition-[width] duration-300 ease-out ${hasReal ? "" : "animate-pulse"}`}
          style={{ width: `${displayPct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>{hasReal ? `${Math.round(displayPct)}%` : "等待生成器响应…"}</span>
        <span>{kind === "video" ? "视频生成" : "图片生成"}</span>
      </div>
    </div>
  );
}

// ---- Inline markdown-image renderer for assistant text ----
const MEDIA_URL_RE =
  /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|(?<![("])\b(https?:\/\/[^\s<>"']+?\.(?:png|jpe?g|gif|webp|avif|svg))(?![)"])/gi;

function TextWithMedia({ text }: { text: string }) {
  const parts: Array<{ kind: "text" | "img"; value: string }> = [];
  let last = 0;
  MEDIA_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEDIA_URL_RE.exec(text)) !== null) {
    const url = m[1] ?? m[2];
    if (!url) continue;
    if (m.index > last) parts.push({ kind: "text", value: text.slice(last, m.index) });
    parts.push({ kind: "img", value: url });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
  if (parts.length === 0) parts.push({ kind: "text", value: text });

  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        p.kind === "img" ? (
          <a
            key={i}
            href={p.value}
            target="_blank"
            rel="noreferrer"
            className="block"
          >
            <img
              src={p.value}
              alt="生成结果"
              className="rounded-md border border-border max-w-full max-h-[520px] hover:opacity-95 transition"
              loading="lazy"
            />
          </a>
        ) : p.value.trim() ? (
          <div
            key={i}
            className="text-sm whitespace-pre-wrap leading-relaxed break-words"
          >
            {p.value}
          </div>
        ) : null,
      )}
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
  defaultTab = "plugins",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenMcpSheet: () => void;
  defaultTab?: PluginTab;
}) {
  const [tab, setTab] = useState<PluginTab>(defaultTab);
  // Re-sync the tab whenever the dialog is reopened with a different intent.
  useEffect(() => {
    if (open) setTab(defaultTab);
  }, [open, defaultTab]);
  const [scope, setScope] = useState<PluginScope>("public");
  const [q, setQ] = useState("");
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [installedSkills, setInstalledSkills] = useState<Record<string, boolean>>({});
  const [installedMcps, setInstalledMcps] = useState<Record<string, boolean>>({});
  const [detail, setDetail] = useState<MarketPlugin | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customPlugins, setCustomPlugins] = useState<MarketPlugin[]>([]);
  const [customSkills, setCustomSkills] = useState<MarketPlugin[]>([]);

  useEffect(() => {
    try {
      const rp = localStorage.getItem("sentinel:plugins:custom");
      if (rp) setCustomPlugins(JSON.parse(rp).map((p: MarketPlugin) => ({ ...p, icon: Puzzle })));
      const rs = localStorage.getItem("sentinel:skills:custom");
      if (rs) setCustomSkills(JSON.parse(rs).map((p: MarketPlugin) => ({ ...p, icon: PenSquare })));
    } catch {}
  }, []);

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

  const source =
    tab === "skills"
      ? [...customSkills, ...MARKET_SKILLS]
      : tab === "mcp"
      ? MARKET_MCPS
      : [...customPlugins, ...MARKET_PLUGINS];
  const installMap = tab === "skills" ? installedSkills : tab === "mcp" ? installedMcps : installed;
  const toggleFor = tab === "skills" ? toggleInstallSkill : tab === "mcp" ? toggleInstallMcp : toggleInstall;

  const createLabel = tab === "plugins" ? "新建插件" : tab === "skills" ? "新建技能" : "接入 MCP";
  const dialogTitle = editingId
    ? tab === "plugins"
      ? "编辑插件"
      : "编辑技能"
    : createLabel;

  function handleCreateClick() {
    if (tab === "mcp") {
      onOpenMcpSheet();
      return;
    }
    setEditingId(null);
    setCreateName("");
    setCreateDesc("");
    setCreateOpen(true);
  }

  function openEdit(item: MarketPlugin) {
    setEditingId(item.id);
    setCreateName(item.name);
    setCreateDesc(item.description ?? item.hint ?? "");
    setCreateOpen(true);
  }

  function persistCustom(kind: "plugins" | "skills", list: MarketPlugin[]) {
    try {
      localStorage.setItem(
        `sentinel:${kind}:custom`,
        JSON.stringify(list.map(({ icon: _i, ...rest }) => rest)),
      );
    } catch {}
  }

  function submitCreate() {
    const name = createName.trim();
    if (!name) return;
    const desc = createDesc.trim();
    const kind: "plugins" | "skills" = tab === "skills" ? "skills" : "plugins";

    if (editingId) {
      if (kind === "plugins") {
        const next = customPlugins.map((p) =>
          p.id === editingId
            ? { ...p, name, hint: desc || p.hint, description: desc || p.description }
            : p,
        );
        setCustomPlugins(next);
        persistCustom("plugins", next);
      } else {
        const next = customSkills.map((s) =>
          s.id === editingId
            ? { ...s, name, hint: desc || s.hint, description: desc || s.description }
            : s,
        );
        setCustomSkills(next);
        persistCustom("skills", next);
      }
      setCreateOpen(false);
      setEditingId(null);
      return;
    }

    const id = `custom-${tab}-${Date.now()}`;
    const item: MarketPlugin = {
      id,
      name,
      hint: desc || (kind === "plugins" ? "自定义插件" : "自定义技能"),
      icon: kind === "plugins" ? Puzzle : PenSquare,
      color: kind === "plugins" ? "text-signal" : "text-purple-400",
      bg: kind === "plugins" ? "bg-signal/15" : "bg-purple-500/15",
      scope: "personal",
      installed: true,
      description: desc || "由你创建的自定义条目。",
      capabilities: [],
      permissions: [],
      version: "0.1.0",
      author: "你",
    };
    if (kind === "plugins") {
      const next = [item, ...customPlugins];
      setCustomPlugins(next);
      persistCustom("plugins", next);
      toggleInstall(id);
    } else {
      const next = [item, ...customSkills];
      setCustomSkills(next);
      persistCustom("skills", next);
      toggleInstallSkill(id);
    }
    setCreateOpen(false);
  }

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
            <Button size="sm" onClick={handleCreateClick} className="ml-1">
              <Plus className="w-3.5 h-3.5 mr-1" />
              {createLabel}
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
                      onEdit={p.id.startsWith("custom-") ? () => openEdit(p) : undefined}
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
                      onEdit={p.id.startsWith("custom-") ? () => openEdit(p) : undefined}
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

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) setEditingId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {tab === "plugins" ? (
                <Puzzle className="w-4 h-4 text-signal" />
              ) : (
                <PenSquare className="w-4 h-4 text-purple-400" />
              )}
              {dialogTitle}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                {tab === "plugins" ? "插件名称" : "技能名称"}
              </label>
              <Input
                autoFocus
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={tab === "plugins" ? "例如：日程整理" : "例如：周报生成器"}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">简介</label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={
                  tab === "plugins"
                    ? "一句话说明这个插件的用途"
                    : "描述这个技能会在何时被 Agent 调用"
                }
                rows={3}
                className="w-full rounded-md bg-surface-1 border border-border px-3 py-2 text-sm outline-none focus:border-signal/50 resize-none"
              />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {editingId
                ? "更改将保存到本地并立即生效。"
                : `创建后会自动加入你的${tab === "plugins" ? "「个人」插件" : "「个人」技能"}并启用。`}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button size="sm" onClick={submitCreate} disabled={!createName.trim()}>
              <Plus className="w-3.5 h-3.5 mr-1" />
              {editingId ? "保存" : "创建"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function PluginCard({
  plugin,
  installed,
  onToggle,
  onOpen,
  onEdit,
}: {
  plugin: MarketPlugin;
  installed: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onEdit?: () => void;
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
      <div className="flex items-center gap-1.5 shrink-0">
        {onEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            title="编辑"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <PenSquare className="w-3.5 h-3.5" />
          </Button>
        )}
        {installed ? (
          <>
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
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            安装
          </Button>
        )}
      </div>
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
