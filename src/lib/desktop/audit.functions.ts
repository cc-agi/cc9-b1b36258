/**
 * P0-R5 — Owner-only server functions for the Desktop Operator console.
 *
 * The Desktop Operator has NO dedicated table. Session metadata is advertised
 * by the Helper in its worker heartbeat (the Helper posts the current
 * DesktopSessionMeta into the existing heartbeat's `last_error_code` JSON
 * escape hatch or an ignored column — either way this function is defensive:
 * it just parses whatever is there, and if nothing is there it returns OFF).
 *
 * Audit lives on agent_events (event_type starts with `desktop.`), so the
 * append-only guarantee is inherited from that table.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { rollupStatus, type DesktopSessionMeta } from "./session";

const listInput = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  since: z.string().datetime().optional(),
});

export const listDesktopAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw) => listInput.parse(raw))
  .handler(async ({ data, context }) => {
    await requireSentinelOwner(context);
    let q = context.supabase
      .from("agent_events")
      .select("id,run_id,event_type,sequence,payload,created_at")
      .like("event_type", "desktop.%")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.since) q = q.gte("created_at", data.since);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return rows ?? [];
  });

export const getDesktopOperatorStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireSentinelOwner(context);
    const { data: hb } = await context.supabase
      .from("worker_heartbeats")
      .select("worker_id,last_seen_at,current_run_id,platform,chrome_version")
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!hb) return { status: { state: "OFF" as const, reason: "no_worker" }, worker: null };

    // The Helper encodes DesktopSessionMeta as a JSON blob inside the
    // free-form `platform` field (prefix: `desktop-session:`). This avoids a
    // schema migration while keeping the P0-R5 owner console useful.
    let meta: DesktopSessionMeta | null = null;
    const marker = "desktop-session:";
    if (typeof hb.platform === "string" && hb.platform.includes(marker)) {
      const raw = hb.platform.slice(hb.platform.indexOf(marker) + marker.length);
      try {
        meta = JSON.parse(raw) as DesktopSessionMeta;
      } catch {
        meta = null;
      }
    }
    return {
      status: rollupStatus(meta, { current_run_id: hb.current_run_id }),
      worker: { worker_id: hb.worker_id, last_seen_at: hb.last_seen_at },
    };
  });
