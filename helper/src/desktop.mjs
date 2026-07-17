// Sentinel Helper — Desktop Operator client (P0-R5).
// Node bridge that forwards desktop_* intents to the local loopback
// PowerShell bridge started by start-desktop-operator.bat.
//
// The bridge listens on 127.0.0.1:<port> and authenticates every request with
// a per-session bearer secret written to %LOCALAPPDATA%\SentinelOS\desktop-session.json
// (mode 0600 + icacls). Cloud never sees the port or the secret.
//
// This module is import-safe on non-Windows (returns DESKTOP_SESSION_INACTIVE).
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fetch } from "undici";

function sessionFilePath() {
  if (process.platform !== "win32") return null;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA;
  if (!base) return null;
  return path.join(base, "SentinelOS", "desktop-session.json");
}

async function readSession() {
  const p = sessionFilePath();
  if (!p) return null;
  try {
    const raw = await readFile(p, "utf8");
    // Defense in depth: strip a leading UTF-8 BOM if a legacy writer emitted one.
    // JSON.parse throws on U+FEFF; without this a BOM-encoded session file would
    // silently produce DESKTOP_SESSION_INACTIVE even when the bridge is ACTIVE.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!parsed?.port || !parsed?.secret || !parsed?.session_id) return null;
    return parsed;
  } catch {
    return null;
  }
}


// Cached read of the desktop session for the heartbeat advertiser.
// Returns a compact meta struct suitable to embed in the heartbeat's
// `platform` field with the `desktop-session:` marker.
export async function readDesktopSessionMeta() {
  const s = await readSession();
  if (!s) return null;
  return {
    session_id: s.session_id,
    started_at: s.started_at ?? Date.now(),
    last_activity_at: s.last_activity_at ?? Date.now(),
    idle_ttl_ms: s.idle_ttl_ms ?? 30 * 60 * 1000,
    active: true,
    worker_id: s.worker_id ?? "",
    log_path: s.log_path ?? "",
  };
}

export async function executeDesktopTool(toolName, args) {
  const started = Date.now();
  const session = await readSession();
  if (!session) {
    return {
      ok: false,
      error_code: "DESKTOP_SESSION_INACTIVE",
      error_message: "No Desktop Operator Session. Run start-desktop-operator.bat on this machine.",
      latency_ms: Date.now() - started,
    };
  }
  if (args?.session_id && args.session_id !== session.session_id) {
    return {
      ok: false,
      error_code: "DESKTOP_SESSION_MISMATCH",
      error_message: "Provided session_id does not match the active local session.",
      latency_ms: Date.now() - started,
    };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${session.port}/v1/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.secret}`,
      },
      body: JSON.stringify({ tool: toolName, args }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {
        ok: false,
        error_code: "DESKTOP_BRIDGE_BAD_RESPONSE",
        error_message: text?.slice(0, 200) ?? "",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error_code: payload.error_code ?? `DESKTOP_BRIDGE_HTTP_${res.status}`,
        error_message: payload.error_message ?? "bridge error",
        latency_ms: Date.now() - started,
      };
    }
    return {
      ok: Boolean(payload.ok),
      result: payload.result ?? payload,
      error_code: payload.error_code,
      error_message: payload.error_message,
      latency_ms: Date.now() - started,
    };
  } catch (e) {
    const timeout = e?.name === "TimeoutError";
    return {
      ok: false,
      error_code: timeout ? "DESKTOP_BRIDGE_TIMEOUT" : "DESKTOP_BRIDGE_UNREACHABLE",
      error_message: String(e?.message ?? e).slice(0, 200),
      latency_ms: Date.now() - started,
    };
  }
}
