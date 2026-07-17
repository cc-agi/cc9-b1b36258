import { auth, defineMcp } from "@lovable.dev/mcp-js";

import whoamiTool from "./tools/whoami";
import getVersionTool from "./tools/get-version";
import listMcpConnectionsTool from "./tools/list-mcp-connections";
import createMcpConnectionTool from "./tools/create-mcp-connection";
import updateMcpConnectionTool from "./tools/update-mcp-connection";
import deleteMcpConnectionTool from "./tools/delete-mcp-connection";
import listAgentRunsTool from "./tools/list-agent-runs";
import getAgentRunTool from "./tools/get-agent-run";
import createAgentRunTool from "./tools/create-agent-run";
import updateAgentRunTool from "./tools/update-agent-run";
import retryAgentRunTool from "./tools/retry-agent-run";
import cancelAgentRunTool from "./tools/cancel-agent-run";
import deleteAgentRunTool from "./tools/delete-agent-run";
import getWorkerHealthTool from "./tools/get-worker-health";
import listAgentEventsTool from "./tools/list-agent-events";
import appendAgentEventTool from "./tools/append-agent-event";
import listImportedResourcesTool from "./tools/list-imported-resources";
import upsertImportedResourceTool from "./tools/upsert-imported-resource";
import deleteImportedResourceTool from "./tools/delete-imported-resource";
import chromeLocalInstructionsTool from "./tools/chrome-local-instructions";
// P0-R5 Desktop Operator tools
import desktopSnapshotTool from "./tools/desktop/snapshot";
import desktopListWindowsTool from "./tools/desktop/list-windows";
import desktopInspectTool from "./tools/desktop/inspect";
import desktopFocusWindowTool from "./tools/desktop/focus-window";
import desktopClickTool from "./tools/desktop/click";
import desktopTypeTool from "./tools/desktop/type";
import desktopPressTool from "./tools/desktop/press";
import desktopHotkeyTool from "./tools/desktop/hotkey";
import desktopScrollTool from "./tools/desktop/scroll";
import desktopDragTool from "./tools/desktop/drag";
import desktopClipboardTool from "./tools/desktop/clipboard";
import desktopLaunchTool from "./tools/desktop/launch";
import desktopWaitTool from "./tools/desktop/wait";
import { MCP_CODE_VERSION } from "./version";

const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

// NOTE: claim_agent_run / heartbeat_agent_run / register_worker_heartbeat
// 已从外部 MCP manifest 中移除。它们是本地 Sentinel Helper 独占的 Worker RPC，
// 通过配对后的 Worker Token 走独立路由调用，禁止外部 AI (ChatGPT/Claude) 触碰。
export default defineMcp({
  name: "sentinel-os-mcp",
  title: "Sentinel OS",
  version: MCP_CODE_VERSION,
  instructions:
    "Sentinel OS is an autonomous-agent control console. All tools act as the signed-in user under RLS. External AI clients (ChatGPT / Claude) should ONLY use: `create_agent_run`, `list_agent_runs`, `get_agent_run`, `retry_agent_run`, `cancel_agent_run`, `get_worker_health`, `get_version`, plus MCP-connection / imported-resource management. Actual execution is done by the Owner's local Sentinel Helper — Worker RPCs (claim / heartbeat) are not exposed here. Runs may be created as `blocked` with `error_code=WORKER_OFFLINE` when no Helper is running; call `get_worker_health` to check and `retry_agent_run` after the Helper is back. MCP connection URLs are always returned redacted; credentials live in a server-side encrypted secret store.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    whoamiTool,
    getVersionTool,
    // MCP 连接
    listMcpConnectionsTool,
    createMcpConnectionTool,
    updateMcpConnectionTool,
    deleteMcpConnectionTool,
    // Agent runs (Owner-facing)
    listAgentRunsTool,
    getAgentRunTool,
    createAgentRunTool,
    updateAgentRunTool, // terminal reporting only
    retryAgentRunTool,
    cancelAgentRunTool,
    deleteAgentRunTool,
    getWorkerHealthTool,
    // Agent events
    listAgentEventsTool,
    appendAgentEventTool,
    // Imported resources
    listImportedResourcesTool,
    upsertImportedResourceTool,
    deleteImportedResourceTool,
    // Local Chrome guidance
    chromeLocalInstructionsTool,
    // P0-R5 Desktop Operator (require an active local DesktopOperatorSession)
    desktopSnapshotTool,
    desktopListWindowsTool,
    desktopInspectTool,
    desktopFocusWindowTool,
    desktopClickTool,
    desktopTypeTool,
    desktopPressTool,
    desktopHotkeyTool,
    desktopScrollTool,
    desktopDragTool,
    desktopClipboardTool,
    desktopLaunchTool,
    desktopWaitTool,
  ],
});
