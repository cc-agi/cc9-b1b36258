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
    "Sentinel OS is an autonomous-agent control console. All tools act as the signed-in user under RLS. Modules: identity (`whoami`); MCP connections (`list_mcp_connections`, `create_mcp_connection`, `update_mcp_connection`, `delete_mcp_connection`); tasks / agent runs (`list_agent_runs`, `get_agent_run`, `create_agent_run`, `update_agent_run`, `delete_agent_run`); agent events (`list_agent_events`, `append_agent_event`); imported resources / skills / plugins (`list_imported_resources`, `upsert_imported_resource`, `delete_imported_resource`); local Chrome / Playwright driving (`chrome_local_instructions` — the browser runs on the user's machine, not in this server).",
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
    deleteAgentRunTool,
    listAgentEventsTool,
    appendAgentEventTool,
    listImportedResourcesTool,
    upsertImportedResourceTool,
    deleteImportedResourceTool,
    chromeLocalInstructionsTool,
  ],
});

