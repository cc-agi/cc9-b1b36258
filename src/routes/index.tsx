import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ArrowRight, Cpu, Network, Zap } from "lucide-react";

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
        content: "Sentinel OS 是一个由 AI 大脑自主驱动的桌面控制器，通过 MCP 协议操作浏览器、桌面和 SaaS，替你完成复杂任务，人工干预趋于零。",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border/50 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="signal-dot animate-pulse-signal" />
            <span className="font-mono text-sm tracking-[0.25em] uppercase">Sentinel OS</span>
          </div>
          <nav className="flex items-center gap-3">
            <Link to="/auth" search={{}}>
              <Button variant="ghost" size="sm">
                登录
              </Button>
            </Link>
            <Link to="/auth" search={{}}>
              <Button size="sm">
                启动终端 <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        <section className="max-w-6xl mx-auto px-6 pt-24 pb-16 w-full">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border bg-surface-1 mb-8">
            <span className="signal-dot animate-pulse-signal" />
            <span className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
              AGI 实现最前沿 · V0.1 Preview
            </span>
          </div>

          <h1 className="text-5xl md:text-7xl font-semibold leading-[1.05] tracking-tight max-w-4xl">
            让 Agent 自主操作
            <br />
            <span className="text-signal">你的桌面世界</span>
          </h1>

          <p className="mt-8 text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Sentinel OS 是一个完全由 AI 大脑自主驱动的控制器 —— 集成 Playwright MCP、browser-use MCP
            和任意标准 MCP 服务器，替你完成跨系统任务。人工干预趋于零。
          </p>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link to="/auth" search={{}}>
              <Button size="lg" className="h-12 px-6 text-base">
                进入控制台 <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
              <Button variant="outline" size="lg" className="h-12 px-6 text-base">
                了解 MCP 协议
              </Button>
            </a>
          </div>
        </section>

        <section className="border-t border-border/50">
          <div className="max-w-6xl mx-auto px-6 py-16 grid md:grid-cols-3 gap-px bg-border">
            <FeatureCard
              icon={<Cpu className="w-5 h-5" />}
              label="AUTONOMOUS BRAIN"
              title="AI 自主循环"
              body="Agent 接到目标后自主思考、拆解、调用工具、观察结果并纠错。最多 50 步循环，全程可观测。"
            />
            <FeatureCard
              icon={<Network className="w-5 h-5" />}
              label="MCP UNIVERSE"
              title="任意 MCP 接入"
              body="内置托管 MCP 或粘贴你自己的 URL —— Playwright、browser-use、Linear、Notion，即插即用。"
            />
            <FeatureCard
              icon={<Zap className="w-5 h-5" />}
              label="ZERO CONFIG"
              title="Lovable AI 大脑"
              body="内置 Gemini 3 / GPT-5 系列模型，无需 API Key。开箱即用，专注任务本身。"
            />
          </div>
        </section>

        <footer className="border-t border-border/50 mt-auto">
          <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between text-xs font-mono text-muted-foreground">
            <span>SENTINEL_OS // AUTONOMOUS DESKTOP CONTROLLER</span>
            <span>{new Date().getFullYear()}</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

function FeatureCard({
  icon,
  label,
  title,
  body,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-background p-8 hover:bg-surface-1 transition-colors">
      <div className="flex items-center gap-2 text-signal">
        {icon}
        <span className="text-xs font-mono uppercase tracking-widest">{label}</span>
      </div>
      <h3 className="mt-4 text-xl font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}
