/**
 * Owner-facing server fns for Worker pairing management.
 * The Owner generates a one-time pairing code, then runs the Helper
 * `install/pair` script with it. The code is stored server-side and
 * expires in 5 minutes; only its plain value is shown once.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const generateWorkerPairingCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { newPairingCode, hashToken } = await import("./worker-api.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const code = newPairingCode();
    const code_hash = hashToken(code);
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    // Legacy `code` column stores hash too (never plaintext); we only ever look up by code_hash.
    const { error } = await supabaseAdmin.from("worker_pairing_codes").insert({
      code: code_hash,
      code_hash,
      user_id: context.userId,
      expires_at: expires.toISOString(),
    });
    if (error) throw new Error(error.message);
    return { code, expires_at: expires.toISOString() };
  });

export const listWorkerTokens = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("worker_tokens")
      .select("id,worker_id,label,revoked_at,last_used_at,created_at")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const revokeWorkerToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("worker_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const requestAgentRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase.rpc("retry_agent_run", {
      _run_id: data.id,
    });
    if (error) throw new Error(error.message);
    return row;
  });
