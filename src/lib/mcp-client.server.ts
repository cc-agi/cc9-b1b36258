// Server-only helpers for talking to remote MCP servers.
// P0-R2b: 从 mcp_connection_secrets 组合凭据，禁止读取 mcp_connections.url 明文；
// rotation_required / 缺失 secret 一律拒绝连接。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool, jsonSchema, type ToolSet } from "ai";
import { readConnectionSecret } from "./mcp/secrets.server";
import { redactMcpUrl } from "./mcp/redact";

export type McpConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  url?: string | null; // legacy — 忽略
  base_url?: string | null;
  secret_ref?: string | null;
  has_credentials?: boolean;
  rotation_required?: boolean;
  disabled_reason?: string | null;
  transport: string;
  auth_type: string;
  auth_metadata: { token?: string; ciphertext?: string } | null;
};

export type OpenMcp = {
  connection: { id: string; name: string; base_url: string; transport: string };
  client: Client;
  tools: ToolSet;
};

async function resolveEffectiveUrlAndHeaders(
  conn: McpConnectionRow,
): Promise<{ url: URL; headers: Record<string, string> }> {
  if (conn.rotation_required || conn.disabled_reason) {
    throw new Error(
      `mcp_connection_disabled: ${conn.disabled_reason ?? "rotation_required"} (id=${conn.id})`,
    );
  }
  const base = conn.base_url ?? conn.url;
  if (!base) throw new Error(`mcp_connection_missing_base_url: id=${conn.id}`);

  let effectiveUrlStr = base;
  const headers: Record<string, string> = {};

  if (conn.has_credentials) {
    if (!conn.secret_ref) {
      throw new Error(`mcp_connection_secret_missing: id=${conn.id}`);
    }
    const secret = await readConnectionSecret(conn.user_id, conn.id, conn.secret_ref);
    if (!secret) {
      throw new Error(`mcp_connection_secret_unreadable: id=${conn.id}`);
    }
    if (secret.full_url) effectiveUrlStr = secret.full_url;
    if (secret.headers) Object.assign(headers, secret.headers);
  }

  // legacy bearer support (only when has_credentials=false + auth_metadata.token)
  if (conn.auth_type === "bearer" && conn.auth_metadata?.token && !headers.Authorization) {
    headers.Authorization = `Bearer ${conn.auth_metadata.token}`;
  }

  return { url: new URL(effectiveUrlStr), headers };
}

async function buildTransport(url: URL, headers: Record<string, string>, transport: string) {
  if (transport === "sse") {
    return new SSEClientTransport(url, { requestInit: { headers } });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

function safeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .slice(0, 24) || "mcp"
  );
}

export async function openMcpConnection(conn: McpConnectionRow): Promise<OpenMcp> {
  const { url, headers } = await resolveEffectiveUrlAndHeaders(conn);
  const transport = await buildTransport(url, headers, conn.transport);
  const client = new Client({ name: "sentinel-os", version: "0.3.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
  } finally {
    // 严禁把 headers/url 明文写日志。
    // 只保留脱敏 base_url 用于诊断。
  }

  const listed = await client.listTools();
  const prefix = safeName(conn.name);
  const tools: ToolSet = {};
  for (const t of listed.tools) {
    const key = `${prefix}__${t.name}`;
    tools[key] = tool({
      description: t.description ?? `${conn.name} · ${t.name}`,
      inputSchema: jsonSchema((t.inputSchema as object) ?? { type: "object", properties: {} }),
      execute: async (args) => {
        const result = await client.callTool({
          name: t.name,
          arguments: args as Record<string, unknown>,
        });
        return result;
      },
    });
  }
  return {
    connection: {
      id: conn.id,
      name: conn.name,
      base_url: redactMcpUrl(conn.base_url ?? conn.url ?? ""),
      transport: conn.transport,
    },
    client,
    tools,
  };
}

export async function openMcpConnections(rows: McpConnectionRow[]): Promise<OpenMcp[]> {
  const results = await Promise.allSettled(rows.map((r) => openMcpConnection(r)));
  const opened: OpenMcp[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") opened.push(r.value);
    else {
      // 仅记录连接 id + 错误 code，不写 headers/url
      console.error(
        `[mcp] failed to open connection id=${rows[i].id}: ${String((r.reason as Error)?.message ?? r.reason)}`,
      );
    }
  });
  return opened;
}

export async function closeMcpConnections(opened: OpenMcp[]) {
  await Promise.allSettled(opened.map((o) => o.client.close()));
}

export function mergeMcpTools(opened: OpenMcp[]): ToolSet {
  const merged: ToolSet = {};
  for (const o of opened) Object.assign(merged, o.tools);
  return merged;
}
