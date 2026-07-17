/**
 * P0-R5 — Owner-only server functions for the Desktop Operator console.
 *
 * Session metadata is advertised by the Helper via its worker heartbeat
 * (encoded inside the free-form `platform` field with the `desktop-session:`
 * marker). Audit lives on agent_events with event_type prefix `desktop.`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { rollupStatus, type DesktopSessionMeta } from "./session";

export const listDesktopAudit = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((raw: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(500).default(100),
        since: z.string().datetime().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data, context }) => {
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
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { data: hb } = await context.supabase
      .from("worker_heartbeats")
      .select("worker_id,last_seen_at,current_run_id,platform")
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!hb) return { status: { state: "OFF" as const, reason: "no_worker" }, worker: null };

    const marker = "desktop-session:";
    let meta: DesktopSessionMeta | null = null;
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
