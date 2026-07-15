// Server-only helpers for talking to remote MCP servers.
// Wraps @modelcontextprotocol/sdk into AI SDK v7 tool objects.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { tool, jsonSchema, type ToolSet } from "ai";

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
  client: Client;
  tools: ToolSet;
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

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24) || "mcp";
}

export async function openMcpConnection(conn: McpConnectionRow): Promise<OpenMcp> {
  const transport = await buildTransport(conn);
  const client = new Client(
    { name: "sentinel-os", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  const listed = await client.listTools();
  const prefix = safeName(conn.name);
  const tools: ToolSet = {};
  for (const t of listed.tools) {
    const key = `${prefix}__${t.name}`;
    tools[key] = tool({
      description: t.description ?? `${conn.name} · ${t.name}`,
      inputSchema: jsonSchema((t.inputSchema as object) ?? { type: "object", properties: {} }),
      execute: async (args) => {
        const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> });
        return result;
      },
    });
  }
  return { connection: conn, client, tools };
}

export async function openMcpConnections(rows: McpConnectionRow[]): Promise<OpenMcp[]> {
  const results = await Promise.allSettled(rows.map((r) => openMcpConnection(r)));
  const opened: OpenMcp[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") opened.push(r.value);
    else console.error(`[mcp] failed to open ${rows[i].name}:`, r.reason);
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
