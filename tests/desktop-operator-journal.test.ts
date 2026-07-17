// P0-R5 R3 follow-up regression: proves the trusted-envelope journal
// semantics and the deterministic desktop routing that survived the
// 0.4.1 hotfix. This spins up a real loopback HTTP bridge that mirrors
// helper/desktop-operator.ps1's Journal-Key contract in Node:
//
//   composite = `${sessionId}|${envelope.run_id}|${envelope.intent_id}|${envelope.idempotency_key}`
//   key       = sha256(composite)
//
// then makes real fetch calls from helper/src/desktop.mjs and asserts:
//   (a) same run_id/intent_id/idempotency_key twice -> exactly one underlying
//       snapshot dispatch, both callers get the SAME stored result;
//   (b) two DIFFERENT (run_id, intent_id) that share the same orchestrator
//       key `att1:seq1` -> TWO underlying dispatches with distinct results;
//   (c) a caller-provided args.idempotency_key CANNOT control journal identity.
//
// Also covers the deterministic-routing session_id round-trip described in
// the review — parseDesktopGoal -> intent.arguments.session_id -> executeDesktopTool.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import http from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { parseDesktopGoal, DESKTOP_GOAL_PREFIX } from "@/lib/orchestrator.server";

const ROUND_TRIP_SESSION_ID = "508d0efd-6306-4a2f-be7a-76fcaf600d9e9";

function journalKey(sessionId: string, env: { run_id: string; intent_id: string; idempotency_key: string }) {
  return createHash("sha256")
    .update(`${sessionId}|${env.run_id}|${env.intent_id}|${env.idempotency_key}`)
    .digest("hex");
}

type EnvelopeIn = { run_id?: unknown; intent_id?: unknown; idempotency_key?: unknown } | undefined;

function startJournalBridge(sessionId: string, secret: string) {
  const journal = new Map<string, { ok: true; result: { snapshot_path: string; ts: number } }>();
  let dispatchCount = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error_code: "UNAUTHORIZED" }));
        return;
      }
      let parsed: { tool?: string; envelope?: EnvelopeIn } = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        /* ignore */
      }
      const env = {
        run_id: String((parsed.envelope as { run_id?: unknown } | undefined)?.run_id ?? ""),
        intent_id: String((parsed.envelope as { intent_id?: unknown } | undefined)?.intent_id ?? ""),
        idempotency_key: String(
          (parsed.envelope as { idempotency_key?: unknown } | undefined)?.idempotency_key ?? "",
        ),
      };
      const key = journalKey(sessionId, env);
      const cached = journal.get(key);
      if (cached) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(cached));
        return;
      }
      dispatchCount += 1;
      const payload = {
        ok: true as const,
        result: {
          snapshot_path: `C:\\snap-${dispatchCount}.png`,
          ts: Date.now() + dispatchCount, // strictly monotonic per dispatch
        },
      };
      journal.set(key, payload);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    });
  });
  return { server, getDispatchCount: () => dispatchCount, journal };
}

async function bootFakeWindowsSession(port: number, secret: string, session_id: string) {
  const tmpRoot = resolve(tmpdir(), `sentinel-journal-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(resolve(tmpRoot, "SentinelOS"), { recursive: true });
  writeFileSync(
    resolve(tmpRoot, "SentinelOS/desktop-session.json"),
    JSON.stringify({
      port,
      secret,
      session_id,
      worker_id: "w-journal",
      started_at: Date.now(),
      last_activity_at: Date.now(),
      idle_ttl_ms: 1_800_000,
      log_path: "",
    }),
    { encoding: "utf8" },
  );
  return tmpRoot;
}

describe("desktop-operator trusted-envelope journal (integration)", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalAppData = process.env.APPDATA;
  let tmpRoot: string | null = null;
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("(a) identical (run_id, intent_id, idempotency_key) replay: 1 dispatch, same result", async () => {
    const sessionId = "sid-journal-a";
    const secret = "sec-a-" + Math.random().toString(36).slice(2);
    const bridge = startJournalBridge(sessionId, secret);
    server = bridge.server;
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    tmpRoot = await bootFakeWindowsSession(port, secret, sessionId);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: false });
    process.env.LOCALAPPDATA = tmpRoot;

    const mod = await import("../helper/src/desktop.mjs?journalA=" + Date.now());
    const env = { run_id: "run-A", intent_id: "int-A", idempotency_key: "att1:seq1" };

    const r1 = await mod.executeDesktopTool("desktop_snapshot", { session_id: sessionId }, env);
    const r2 = await mod.executeDesktopTool("desktop_snapshot", { session_id: sessionId }, env);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(bridge.getDispatchCount()).toBe(1);
    expect(r1.result).toEqual(r2.result);
  });

  it("(b) different (run_id,intent_id) sharing idempotency_key `att1:seq1`: 2 dispatches, distinct results", async () => {
    const sessionId = "sid-journal-b";
    const secret = "sec-b-" + Math.random().toString(36).slice(2);
    const bridge = startJournalBridge(sessionId, secret);
    server = bridge.server;
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    tmpRoot = await bootFakeWindowsSession(port, secret, sessionId);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: false });
    process.env.LOCALAPPDATA = tmpRoot;

    const mod = await import("../helper/src/desktop.mjs?journalB=" + Date.now());

    const r1 = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: sessionId },
      { run_id: "run-1", intent_id: "int-1", idempotency_key: "att1:seq1" },
    );
    const r2 = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: sessionId },
      { run_id: "run-2", intent_id: "int-2", idempotency_key: "att1:seq1" },
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(bridge.getDispatchCount()).toBe(2);
    expect((r1.result as { snapshot_path: string }).snapshot_path).not.toBe(
      (r2.result as { snapshot_path: string }).snapshot_path,
    );
    expect((r1.result as { ts: number }).ts).not.toBe((r2.result as { ts: number }).ts);
  });

  it("(c) caller-provided args.idempotency_key cannot control journal identity", async () => {
    const sessionId = "sid-journal-c";
    const secret = "sec-c-" + Math.random().toString(36).slice(2);
    const bridge = startJournalBridge(sessionId, secret);
    server = bridge.server;
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    tmpRoot = await bootFakeWindowsSession(port, secret, sessionId);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: false });
    process.env.LOCALAPPDATA = tmpRoot;

    const mod = await import("../helper/src/desktop.mjs?journalC=" + Date.now());
    const env = { run_id: "run-C", intent_id: "int-C", idempotency_key: "att1:seq1" };

    // Same trusted envelope, DIFFERENT caller-supplied args.idempotency_key.
    const r1 = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: sessionId, idempotency_key: "attacker-key-1" },
      env,
    );
    const r2 = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: sessionId, idempotency_key: "attacker-key-2" },
      env,
    );
    // If args.idempotency_key had leaked into Journal-Key, dispatch would be 2.
    expect(bridge.getDispatchCount()).toBe(1);
    expect(r1.result).toEqual(r2.result);
  });
});

describe("desktop deterministic routing: session_id round-trip", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let tmpRoot: string | null = null;
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("parseDesktopGoal preserves the exact session_id byte-for-byte", () => {
    const goal = `${DESKTOP_GOAL_PREFIX}desktop_snapshot] ${JSON.stringify({
      args: { session_id: ROUND_TRIP_SESSION_ID },
    })}`;
    const parsed = parseDesktopGoal(goal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.tool).toBe("desktop_snapshot");
    // Byte-for-byte string identity — no trimming, no re-formatting.
    expect(parsed.args.session_id).toBe(ROUND_TRIP_SESSION_ID);
    expect(String(parsed.args.session_id).length).toBe(ROUND_TRIP_SESSION_ID.length);
  });

  it("matching session_id succeeds; a genuinely different one fails without calling the bridge", async () => {
    const secret = "sec-rt-" + Math.random().toString(36).slice(2);
    let bridgeCalls = 0;
    server = http.createServer((req, res) => {
      bridgeCalls += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { echoed: true } }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    tmpRoot = await bootFakeWindowsSession(port, secret, ROUND_TRIP_SESSION_ID);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: false });
    process.env.LOCALAPPDATA = tmpRoot;

    // Route the parsed args directly into executeDesktopTool — the exact
    // path the Helper takes after /next-intent returns the pending intent.
    const goal = `${DESKTOP_GOAL_PREFIX}desktop_snapshot] ${JSON.stringify({
      args: { session_id: ROUND_TRIP_SESSION_ID },
    })}`;
    const parsed = parseDesktopGoal(goal);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");

    const mod = await import("../helper/src/desktop.mjs?rt=" + Date.now());
    const ok = await mod.executeDesktopTool("desktop_snapshot", parsed.args, {
      run_id: "run-rt",
      intent_id: "int-rt",
      idempotency_key: "att1:seq1",
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(bridgeCalls).toBe(1);

    // Genuinely different session_id -> fail closed, bridge NOT invoked again.
    const mismatch = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: "00000000-0000-0000-0000-000000000000" },
      { run_id: "run-rt2", intent_id: "int-rt2", idempotency_key: "att1:seq1" },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error_code).toBe("DESKTOP_SESSION_MISMATCH");
    expect(bridgeCalls).toBe(1); // no additional call
  });
});
