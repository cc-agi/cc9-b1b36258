/**
 * P0-R5 — Desktop Operator Session lifecycle (pure helpers).
 *
 * The session itself lives on the LOCAL Windows machine, started by the
 * Owner running `start-desktop-operator.bat`. That script launches
 * `desktop-operator.ps1` which listens on 127.0.0.1:<random port>, mints a
 * per-session bearer secret, and writes a session descriptor to
 * `%LOCALAPPDATA%\SentinelOS\desktop-session.json`. The Helper daemon reads
 * that descriptor before executing any desktop_* intent.
 *
 * Cloud NEVER holds the session secret. It only sees the metadata the Helper
 * chooses to advertise in its heartbeat (session_id, expires_at, active flag).
 *
 * This module is import-safe on both Cloud SSR and unit tests.
 */

export const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_IDLE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours hard cap
export const MIN_IDLE_TTL_MS = 60 * 1000; // 1 minute floor

export interface DesktopSessionMeta {
  session_id: string; // uuid
  started_at: number; // epoch ms
  last_activity_at: number; // epoch ms — bumped on every accepted intent
  idle_ttl_ms: number; // resolved TTL (clamped)
  active: boolean; // false once stopped or expired
  worker_id: string;
  log_path: string; // absolute local path
}

export function clampIdleTtl(ms: number | undefined): number {
  const v = typeof ms === "number" && Number.isFinite(ms) ? ms : DEFAULT_IDLE_TTL_MS;
  return Math.min(MAX_IDLE_TTL_MS, Math.max(MIN_IDLE_TTL_MS, Math.floor(v)));
}

export function isExpired(meta: DesktopSessionMeta, now: number = Date.now()): boolean {
  if (!meta.active) return true;
  return now - meta.last_activity_at > meta.idle_ttl_ms;
}

export function remainingMs(meta: DesktopSessionMeta, now: number = Date.now()): number {
  if (!meta.active) return 0;
  return Math.max(0, meta.idle_ttl_ms - (now - meta.last_activity_at));
}

/**
 * Idempotency composite key stored per (run, attempt, sequence, session).
 * Same tuple + same idempotency_key → replay the stored result verbatim, do
 * NOT re-execute the side effect. The Helper's on-disk journal keys off the
 * SHA-256 of this composite.
 */
export function idempotencyComposite(input: {
  run_id: string;
  attempt: number;
  sequence: number;
  session_id: string;
  idempotency_key: string;
}): string {
  return [
    input.run_id,
    String(input.attempt),
    String(input.sequence),
    input.session_id,
    input.idempotency_key,
  ].join("|");
}

/**
 * Owner-facing rollup for the console panel.
 */
export type DesktopSessionStatus =
  | { state: "OFF"; reason?: string }
  | {
      state: "ACTIVE";
      worker_id: string;
      session_id: string;
      remaining_ms: number;
      log_path: string;
      current_run_id?: string | null;
    };

export function rollupStatus(
  meta: DesktopSessionMeta | null | undefined,
  opts: { now?: number; current_run_id?: string | null } = {},
): DesktopSessionStatus {
  const now = opts.now ?? Date.now();
  if (!meta || !meta.active) return { state: "OFF" };
  if (isExpired(meta, now)) return { state: "OFF", reason: "expired" };
  return {
    state: "ACTIVE",
    worker_id: meta.worker_id,
    session_id: meta.session_id,
    remaining_ms: remainingMs(meta, now),
    log_path: meta.log_path,
    current_run_id: opts.current_run_id ?? null,
  };
}
