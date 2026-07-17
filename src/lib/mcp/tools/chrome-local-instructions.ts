import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { ensureOwnerOrError } from "./_supabase";

export default defineTool({
  name: "chrome_local_instructions",
  title: "Chrome / Playwright local instructions",
  description:
    "Explains how to drive the user's local Chrome via the Sentinel Helper (127.0.0.1:9223) and Playwright over CDP (127.0.0.1:9222). The MCP server runs in the cloud and cannot reach the user's machine directly; this tool returns copy-pasteable guidance the assistant can relay.",
  inputSchema: {
    goal: z.string().optional().describe("Optional: what the user wants Chrome to do."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ goal }, ctx) => {
    const denied = ensureOwnerOrError(ctx);
    if (denied) return denied;
    const text = [
      "Sentinel OS Chrome automation runs on the USER'S local machine — the MCP server cannot connect to it over the internet.",
      "",
      "Prerequisites (user must do these locally):",
      "1. Run the Sentinel Helper (docs/sentinel-helper) — it listens on http://127.0.0.1:9223.",
      "2. POST http://127.0.0.1:9223/launch to start Chrome with --remote-debugging-port=9222 and a dedicated user-data-dir.",
      "3. Verify http://127.0.0.1:9222/json/version returns a Browser + webSocketDebuggerUrl.",
      "",
      "Then Playwright (running locally) connects with:",
      "  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');",
      "",
      "Preferred workflow via this MCP:",
      "- Use `create_agent_run` with a natural-language goal describing the browser task.",
      "- The user's Sentinel OS console (web app) picks up the run and executes it against local Chrome.",
      "- Poll with `get_agent_run` / `list_agent_events` for progress and results.",
      goal ? `\nSuggested goal to queue: ${goal}` : "",
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
});
