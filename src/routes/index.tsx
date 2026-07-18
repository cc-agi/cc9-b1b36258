import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

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

// Orbiting satellites — software & hardware Sentinel controls
const NODES = [
  { label: "BROWSER", ring: 0, angle: 0 },
  { label: "DESKTOP", ring: 0, angle: 72 },
  { label: "SHELL", ring: 0, angle: 144 },
  { label: "FS", ring: 0, angle: 216 },
  { label: "CLIP", ring: 0, angle: 288 },
  { label: "MOUSE", ring: 1, angle: 30 },
  { label: "KEYBOARD", ring: 1, angle: 100 },
  { label: "DISPLAY", ring: 1, angle: 170 },
  { label: "GPU", ring: 1, angle: 240 },
  { label: "NET", ring: 1, angle: 310 },
  { label: "MCP:CC6", ring: 2, angle: 20 },
  { label: "MCP:CHROME", ring: 2, angle: 80 },
  { label: "MCP:SUPABASE", ring: 2, angle: 140 },
  { label: "MCP:GH", ring: 2, angle: 200 },
  { label: "MCP:FIGMA", ring: 2, angle: 260 },
  { label: "MCP:LOCAL", ring: 2, angle: 320 },
];

function Landing() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [charging, setCharging] = useState(false);
  const [warp, setWarp] = useState(false);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  // Wormhole canvas — tunneling starfield + rotating rings
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      cx = w / 2;
      cy = h / 2;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Tunnel particles moving from center outward
    type P = { a: number; r: number; s: number; z: number; hue: number };
    const parts: P[] = [];
    const seed = () => {
      for (let i = 0; i < 260; i++) {
        parts.push({
          a: Math.random() * Math.PI * 2,
          r: Math.random() * Math.max(w, h) * 0.6,
          s: 0.4 + Math.random() * 2.4,
          z: 0.2 + Math.random() * 1.8,
          hue: Math.random() < 0.7 ? 155 : 220,
        });
      }
    };
    seed();

    let t = 0;
    const draw = () => {
      t += 1;
      const boost = warp ? 6 : charging ? 2.2 : 1;
      // Trail
      ctx.fillStyle = `rgba(8, 12, 20, ${warp ? 0.15 : 0.25})`;
      ctx.fillRect(0, 0, w, h);

      // Radial glow center
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.5);
      grd.addColorStop(0, "rgba(120,255,180,0.18)");
      grd.addColorStop(0.4, "rgba(80,180,255,0.06)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);

      // Tunnel streaks
      for (const p of parts) {
        p.r += p.s * boost * p.z;
        if (p.r > Math.max(w, h) * 0.8) {
          p.r = 4;
          p.a = Math.random() * Math.PI * 2;
        }
        const x = cx + Math.cos(p.a) * p.r;
        const y = cy + Math.sin(p.a) * p.r;
        const x2 = cx + Math.cos(p.a) * (p.r - 18 * boost * p.z);
        const y2 = cy + Math.sin(p.a) * (p.r - 18 * boost * p.z);
        const alpha = Math.min(1, p.r / (Math.max(w, h) * 0.4));
        ctx.strokeStyle = `hsla(${p.hue}, 90%, 65%, ${alpha * 0.85})`;
        ctx.lineWidth = p.z * (warp ? 1.6 : 1);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // Concentric portal rings
      const ringCount = 6;
      for (let i = 0; i < ringCount; i++) {
        const phase = (t * 0.006 + i * 0.4) % 1;
        const radius = 60 + phase * Math.min(w, h) * 0.55;
        const a = (1 - phase) * 0.55;
        ctx.strokeStyle = `hsla(155, 90%, 65%, ${a})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Hex core
      const coreR = 46 + Math.sin(t * 0.05) * 4 + (warp ? 30 : charging ? 12 : 0);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.008);
      ctx.strokeStyle = "hsla(155,95%,70%,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6;
        const x = Math.cos(a) * coreR;
        const y = Math.sin(a) * coreR;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      // inner glow
      const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      g2.addColorStop(0, "rgba(180,255,210,0.9)");
      g2.addColorStop(1, "rgba(0,255,140,0)");
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [charging, warp]);

  // Parallax
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      setMouse({
        x: (e.clientX - r.left) / r.width - 0.5,
        y: (e.clientY - r.top) / r.height - 0.5,
      });
    };
    el.addEventListener("mousemove", onMove);
    return () => el.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative min-h-screen w-full overflow-hidden bg-background text-foreground"
      style={{ backgroundImage: "none" }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{
          transform: `translate3d(${mouse.x * -20}px, ${mouse.y * -20}px, 0) scale(${warp ? 1.15 : 1})`,
          transition: "transform 600ms cubic-bezier(.2,.8,.2,1)",
        }}
      />

      {/* Scanline overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-30 mix-blend-screen"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(120,255,180,0.06) 0 1px, transparent 1px 3px)",
        }}
      />

      {/* HUD frame */}
      <HUDFrame warp={warp} />

      {/* Orbiting satellite nodes */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          transform: `translate3d(${mouse.x * 24}px, ${mouse.y * 24}px, 0)`,
          transition: "transform 400ms cubic-bezier(.2,.8,.2,1)",
        }}
      >
        {NODES.map((n, i) => (
          <Satellite key={n.label} node={n} index={i} warp={warp} />
        ))}
      </div>

      {/* Center teleport gate */}
      <div className="absolute inset-0 flex items-center justify-center">
        <TeleportGate
          charging={charging}
          warp={warp}
          onEnter={() => setWarp(true)}
          onHold={setCharging}
        />
      </div>

      {/* Warp navigate */}
      <WarpRouter warp={warp} />
    </div>
  );
}

/* ---------- HUD ---------- */
function HUDFrame({ warp }: { warp: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now.toISOString().split("T")[1]?.slice(0, 8) ?? "";
  return (
    <>
      {/* corners */}
      {(["tl", "tr", "bl", "br"] as const).map((k) => (
        <Corner key={k} pos={k} />
      ))}
      <div className="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-[0.4em] text-signal">
        SENTINEL·OS  //  TELEPORT CORE  //  {warp ? "WARP" : "IDLE"}
      </div>
      <div className="pointer-events-none absolute left-6 top-6 font-mono text-[10px] leading-relaxed text-muted-foreground">
        <div>SYS <span className="text-signal">◉</span> ONLINE</div>
        <div>UTC {time}</div>
        <div>NODES 16/16</div>
      </div>
      <div className="pointer-events-none absolute right-6 top-6 text-right font-mono text-[10px] leading-relaxed text-muted-foreground">
        <div>LINK <span className="text-signal">◉</span> STABLE</div>
        <div>PWR {warp ? "1.00" : "0.72"}</div>
        <div>GATE {warp ? "OPEN" : "READY"}</div>
      </div>
      <div className="pointer-events-none absolute bottom-6 left-6 font-mono text-[10px] text-muted-foreground">
        [ v0.4.2 ]
      </div>
      <div className="pointer-events-none absolute bottom-6 right-6 font-mono text-[10px] text-muted-foreground">
        HOLD · TO · WARP
      </div>
    </>
  );
}

function Corner({ pos }: { pos: "tl" | "tr" | "bl" | "br" }) {
  const map: Record<string, string> = {
    tl: "top-3 left-3 border-l border-t",
    tr: "top-3 right-3 border-r border-t",
    bl: "bottom-3 left-3 border-l border-b",
    br: "bottom-3 right-3 border-r border-b",
  };
  return (
    <div
      className={`pointer-events-none absolute h-6 w-6 border-signal/70 ${map[pos]}`}
      style={{ borderColor: "hsla(155,90%,65%,0.7)" }}
    />
  );
}

/* ---------- Satellite ---------- */
function Satellite({
  node,
  index,
  warp,
}: {
  node: (typeof NODES)[number];
  index: number;
  warp: boolean;
}) {
  const radii = ["30%", "40%", "50%"];
  const speeds = [40, 60, 80];
  const dir = node.ring % 2 === 0 ? 1 : -1;
  const style: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: 0,
    height: 0,
    animation: `orbit-${node.ring} ${speeds[node.ring]}s linear infinite ${dir === -1 ? "reverse" : ""}`,
  };
  return (
    <>
      <style>{`
        @keyframes orbit-${node.ring} {
          from { transform: translate(-50%,-50%) rotate(${node.angle}deg) translateX(${radii[node.ring]}) rotate(-${node.angle}deg); }
          to   { transform: translate(-50%,-50%) rotate(${node.angle + 360}deg) translateX(${radii[node.ring]}) rotate(-${node.angle + 360}deg); }
        }
      `}</style>
      <div style={style}>
        <div
          className="relative -translate-x-1/2 -translate-y-1/2"
          style={{
            transition: "all 500ms",
            opacity: warp ? 0 : 1,
            transform: `translate(-50%,-50%) scale(${warp ? 0.4 : 1})`,
          }}
        >
          <div
            className="flex items-center gap-2 rounded-sm border border-signal/40 bg-background/60 px-2 py-1 font-mono text-[10px] tracking-wider text-signal backdrop-blur-sm"
            style={{
              boxShadow: "0 0 12px rgba(120,255,180,0.25)",
              animationDelay: `${index * 0.15}s`,
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-signal"
              style={{ boxShadow: "0 0 8px currentColor" }}
            />
            {node.label}
          </div>
          {/* link line to center */}
          <div
            aria-hidden
            className="absolute left-1/2 top-1/2 h-px w-[1000px] origin-left"
            style={{
              background:
                "linear-gradient(to right, transparent, hsla(155,90%,65%,0.35) 40%, transparent)",
              transform: "translateY(-50%) rotate(180deg)",
              opacity: warp ? 0 : 0.5,
            }}
          />
        </div>
      </div>
    </>
  );
}

/* ---------- Teleport Gate (center CTA) ---------- */
function TeleportGate({
  charging,
  warp,
  onEnter,
  onHold,
}: {
  charging: boolean;
  warp: boolean;
  onEnter: () => void;
  onHold: (v: boolean) => void;
}) {
  const [progress, setProgress] = useState(0);
  const holdRef = useRef<number | null>(null);
  const startedRef = useRef(0);

  const start = () => {
    onHold(true);
    startedRef.current = performance.now();
    const tick = () => {
      const dt = performance.now() - startedRef.current;
      const p = Math.min(1, dt / 900);
      setProgress(p);
      if (p >= 1) {
        onEnter();
        return;
      }
      holdRef.current = requestAnimationFrame(tick);
    };
    holdRef.current = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (holdRef.current) cancelAnimationFrame(holdRef.current);
    onHold(false);
    if (progress < 1) setProgress(0);
  };

  const size = 260;
  const stroke = 3;
  const r = size / 2 - stroke * 2;
  const C = 2 * Math.PI * r;

  return (
    <button
      aria-label="Enter"
      onMouseDown={start}
      onMouseUp={stop}
      onMouseLeave={stop}
      onTouchStart={(e) => {
        e.preventDefault();
        start();
      }}
      onTouchEnd={stop}
      className="group relative cursor-pointer select-none rounded-full outline-none"
      style={{
        width: size,
        height: size,
        transform: warp ? "scale(4)" : charging ? "scale(1.05)" : "scale(1)",
        transition: "transform 700ms cubic-bezier(.5,.05,.2,1)",
        opacity: warp ? 0 : 1,
      }}
    >
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={{ filter: "drop-shadow(0 0 24px rgba(120,255,180,0.55))" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsla(155,80%,60%,0.2)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="hsla(155,95%,70%,1)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: progress === 0 ? "stroke-dashoffset 300ms" : "none" }}
        />
        {/* rotating tick marks */}
        <g className="origin-center" style={{ animation: "spin-slow 18s linear infinite" }}>
          {Array.from({ length: 48 }).map((_, i) => {
            const a = (i / 48) * Math.PI * 2;
            const x1 = size / 2 + Math.cos(a) * (r - 10);
            const y1 = size / 2 + Math.sin(a) * (r - 10);
            const x2 = size / 2 + Math.cos(a) * (r - (i % 6 === 0 ? 18 : 14));
            const y2 = size / 2 + Math.sin(a) * (r - (i % 6 === 0 ? 18 : 14));
            return (
              <line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="hsla(155,80%,65%,0.6)"
                strokeWidth={i % 6 === 0 ? 1.5 : 0.8}
              />
            );
          })}
        </g>
      </svg>

      {/* Inner core */}
      <div className="absolute inset-8 flex items-center justify-center rounded-full">
        <div
          className="relative flex h-full w-full items-center justify-center rounded-full"
          style={{
            background:
              "radial-gradient(circle at 50% 45%, rgba(180,255,210,0.9), rgba(20,140,90,0.5) 40%, rgba(0,20,10,0.9) 75%)",
            boxShadow:
              "inset 0 0 40px rgba(120,255,180,0.6), inset 0 0 100px rgba(0,120,90,0.6)",
          }}
        >
          <div
            className="absolute inset-4 rounded-full border border-signal/50"
            style={{ animation: "spin-slow 8s linear infinite" }}
          />
          <div
            className="absolute inset-8 rounded-full border border-signal/30"
            style={{ animation: "spin-slow 12s linear infinite reverse" }}
          />
          <div className="relative z-10 flex flex-col items-center gap-1 font-mono">
            <span
              className="text-[10px] tracking-[0.5em] text-signal"
              style={{ textShadow: "0 0 12px currentColor" }}
            >
              {charging ? "CHARGING" : "ENGAGE"}
            </span>
            <span
              className="text-2xl font-bold tracking-[0.3em] text-signal"
              style={{ textShadow: "0 0 20px currentColor" }}
            >
              {String(Math.round(progress * 100)).padStart(3, "0")}
            </span>
            <span className="text-[9px] tracking-[0.4em] text-muted-foreground">
              HOLD TO WARP
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin-slow { to { transform: rotate(360deg); } }
      `}</style>
    </button>
  );
}

/* ---------- Warp router: navigate to /console after warp animation ---------- */
function WarpRouter({ warp }: { warp: boolean }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (!warp) return;
    const id = setTimeout(() => setGo(true), 900);
    return () => clearTimeout(id);
  }, [warp]);
  return (
    <>
      {warp && (
        <div
          className="pointer-events-none absolute inset-0 bg-white"
          style={{
            animation: "flash 900ms ease-out forwards",
          }}
        />
      )}
      <style>{`
        @keyframes flash {
          0% { opacity: 0; }
          70% { opacity: 0.9; }
          100% { opacity: 1; }
        }
      `}</style>
      {go && <NavigateTo path="/console" />}
    </>
  );
}

function NavigateTo({ path }: { path: string }) {
  // hidden Link auto-clicked to keep type-safe routing
  const ref = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    ref.current?.click();
  }, []);
  return (
    <Link to={path} ref={ref} className="hidden" aria-hidden>
      go
    </Link>
  );
}
