/**
 * Owner-facing diagnostics + one-click repair server fns (P0-R3).
 * All checks are read-only unless explicitly labelled as a repair action.
 * No secrets are returned; only booleans, timestamps, and Chinese labels.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { z } from "zod";
import { explainError, type SentinelErrorCode } from "./error-catalog";

export type DiagnosticCheck = {
  id: string;
  label: string;
  ok: boolean | null; // null = 未知/未探测
  detail: string;
  suggestion?: string;
  timestamp: string;
};

/**
 * 一键运行环境诊断。
 * - Cloud API: 隐含通过（能执行到这里说明 API 可达）
 * - OAuth identity: context.userId 存在
 * - Helper heartbeat / version / CDP: 读 worker_heartbeats 最新一行
 * - Active run: 是否存在卡在 claimed/running 的任务
 * - Stale runs: 是否有超时未清理
 */
export const runDiagnostics = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { MIN_HELPER_VERSION } = await import("./mcp/version");
    const now = Date.now();
    const iso = new Date().toISOString();
    const checks: DiagnosticCheck[] = [];

    // Cloud API
    checks.push({
      id: "cloud_api",
      label: "Cloud API 可达",
      ok: true,
      detail: "服务端函数响应正常。",
      timestamp: iso,
    });

    // OAuth identity
    checks.push({
      id: "oauth_identity",
      label: "OAuth 身份",
      ok: Boolean(context.userId),
      detail: context.userId ? "已登录当前 Owner。" : "未识别登录用户。",
      timestamp: iso,
    });

    // Helper heartbeat
    const { data: hb } = await context.supabase
      .from("worker_heartbeats")
      .select(
        "worker_id,version,platform,computer_name,chrome_version,state,cdp_reachable,current_run_id,last_error_code,last_seen_at",
      )
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const helperAgeSec = hb ? Math.floor((now - new Date(hb.last_seen_at).getTime()) / 1000) : null;
    const helperOnline = helperAgeSec !== null && helperAgeSec < 60;

    checks.push({
      id: "helper_heartbeat",
      label: "Helper 心跳",
      ok: helperOnline ? true : hb ? false : null,
      detail: hb
        ? `worker=${hb.worker_id} · ${helperAgeSec}s 前 · ${hb.state}`
        : "从未收到 Helper 心跳。",
      suggestion: helperOnline ? undefined : "在 Windows 上运行 start-sentinel.bat 启动 Helper。",
      timestamp: iso,
    });

    // Helper version
    const versionOk = hb?.version ? cmpSemver(hb.version, MIN_HELPER_VERSION) >= 0 : null;
    checks.push({
      id: "helper_version",
      label: "Helper 版本",
      ok: versionOk,
      detail: hb?.version
        ? `v${hb.version}${versionOk ? "" : `（要求 ≥ v${MIN_HELPER_VERSION}）`}`
        : "等待 Helper 上线。",
      suggestion: versionOk === false ? "运行 helper\\install-helper.ps1 升级 Helper。" : undefined,
      timestamp: iso,
    });

    // CDP
    checks.push({
      id: "cdp",
      label: "Chrome CDP (/json/version)",
      ok: hb?.cdp_reachable === true ? true : hb?.cdp_reachable === false ? false : null,
      detail:
        hb?.cdp_reachable === true
          ? `Chrome ${hb.chrome_version ?? "?"} · 计算机 ${hb.computer_name ?? "?"}`
          : hb?.cdp_reachable === false
            ? `Helper 在线但 127.0.0.1:9222 不可达（最近错误：${hb.last_error_code ?? "n/a"}）`
            : "未探测。",
      suggestion:
        hb?.cdp_reachable === false ? "运行 repair-sentinel.bat 重启专用 Chrome。" : undefined,
      timestamp: iso,
    });

    // Active run
    const { data: activeRun } = await context.supabase
      .from("agent_runs")
      .select("id,status,goal,started_at,heartbeat_at,error_code")
      .in("status", ["claimed", "running"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    checks.push({
      id: "active_run",
      label: "当前活动任务",
      ok: null,
      detail: activeRun
        ? `${activeRun.status} · ${(activeRun.goal ?? "").slice(0, 60)}`
        : "无活动任务。",
      timestamp: iso,
    });

    // Stuck runs (running > 3 min without recent event)
    const cutoff = new Date(now - 3 * 60 * 1000).toISOString();
    const { data: stuck } = await context.supabase
      .from("agent_runs")
      .select("id")
      .in("status", ["claimed", "running"])
      .lt("started_at", cutoff);
    checks.push({
      id: "stuck_runs",
      label: "疑似僵尸任务",
      ok: (stuck ?? []).length === 0,
      detail: `${(stuck ?? []).length} 个任务在 running/claimed 状态超过 3 分钟。`,
      suggestion:
        (stuck ?? []).length > 0
          ? "点击「清理僵尸任务」触发 sweep，Cloud 会把它们标为 timed_out。"
          : undefined,
      timestamp: iso,
    });

    return {
      checks,
      helper: hb
        ? {
            worker_id: hb.worker_id,
            version: hb.version,
            platform: hb.platform,
            computer_name: hb.computer_name,
            chrome_version: hb.chrome_version,
            state: hb.state,
            cdp_reachable: hb.cdp_reachable,
            current_run_id: hb.current_run_id,
            last_error_code: hb.last_error_code,
            last_error_hint: hb.last_error_code
              ? explainError(hb.last_error_code as SentinelErrorCode)
              : null,
            last_seen_at: hb.last_seen_at,
            age_seconds: helperAgeSec,
            online: helperOnline,
          }
        : null,
      generated_at: iso,
    };
  });

/**
 * 一键清理僵尸任务：调用 sweep_stale_agent_runs()。
 * Cloud 侧的 SECURITY DEFINER 已 revoke，只有 service_role 可执行；
 * 因此这里通过 supabaseAdmin 调用，但只在验证过 owner 身份之后。
 */
export const sweepStaleRuns = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.rpc("sweep_stale_agent_runs");
    if (error) throw new Error(error.message);
    // 只返回属于当前 owner 的行数（sweep 会全库扫描；返回集合里也只包含 id）
    if (!Array.isArray(data)) return { swept: 0 };
    // 二次核对：过滤出属于当前用户的
    if (data.length === 0) return { swept: 0 };
    const ids = data.map((r: { swept_id: string }) => r.swept_id).filter(Boolean);
    const { data: owned } = await context.supabase.from("agent_runs").select("id").in("id", ids);
    return { swept: owned?.length ?? 0 };
  });

/**
 * 一键"安全重试"：等价于 Owner 手动 retry_agent_run。
 * 保留一层 wrapper 是为了让 UI 可以在诊断结果里直接触发。
 */
export const retryRun = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin.rpc("retry_agent_run", {
      _run_id: data.id,
      _actor_user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    return row;
  });

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
