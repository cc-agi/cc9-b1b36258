// Sentinel OS Worker daemon (P0-R2c)
// - Pairs via /pair (Owner-generated one-time code, hashed server-side)
// - Heartbeats every 5s (state + CDP reachability, version)
// - Polls /claim, moves run to running, then loops:
//     /next-intent -> execute via helper/src/browser.mjs -> /step-result
//   until { kind: final | blocked | cancelled }.
// - Checks cancel-status every heartbeat AND between steps.
// SECURITY: never persists Supabase or user OAuth tokens; only worker.json (mode 0600 + icacls).
import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";
import { executeTool } from "./browser.mjs";
import { executeDesktopTool, readDesktopSessionMeta } from "./desktop.mjs";

const VERSION = "0.4.8";
const HEARTBEAT_MS = 5000;
const POLL_MS = 4000;
const CDP_URL = process.env.SENTINEL_CDP_URL || "http://127.0.0.1:9222/json/version";
const CDP_BASE = CDP_URL.replace(/\/json\/version$/, "");
const COMPUTER_NAME = hostname();

function configDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(),
      "SentinelOS",
    );
  }
  return path.join(process.env.HOME || process.cwd(), ".sentinel-os");
}

async function loadConfig() {
  const file = path.join(configDir(), "worker.json");
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.error(`[sentinel] no worker config at ${file}. Run "npm run pair" first.`);
    process.exit(2);
  }
}

async function checkCdp() {
  try {
    const res = await fetch(CDP_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, code: "CDP_HTTP_" + res.status };
    let chromeVersion = null;
    try {
      const info = await res.json();
      chromeVersion = info?.Browser ?? info?.["Browser-Version"] ?? null;
    } catch {
      /* ignore parse errors */
    }
    return { ok: true, chromeVersion };
  } catch (e) {
    return {
      ok: false,
      code: e.name === "TimeoutError" ? "CDP_CONNECT_TIMEOUT" : "CDP_UNREACHABLE",
    };
  }
}

class WorkerClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
      "x-worker-id": cfg.worker_id,
      "x-helper-version": VERSION,
    };
  }
  async post(action, body) {
    const res = await fetch(`${this.cfg.cloud_base_url}/api/worker/v1/${action}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`worker_api_${action}_failed_${res.status}: ${payload.error ?? text}`);
      err.status = res.status;
      err.body = payload;
      throw err;
    }
    return payload;
  }
  async get(action, query = {}) {
    const url = new URL(`${this.cfg.cloud_base_url}/api/worker/v1/${action}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`worker_api_${action}_failed_${res.status}`);
    return res.json();
  }
}

async function heartbeatLoop(client, state) {
  while (!state.stopping) {
    const cdp = await checkCdp();
    const desktop = await readDesktopSessionMeta();
    // P0-R5 hotfix (0.4.1): platform is bounded (max 64). Never embed a
    // JSON-stringified desktop session here or the cloud heartbeat schema
    // rejects with HTTP 400 invalid_input. Desktop visibility ships in a
    // dedicated typed heartbeat field that carries NO port and NO secret.
    const platformStr = `${platform()}/${COMPUTER_NAME}`.slice(0, 64);
    const desktopSession = desktop
      ? {
          active: Boolean(desktop.active),
          session_id: String(desktop.session_id ?? "").slice(0, 64),
          started_at: Number(desktop.started_at) || null,
          last_activity_at: Number(desktop.last_activity_at) || null,
          idle_ttl_ms: Number(desktop.idle_ttl_ms) || null,
        }
      : null;
    try {
      await client.post("heartbeat", {
        state: state.currentRunId ? "working" : "idle",
        cdp_reachable: cdp.ok,
        current_run_id: state.currentRunId,
        last_error_code: cdp.ok ? null : cdp.code,
        version: VERSION,
        platform: platformStr,
        computer_name: COMPUTER_NAME,
        chrome_version: cdp.chromeVersion ?? null,
        desktop_session: desktopSession,
      });

      state.lastHeartbeatOk = Date.now();
      // between-step cancel poll
      if (state.currentRunId) {
        try {
          const cs = await client.get("cancel-status", { run_id: state.currentRunId });
          if (cs.cancel_requested) state.cancelRequested = true;
          if (cs.lease_holder === false) {
            state.leaseLost = true;
          }
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.error("[heartbeat]", e.message);
      if (e.status === 401 || e.status === 426) {
        console.error(
          `[sentinel] ${e.status === 426 ? "helper too old" : "token rejected"} — stopping.`,
        );
        state.stopping = true;
        return;
      }
    }
    await sleep(HEARTBEAT_MS);
  }
}

async function executeRun(client, state, run) {
  state.currentRunId = run.id;
  state.cancelRequested = false;
  state.leaseLost = false;
  try {
    const cdp = await checkCdp();
    if (!cdp.ok) {
      await client.post("event", {
        run_id: run.id,
        event_type: "cdp.checked",
        payload: { reachable: false, code: cdp.code },
      });
      await client.post("block", {
        run_id: run.id,
        error_code: cdp.code,
        message: "CDP not reachable",
      });
      return;
    }
    await client.post("event", {
      run_id: run.id,
      event_type: "cdp.checked",
      payload: { reachable: true },
    });
    await client.post("event", {
      run_id: run.id,
      event_type: "run.started",
      payload: { helper_version: VERSION },
    });

    for (let i = 0; i < 40; i++) {
      if (state.stopping) return;
      if (state.cancelRequested) {
        await client.post("event", {
          run_id: run.id,
          event_type: "helper.cancelling",
          payload: {},
        });
        // Report cancelled via next-intent (Cloud will finalize)
      }
      if (state.leaseLost) {
        console.error("[sentinel] lease lost — abandoning run");
        return;
      }

      let next;
      try {
        next = await client.post("next-intent", { run_id: run.id });
      } catch (e) {
        if (e.status === 409 || e.status === 404) {
          console.error("[next-intent]", e.message);
          return;
        }
        throw e;
      }
      if (next.kind === "final") {
        console.log(`[run] ${run.id} succeeded`);
        return;
      }
      if (next.kind === "blocked") {
        console.log(`[run] ${run.id} blocked: ${next.error_code}`);
        return;
      }
      if (next.kind === "failed") {
        console.log(`[run] ${run.id} failed: ${next.error_code}`);
        return;
      }
      if (next.kind === "cancelled") {
        console.log(`[run] ${run.id} cancelled`);
        return;
      }

      if (next.kind !== "intent" || !next.intent) {
        console.error("[next-intent] unexpected response", next);
        return;
      }

      const intent = next.intent;
      await client.post("event", {
        run_id: run.id,
        event_type: "step.executing",
        payload: {
          tool: intent.tool_name,
          sequence: intent.sequence,
          idempotency_key: intent.idempotency_key,
        },
      });
      let stepResult;
      try {
        if (typeof intent.tool_name === "string" && intent.tool_name.startsWith("desktop_")) {
          stepResult = await executeDesktopTool(intent.tool_name, intent.arguments, {
            run_id: run.id,
            intent_id: intent.id,
            idempotency_key: intent.idempotency_key,
          });
        } else {
          stepResult = await executeTool(CDP_BASE, intent.tool_name, intent.arguments);
        }
      } catch (e) {
        stepResult = {
          ok: false,
          error_code: "HELPER_EXCEPTION",
          error_message: String(e?.message ?? e).slice(0, 500),
        };
      }
      await client.post("step-result", {
        intent_id: intent.id,
        run_id: run.id,
        idempotency_key: intent.idempotency_key,
        ok: stepResult.ok,
        result: stepResult.result,
        error_code: stepResult.error_code,
        error_message: stepResult.error_message,
        latency_ms: stepResult.latency_ms,
      });
      await client.post("event", {
        run_id: run.id,
        event_type: stepResult.ok ? "step.completed" : "step.failed",
        payload: {
          tool: intent.tool_name,
          sequence: intent.sequence,
          error_code: stepResult.error_code ?? null,
          error_message: stepResult.error_message ?? null,
          diagnostics: stepResult.result ?? null,
          latency_ms: stepResult.latency_ms ?? null,
        },
      });
    }
    // Loop cap safety
    await client.post("block", {
      run_id: run.id,
      error_code: "HELPER_STEP_CAP",
      message: "40 helper iterations reached",
    });
  } catch (e) {
    console.error("[run]", e.message);
    try {
      await client.post("fail", {
        run_id: run.id,
        error_code: "HELPER_EXCEPTION",
        message: e.message?.slice(0, 500),
      });
    } catch {
      /* ignore */
    }
  } finally {
    state.currentRunId = null;
  }
}

async function pollLoop(client, state) {
  while (!state.stopping) {
    try {
      await client.post("sweep").catch(() => {});
      const { run } = await client.post("claim", { lease_seconds: 120 });
      if (run) {
        console.log(`[claim] run=${run.id} goal="${(run.goal || "").slice(0, 80)}"`);
        await executeRun(client, state, run);
      } else {
        await sleep(POLL_MS);
      }
    } catch (e) {
      console.error("[poll]", e.message);
      if (e.status === 401 || e.status === 426) {
        state.stopping = true;
        return;
      }
      await sleep(POLL_MS * 2);
    }
  }
}

async function main() {
  const cfg = await loadConfig();
  console.log(
    `[sentinel-helper] v${VERSION} worker_id=${cfg.worker_id} cloud=${cfg.cloud_base_url}`,
  );
  const client = new WorkerClient(cfg);
  const state = {
    stopping: false,
    currentRunId: null,
    cancelRequested: false,
    leaseLost: false,
    lastHeartbeatOk: 0,
  };
  process.on("SIGINT", () => {
    state.stopping = true;
    console.log("\n[sentinel] shutting down");
  });
  process.on("SIGTERM", () => {
    state.stopping = true;
  });
  await Promise.all([heartbeatLoop(client, state), pollLoop(client, state)]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
