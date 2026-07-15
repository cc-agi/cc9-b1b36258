/**
 * Hard-coded target: cc6 MCP server.
 * URL allowlist enforced everywhere we do a network call.
 */
export const CC6 = {
  serverId: "cc6",
  name: "cc6",
  serverUrl: "https://qjihfiixqkfjaxelfuia.supabase.co/functions/v1/mcp",
  issuer: "https://qjihfiixqkfjaxelfuia.supabase.co/auth/v1",
  clientName: "Sentinel OS",
  // Requested scopes — Supabase Auth doesn't use OAuth scopes, but DCR
  // needs the field present.
  scope: "openid",
} as const;

export function assertAllowedServerUrl(url: string) {
  if (url !== CC6.serverUrl) {
    throw new Error(`MCP server URL not allowed: ${url}`);
  }
}
