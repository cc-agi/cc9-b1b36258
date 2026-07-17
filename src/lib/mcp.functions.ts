import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { redactMcpUrl } from "./mcp/redact";

const CreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .url("URL 格式不正确")
    .refine((u) => !/[<>]/.test(u), {
      message: "URL 里还有占位符 <...>，请替换成真实的 API Key",
    }),
  transport: z.enum(["http", "sse"]).default("http"),
  auth_type: z.enum(["none", "bearer"]).default("none"),
  auth_token: z.string().optional(),
});

export const listMcpConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("mcp_connections")
      .select(
        "id, name, url, base_url, transport, state, auth_type, tools_cache, last_error, has_credentials, rotation_required, disabled_reason, created_at",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // 关键安全修复：只返回脱敏 URL、has_credentials、rotation_required。
    // 前端只用它来显示；真正打开连接时后端会从加密 Secret 组合。
    return (data ?? []).map((row) => ({
      ...row,
      url: redactMcpUrl(row.base_url ?? row.url),
      base_url: row.base_url ?? null,
    }));
  });

export const createMcpConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const auth_metadata: Record<string, string> = {};
    if (data.auth_type === "bearer" && data.auth_token) {
      auth_metadata.token = data.auth_token;
    }
    const { data: row, error } = await context.supabase
      .from("mcp_connections")
      .insert({
        user_id: context.userId,
        name: data.name,
        url: data.url,
        transport: data.transport,
        auth_type: data.auth_type,
        auth_metadata,
        state: "ready",
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteMcpConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("mcp_connections")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const testMcpConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("mcp_connections")
      .select("id, name, url, transport, auth_type, auth_metadata")
      .eq("id", data.id)
      .single();
    if (error || !row) throw new Error(error?.message ?? "连接不存在");

    const started = Date.now();
    const { openMcpConnection } = await import("./mcp-client.server");
    try {
      const opened = await openMcpConnection(row as never);
      const handshakeMs = Date.now() - started;
      const toolNames = Object.keys(opened.tools);
      await opened.client.close();

      await context.supabase
        .from("mcp_connections")
        .update({
          state: "ready",
          last_error: null,
          tools_cache: toolNames,
        })
        .eq("id", row.id);

      return {
        ok: true as const,
        handshakeMs,
        toolCount: toolNames.length,
        tools: toolNames.slice(0, 50),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await context.supabase
        .from("mcp_connections")
        .update({ state: "error", last_error: message })
        .eq("id", row.id);
      return {
        ok: false as const,
        handshakeMs: Date.now() - started,
        error: message,
      };
    }
  });

export const listAgentRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // 机会式扫描：把已经"僵死"的 queued / running 状态回收，避免永久停在 queued。
    // 用 service_role 客户端调用，因为 sweep 函数只授权给 service_role。
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.rpc("sweep_stale_agent_runs");
    } catch {
      // sweep 失败不影响列表返回
    }
    const { data, error } = await context.supabase
      .from("agent_runs")
      .select(
        "id, goal, status, created_at, completed_at, started_at, heartbeat_at, worker_id, attempts, last_error",
      )
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
