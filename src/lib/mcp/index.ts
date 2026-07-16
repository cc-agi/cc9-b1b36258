import { auth, defineMcp } from "@lovable.dev/mcp-js";

import whoamiTool from "./tools/whoami";
import listMcpConnectionsTool from "./tools/list-mcp-connections";
import listAgentRunsTool from "./tools/list-agent-runs";
import getAgentRunTool from "./tools/get-agent-run";
import createAgentRunTool from "./tools/create-agent-run";
import listImportedResourcesTool from "./tools/list-imported-resources";

// OAuth issuer MUST be the direct Supabase host — the runtime SUPABASE_URL is
// the .lovable.cloud proxy, which mcp-js rejects (RFC 8414 issuer mismatch).
// VITE_SUPABASE_PROJECT_ID is inlined at build time by Vite.
const projectRef =
  import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "sentinel-os-mcp",
  title: "Sentinel OS",
  version: "0.1.0",
  instructions:
    "Sentinel OS is an autonomous-agent control console. Use `whoami` to confirm the connection, `list_mcp_connections` / `list_imported_resources` to see the user's saved integrations, `list_agent_runs` / `get_agent_run` to inspect activity, and `create_agent_run` to queue a new task by natural-language goal.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    whoamiTool,
    listMcpConnectionsTool,
    listAgentRunsTool,
    getAgentRunTool,
    createAgentRunTool,
    listImportedResourcesTool,
  ],
});
