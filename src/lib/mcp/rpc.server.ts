import { CC6, assertAllowedServerUrl } from "./config";
import { loadAccessToken } from "./connections.server";

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

// Session id per user cached in-memory. Workers are stateless so this only
// helps within a single warm instance — losing it just means one extra
// initialize call.
const sessionByUser = new Map<string, string>();

async function mcpFetch(params: {
  userId: string;
  message: object;
  sessionId?: string;
}): Promise<{ body: JsonRpcResponse; sessionId?: string }> {
  assertAllowedServerUrl(CC6.serverUrl);
  const token = await loadAccessToken(params.userId);
  if (!token) throw new Error("Not connected to cc6");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // MCP Streamable HTTP spec: server rejects (406) without both types.
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (params.sessionId) headers["Mcp-Session-Id"] = params.sessionId;

  const res = await fetch(CC6.serverUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(params.message),
    redirect: "error",
  });
  const respSessionId = res.headers.get("mcp-session-id") ?? undefined;

  if (res.status === 401) throw new Error("cc6 access token rejected (401). Please reconnect.");
  if (!res.ok) throw new Error(`cc6 MCP HTTP ${res.status}: ${await res.text()}`);

  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  let body: JsonRpcResponse;
  if (ct.includes("text/event-stream")) {
    // Take the first `data:` line as the JSON-RPC response.
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`cc6 MCP empty SSE response`);
    body = JSON.parse(line.slice(5).trim());
  } else {
    body = JSON.parse(raw);
  }
  return { body, sessionId: respSessionId };
}

async function ensureSession(userId: string): Promise<string | undefined> {
  const existing = sessionByUser.get(userId);
  if (existing) return existing;
  const init = await mcpFetch({
    userId,
    message: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Sentinel OS", version: "0.1.0" },
      },
    },
  });
  if (init.body.error) throw new Error(`initialize failed: ${init.body.error.message}`);
  if (init.sessionId) sessionByUser.set(userId, init.sessionId);
  // Some servers require the initialized notification before other calls.
  try {
    await mcpFetch({
      userId,
      sessionId: init.sessionId,
      message: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
  } catch {
    // Notification failures are non-fatal.
  }
  return init.sessionId;
}

export async function listTools(userId: string) {
  const sessionId = await ensureSession(userId);
  const { body } = await mcpFetch({
    userId,
    sessionId,
    message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  if (body.error) throw new Error(body.error.message);
  return (
    (
      body.result as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
      }
    )?.tools ?? []
  );
}

export async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const sessionId = await ensureSession(userId);
  const { body } = await mcpFetch({
    userId,
    sessionId,
    message: {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export function clearSession(userId: string) {
  sessionByUser.delete(userId);
}
