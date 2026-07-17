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

const THOUGHTS = [
  "解析目标 · 拆解意图向量",
  "扫描 MCP 拓扑 · 12 节点在线",
  "调用 Playwright · 打开浏览器上下文",
  "观测 DOM · 定位交互焦点",
  "反思执行结果 · 校准下一步",
  "写入长期记忆 · 巩固经验",
  "调度 browser-use · 并行子任务",
  "自主纠错 · 重放失败步骤",
  "同步状态 · 用户可观测",
];

const TELEMETRY = [
  ["CORE", "AUTONOMOUS"],
  ["LOOP", "SELF-DIRECTED"],
  ["MCP", "ACTIVE"],
  ["LATENCY", "42MS"],
  ["MEMORY", "OK"],
  ["BRAIN", "GEMINI-3"],
];

function Landing() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [thoughtIdx, setThoughtIdx] = useState(0);
  const [tick, setTick] = useState(0);

  // Rotating "thought" stream
  useEffect(() => {
    const id = setInterval(() => setThoughtIdx((i) => (i + 1) % THOUGHTS.length), 2200);
    return () => clearInterval(id);
  }, []);

  // Global tick for telemetry pulse
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

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

      {/* Top HUD bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-5 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="signal-dot animate-pulse-signal" />
          <span>SENTINEL_OS // v0.1</span>
        </div>
        <div className="hidden md:flex items-center gap-6">
          <span>UPLINK · STABLE</span>
          <span>{new Date().toISOString().slice(11, 19)} UTC · T+{tick}</span>
          <span>OPERATOR · aosenbearing</span>
        </div>
      </div>

      {/* Bottom HUD bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 grid grid-cols-2 gap-6 border-t border-border/40 bg-background/40 px-6 py-4 backdrop-blur md:grid-cols-6">
        {TELEMETRY.map(([k, v], i) => (
          <div key={k} className="font-mono text-[10px]">
            <div className="uppercase tracking-[0.25em] text-muted-foreground">{k}</div>
            <div
              className="mt-1 text-signal"
              style={{ opacity: 0.6 + Math.sin((tick + i) * 0.9) * 0.4 }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      {/* Center core — the "consciousness" */}
      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center px-6 text-center">
        {/* Rings */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="relative h-[520px] w-[520px] max-h-[80vh] max-w-[80vw]">
            <Ring size={520} duration={30} />
            <Ring size={380} duration={18} reverse />
            <Ring size={240} duration={10} />
            {/* Core glow */}
            <div className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,oklch(0.88_0.2_155/0.55),transparent_70%)] blur-2xl animate-pulse-signal" />
            <div className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-signal shadow-[0_0_40px_10px_oklch(0.82_0.19_155/0.55)]" />
          </div>
        </div>

        <div className="relative">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/40 px-3 py-1.5 backdrop-blur">
            <span className="signal-dot animate-pulse-signal" />
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
              AUTONOMOUS COGNITION · ONLINE
            </span>
          </div>

          <h1 className="text-5xl md:text-7xl lg:text-8xl font-semibold leading-[0.95] tracking-tight">
            <span className="block">我思，</span>
            <span className="block text-signal drop-shadow-[0_0_30px_oklch(0.82_0.19_155/0.6)]">
              故我操作。
            </span>
          </h1>

          <div className="mt-8 h-6 font-mono text-sm text-muted-foreground">
            <span className="mr-2 text-signal">▸</span>
            <span key={thoughtIdx} className="inline-block animate-[fade-in_0.4s_ease-out]">
              {THOUGHTS[thoughtIdx]}
              <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 bg-signal animate-pulse-signal" />
            </span>
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
