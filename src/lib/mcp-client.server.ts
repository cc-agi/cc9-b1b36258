// Server-only helpers for talking to remote MCP servers.
// Uses the AI SDK's experimental MCP client plus @modelcontextprotocol/sdk transports.
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export type McpConnectionRow = {
  id: string;
  name: string;
  url: string;
  transport: string;
  auth_type: string;
  auth_metadata: { token?: string } | null;
};

export type OpenMcp = {
  connection: McpConnectionRow;
  client: Awaited<ReturnType<typeof experimental_createMCPClient>>;
  tools: Record<string, unknown>;
};

async function buildTransport(conn: McpConnectionRow) {
  const url = new URL(conn.url);
  const headers: Record<string, string> = {};
  if (conn.auth_type === "bearer" && conn.auth_metadata?.token) {
    headers.Authorization = `Bearer ${conn.auth_metadata.token}`;
  }
  if (conn.transport === "sse") {
    return new SSEClientTransport(url, { requestInit: { headers } });
  }
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

export async function openMcpConnections(rows: McpConnectionRow[]): Promise<OpenMcp[]> {
  const opened: OpenMcp[] = [];
  for (const conn of rows) {
    try {
      const transport = await buildTransport(conn);
      const client = await experimental_createMCPClient({ transport });
      const tools = await client.tools();
      opened.push({ connection: conn, client, tools });
    } catch (err) {
      console.error(`[mcp] failed to open ${conn.name}:`, err);
    }
  }
  return opened;
}

export async function closeMcpConnections(opened: OpenMcp[]) {
  await Promise.allSettled(opened.map((o) => o.client.close()));
}

export function mergeMcpTools(opened: OpenMcp[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const o of opened) {
    const prefix = o.connection.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
    for (const [name, tool] of Object.entries(o.tools)) {
      const key = `${prefix}__${name}`;
      merged[key] = tool;
    }
  }
  return merged;
}
