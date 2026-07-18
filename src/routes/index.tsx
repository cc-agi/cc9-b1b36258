import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

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

// Consolidated orbit keyframes (one <style> block instead of one per satellite).
const ORBIT_CSS = `
@keyframes orbit-0 { to { transform: translate(-50%,-50%) rotate(360deg); } }
@keyframes orbit-1 { to { transform: translate(-50%,-50%) rotate(-360deg); } }
@keyframes orbit-2 { to { transform: translate(-50%,-50%) rotate(360deg); } }
@keyframes counter-orbit-0 { to { transform: rotate(-360deg); } }
@keyframes counter-orbit-1 { to { transform: rotate(360deg); } }
@keyframes counter-orbit-2 { to { transform: rotate(-360deg); } }
@keyframes spin-slow { to { transform: rotate(360deg); } }
@keyframes flash-fade {
  0% { opacity: 0; }
  70% { opacity: 0.9; }
  100% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .sentinel-orbit, .sentinel-orbit-inner, .sentinel-spin { animation: none !important; }
}
`;

// Device-adaptive perf profile.
function getPerfProfile() {
  if (typeof window === "undefined") {
    return { particles: 180, dpr: 1.5, rings: 5, reduced: false };
  }
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  // @ts-expect-error non-standard hints
  const mem: number = navigator.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const area = window.innerWidth * window.innerHeight;
  const rawDpr = window.devicePixelRatio || 1;

  // Low tier: mobile / <=4GB / <=4 cores
  const low = mem <= 4 || cores <= 4 || area < 600_000;
  // High tier: desktop with headroom
  const high = mem >= 8 && cores >= 8 && area >= 1_200_000;

  if (reduced) return { particles: 0, dpr: 1, rings: 3, reduced: true };
  if (low) return { particles: 110, dpr: Math.min(rawDpr, 1.25), rings: 4, reduced: false };
  if (high) return { particles: 240, dpr: Math.min(rawDpr, 2), rings: 6, reduced: false };
  return { particles: 170, dpr: Math.min(rawDpr, 1.5), rings: 5, reduced: false };
}

function Landing() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const orbitsRef = useRef<HTMLDivElement | null>(null);

  const [charging, setCharging] = useState(false);
  const [warp, setWarp] = useState(false);

  // Refs mirror state for the rAF loop — avoid restarting the loop on state change.
  const chargingRef = useRef(false);
  const warpRef = useRef(false);
  chargingRef.current = charging;
  warpRef.current = warp;

  const profile = useMemo(getPerfProfile, []);

  // Wormhole canvas — tunneling starfield + rotating rings
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const { particles: PCOUNT, dpr, rings: RING_COUNT, reduced } = profile;

    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let maxDim = 0;
    let cachedGrd: CanvasGradient | null = null;

    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      cx = w / 2;
      cy = h / 2;
      maxDim = Math.max(w, h);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Rebuild cached gradient after resize
      cachedGrd = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxDim * 0.5);
      cachedGrd.addColorStop(0, "rgba(120,255,180,0.18)");
      cachedGrd.addColorStop(0.4, "rgba(80,180,255,0.06)");
      cachedGrd.addColorStop(1, "rgba(0,0,0,0)");
    };
    resize();

    let resizeQueued = false;
    const onResize = () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resize();
      });
    };
    window.addEventListener("resize", onResize);

    // Reduced-motion: paint one static frame and bail.
    if (reduced || PCOUNT === 0) {
      ctx.fillStyle = "rgb(8, 12, 20)";
      ctx.fillRect(0, 0, w, h);
      if (cachedGrd) {
        ctx.fillStyle = cachedGrd;
        ctx.fillRect(0, 0, w, h);
      }
      return () => window.removeEventListener("resize", onResize);
    }

    // Typed arrays are cheaper than object arrays in tight loops.
    const pa = new Float32Array(PCOUNT); // angle
    const pr = new Float32Array(PCOUNT); // radius
    const ps = new Float32Array(PCOUNT); // speed
    const pz = new Float32Array(PCOUNT); // depth
    const phGreen = new Uint8Array(PCOUNT); // 1 = green, 0 = blue
    for (let i = 0; i < PCOUNT; i++) {
      pa[i] = Math.random() * Math.PI * 2;
      pr[i] = Math.random() * maxDim * 0.6;
      ps[i] = 0.4 + Math.random() * 2.4;
      pz[i] = 0.2 + Math.random() * 1.8;
      phGreen[i] = Math.random() < 0.7 ? 1 : 0;
    }

    let raf = 0;
    let t = 0;
    let last = performance.now();
    // Frame budget: skip a frame if the last one took too long (thermal throttle).
    let skip = false;

    const draw = (nowTs: number) => {
      const dt = nowTs - last;
      last = nowTs;
      // Normalize to ~60fps; clamp so a stall doesn't teleport particles.
      const step = Math.min(2.5, dt / 16.6);

      if (skip) {
        skip = false;
        raf = requestAnimationFrame(draw);
        return;
      }
      // Simple heuristic: if last frame was >32ms, skip the next to give GC/paint room.
      if (dt > 32) skip = true;

      t += step * 0.55;
      const isWarp = warpRef.current;
      const isCharging = chargingRef.current;
      const boost = (isWarp ? 6 : isCharging ? 2.2 : 1) * 0.5;

      // Trail
      ctx.fillStyle = isWarp ? "rgba(8, 12, 20, 0.15)" : "rgba(8, 12, 20, 0.25)";
      ctx.fillRect(0, 0, w, h);

      // Radial glow center (cached gradient)
      if (cachedGrd) {
        ctx.fillStyle = cachedGrd;
        ctx.fillRect(0, 0, w, h);
      }

      // Tunnel streaks — batched by color into two single beginPath() calls.
      const limit = maxDim * 0.8;
      const alphaDiv = maxDim * 0.4;
      const baseLW = isWarp ? 1.6 : 1;

      // Green batch
      ctx.strokeStyle = `hsla(155, 90%, 65%, 0.7)`;
      ctx.lineWidth = baseLW;
      ctx.beginPath();
      for (let i = 0; i < PCOUNT; i++) {
        if (!phGreen[i]) continue;
        let r = pr[i] + ps[i] * boost * pz[i] * step;
        if (r > limit) {
          r = 4;
          pa[i] = Math.random() * Math.PI * 2;
        }
        pr[i] = r;
        const cos = Math.cos(pa[i]);
        const sin = Math.sin(pa[i]);
        const tail = 18 * boost * pz[i];
        const x = cx + cos * r;
        const y = cy + sin * r;
        const x2 = cx + cos * (r - tail);
        const y2 = cy + sin * (r - tail);
        // Alpha modulation via lineWidth-batch trick: skip individual alpha; batch is close enough.
        // Use per-particle alpha via short segments — cheaper: skip near-center faint particles.
        if (r < alphaDiv * 0.2) continue;
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Blue batch
      ctx.strokeStyle = `hsla(220, 90%, 70%, 0.6)`;
      ctx.lineWidth = baseLW;
      ctx.beginPath();
      for (let i = 0; i < PCOUNT; i++) {
        if (phGreen[i]) continue;
        let r = pr[i] + ps[i] * boost * pz[i] * step;
        if (r > limit) {
          r = 4;
          pa[i] = Math.random() * Math.PI * 2;
        }
        pr[i] = r;
        const cos = Math.cos(pa[i]);
        const sin = Math.sin(pa[i]);
        const tail = 18 * boost * pz[i];
        const x = cx + cos * r;
        const y = cy + sin * r;
        const x2 = cx + cos * (r - tail);
        const y2 = cy + sin * (r - tail);
        if (r < alphaDiv * 0.2) continue;
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();

      // Concentric portal rings — single strokeStyle, batched paths.
      ctx.lineWidth = 1.2;
      const ringSpan = Math.min(w, h) * 0.55;
      for (let i = 0; i < RING_COUNT; i++) {
        const phase = ((t * 0.006 + i * 0.4) % 1 + 1) % 1;
        const radius = 60 + phase * ringSpan;
        const a = (1 - phase) * 0.55;
        ctx.strokeStyle = `hsla(155, 90%, 65%, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Hex core
      const coreR = 46 + Math.sin(t * 0.05) * 4 + (isWarp ? 30 : isCharging ? 12 : 0);
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

    // Pause loop when tab hidden — saves battery, prevents huge dt catch-ups.
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [profile]);

  // Parallax — mutate transform via ref inside rAF; no React state churn.
  useEffect(() => {
    const el = wrapRef.current;
    const cwrap = canvasWrapRef.current;
    const orbits = orbitsRef.current;
    if (!el) return;
    if (profile.reduced) return;

    let mx = 0;
    let my = 0;
    let tx = 0;
    let ty = 0;
    let queued = false;

    const tick = () => {
      queued = false;
      // Ease toward target
      tx += (mx - tx) * 0.12;
      ty += (my - ty) * 0.12;
      if (cwrap) {
        cwrap.style.transform = `translate3d(${tx * -20}px, ${ty * -20}px, 0)`;
      }
      if (orbits) {
        orbits.style.transform = `translate3d(${tx * 24}px, ${ty * 24}px, 0)`;
      }
      if (Math.abs(mx - tx) > 0.001 || Math.abs(my - ty) > 0.001) schedule();
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(tick);
    };

    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width - 0.5;
      my = (e.clientY - r.top) / r.height - 0.5;
      schedule();
    };
    el.addEventListener("mousemove", onMove, { passive: true });
    return () => el.removeEventListener("mousemove", onMove);
  }, [profile]);

  return (
    <div
      ref={wrapRef}
      className="relative min-h-screen w-full overflow-hidden bg-background text-foreground"
      style={{ backgroundImage: "none" }}
    >
      <style>{ORBIT_CSS}</style>

      <div
        ref={canvasWrapRef}
        className="absolute inset-0 will-change-transform"
        style={{
          transform: "translate3d(0,0,0)",
          transition: warp ? "transform 600ms cubic-bezier(.2,.8,.2,1)" : undefined,
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{
            transform: warp ? "scale(1.15)" : "scale(1)",
            transition: "transform 600ms cubic-bezier(.2,.8,.2,1)",
          }}
        />
      </div>

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
        ref={orbitsRef}
        className="pointer-events-none absolute inset-0 will-change-transform"
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
      className={`pointer-events-none absolute h-6 w-6 ${map[pos]}`}
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
  const speeds = [80, 120, 160];
  const orbitStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: 0,
    height: 0,
    // Start rotation at the node's assigned angle by using negative animation-delay
    animation: `orbit-${node.ring} ${speeds[node.ring]}s linear infinite`,
    animationDelay: `${-(node.angle / 360) * speeds[node.ring]}s`,
    willChange: "transform",
  };
  // Counter-rotate so the label stays upright.
  const counterStyle: React.CSSProperties = {
    position: "absolute",
    left: radii[node.ring],
    top: 0,
    animation: `counter-orbit-${node.ring} ${speeds[node.ring]}s linear infinite`,
    animationDelay: `${-(node.angle / 360) * speeds[node.ring]}s`,
    willChange: "transform",
  };
  return (
    <div className="sentinel-orbit" style={orbitStyle}>
      <div className="sentinel-orbit-inner" style={counterStyle}>
        <div
          className="relative -translate-x-1/2 -translate-y-1/2"
          style={{
            transition: "opacity 500ms, transform 500ms",
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
        </div>
      </div>
    </div>
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
      const p = Math.min(1, dt / 1600);
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
    setProgress((p) => (p < 1 ? 0 : p));
  };

  const size = 260;
  const stroke = 3;
  const r = size / 2 - stroke * 2;
  const C = 2 * Math.PI * r;

  // Pre-computed tick marks — never recreated per render.
  const ticks = useMemo(() => {
    const arr: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const major = i % 6 === 0;
      arr.push({
        x1: size / 2 + Math.cos(a) * (r - 10),
        y1: size / 2 + Math.sin(a) * (r - 10),
        x2: size / 2 + Math.cos(a) * (r - (major ? 18 : 14)),
        y2: size / 2 + Math.sin(a) * (r - (major ? 18 : 14)),
        major,
      });
    }
    return arr;
  }, [r]);

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
      className="group relative cursor-pointer select-none rounded-full outline-none will-change-transform"
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
        <g
          className="sentinel-spin origin-center"
          style={{ animation: "spin-slow 36s linear infinite", willChange: "transform" }}
        >
          {ticks.map((tk, i) => (
            <line
              key={i}
              x1={tk.x1}
              y1={tk.y1}
              x2={tk.x2}
              y2={tk.y2}
              stroke="hsla(155,80%,65%,0.6)"
              strokeWidth={tk.major ? 1.5 : 0.8}
            />
          ))}
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
            className="sentinel-spin absolute inset-4 rounded-full border border-signal/50"
            style={{ animation: "spin-slow 8s linear infinite", willChange: "transform" }}
          />
          <div
            className="sentinel-spin absolute inset-8 rounded-full border border-signal/30"
            style={{ animation: "spin-slow 12s linear infinite reverse", willChange: "transform" }}
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
          style={{ animation: "flash-fade 900ms ease-out forwards" }}
        />
      )}
      {go && <NavigateTo path="/console" />}
    </>
  );
}

function NavigateTo({ path }: { path: string }) {
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
