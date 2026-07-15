import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().url(),
  transport: z.enum(["http", "sse"]).default("http"),
  auth_type: z.enum(["none", "bearer"]).default("none"),
  auth_token: z.string().optional(),
});

export const listMcpConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("mcp_connections")
      .select("id, name, url, transport, state, auth_type, tools_cache, last_error, created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createMcpConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CreateInput.parse(input))
  .handler(async ({ data, context }) => {
    const auth_metadata: Record<string, unknown> = {};
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

export const listAgentRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("agent_runs")
      .select("id, goal, status, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
