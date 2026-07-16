import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import mcp from "@/lib/mcp/index";

type ToolInfo = { name: string; title?: string; description?: string; readOnly?: boolean; destructive?: boolean };

export const testMcpConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const t0 = Date.now();
    const def = mcp as unknown as {
      name?: string;
      title?: string;
      version?: string;
      tools?: Array<{
        name: string;
        title?: string;
        description?: string;
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
      }>;
    };
    const tools: ToolInfo[] = (def.tools ?? []).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      readOnly: t.annotations?.readOnlyHint,
      destructive: t.annotations?.destructiveHint,
    }));

    // Live DB check: same path list_mcp_connections would run for this user.
    const { count, error } = await context.supabase
      .from("mcp_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId);

    const { data: userData } = await context.supabase.auth.getUser();

    return {
      ok: !error,
      elapsedMs: Date.now() - t0,
      server: { name: def.name, title: def.title, version: def.version },
      user: { id: context.userId, email: userData?.user?.email ?? null },
      toolCount: tools.length,
      tools,
      dbCheck: {
        ok: !error,
        mcpConnectionsCount: count ?? 0,
        error: error?.message ?? null,
      },
    };
  });
