import { auth, defineMcp } from "@lovable.dev/mcp-js";

import whoamiTool from "./tools/whoami";
import listMcpConnectionsTool from "./tools/list-mcp-connections";
import createMcpConnectionTool from "./tools/create-mcp-connection";
import updateMcpConnectionTool from "./tools/update-mcp-connection";
import deleteMcpConnectionTool from "./tools/delete-mcp-connection";
import listAgentRunsTool from "./tools/list-agent-runs";
import getAgentRunTool from "./tools/get-agent-run";
import createAgentRunTool from "./tools/create-agent-run";
import updateAgentRunTool from "./tools/update-agent-run";
import claimAgentRunTool from "./tools/claim-agent-run";
import heartbeatAgentRunTool from "./tools/heartbeat-agent-run";
import deleteAgentRunTool from "./tools/delete-agent-run";
import listAgentEventsTool from "./tools/list-agent-events";
import appendAgentEventTool from "./tools/append-agent-event";
import listImportedResourcesTool from "./tools/list-imported-resources";
import upsertImportedResourceTool from "./tools/upsert-imported-resource";
import deleteImportedResourceTool from "./tools/delete-imported-resource";
import chromeLocalInstructionsTool from "./tools/chrome-local-instructions";

const projectRef =
  import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "sentinel-os-mcp",
  title: "Sentinel OS",
  version: "0.2.0",
  instructions:
    "Sentinel OS is an autonomous-agent control console. All tools act as the signed-in user under RLS. Modules: identity (`whoami`); MCP connections (`list_mcp_connections`, `create_mcp_connection`, `update_mcp_connection`, `delete_mcp_connection`) — URLs are returned redacted (`***` for API keys / tokens in query strings); tasks / agent runs lifecycle (`list_agent_runs`, `get_agent_run`, `create_agent_run` → queued, `claim_agent_run` → running with lease, `heartbeat_agent_run` every 30-60s to extend the lease, `update_agent_run` to finalize succeeded/failed/cancelled — which auto-clears the lease); stale queued/running runs are swept automatically (no worker within 5 minutes → failed; heartbeat gap > 2 minutes → retried up to `max_attempts`, else failed); agent events (`list_agent_events`, `append_agent_event`); imported resources / skills / plugins (`list_imported_resources`, `upsert_imported_resource`, `delete_imported_resource`); local Chrome / Playwright driving (`chrome_local_instructions` — the browser runs on the user's machine, not in this server).",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    whoamiTool,
    listMcpConnectionsTool,
    createMcpConnectionTool,
    updateMcpConnectionTool,
    deleteMcpConnectionTool,
    listAgentRunsTool,
    getAgentRunTool,
    createAgentRunTool,
    updateAgentRunTool,
    claimAgentRunTool,
    heartbeatAgentRunTool,
    deleteAgentRunTool,
    listAgentEventsTool,
    appendAgentEventTool,
    listImportedResourcesTool,
    upsertImportedResourceTool,
    deleteImportedResourceTool,
    chromeLocalInstructionsTool,
  ],
});

