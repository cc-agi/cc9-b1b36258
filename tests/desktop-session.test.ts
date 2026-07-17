import { describe, it, expect } from "vitest";
import {
  clampIdleTtl,
  DEFAULT_IDLE_TTL_MS,
  MAX_IDLE_TTL_MS,
  MIN_IDLE_TTL_MS,
  idempotencyComposite,
  isExpired,
  remainingMs,
  rollupStatus,
  type DesktopSessionMeta,
} from "@/lib/desktop/session";

const base: DesktopSessionMeta = {
  session_id: "11111111-1111-1111-1111-111111111111",
  started_at: 1_000_000,
  last_activity_at: 1_000_000,
  idle_ttl_ms: 60_000,
  active: true,
  worker_id: "w-1",
  log_path: "C:\\log.txt",
};

describe("desktop session", () => {
  it("clamps idle ttl to [1min, 2h]", () => {
    expect(clampIdleTtl(undefined)).toBe(DEFAULT_IDLE_TTL_MS);
    expect(clampIdleTtl(0)).toBe(MIN_IDLE_TTL_MS);
    expect(clampIdleTtl(1_000_000_000)).toBe(MAX_IDLE_TTL_MS);
    expect(clampIdleTtl(5 * 60 * 1000)).toBe(5 * 60 * 1000);
  });

  it("expires strictly by last_activity_at + idle_ttl_ms", () => {
    expect(isExpired(base, 1_050_000)).toBe(false);
    expect(isExpired(base, 1_060_001)).toBe(true);
    expect(remainingMs(base, 1_030_000)).toBe(30_000);
    expect(remainingMs({ ...base, active: false })).toBe(0);
  });

  it("inactive sessions are OFF even if within TTL", () => {
    const s = rollupStatus({ ...base, active: false }, { now: 1_000_010 });
    expect(s.state).toBe("OFF");
  });

  it("active session rollup carries worker/session/log/remaining", () => {
    const s = rollupStatus(base, { now: 1_030_000, current_run_id: "r1" });
    expect(s).toMatchObject({
      state: "ACTIVE",
      worker_id: "w-1",
      session_id: base.session_id,
      remaining_ms: 30_000,
      log_path: "C:\\log.txt",
      current_run_id: "r1",
    });
  });

  it("idempotency composite is deterministic and includes session + attempt + sequence", () => {
    const a = idempotencyComposite({
      run_id: "r",
      attempt: 1,
      sequence: 3,
      session_id: "s",
      idempotency_key: "k",
    });
    const b = idempotencyComposite({
      run_id: "r",
      attempt: 1,
      sequence: 3,
      session_id: "s",
      idempotency_key: "k",
    });
    expect(a).toBe(b);
    const c = idempotencyComposite({
      run_id: "r",
      attempt: 2, // changed attempt
      sequence: 3,
      session_id: "s",
      idempotency_key: "k",
    });
    expect(c).not.toBe(a);
  });
});
