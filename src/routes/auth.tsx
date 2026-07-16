import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

// 唯一允许接入的账号
const ALLOWED_EMAIL = "aosenbearing@gmail.com";

function isAllowed(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase() === ALLOWED_EMAIL;
}

// Same-origin relative path only — never redirect users to an external URL
// pulled from a query param. Falls back to /console.
function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "/console";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/console";
  return raw;
}

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>): { next?: string } =>
    typeof s.next === "string" ? { next: s.next } : {},

  head: () => ({
    meta: [
      { title: "接入终端 · Sentinel OS" },
      { name: "description", content: "登录 Sentinel OS 自主 Agent 控制器" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { next: nextRaw } = Route.useSearch();
  const next = safeNext(nextRaw);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const currentEmail = data.session?.user.email;
      if (!data.session) return;
      // 已登录但不是白名单账号：立即退出
      if (!isAllowed(currentEmail)) {
        await supabase.auth.signOut();
        toast.error("该账号无权接入 Sentinel OS");
        return;
      }
      window.location.replace(next);
    });
  }, [next, navigate]);

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (!isAllowed(email)) {
        throw new Error("该账号无权接入 Sentinel OS");
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.replace(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "认证失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setBusy(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/auth`,
      });
      if (result.error) throw result.error;
      if (result.redirected) return; // 浏览器会跳走, 回到 /auth 后由 useEffect 校验
      // 弹窗流程直接拿到 session
      const { data } = await supabase.auth.getSession();
      if (!isAllowed(data.session?.user.email)) {
        await supabase.auth.signOut();
        throw new Error("该 Google 账号无权接入 Sentinel OS");
      }
      window.location.replace(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google 登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md panel p-8">
        <div className="flex items-center gap-3 mb-6">
          <span className="signal-dot animate-pulse-signal" />
          <span className="font-mono text-xs tracking-[0.3em] text-muted-foreground uppercase">
            Sentinel OS · Terminal
          </span>
        </div>
        <h1 className="text-3xl font-semibold mb-1">接入控制台</h1>
        <p className="text-sm text-muted-foreground mb-8">登录以调度你的自主 Agent。</p>

        <Button
          type="button"
          variant="outline"
          className="w-full mb-4 h-11"
          onClick={handleGoogle}
          disabled={busy}
        >
          使用 Google 继续
        </Button>

        <div className="flex items-center gap-3 my-5">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground font-mono">OR</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleEmail} className="space-y-4">
          <div>
            <Label htmlFor="email" className="text-xs uppercase tracking-wider">
              邮箱
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1.5 h-11 font-mono"
              placeholder={ALLOWED_EMAIL}
            />
          </div>
          <div>
            <Label htmlFor="password" className="text-xs uppercase tracking-wider">
              密码
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="mt-1.5 h-11 font-mono"
            />
          </div>
          <Button type="submit" className="w-full h-11" disabled={busy}>
            {busy ? "正在验证…" : "接入"}
          </Button>
        </form>

        <p className="mt-6 text-[11px] text-muted-foreground text-center leading-relaxed">
          本终端为私有部署，仅允许授权账号接入。
        </p>

        <div className="mt-6 text-center">
          <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
            ← 返回主页
          </Link>
        </div>
      </div>
    </div>
  );
}
