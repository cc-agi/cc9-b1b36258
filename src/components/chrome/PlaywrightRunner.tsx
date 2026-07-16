import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Play,
  Square,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowUp,
  ArrowDown,
  Copy,
  Eraser,
} from "lucide-react";
import {
  interpolateSelectedFile,
  FILE_TOKENS,
  type SelectedFile,
} from "./selected-file";

type StepType =
  | "goto"
  | "wait"
  | "click"
  | "fill"
  | "press"
  | "screenshot"
  | "extract"
  | "eval"
  | "upload"
  | "open";

export type PwStep = {
  id: string;
  type: StepType;
  /** goto url / wait & click & fill & extract selector / press key / screenshot name / eval script */
  target: string;
  /** fill value / extract attribute (default: innerText) / wait timeout ms */
  value?: string;
};

type LogLevel = "info" | "step" | "ok" | "warn" | "err" | "result";
type LogEntry = { at: number; level: LogLevel; message: string };

type RunState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "running"; runId: string; startedAt: number }
  | { status: "done"; runId: string; ms: number }
  | { status: "cancelled"; runId: string }
  | { status: "failed"; message: string };

const STORAGE_KEY = "sentinel:playwright:steps";

const DEFAULT_STEPS: PwStep[] = [
  { id: crypto.randomUUID(), type: "goto", target: "https://example.com" },
  { id: crypto.randomUUID(), type: "wait", target: "h1", value: "5000" },
  { id: crypto.randomUUID(), type: "extract", target: "h1" },
  { id: crypto.randomUUID(), type: "screenshot", target: "example" },
];

const STEP_LABEL: Record<StepType, string> = {
  goto: "打开 URL",
  wait: "等待选择器",
  click: "点击",
  fill: "填写输入",
  press: "按键",
  screenshot: "截图",
  extract: "抓取文本",
  eval: "执行脚本",
  upload: "上传文件",
  open: "打开本地文件",
};

const STEP_HINT: Record<StepType, { target: string; value?: string }> = {
  goto: { target: "https://example.com" },
  wait: { target: "选择器（如 h1, [name=q]）", value: "超时 ms，默认 10000" },
  click: { target: "选择器" },
  fill: { target: "选择器", value: "要填写的值（可用 {{file.content}}）" },
  press: { target: "按键（Enter / Tab / Escape）" },
  screenshot: { target: "截图文件名（无扩展名）" },
  extract: { target: "选择器", value: "属性名（留空取 innerText）" },
  eval: { target: "() => document.title" },
  upload: { target: "input[type=file] 选择器", value: "文件路径，多个用逗号或换行 (可用 {{file.path}})" },
  open: { target: "本地文件路径 (可用 {{file.path}})" },
};

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

const LEVEL_STYLE: Record<LogLevel, string> = {
  info: "text-muted-foreground",
  step: "text-signal",
  ok: "text-emerald-400",
  warn: "text-amber-400",
  err: "text-destructive",
  result: "text-blue-400",
};

export function PlaywrightRunner({
  helperBase,
  attach,
  selectedFile = null,
}: {
  helperBase: string;
  attach: { host: string; port: string };
  selectedFile?: SelectedFile | null;
}) {
  const [steps, setSteps] = useState<PwStep[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PwStep[];
        if (Array.isArray(parsed) && parsed.length) return parsed;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_STEPS;
  });
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(steps));
    } catch {
      /* ignore */
    }
  }, [steps]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [logs]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const base = useMemo(() => helperBase.replace(/\/+$/, ""), [helperBase]);

  const pushLog = useCallback((level: LogLevel, message: string) => {
    setLogs((prev) => [...prev, { at: Date.now(), level, message }]);
  }, []);

  function updateStep(id: string, patch: Partial<PwStep>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }
  function removeStep(id: string) {
    setSteps((prev) => prev.filter((s) => s.id !== id));
  }
  function addStep() {
    setSteps((prev) => [...prev, { id: crypto.randomUUID(), type: "goto", target: "" }]);
  }
  function moveStep(id: string, dir: -1 | 1) {
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });
  }

  async function startRun() {
    if (run.status === "starting" || run.status === "running") return;
    setLogs([]);
    setRun({ status: "starting" });
    pushLog("info", `请求 ${base}/playwright/run …`);
    try {
      const res = await fetch(`${base}/playwright/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attach: { host: attach.host || "127.0.0.1", port: attach.port || "9222" },
          steps: steps.map(({ id: _id, target, value, ...rest }) => ({
            ...rest,
            target: interpolateSelectedFile(target, selectedFile),
            value: value === undefined ? undefined : interpolateSelectedFile(value, selectedFile),
          })),
        }),
      });
      if (!res.ok) throw new Error(`Helper 返回 HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as { runId?: string };
      if (!data.runId) throw new Error("Helper 未返回 runId");
      const runId = data.runId;
      pushLog("info", `已启动 run ${runId}，订阅日志…`);
      setRun({ status: "running", runId, startedAt: Date.now() });

      const es = new EventSource(`${base}/playwright/logs/${runId}`);
      esRef.current = es;

      es.addEventListener("log", (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as {
            level?: LogLevel;
            message?: string;
          };
          pushLog(payload.level ?? "info", payload.message ?? "");
        } catch {
          pushLog("info", (e as MessageEvent).data);
        }
      });
      es.addEventListener("step", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as {
            index: number;
            type: string;
            target?: string;
          };
          pushLog("step", `▶ 步骤 ${p.index + 1} · ${p.type}${p.target ? " " + p.target : ""}`);
        } catch {
          pushLog("step", (e as MessageEvent).data);
        }
      });
      es.addEventListener("result", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as { key?: string; value?: unknown };
          pushLog("result", `⇢ ${p.key ?? "result"}: ${JSON.stringify(p.value)}`);
        } catch {
          pushLog("result", (e as MessageEvent).data);
        }
      });
      es.addEventListener("done", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as { ms?: number };
          pushLog("ok", `✔ 运行完成 · ${p.ms ?? 0} ms`);
          setRun({ status: "done", runId, ms: p.ms ?? 0 });
        } catch {
          pushLog("ok", "✔ 运行完成");
          setRun({ status: "done", runId, ms: Date.now() - Date.now() });
        }
        es.close();
        esRef.current = null;
      });
      es.addEventListener("error-event", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as { message?: string };
          pushLog("err", `✘ ${p.message ?? "未知错误"}`);
          setRun({ status: "failed", message: p.message ?? "未知错误" });
        } catch {
          pushLog("err", "✘ 运行失败");
          setRun({ status: "failed", message: "运行失败" });
        }
        es.close();
        esRef.current = null;
      });
      es.onerror = () => {
        // SSE will auto-reconnect; treat as warning unless not running
        pushLog("warn", "日志流连接中断，重试中…");
      };
    } catch (e) {
      const msg = e instanceof TypeError
        ? `无法访问 Helper (${base})，请确认 sentinel-helper 已启动`
        : e instanceof Error
        ? e.message
        : "启动失败";
      pushLog("err", msg);
      setRun({ status: "failed", message: msg });
    }
  }

  async function cancelRun() {
    if (run.status !== "running") return;
    const runId = run.runId;
    try {
      await fetch(`${base}/playwright/cancel/${runId}`, { method: "POST" });
      pushLog("warn", "已请求取消…");
    } catch {
      pushLog("warn", "取消请求发送失败");
    }
    esRef.current?.close();
    esRef.current = null;
    setRun({ status: "cancelled", runId });
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground">Playwright 执行</div>
          <div className="text-[11px] text-muted-foreground">
            通过 Helper 附加到已启动的 Chrome（复用登录态），按步骤执行并回传日志
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            onClick={startRun}
            disabled={run.status === "starting" || run.status === "running" || steps.length === 0}
            className="h-8 text-xs"
          >
            {run.status === "starting" || run.status === "running" ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5 mr-1" />
            )}
            运行
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={cancelRun}
            disabled={run.status !== "running"}
            className="h-8 text-xs"
          >
            <Square className="w-3.5 h-3.5 mr-1" />
            取消
          </Button>
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">步骤</Label>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addStep}>
              <Plus className="w-3.5 h-3.5 mr-1" /> 添加步骤
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                navigator.clipboard?.writeText(
                  JSON.stringify(steps.map(({ id: _id, ...r }) => r), null, 2),
                )
              }
            >
              <Copy className="w-3.5 h-3.5 mr-1" /> 复制 JSON
            </Button>
          </div>
        </div>
        {steps.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-4 border border-dashed border-border rounded-md">
            尚无步骤，点击"添加步骤"开始
          </div>
        ) : (
          <div className="space-y-1.5">
            {steps.map((s, i) => {
              const hint = STEP_HINT[s.type];
              const hasValue = s.type === "fill" || s.type === "wait" || s.type === "extract";
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-1.5 p-1.5 rounded-md bg-surface-1 border border-border"
                >
                  <span className="text-[10px] font-mono text-muted-foreground w-5 text-center shrink-0">
                    {i + 1}
                  </span>
                  <Select
                    value={s.type}
                    onValueChange={(v) => updateStep(s.id, { type: v as StepType })}
                  >
                    <SelectTrigger className="w-28 h-7 text-xs shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STEP_LABEL) as StepType[]).map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {STEP_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={s.target}
                    onChange={(e) => updateStep(s.id, { target: e.target.value })}
                    placeholder={hint.target}
                    className="h-7 text-xs font-mono flex-1 min-w-0"
                  />
                  {hasValue && (
                    <Input
                      value={s.value ?? ""}
                      onChange={(e) => updateStep(s.id, { value: e.target.value })}
                      placeholder={hint.value}
                      className="h-7 text-xs font-mono w-40 shrink-0"
                    />
                  )}
                  <div className="flex items-center shrink-0">
                    <button
                      type="button"
                      onClick={() => moveStep(s.id, -1)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-white/5"
                      aria-label="上移"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveStep(s.id, 1)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-white/5"
                      aria-label="下移"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeStep(s.id)}
                      className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      aria-label="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Status */}
      <div className="flex items-center gap-2 text-[11px]">
        {run.status === "idle" && <span className="text-muted-foreground">尚未运行</span>}
        {run.status === "starting" && (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">正在启动…</span>
          </>
        )}
        {run.status === "running" && (
          <>
            <Loader2 className="w-3 h-3 animate-spin text-signal" />
            <span className="text-signal">运行中 · {run.runId.slice(0, 8)}</span>
          </>
        )}
        {run.status === "done" && (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-400">完成 · {run.ms} ms</span>
          </>
        )}
        {run.status === "cancelled" && (
          <span className="text-amber-400">已取消 · {run.runId.slice(0, 8)}</span>
        )}
        {run.status === "failed" && (
          <>
            <XCircle className="w-3.5 h-3.5 text-destructive" />
            <span className="text-destructive">失败 · {run.message}</span>
          </>
        )}
      </div>

      {/* Log console */}
      <div className="rounded-md border border-border bg-black/60 overflow-hidden">
        <div className="flex items-center justify-between px-2 py-1 border-b border-border/60">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            执行日志 · {logs.length}
          </span>
          <button
            type="button"
            onClick={() => setLogs([])}
            className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <Eraser className="w-3 h-3" /> 清空
          </button>
        </div>
        <div className="h-48 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-muted-foreground/60 text-center py-6">尚无日志</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap break-words">
                <span className="text-muted-foreground/70">{formatTime(l.at)} </span>
                <span className={LEVEL_STYLE[l.level]}>{l.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
