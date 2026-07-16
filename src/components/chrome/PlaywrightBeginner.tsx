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
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowUp,
  ArrowDown,
  FlaskConical,
  Save,
  Copy,
  HelpCircle,
  Wand2,
  MousePointer,
  Sparkles,
  Rocket,
  ListChecks,
  FileDown,
  FileUp,
} from "lucide-react";

// -- Types -------------------------------------------------------------------

type StepType =
  | "goto"
  | "wait"
  | "click"
  | "fill"
  | "press"
  | "screenshot"
  | "extract";

export type BeginnerStep = {
  id: string;
  type: StepType;
  target: string;
  value?: string;
  /** Optional friendly note shown to user */
  note?: string;
};

type SavedTask = {
  id: string;
  name: string;
  url: string;
  steps: BeginnerStep[];
  createdAt: number;
  lastRunAt?: number;
  lastRunOk?: boolean;
  lastRunMs?: number;
};

type StepResult = {
  status: "running" | "ok" | "err";
  ms?: number;
  message?: string;
  extract?: string;
};

// -- Action catalog (friendly labels) ----------------------------------------

const ACTIONS: Array<{
  type: StepType;
  label: string;
  desc: string;
  targetLabel: string;
  targetPlaceholder: string;
  valueLabel?: string;
  valuePlaceholder?: string;
}> = [
  {
    type: "goto",
    label: "打开网页",
    desc: "在浏览器中打开一个网址",
    targetLabel: "网址",
    targetPlaceholder: "https://www.google.com",
  },
  {
    type: "wait",
    label: "等待页面元素",
    desc: "等待指定元素出现（如搜索框、按钮）",
    targetLabel: "元素选择器",
    targetPlaceholder: "如 h1, input[name=q]",
    valueLabel: "超时（毫秒）",
    valuePlaceholder: "默认 10000",
  },
  {
    type: "click",
    label: "点击元素",
    desc: "点击按钮、链接或任意元素",
    targetLabel: "元素选择器",
    targetPlaceholder: "如 button[type=submit]",
  },
  {
    type: "fill",
    label: "输入文字",
    desc: "在输入框中填写内容",
    targetLabel: "输入框选择器",
    targetPlaceholder: "如 input[name=q]",
    valueLabel: "要输入的文字",
    valuePlaceholder: "如 轴承供应商",
  },
  {
    type: "press",
    label: "按下键盘按键",
    desc: "常用于按 Enter 提交搜索",
    targetLabel: "按键",
    targetPlaceholder: "Enter / Tab / Escape",
  },
  {
    type: "extract",
    label: "抓取文字",
    desc: "从页面中提取指定元素的文本",
    targetLabel: "元素选择器",
    targetPlaceholder: "如 h1",
    valueLabel: "属性（留空取文本）",
    valuePlaceholder: "留空即可",
  },
  {
    type: "screenshot",
    label: "保存截图",
    desc: "把当前页面保存成图片",
    targetLabel: "截图文件名",
    targetPlaceholder: "如 result",
  },
];

const actionOf = (t: StepType) => ACTIONS.find((a) => a.type === t)!;

// -- Task templates ----------------------------------------------------------

const uid = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2));

function mkStep(
  type: StepType,
  target: string,
  value?: string,
  note?: string,
): BeginnerStep {
  return { id: uid(), type, target, value, note };
}

type Template = {
  id: string;
  name: string;
  desc: string;
  url: string;
  steps: (url: string, kw: string) => BeginnerStep[];
  requiresKeyword?: boolean;
  defaultKeyword?: string;
};

const TEMPLATES: Template[] = [
  {
    id: "open-shot",
    name: "打开网页并截图",
    desc: "打开任意网址并保存一张截图",
    url: "https://example.com",
    steps: (url) => [
      mkStep("goto", url, undefined, "打开目标网址"),
      mkStep("wait", "body", "10000", "等待页面加载"),
      mkStep("screenshot", "page", undefined, "保存截图"),
    ],
  },
  {
    id: "google-search",
    name: "Google 搜索关键词",
    desc: "打开 Google，输入关键词，按 Enter，截图结果",
    url: "https://www.google.com",
    requiresKeyword: true,
    defaultKeyword: "轴承供应商",
    steps: (_url, kw) => [
      mkStep("goto", "https://www.google.com", undefined, "打开 Google"),
      mkStep("wait", "textarea[name=q], input[name=q]", "10000", "等待搜索框"),
      mkStep("fill", "textarea[name=q], input[name=q]", kw, "输入关键词"),
      mkStep("press", "Enter", undefined, "按 Enter 提交"),
      mkStep("wait", "#search, #rso", "10000", "等待搜索结果"),
      mkStep("screenshot", "google_results", undefined, "保存搜索结果截图"),
    ],
  },
  {
    id: "grab-title",
    name: "抓取网页标题",
    desc: "打开网址后抓取 <h1> 文本",
    url: "https://example.com",
    steps: (url) => [
      mkStep("goto", url, undefined, "打开目标网址"),
      mkStep("wait", "h1", "10000", "等待标题出现"),
      mkStep("extract", "h1", undefined, "抓取 h1 文字"),
      mkStep("screenshot", "title", undefined, "保存截图"),
    ],
  },
  {
    id: "click-wait",
    name: "点击按钮并等待新页面",
    desc: "打开页面，点击链接/按钮，等待跳转后截图",
    url: "https://example.com",
    steps: (url) => [
      mkStep("goto", url, undefined, "打开目标网址"),
      mkStep("wait", "a", "10000", "等待链接出现"),
      mkStep("click", "a", undefined, "点击第一个链接"),
      mkStep("wait", "body", "10000", "等待新页面"),
      mkStep("screenshot", "after_click", undefined, "保存截图"),
    ],
  },
  {
    id: "fill-form",
    name: "填写联系表单示例",
    desc: "示例：填写姓名/邮箱后截图（选择器需按目标站点调整）",
    url: "https://example.com/contact",
    steps: (url) => [
      mkStep("goto", url, undefined, "打开表单页"),
      mkStep("wait", "input[name=name]", "10000"),
      mkStep("fill", "input[name=name]", "张三", "填姓名"),
      mkStep("fill", "input[name=email]", "test@example.com", "填邮箱"),
      mkStep("screenshot", "form_filled"),
    ],
  },
];

// -- Storage -----------------------------------------------------------------

const TASKS_KEY = "sentinel:beginner:tasks";
const MODE_KEY = "sentinel:playwright:mode";

function loadTasks(): SavedTask[] {
  try {
    const raw = localStorage.getItem(TASKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* ignore */
  }
  return [];
}

function saveTasks(tasks: SavedTask[]) {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  } catch {
    /* ignore */
  }
}

// -- Helpers -----------------------------------------------------------------

function isValidUrl(s: string) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function stripBase(base: string) {
  return base.replace(/\/+$/, "");
}

// Run a list of steps against the helper, streaming logs via SSE. Returns a
// promise resolving on 'done' or rejecting on error.
async function runSteps(opts: {
  base: string;
  attach: { host: string; port: string };
  steps: BeginnerStep[];
  onStep?: (index: number) => void;
  onResult?: (key: string, value: unknown) => void;
  onLog?: (level: string, msg: string) => void;
}): Promise<{ ms: number }> {
  const { base, attach, steps, onStep, onResult, onLog } = opts;
  const res = await fetch(`${stripBase(base)}/playwright/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attach: { host: attach.host || "127.0.0.1", port: attach.port || "9222" },
      steps: steps.map(({ id: _id, note: _n, ...r }) => r),
    }),
  });
  if (!res.ok) throw new Error(`Helper HTTP ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { runId?: string };
  if (!data.runId) throw new Error("Helper 未返回 runId");
  const runId = data.runId;

  return await new Promise<{ ms: number }>((resolve, reject) => {
    const es = new EventSource(`${stripBase(base)}/playwright/logs/${runId}`);
    es.addEventListener("log", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        onLog?.(p.level ?? "info", p.message ?? "");
      } catch { /* ignore */ }
    });
    es.addEventListener("step", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        if (typeof p.index === "number") onStep?.(p.index);
      } catch { /* ignore */ }
    });
    es.addEventListener("result", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        onResult?.(p.key ?? "result", p.value);
      } catch { /* ignore */ }
    });
    es.addEventListener("done", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        es.close();
        resolve({ ms: p.ms ?? 0 });
      } catch {
        es.close();
        resolve({ ms: 0 });
      }
    });
    es.addEventListener("error-event", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent).data);
        es.close();
        reject(new Error(p.message ?? "运行失败"));
      } catch {
        es.close();
        reject(new Error("运行失败"));
      }
    });
    es.onerror = () => {
      // let the retry happen; only fatal if never got 'done'
    };
  });
}

// -- Component ---------------------------------------------------------------

export function PlaywrightBeginner({
  helperBase,
  attach,
  onOpenAdvanced,
}: {
  helperBase: string;
  attach: { host: string; port: string };
  onOpenAdvanced?: () => void;
}) {
  const base = useMemo(() => stripBase(helperBase), [helperBase]);

  const [taskName, setTaskName] = useState("我的第一个任务");
  const [targetUrl, setTargetUrl] = useState("https://www.google.com");
  const [steps, setSteps] = useState<BeginnerStep[]>([]);
  const [tasks, setTasks] = useState<SavedTask[]>(() => loadTasks());
  const [runningIdx, setRunningIdx] = useState<number | null>(null);
  const [stepResults, setStepResults] = useState<Record<string, StepResult>>({});
  const [runSummary, setRunSummary] = useState<null | {
    ok: boolean;
    ms: number;
    total: number;
    completed: number;
    extracts: Array<{ key: string; value: unknown }>;
    message?: string;
  }>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [templateKw, setTemplateKw] = useState("轴承供应商");
  const [preRunErrors, setPreRunErrors] = useState<string[]>([]);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => saveTasks(tasks), [tasks]);

  // Step manipulation ------------------------------------------------------
  const patch = (id: string, p: Partial<BeginnerStep>) =>
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const remove = (id: string) =>
    setSteps((prev) => prev.filter((s) => s.id !== id));
  const move = (id: string, dir: -1 | 1) =>
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const cp = [...prev];
      [cp[i], cp[j]] = [cp[j], cp[i]];
      return cp;
    });
  const addStep = (type: StepType = "goto") =>
    setSteps((prev) => [...prev, mkStep(type, "", undefined)]);

  const applyTemplate = (t: Template) => {
    const url = targetUrl && isValidUrl(targetUrl) ? targetUrl : t.url;
    setTargetUrl(url);
    setTaskName(t.name);
    setSteps(t.steps(url, templateKw || t.defaultKeyword || ""));
    setStepResults({});
    setRunSummary(null);
    setPreRunErrors([]);
  };

  // Pre-run checks ---------------------------------------------------------
  const runChecks = useCallback(
    async (opts: { needSteps: boolean }): Promise<string[]> => {
      const errs: string[] = [];
      // Helper reachability
      try {
        const r = await fetch(`${base}/`, { method: "GET", cache: "no-store" });
        if (!r.ok) errs.push(`Helper 未响应（HTTP ${r.status}）`);
        else {
          const j = await r.json().catch(() => ({}));
          if (j?.name !== "sentinel-helper" || j?.ok !== true)
            errs.push("Helper 响应不合法");
        }
      } catch {
        errs.push("无法连接本机 Helper（请先点上方「检查 Helper」）");
      }
      // Chrome status
      try {
        const r = await fetch(`${base}/chrome/status`, { method: "GET" });
        const j = await r.json().catch(() => ({} as { ok?: boolean }));
        if (!j?.ok) errs.push("Chrome 尚未在 9222 端口运行（请点「启动 Chrome」）");
      } catch {
        errs.push("无法查询 Chrome 状态");
      }
      // URL & steps
      if (targetUrl && !isValidUrl(targetUrl))
        errs.push("目标网址不是有效的 http(s) URL");
      if (opts.needSteps) {
        if (steps.length === 0) errs.push("尚未添加任何步骤");
        steps.forEach((s, i) => {
          if (!s.target?.trim())
            errs.push(`第 ${i + 1} 步「${actionOf(s.type).label}」缺少必填内容`);
          if (
            s.type === "screenshot" &&
            s.target &&
            !/^[\w\-\u4e00-\u9fa5]{1,64}$/.test(s.target.trim())
          )
            errs.push(`第 ${i + 1} 步截图名称非法（仅字母/数字/中文/-/_，≤64）`);
        });
      }
      return errs;
    },
    [base, targetUrl, steps],
  );

  // Single-step test -------------------------------------------------------
  async function testStep(step: BeginnerStep) {
    // For tests: prepend a goto if the step is not itself a goto and we have a URL
    const seq: BeginnerStep[] = [];
    if (step.type !== "goto" && targetUrl && isValidUrl(targetUrl)) {
      seq.push(mkStep("goto", targetUrl));
    }
    seq.push(step);
    setStepResults((r) => ({ ...r, [step.id]: { status: "running" } }));
    const startedAt = Date.now();
    let extractText: string | undefined;
    try {
      const errs = await runChecks({ needSteps: false });
      if (errs.length) throw new Error(errs.join("；"));
      await runSteps({
        base,
        attach,
        steps: seq,
        onResult: (_k, v) => {
          if (typeof v === "string") extractText = v;
          else extractText = JSON.stringify(v);
        },
      });
      const ms = Date.now() - startedAt;
      setStepResults((r) => ({
        ...r,
        [step.id]: { status: "ok", ms, extract: extractText },
      }));
    } catch (e) {
      const ms = Date.now() - startedAt;
      setStepResults((r) => ({
        ...r,
        [step.id]: {
          status: "err",
          ms,
          message: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  }

  // Full run ---------------------------------------------------------------
  async function runAll() {
    const errs = await runChecks({ needSteps: true });
    setPreRunErrors(errs);
    if (errs.length) return;
    setRunningIdx(0);
    setStepResults({});
    setRunSummary(null);
    const extracts: Array<{ key: string; value: unknown }> = [];
    const startedAt = Date.now();
    try {
      await runSteps({
        base,
        attach,
        steps,
        onStep: (i) => {
          setRunningIdx(i);
          const s = steps[i];
          if (s)
            setStepResults((r) => ({ ...r, [s.id]: { status: "running" } }));
          // mark previous as ok
          if (i > 0) {
            const prev = steps[i - 1];
            if (prev)
              setStepResults((r) =>
                r[prev.id]?.status === "running"
                  ? { ...r, [prev.id]: { status: "ok" } }
                  : r,
              );
          }
        },
        onResult: (k, v) => extracts.push({ key: k, value: v }),
      });
      // mark all as ok
      setStepResults((r) => {
        const next = { ...r };
        steps.forEach((s) => {
          if (next[s.id]?.status !== "err") next[s.id] = { status: "ok" };
        });
        return next;
      });
      setRunningIdx(null);
      setRunSummary({
        ok: true,
        ms: Date.now() - startedAt,
        total: steps.length,
        completed: steps.length,
        extracts,
      });
    } catch (e) {
      const idx = runningIdx ?? 0;
      const s = steps[idx];
      if (s)
        setStepResults((r) => ({
          ...r,
          [s.id]: {
            status: "err",
            message: e instanceof Error ? e.message : String(e),
          },
        }));
      setRunningIdx(null);
      setRunSummary({
        ok: false,
        ms: Date.now() - startedAt,
        total: steps.length,
        completed: idx,
        extracts,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Task management -------------------------------------------------------
  function saveCurrentAsTask() {
    if (!taskName.trim()) return;
    const t: SavedTask = {
      id: uid(),
      name: taskName.trim(),
      url: targetUrl,
      steps,
      createdAt: Date.now(),
      lastRunAt: runSummary ? Date.now() : undefined,
      lastRunOk: runSummary?.ok,
      lastRunMs: runSummary?.ms,
    };
    setTasks((prev) => [t, ...prev]);
  }
  function loadTask(t: SavedTask) {
    setTaskName(t.name);
    setTargetUrl(t.url);
    setSteps(t.steps.map((s) => ({ ...s, id: uid() })));
    setStepResults({});
    setRunSummary(null);
  }
  function duplicateTask(t: SavedTask) {
    setTasks((prev) => [
      { ...t, id: uid(), name: t.name + " · 副本", createdAt: Date.now() },
      ...prev,
    ]);
  }
  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }
  function exportTasks() {
    const blob = new Blob([JSON.stringify(tasks, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sentinel-tasks.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function importTasks(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arr = JSON.parse(String(reader.result));
        if (Array.isArray(arr)) setTasks((prev) => [...arr, ...prev]);
      } catch {
        /* ignore */
      }
    };
    reader.readAsText(file);
  }

  // Render -----------------------------------------------------------------
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-signal" />
            自动化任务 · 新手模式
          </div>
          <div className="text-[11px] text-muted-foreground">
            按向导创建任务：目标网址 → 选模板/加动作 → 单步测试 → 一键运行
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => setShowHelp((v) => !v)}
          >
            <HelpCircle className="w-3.5 h-3.5 mr-1" />
            如何使用
          </Button>
          {onOpenAdvanced && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={onOpenAdvanced}
            >
              高级模式
            </Button>
          )}
        </div>
      </div>

      {showHelp && (
        <div className="rounded-md border border-signal/30 bg-signal/5 p-2.5 text-[11px] text-foreground/90 space-y-1">
          <div className="font-medium text-signal">六步搞定你的第一个自动化任务</div>
          <ol className="list-decimal list-inside space-y-0.5 text-muted-foreground">
            <li>点上方「检查 Helper」，确认本机 Helper 已连接</li>
            <li>点「启动 Chrome」（若尚未运行）</li>
            <li>在下方「第 1 步」输入目标网址</li>
            <li>选择一个模板，或点「添加动作」自行组合</li>
            <li>每步右侧「测试」验证是否成功</li>
            <li>点「运行任务」查看整体结果，满意后「保存任务」</li>
          </ol>
          <div className="pt-1 text-[10px] text-muted-foreground">
            提示：可视化「从网页选择元素」功能将在下一阶段推出，目前可用高级模式手写 CSS 选择器。
          </div>
        </div>
      )}

      {/* Step 1: Task name + URL */}
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          第 1 步 · 基本信息
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">任务名称</Label>
            <Input
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              placeholder="例如：Google 搜索轴承供应商"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">目标网址</Label>
            <div className="flex gap-1">
              <Input
                value={targetUrl}
                onChange={(e) => setTargetUrl(e.target.value)}
                placeholder="https://www.google.com"
                className="h-8 text-xs font-mono"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs shrink-0"
                disabled
                title="下一阶段推出：在专用 Chrome 中可视化选择元素"
              >
                <MousePointer className="w-3.5 h-3.5 mr-1" />
                选元素
              </Button>
            </div>
            {targetUrl && !isValidUrl(targetUrl) && (
              <div className="text-[10px] text-destructive">
                请输入以 http:// 或 https:// 开头的完整网址
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Step 2: Templates */}
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            第 2 步 · 选择模板（可选）
          </div>
          <div className="flex items-center gap-1">
            <Label className="text-[10px] text-muted-foreground">搜索关键词</Label>
            <Input
              value={templateKw}
              onChange={(e) => setTemplateKw(e.target.value)}
              className="h-6 w-32 text-[11px]"
              placeholder="如 轴承供应商"
            />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="text-left p-2 rounded border border-border bg-background/40 hover:border-signal/60 hover:bg-signal/5 transition"
            >
              <div className="text-xs font-medium text-foreground flex items-center gap-1">
                <Wand2 className="w-3 h-3 text-signal" />
                {t.name}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {t.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Step 3: Steps editor */}
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            第 3 步 · 步骤列表（{steps.length}）
          </div>
          <div className="flex items-center gap-1">
            <Select onValueChange={(v) => addStep(v as StepType)}>
              <SelectTrigger className="h-7 w-32 text-[11px]">
                <SelectValue placeholder="+ 添加动作" />
              </SelectTrigger>
              <SelectContent>
                {ACTIONS.map((a) => (
                  <SelectItem key={a.type} value={a.type} className="text-xs">
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {steps.length === 0 ? (
          <div className="text-[11px] text-muted-foreground text-center py-6 border border-dashed border-border rounded">
            尚无步骤 — 选一个模板，或点右上「添加动作」
          </div>
        ) : (
          <div className="space-y-1.5">
            {steps.map((s, i) => {
              const act = actionOf(s.type);
              const res = stepResults[s.id];
              const isRunning = runningIdx === i;
              return (
                <div
                  key={s.id}
                  className={
                    "rounded border p-2 space-y-1.5 " +
                    (isRunning
                      ? "border-signal bg-signal/5"
                      : res?.status === "ok"
                      ? "border-emerald-500/40 bg-emerald-500/5"
                      : res?.status === "err"
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-background/40")
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-muted-foreground w-5 text-center shrink-0">
                      {i + 1}
                    </span>
                    <Select
                      value={s.type}
                      onValueChange={(v) => patch(s.id, { type: v as StepType })}
                    >
                      <SelectTrigger className="w-32 h-7 text-xs shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTIONS.map((a) => (
                          <SelectItem
                            key={a.type}
                            value={a.type}
                            className="text-xs"
                          >
                            {a.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span
                      className="text-[10px] text-muted-foreground truncate flex-1"
                      title={act.desc}
                    >
                      {act.desc}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[11px] shrink-0"
                      onClick={() => testStep(s)}
                      disabled={res?.status === "running"}
                    >
                      {res?.status === "running" ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <FlaskConical className="w-3 h-3 mr-1" />
                      )}
                      测试
                    </Button>
                    <button
                      type="button"
                      onClick={() => move(s.id, -1)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground"
                      aria-label="上移"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(s.id, 1)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground"
                      aria-label="下移"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(s.id)}
                      className="p-1 rounded text-muted-foreground hover:text-destructive"
                      aria-label="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 pl-6">
                    <div className="flex-1 space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        {act.targetLabel}
                      </Label>
                      <Input
                        value={s.target}
                        onChange={(e) => patch(s.id, { target: e.target.value })}
                        placeholder={act.targetPlaceholder}
                        className="h-7 text-xs font-mono"
                      />
                    </div>
                    {act.valueLabel && (
                      <div className="flex-1 space-y-1">
                        <Label className="text-[10px] text-muted-foreground">
                          {act.valueLabel}
                        </Label>
                        <Input
                          value={s.value ?? ""}
                          onChange={(e) => patch(s.id, { value: e.target.value })}
                          placeholder={act.valuePlaceholder}
                          className="h-7 text-xs font-mono"
                        />
                      </div>
                    )}
                  </div>
                  {res && (
                    <div className="pl-6 text-[10px]">
                      {res.status === "running" && (
                        <span className="text-signal">正在测试此步骤…</span>
                      )}
                      {res.status === "ok" && (
                        <span className="text-emerald-400">
                          ✔ 成功{res.ms ? ` · ${res.ms} ms` : ""}
                          {res.extract ? ` · 抓取：${res.extract.slice(0, 200)}` : ""}
                        </span>
                      )}
                      {res.status === "err" && (
                        <span className="text-destructive">
                          ✘ 失败{res.ms ? ` · ${res.ms} ms` : ""} · {res.message}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Step 4: Run + save */}
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          第 4 步 · 运行与保存
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs"
            onClick={runAll}
            disabled={runningIdx !== null || steps.length === 0}
          >
            {runningIdx !== null ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Rocket className="w-3.5 h-3.5 mr-1" />
            )}
            运行任务
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={saveCurrentAsTask}
            disabled={!taskName.trim() || steps.length === 0}
          >
            <Save className="w-3.5 h-3.5 mr-1" />
            保存任务
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={() =>
              navigator.clipboard?.writeText(
                JSON.stringify(
                  steps.map(({ id: _id, note: _n, ...r }) => r),
                  null,
                  2,
                ),
              )
            }
          >
            <Copy className="w-3.5 h-3.5 mr-1" />
            复制 JSON
          </Button>
        </div>

        {preRunErrors.length > 0 && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-[11px] space-y-0.5">
            <div className="text-destructive font-medium">运行前检查未通过：</div>
            {preRunErrors.map((e, i) => (
              <div key={i} className="text-destructive/90">• {e}</div>
            ))}
          </div>
        )}

        {runningIdx !== null && (
          <div className="rounded border border-signal/40 bg-signal/5 p-2 text-[11px] text-signal">
            <div className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              步骤 {runningIdx + 1}/{steps.length}：正在{
                actionOf(steps[runningIdx]?.type ?? "goto").label
              }
            </div>
          </div>
        )}

        {runSummary && (
          <div
            className={
              "rounded border p-2 text-[11px] space-y-1 " +
              (runSummary.ok
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-destructive/40 bg-destructive/5")
            }
          >
            <div className="flex items-center gap-1.5 font-medium">
              {runSummary.ok ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-destructive" />
              )}
              <span
                className={runSummary.ok ? "text-emerald-400" : "text-destructive"}
              >
                {runSummary.ok ? "执行成功" : "执行失败"} · 完成 {runSummary.completed}/
                {runSummary.total} · {runSummary.ms} ms
              </span>
            </div>
            {runSummary.message && (
              <div className="text-destructive/90">{runSummary.message}</div>
            )}
            {runSummary.extracts.length > 0 && (
              <div className="space-y-0.5">
                <div className="text-muted-foreground">抓取结果：</div>
                {runSummary.extracts.map((e, i) => (
                  <div key={i} className="font-mono text-foreground/90 break-all">
                    {e.key}: {JSON.stringify(e.value)}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-1.5 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={runAll}
              >
                <Play className="w-3 h-3 mr-1" /> 再次运行
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Saved tasks */}
      <div className="rounded-md border border-border bg-surface-1 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <ListChecks className="w-3 h-3" /> 已保存任务（{tasks.length}）
          </div>
          <div className="flex items-center gap-1">
            <input
              ref={importInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importTasks(f);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => importInputRef.current?.click()}
            >
              <FileUp className="w-3 h-3 mr-1" /> 导入
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              disabled={tasks.length === 0}
              onClick={exportTasks}
            >
              <FileDown className="w-3 h-3 mr-1" /> 导出
            </Button>
          </div>
        </div>
        {tasks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground text-center py-3">
            尚无已保存任务 — 编辑好后点「保存任务」
          </div>
        ) : (
          <div className="space-y-1">
            {tasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-1.5 p-1.5 rounded border border-border bg-background/40 text-[11px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-foreground font-medium truncate">
                    {t.name}
                  </div>
                  <div className="text-muted-foreground text-[10px] truncate">
                    {t.url || "—"} · {t.steps.length} 步
                    {t.lastRunAt ? (
                      <>
                        {" "}· 上次{t.lastRunOk ? "成功" : "失败"} ·{" "}
                        {new Date(t.lastRunAt).toLocaleString()}
                        {t.lastRunMs ? ` · ${t.lastRunMs}ms` : ""}
                      </>
                    ) : (
                      " · 尚未运行"
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px]"
                  onClick={() => loadTask(t)}
                >
                  载入
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px]"
                  onClick={() => duplicateTask(t)}
                >
                  复制
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px] text-destructive hover:text-destructive"
                  onClick={() => deleteTask(t.id)}
                >
                  删除
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add-step quick bar */}
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[10px] text-muted-foreground">快速添加：</span>
        {ACTIONS.map((a) => (
          <button
            key={a.type}
            type="button"
            onClick={() => addStep(a.type)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:border-signal/50 hover:text-signal transition"
            title={a.desc}
          >
            <Plus className="w-2.5 h-2.5 inline -mt-0.5" /> {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
