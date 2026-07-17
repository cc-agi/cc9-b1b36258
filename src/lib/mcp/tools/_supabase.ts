import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";
import { SENTINEL_OWNER_EMAIL, isSentinelOwnerEmail } from "@/lib/owner-guard";

/**
 * Enforce that the MCP caller is the Sentinel Owner (email allowlist).
 * MCP OAuth (Supabase issuer) will accept *any* signed-in Supabase user,
 * so every tool must additionally verify the verified `email` claim.
 *
 * Returns an MCP-shaped error result when the caller is not the owner —
 * tool handlers should early-return this value.
 */
export function ensureOwnerOrError(ctx: ToolContext):
  | { content: [{ type: "text"; text: string }]; isError: true }
  | null {
  if (!ctx.isAuthenticated()) {
    return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
  }
  const email = ctx.getUserEmail?.();
  if (!isSentinelOwnerEmail(email)) {
    console.warn("[mcp-owner-guard] access_denied", {
      user_id: ctx.getUserId?.(),
      email: email ?? null,
    });
    return {
      content: [
        {
          type: "text",
          text: `access_denied: Sentinel OS is restricted to the Owner (${SENTINEL_OWNER_EMAIL}).`,
        },
      ],
      isError: true,
    };
  }
  return null;
}

/**
 * Build a Supabase client scoped to the calling MCP user.
 * Forwards the verified OAuth bearer token so RLS runs as that user.
 *
 * Callers MUST invoke `ensureOwnerOrError(ctx)` first and short-circuit on
 * a non-null return; this helper assumes the owner check has already passed.
 */
export function supabaseForUser(ctx: ToolContext) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}
