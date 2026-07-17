import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sentinel OS — 完全自主的桌面控制 Agent" },
      {
        name: "description",
        content:
          "Sentinel OS 是一个由 AI 大脑自主驱动的桌面控制器，通过 MCP 协议操作浏览器、桌面和 SaaS，替你完成复杂任务，人工干预趋于零。",
      },
      { property: "og:title", content: "Sentinel OS — 完全自主的桌面控制 Agent" },
      {
        property: "og:description",
        content:
          "Sentinel OS 是一个由 AI 大脑自主驱动的桌面控制器，通过 MCP 协议操作浏览器、桌面和 SaaS，替你完成复杂任务，人工干预趋于零。",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const THOUGHTS: {
  phase: string;
  action: string;
  detail: string;
  deep: string[];
}[] = [
  {
    phase: "感知",
    action: "解析目标 · 拆解意图向量",
    detail: "将自然语言拆分为可执行的子目标序列",
    deep: [
      "对用户输入做多层语义解析，抽取动词、对象与约束条件",
      "结合当前工作区上下文，推断隐含前提与优先级",
      "生成结构化任务图，标注可并行与必须串行的节点",
    ],
  },
  {
    phase: "拓扑",
    action: "扫描 MCP 网络 · 12 节点在线",
    detail: "枚举可用工具，评估路径成本与置信度",
    deep: [
      "轮询已连接的 MCP 服务器，刷新工具清单与健康度",
      "根据历史成功率与延迟为每条路径打分",
      "选出成本最低且覆盖目标最全的工具组合",
    ],
  },
  {
    phase: "行动",
    action: "唤起 Playwright · 打开浏览器上下文",
    detail: "建立独立会话，注入身份与 Cookie",
    deep: [
      "分配隔离的浏览器上下文，避免污染用户主会话",
      "按需注入登录态、UA、地域与视口尺寸",
      "开启网络与控制台监听，为后续观测做准备",
    ],
  },
  {
    phase: "观测",
    action: "读取 DOM · 定位交互焦点",
    detail: "解析可访问性树，锁定候选元素",
    deep: [
      "抓取当前页面的语义快照而非原始像素",
      "结合角色、标签与位置对候选元素排序",
      "在多个候选之间使用启发式规则做最终裁决",
    ],
  },
  {
    phase: "反思",
    action: "评估执行结果 · 校准下一步",
    detail: "对比预期与实际状态，触发自我修正",
    deep: [
      "把当前观测与预期后置条件做逐项比对",
      "识别偏差类型：环境变化、选择错误或工具故障",
      "决定继续、重试、回退或向用户求证",
    ],
  },
  {
    phase: "记忆",
    action: "写入长期存储 · 巩固经验",
    detail: "关键片段向量化，供后续任务复用",
    deep: [
      "从本轮执行中蒸馏出可复用的经验片段",
      "写入向量库并建立与任务、工具、站点的索引",
      "对冲突记忆做版本合并，保持知识一致性",
    ],
  },
  {
    phase: "调度",
    action: "并行 browser-use · 分裂子任务",
    detail: "在多个上下文中同步推进独立分支",
    deep: [
      "把彼此独立的子目标分派到多个执行器",
      "限制并发以避免触发目标站点的风控",
      "在汇合点聚合结果并解决冲突",
    ],
  },
  {
    phase: "恢复",
    action: "自主纠错 · 重放失败步骤",
    detail: "回滚脆弱节点，切换备用工具链",
    deep: [
      "定位失败步骤并回退到最近的稳定快照",
      "切换到备用工具或替代路径重新尝试",
      "如连续失败则升级为人工介入请求",
    ],
  },
  {
    phase: "同步",
    action: "回传状态 · 用户可观测",
    detail: "推送事件流，保持人机上下文一致",
    deep: [
      "将关键事件以结构化流的形式推送到控制台",
      "为每一步生成可回放的截图与日志",
      "允许用户随时暂停、干预或接管当前任务",
    ],
  },
];

// 每个阶段独有的 HUD / 核心动画参数。心跳越低越"专注"，越高越"兴奋"。
const PHASE_META: {
  tool: string;
  mode: string;
  latencyMs: number;
  heartbeatMs: number;
  ringSpeed: number; // 环旋转倍率
  coreScale: number; // 核心光晕缩放
  loop: string;
}[] = [
  { tool: "Language Parser",   mode: "感知输入",   latencyMs: 38, heartbeatMs: 900, ringSpeed: 0.8, coreScale: 1.0, loop: "输入 → 意图" },
  { tool: "MCP Registry",      mode: "网络扫描",   latencyMs: 51, heartbeatMs: 700, ringSpeed: 1.2, coreScale: 1.05, loop: "枚举 → 打分" },
  { tool: "Playwright",        mode: "浏览器控制", latencyMs: 92, heartbeatMs: 520, ringSpeed: 1.6, coreScale: 1.15, loop: "会话 → 打开" },
  { tool: "A11y Snapshot",     mode: "视觉观测",   latencyMs: 44, heartbeatMs: 620, ringSpeed: 1.1, coreScale: 1.05, loop: "抓取 → 定位" },
  { tool: "Self Critic",       mode: "自我反思",   latencyMs: 33, heartbeatMs: 1100, ringSpeed: 0.6, coreScale: 0.9, loop: "对比 → 校准" },
  { tool: "Vector Memory",     mode: "记忆写入",   latencyMs: 27, heartbeatMs: 950, ringSpeed: 0.9, coreScale: 1.0, loop: "蒸馏 → 索引" },
  { tool: "browser-use",       mode: "并行调度",   latencyMs: 68, heartbeatMs: 480, ringSpeed: 1.8, coreScale: 1.2, loop: "分裂 → 汇合" },
  { tool: "Recovery Engine",   mode: "故障恢复",   latencyMs: 76, heartbeatMs: 560, ringSpeed: 1.4, coreScale: 1.1, loop: "回滚 → 重放" },
  { tool: "Event Stream",      mode: "同步用户",   latencyMs: 22, heartbeatMs: 1000, ringSpeed: 0.7, coreScale: 0.95, loop: "推送 → 观测" },
];

const VITALS = [
  { label: "思考频率", unit: "Hz" },
  { label: "工具调用", unit: "ops/s" },
  { label: "置信度", unit: "%" },
  { label: "上下文", unit: "K tok" },
];

function Landing() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [thoughtIdx, setThoughtIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [beat, setBeat] = useState(0); // 心跳计数：每 phase.heartbeatMs 递增一次
  const [callCount, setCallCount] = useState(0); // 累计工具调用数
  const phase = PHASE_META[thoughtIdx];

  // 意识流节奏：4.2s 一步，展开时暂停。用 progress 驱动进度条实现平滑视觉。
  const STEP_MS = 4200;
  useEffect(() => {
    if (expanded) return;
    const started = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      const p = Math.min(1, (now - started) / STEP_MS);
      setProgress(p);
      if (p >= 1) {
        setThoughtIdx((i) => (i + 1) % THOUGHTS.length);
      } else {
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [thoughtIdx, expanded]);

  // Global tick for telemetry pulse
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // 心跳节拍 —— 节奏由当前阶段决定，每次心跳视为一次工具调用
  useEffect(() => {
    setBeat(0); // 阶段切换时重置心跳，触发核心动画
    const id = setInterval(() => {
      setBeat((b) => b + 1);
      setCallCount((c) => c + 1);
    }, phase.heartbeatMs);
    return () => clearInterval(id);
  }, [phase.heartbeatMs, thoughtIdx]);

  // Neural network canvas — nodes + connective pulses
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    type Node = { x: number; y: number; vx: number; vy: number; r: number };
    let nodes: Node[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(90, Math.floor((width * height) / 16000));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.4 + 0.6,
      }));
    };
    resize();
    window.addEventListener("resize", resize);

    const mouse = { x: width / 2, y: height / 2, active: false };
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
    };
    const onLeave = () => (mouse.active = false);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    let t = 0;
    const render = () => {
      t += 1;
      ctx.clearRect(0, 0, width, height);

      // Move nodes
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 0 || n.x > width) n.vx *= -1;
        if (n.y < 0 || n.y > height) n.vy *= -1;

        // Attract to cursor
        if (mouse.active) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 22000) {
            n.vx += (dx / Math.sqrt(d2 + 1)) * 0.01;
            n.vy += (dy / Math.sqrt(d2 + 1)) * 0.01;
          }
        }
        // Damp
        n.vx = Math.max(-0.8, Math.min(0.8, n.vx * 0.995));
        n.vy = Math.max(-0.8, Math.min(0.8, n.vy * 0.995));
      }

      // Connections
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 140) {
            const alpha = (1 - d / 140) * 0.35;
            ctx.strokeStyle = `oklch(0.82 0.19 155 / ${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();

            // Traveling pulse
            const pulse = ((t * 0.6 + i * 13 + j * 7) % 200) / 200;
            if (pulse < 1) {
              const px = a.x + (b.x - a.x) * pulse;
              const py = a.y + (b.y - a.y) * pulse;
              ctx.fillStyle = `oklch(0.88 0.2 155 / ${alpha * 1.5})`;
              ctx.beginPath();
              ctx.arc(px, py, 1.2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // Nodes
      for (const n of nodes) {
        const glow = 0.6 + Math.sin((t + n.x) * 0.02) * 0.4;
        ctx.fillStyle = `oklch(0.88 0.2 155 / ${0.5 + glow * 0.4})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Neural canvas */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Radial vignette + scanline */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,oklch(0.14_0.015_250/0.85)_75%)]" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.08] mix-blend-overlay"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, oklch(0.82 0.19 155) 0px, oklch(0.82 0.19 155) 1px, transparent 1px, transparent 3px)",
        }}
      />

      {/* Top HUD bar —— 阶段名与工具名随意识流同步 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-5 font-mono text-[10px] tracking-[0.3em] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span
            className="signal-dot"
            style={{ animation: `pulse-signal ${phase.heartbeatMs}ms ease-in-out infinite` }}
          />
          <span className="uppercase">SENTINEL_OS · 哨兵系统 v0.1</span>
          <span className="hidden md:inline text-signal">
            » {phase.mode} · {phase.tool}
          </span>
        </div>
        <div className="hidden md:flex items-center gap-6">
          <span>链路 · 稳定</span>
          <span className="uppercase">
            {new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19)} CST · T+{tick}
          </span>
        </div>
      </div>

      {/* Bottom HUD bar —— 全部字段随阶段联动 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 grid grid-cols-2 gap-6 border-t border-border/40 bg-background/40 px-6 py-4 backdrop-blur md:grid-cols-6">
        {[
          ["阶段", `${String(thoughtIdx + 1).padStart(2, "0")} · ${THOUGHTS[thoughtIdx].phase}`],
          ["工具", phase.tool],
          ["循环", phase.loop],
          ["延迟", `${phase.latencyMs} 毫秒`],
          ["心跳", `${(60000 / phase.heartbeatMs).toFixed(0)} BPM`],
          ["调用", `${callCount} ops`],
        ].map(([k, v], i) => (
          <div key={k} className="font-mono text-[10px]">
            <div className="tracking-[0.25em] text-muted-foreground">{k}</div>
            <div
              key={`${k}-${thoughtIdx}`}
              className="mt-1 text-signal animate-[fade-in_0.4s_ease-out]"
              style={{ opacity: 0.6 + Math.sin((tick + i) * 0.9) * 0.4 }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      {/* Center core — the "consciousness" */}
      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center px-6 text-center">
        {/* Rings —— 转速跟随阶段，key 触发切换时的重启动画 */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div
            className="relative h-[520px] w-[520px] max-h-[80vh] max-w-[80vw] transition-transform duration-700"
            style={{ transform: `scale(${phase.coreScale})` }}
          >
            <Ring key={`r1-${thoughtIdx}`} size={520} duration={30 / phase.ringSpeed} />
            <Ring key={`r2-${thoughtIdx}`} size={380} duration={18 / phase.ringSpeed} reverse />
            <Ring key={`r3-${thoughtIdx}`} size={240} duration={10 / phase.ringSpeed} />
            {/* Core glow —— 心跳节拍缩放 */}
            <div
              key={`glow-${beat}`}
              className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,oklch(0.88_0.2_155/0.55),transparent_70%)] blur-2xl"
              style={{
                animation: `pulse-signal ${phase.heartbeatMs}ms ease-in-out infinite`,
              }}
            />
            <div
              key={`dot-${beat}`}
              className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal"
              style={{
                boxShadow: `0 0 40px 10px oklch(0.82 0.19 155 / ${0.4 + (beat % 2) * 0.35})`,
                transform: `translate(-50%, -50%) scale(${1 + (beat % 2) * 0.4})`,
                transition: `transform ${phase.heartbeatMs / 2}ms ease-out, box-shadow ${phase.heartbeatMs / 2}ms ease-out`,
              }}
            />
          </div>
        </div>

        <div className="relative">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/40 px-3 py-1.5 backdrop-blur">
            <span
              className="signal-dot"
              style={{ animation: `pulse-signal ${phase.heartbeatMs}ms ease-in-out infinite` }}
            />
            <span
              key={`mode-${thoughtIdx}`}
              className="font-mono text-[10px] tracking-[0.3em] text-muted-foreground animate-[fade-in_0.4s_ease-out]"
            >
              自主意识 · {phase.mode} · {(60000 / phase.heartbeatMs).toFixed(0)} BPM
            </span>
          </div>

          <h1 className="font-semibold leading-[0.92] tracking-[-0.02em]">
            <span className="block text-4xl md:text-6xl lg:text-7xl text-foreground/95">
              自主意识
              <span className="mx-3 md:mx-4 inline-block h-[0.7em] w-px align-middle bg-signal/60" />
              替你思考
            </span>
            <span className="mt-2 md:mt-3 block text-5xl md:text-7xl lg:text-8xl text-signal drop-shadow-[0_0_40px_oklch(0.82_0.19_155/0.55)]">
              也替你行动
            </span>
          </h1>

          <p className="mt-6 mx-auto max-w-2xl text-sm md:text-base text-muted-foreground leading-relaxed">
            一枚永不休眠的数字心智 —— 感知目标、编排工具、执行任务、反思结果。
            <span className="text-foreground/80">你只需下达意图，剩下的交给 Sentinel。</span>
          </p>

          {/* 实时字幕：阶段标签（可点击展开）+ 当前动作 + 状态解释 + 节奏进度条 */}
          <div className="mt-8">
            <div className="flex items-center justify-center gap-3 font-mono text-[10px] tracking-[0.3em] text-muted-foreground">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="group inline-flex items-center gap-1.5 rounded-sm border border-signal/50 bg-signal/10 px-2 py-0.5 text-signal transition-all hover:bg-signal/20 hover:shadow-[0_0_20px_oklch(0.82_0.19_155/0.4)]"
              >
                <span>
                  阶段 {String(thoughtIdx + 1).padStart(2, "0")} · {THOUGHTS[thoughtIdx].phase}
                </span>
                <span
                  className={`transition-transform ${expanded ? "rotate-90" : ""}`}
                  aria-hidden
                >
                  ▸
                </span>
              </button>
              <span className="h-px w-8 bg-signal/40" />
              <span>{expanded ? "已锁定 · 点击折叠" : "意识流 · 点击展开"}</span>
            </div>

            <div
              key={thoughtIdx}
              className="mt-3 font-mono text-sm text-foreground animate-[fade-in_0.6s_ease-out]"
            >
              <span className="mr-2 text-signal">▸</span>
              {THOUGHTS[thoughtIdx].action}
              <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 bg-signal animate-pulse-signal" />
            </div>
            <div
              key={`d-${thoughtIdx}`}
              className="mt-2 max-w-xl mx-auto text-xs text-muted-foreground leading-relaxed animate-[fade-in_0.7s_ease-out]"
            >
              {THOUGHTS[thoughtIdx].detail}
            </div>

            {/* 节奏进度条：非展开状态下平滑推进 */}
            <div className="mt-3 mx-auto h-px w-40 overflow-hidden bg-border/40">
              <div
                className="h-full bg-signal"
                style={{
                  width: `${(expanded ? 1 : progress) * 100}%`,
                  opacity: expanded ? 0.35 : 1,
                  transition: expanded ? "opacity 0.3s ease" : "none",
                }}
              />
            </div>

            {/* 展开：更详细的中文解释 */}
            <div
              className={`grid transition-all duration-500 ease-out ${
                expanded ? "grid-rows-[1fr] opacity-100 mt-4" : "grid-rows-[0fr] opacity-0 mt-0"
              }`}
            >
              <div className="overflow-hidden">
                <div className="mx-auto max-w-xl rounded-md border border-signal/30 bg-background/60 p-4 text-left backdrop-blur">
                  <div className="mb-2 font-mono text-[10px] tracking-[0.3em] text-signal">
                    详细解释 · {THOUGHTS[thoughtIdx].phase}
                  </div>
                  <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
                    {THOUGHTS[thoughtIdx].deep.map((line, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-signal" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                    <span>已暂停自动推进</span>
                    <button
                      type="button"
                      onClick={() =>
                        setThoughtIdx((i) => (i + 1) % THOUGHTS.length)
                      }
                      className="rounded-sm border border-border/60 px-2 py-0.5 hover:border-signal/50 hover:text-signal"
                    >
                      下一阶段 →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 生命体征 · 每秒漂移 */}
          <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl mx-auto">
            {VITALS.map((v, i) => {
              const seed = Math.sin(tick * 0.7 + i * 1.3);
              const val =
                v.unit === "%"
                  ? (88 + seed * 6).toFixed(1)
                  : v.unit === "Hz"
                    ? (12 + seed * 3).toFixed(2)
                    : v.unit === "K tok"
                      ? (128 + Math.floor(seed * 12))
                      : (4.2 + seed * 1.5).toFixed(2);
              const pct = 60 + seed * 30;
              return (
                <div
                  key={v.label}
                  className="rounded-sm border border-border/50 bg-background/40 px-3 py-2 text-left backdrop-blur"
                >
                  <div className="font-mono text-[9px] tracking-[0.25em] text-muted-foreground">
                    {v.label}
                  </div>
                  <div className="mt-1 flex items-baseline gap-1 font-mono text-signal">
                    <span className="text-sm tabular-nums">{val}</span>
                    <span className="text-[9px] text-muted-foreground">{v.unit}</span>
                  </div>
                  <div className="mt-1.5 h-0.5 w-full overflow-hidden bg-border/40">
                    <div
                      className="h-full bg-signal transition-all duration-700"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link to="/auth">
              <button className="group relative overflow-hidden rounded-md border border-signal/60 bg-signal/10 px-6 py-3 font-mono text-sm uppercase tracking-[0.25em] text-signal transition-all hover:bg-signal hover:text-primary-foreground hover:shadow-[0_0_40px_oklch(0.82_0.19_155/0.6)]">
                <span className="relative z-10 inline-flex items-center gap-2">
                  唤醒 Sentinel <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
                <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-signal-glow/30 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
              </button>
            </Link>
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border/60 bg-background/40 px-6 py-3 font-mono text-sm uppercase tracking-[0.25em] text-muted-foreground backdrop-blur transition-colors hover:border-signal/40 hover:text-foreground"
            >
              MCP 协议
            </a>
          </div>
        </div>
      </div>

      {/* Corner brackets */}
      <Corner className="left-4 top-4" />
      <Corner className="right-4 top-4 rotate-90" />
      <Corner className="left-4 bottom-16 -rotate-90" />
      <Corner className="right-4 bottom-16 rotate-180" />
    </div>
  );
}

function Ring({ size, duration, reverse }: { size: number; duration: number; reverse?: boolean }) {
  return (
    <div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-signal/20"
      style={{
        width: size,
        height: size,
        maxWidth: "80vw",
        maxHeight: "80vw",
        animation: `spin ${duration}s linear infinite ${reverse ? "reverse" : ""}`,
        background:
          "conic-gradient(from 0deg, transparent 0deg, oklch(0.82 0.19 155 / 0.35) 40deg, transparent 90deg, transparent 360deg)",
        WebkitMask:
          "radial-gradient(circle, transparent calc(50% - 1px), black calc(50% - 1px), black 50%, transparent 50%)",
        mask: "radial-gradient(circle, transparent calc(50% - 1px), black calc(50% - 1px), black 50%, transparent 50%)",
      }}
    />
  );
}

function Corner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`pointer-events-none absolute h-6 w-6 border-l-2 border-t-2 border-signal/50 ${className}`}
    />
  );
}
