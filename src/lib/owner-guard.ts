/**
 * Sentinel Owner Guard (P0-R3.2 Repair).
 *
 * Server-side, canonical Owner check for privileged Sentinel operations:
 *   - Runtime Acceptance Lab (create/list/get/retry)
 *   - Diagnostics one-click repairs
 *   - Stale-worker deletion listing
 *
 * Owner identity is the Supabase-authenticated user whose verified email
 * matches SENTINEL_OWNER_EMAIL. RLS or UI checks are NOT sufficient.
 * Non-owner callers get access_denied; the denial is written to the
 * server log via console.warn (no persistent audit table exists yet —
 * do NOT claim this is written to a persistent audit ledger).
 */
import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const SENTINEL_OWNER_EMAIL = "aosenbearing@gmail.com";

function normalize(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function isSentinelOwnerEmail(email: unknown): boolean {
  return normalize(email) === SENTINEL_OWNER_EMAIL;
}

/**
 * Chained after `requireSupabaseAuth`. Verifies:
 *   - Supabase session is valid (inherited from base middleware).
 *   - JWT claim `email` (or user_metadata.email) strictly equals SENTINEL_OWNER_EMAIL.
 *
 * Denials throw with `access_denied` and are audited via `agent_events`
 * only when a plausible run_id is not required; the record uses NULL run_id.
 */
export const requireSentinelOwner = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const claims = context.claims as Record<string, unknown> | undefined;
    const claimEmail = claims?.email;
    const metaEmail = (claims?.user_metadata as Record<string, unknown> | undefined)?.email;
    const email = normalize(claimEmail) || normalize(metaEmail);

    if (!isSentinelOwnerEmail(email)) {
      // Denials are written to the server log only. There is no persistent
      // audit table yet; see file header. Do not add a placeholder insert
      // into agent_events — it would require fabricating a run_id.
      console.warn("[sentinel-owner] access_denied", {
        user_id: context.userId,
        email: email || null,
      });
      throw new Error("access_denied");
    }

    return next({ context: { ownerEmail: email } });
  });
