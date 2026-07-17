// Sentinel OS Worker daemon (P0-R2b)
// - Loads pairing token from %LOCALAPPDATA%\SentinelOS\worker.json (or ~/.sentinel-os on POSIX)
// - Heartbeats every 5s (state + CDP reachability)
// - Polls /claim, executes step intents (TODO: full orchestrator wiring),
//   reports events, finalizes success/fail/block.
//
// SECURITY: never persists Supabase service_role or user OAuth token.
// The only long-lived credential is the Worker Token issued by /api/worker/v1/pair.
import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";

const VERSION = "0.3.0";
const HEARTBEAT_MS = 5000;
const POLL_MS = 4000;
const CDP_URL = process.env.SENTINEL_CDP_URL || "http://127.0.0.1:9222/json/version";

function configDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "SentinelOS");
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
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.name === "TimeoutError" ? "CDP_CONNECT_TIMEOUT" : "CDP_UNREACHABLE" };
  }
}

class WorkerClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.headers = {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.token}`,
      "x-worker-id": cfg.worker_id,
    };
  }
  async post(action, body) {
    const res = await fetch(`${this.cfg.cloud_base_url}/api/worker/v1/${action}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`worker_api_${action}_failed_${res.status}: ${json.error ?? text}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
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
    try {
      await client.post("heartbeat", {
        state: state.currentRunId ? "working" : "idle",
        cdp_reachable: cdp.ok,
        current_run_id: state.currentRunId,
        last_error_code: cdp.ok ? null : cdp.code,
        version: VERSION,
        platform: `${platform()}/${hostname()}`,
      });
      state.lastHeartbeatOk = Date.now();
    } catch (e) {
      console.error("[heartbeat]", e.message);
      if (e.status === 401) {
        console.error("[sentinel] token rejected — stopping. Re-run 'npm run pair'.");
        state.stopping = true;
        return;
      }
    }
    await sleep(HEARTBEAT_MS);
  }
}

/**
 * Execute one claimed run.
 * Placeholder for the full Cloud orchestrator handoff (step_intents / step_results).
 * Until the Cloud-side orchestrator is wired to emit step intents for the goal,
 * we honestly BLOCK the run with NOT_IMPLEMENTED_ORCHESTRATOR_WIRING so the Owner
 * knows the pipeline isn't complete. Never fake succeeded.
 */
async function executeRun(client, state, run) {
  state.currentRunId = run.id;
  try {
    // Preflight CDP
    const cdp = await checkCdp();
    if (!cdp.ok) {
      await client.post("event", {
        run_id: run.id, event_type: "cdp.checked",
        payload: { reachable: false, code: cdp.code },
      });
      await client.post("block", { run_id: run.id, error_code: cdp.code, message: "CDP not reachable" });
      return;
    }
    await client.post("event", { run_id: run.id, event_type: "cdp.checked", payload: { reachable: true } });
    await client.post("event", { run_id: run.id, event_type: "run.started", payload: { helper_version: VERSION } });

    // Poll cancel-status while (in the real orchestrator) driving step_intents.
    // For now we block explicitly.
    await client.post("event", {
      run_id: run.id, event_type: "helper.notice",
      payload: { message: "Cloud orchestrator step-intent bridge is not yet enabled." },
    });
    await client.post("block", {
      run_id: run.id,
      error_code: "NOT_IMPLEMENTED_ORCHESTRATOR_WIRING",
      message: "Helper paired and CDP OK; awaiting Cloud step-intent bridge.",
    });
  } catch (e) {
    console.error("[run]", e.message);
    try {
      await client.post("fail", {
        run_id: run.id,
        error_code: "HELPER_EXCEPTION",
        message: e.message?.slice(0, 500),
      });
    } catch { /* ignore */ }
  } finally {
    state.currentRunId = null;
  }
}

async function pollLoop(client, state) {
  while (!state.stopping) {
    try {
      // Opportunistic sweep to keep queued/running clean
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
      await sleep(POLL_MS * 2);
    }
  }
}

async function main() {
  const cfg = await loadConfig();
  console.log(`[sentinel-helper] v${VERSION} worker_id=${cfg.worker_id} cloud=${cfg.cloud_base_url}`);
  const client = new WorkerClient(cfg);
  const state = { stopping: false, currentRunId: null, lastHeartbeatOk: 0 };
  process.on("SIGINT", () => { state.stopping = true; console.log("\n[sentinel] shutting down"); });
  process.on("SIGTERM", () => { state.stopping = true; });
  await Promise.all([heartbeatLoop(client, state), pollLoop(client, state)]);
}

main().catch((e) => { console.error(e); process.exit(1); });
