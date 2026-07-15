import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Every handler dynamically imports its server-only helpers so the module
// stays safe to include in the client graph (only handler bodies are
// stripped, not module top-level imports).

export const getCc6Status = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getConnectionStatus } = await import("./connections.server");
    return getConnectionStatus(context.userId);
  });

export const startCc6Connect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { origin: string }) => z.object({ origin: z.string().url() }).parse(data))
  .handler(async ({ data, context }) => {
    const { CC6 } = await import("./config");
    const { registerClient, generatePkce, generateState, buildAuthorizeUrl } = await import(
      "./oauth.server"
    );
    const { encryptJson } = await import("./crypto.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const redirectUri = `${data.origin.replace(/\/$/, "")}/api/oauth/cc6/callback`;
    const client = await registerClient(redirectUri);
    const { verifier, challenge } = generatePkce();
    const state = generateState();

    await supabaseAdmin.from("mcp_oauth_pending").insert({
      state,
      user_id: context.userId,
      server_id: CC6.serverId,
      code_verifier: verifier,
      client_registration_ciphertext: encryptJson(client),
      redirect_uri: redirectUri,
    });

    const url = await buildAuthorizeUrl({ client, redirectUri, state, codeChallenge: challenge });
    return { authorizeUrl: url };
  });

export const disconnectCc6 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { deleteConnection } = await import("./connections.server");
    const { clearSession } = await import("./rpc.server");
    await deleteConnection(context.userId);
    clearSession(context.userId);
    return { ok: true };
  });

export type Cc6ToolInfo = { name: string; description: string; inputSchema: string };

export const listCc6Tools = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ok: true; tools: Cc6ToolInfo[] } | { ok: false; error: string }> => {
    const { listTools } = await import("./rpc.server");
    try {
      const raw = await listTools(context.userId);
      const tools: Cc6ToolInfo[] = raw.map((t) => ({
        name: String(t.name),
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: JSON.stringify(t.inputSchema ?? {}),
      }));
      return { ok: true, tools };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

export const callCc6Tool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { name: string; args?: Record<string, unknown> }) =>
    z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).parse(data),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; result: string } | { ok: false; error: string }> => {
    const { callTool } = await import("./rpc.server");
    try {
      const result = await callTool(context.userId, data.name, data.args ?? {});
      return { ok: true, result: JSON.stringify(result) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

export type Cc6Resource = {
  id: string;
  kind: "mcp" | "plugin" | "skill";
  name: string;
  description: string;
  /** JSON-stringified original payload (kept as string to stay serializable). */
  metadata: string;
};

function normalizeResources(raw: unknown): Cc6Resource[] {
  const out: Cc6Resource[] = [];
  const collect = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const rawKind = String(o.kind ?? o.type ?? o.category ?? "").toLowerCase();
    const kind: Cc6Resource["kind"] | null =
      rawKind.includes("mcp") ? "mcp" :
      rawKind.includes("skill") ? "skill" :
      rawKind.includes("plugin") || rawKind.includes("extension") ? "plugin" :
      null;
    if (!kind) return;
    const id = String(o.id ?? o.slug ?? o.name ?? "");
    const name = String(o.name ?? o.title ?? id);
    if (!id || !name) return;
    out.push({
      id,
      kind,
      name,
      description: typeof o.description === "string" ? o.description : (typeof o.summary === "string" ? o.summary : ""),
      metadata: JSON.stringify(o),
    });
  };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if ("kind" in o || "type" in o || "category" in o) collect(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(raw);
  return out;
}

export const searchCc6Resources = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { query?: string; kind?: "mcp" | "plugin" | "skill" | "all" }) =>
    z.object({
      query: z.string().optional(),
      kind: z.enum(["mcp", "plugin", "skill", "all"]).optional(),
    }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { callTool } = await import("./rpc.server");
    try {
      const args: Record<string, unknown> = {};
      if (data.query) args.query = data.query;
      if (data.kind && data.kind !== "all") args.kind = data.kind;
      const raw = await callTool(context.userId, "search_resources", args);
      let parsed: unknown = raw;
      const content = (raw as { content?: Array<{ type: string; text?: string }> })?.content;
      if (Array.isArray(content)) {
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        try { parsed = JSON.parse(text); } catch { parsed = { text }; }
      }
      const items = normalizeResources(parsed);
      const filtered = data.kind && data.kind !== "all" ? items.filter((i) => i.kind === data.kind) : items;
      return { ok: true as const, items };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const installCc6Resource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: Cc6Resource) =>
    z.object({
      id: z.string().min(1),
      kind: z.enum(["mcp", "plugin", "skill"]),
      name: z.string().min(1),
      description: z.string().default(""),
      metadata: z.string().default("{}"),
    }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let metaObj: unknown = {};
    try { metaObj = JSON.parse(data.metadata || "{}"); } catch { metaObj = { raw: data.metadata }; }
    const { error } = await supabaseAdmin.from("imported_resources").upsert(
      {
        user_id: context.userId,
        source: "cc6",
        source_id: data.id,
        kind: data.kind,
        name: data.name,
        description: data.description ?? "",
        metadata: metaObj as never,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,source,kind,source_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });

export type InstalledResource = {
  id: string;
  kind: "mcp" | "plugin" | "skill";
  name: string;
  description: string;
  source_id: string;
  created_at: string;
};

export const listInstalledResources = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<InstalledResource[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("imported_resources")
      .select("id, kind, name, description, source_id, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as InstalledResource[];
  });

export const uninstallResource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { id: string }) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("imported_resources")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
