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

export const listCc6Tools = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listTools } = await import("./rpc.server");
    try {
      const tools = await listTools(context.userId);
      return { ok: true as const, tools };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

export const callCc6Tool = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { name: string; args?: Record<string, unknown> }) =>
    z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { callTool } = await import("./rpc.server");
    try {
      const result = await callTool(context.userId, data.name, data.args ?? {});
      return { ok: true as const, result };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });
