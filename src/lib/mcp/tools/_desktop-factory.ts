/**
 * P0-R5 — Factory that turns a DESKTOP_TOOLS descriptor into a defineTool
 * whose handler queues a single-intent Sentinel agent run.
 *
 * The MCP surface is user-facing: ChatGPT/Claude call desktop_* directly.
 * Under the hood we reuse the existing agent-run pipeline so idempotency,
 * lease renewal, cancel semantics, and audit come for free.
 */
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "./_supabase";
import { getDesktopToolDescriptor, type DesktopToolName } from "@/lib/desktop/schemas";
import { redactDesktopArgs } from "@/lib/desktop/redact";

export function makeDesktopTool(name: DesktopToolName) {
  const d = getDesktopToolDescriptor(name);
  const input = d.input as unknown as z.ZodObject<z.ZodRawShape>;
  return defineTool({
    name: d.name,
    title: d.title,
    description: d.description,
    // Feed the raw shape so mcp-js publishes the schema.
    inputSchema: input.shape,
    annotations: {
      readOnlyHint: d.readOnly,
      destructiveHint: d.destructive,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (rawArgs: unknown, ctx: ToolContext) => {
      if (!ctx.isAuthenticated())
        return { content: [{ type: "text", text: "Not authenticated" }], isError: true };

      const parsed = input.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify(parsed.error.issues) }],
          isError: true,
        };
      }
      const args = parsed.data as Record<string, unknown>;

      const sb = supabaseForUser(ctx);

      // Pre-flight: require a live Helper heartbeat.
      const cutoff = new Date(Date.now() - 10_000).toISOString();
      const { data: alive } = await sb
        .from("worker_heartbeats")
        .select("worker_id,platform,last_seen_at")
        .gte("last_seen_at", cutoff)
        .limit(1)
        .maybeSingle();

      let status: "queued" | "blocked" = "queued";
      let error_code: string | null = null;
      let last_error: string | null = null;
      if (!alive) {
        status = "blocked";
        error_code = "WORKER_OFFLINE";
        last_error =
          "No local Sentinel Helper heartbeat within 10s. Start the Helper and retry.";
      } else if (typeof alive.platform === "string" && !alive.platform.includes("desktop-session:")) {
        status = "blocked";
        error_code = "DESKTOP_SESSION_INACTIVE";
        last_error =
          "Helper is online but no active Desktop Operator Session. Run start-desktop-operator.bat on the paired machine.";
      }

      const goalMeta = {
        kind: "desktop",
        tool: d.name,
        args_redacted: redactDesktopArgs(d.name, args),
        session_id: (args as { session_id?: string }).session_id ?? null,
        idempotency_key: (args as { idempotency_key?: string }).idempotency_key ?? null,
      };
      const { data: run, error } = await sb
        .from("agent_runs")
        .insert({
          user_id: ctx.getUserId(),
          goal: `[DESKTOP] ${d.name}`,
          status,
          error_code,
          last_error,
          input_payload: goalMeta,
        })
        .select("id,goal,status,error_code,last_error,created_at")
        .single();
      if (error) return { content: [{ type: "text", text: error.message }], isError: true };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ run, tool: d.name, blocked: status === "blocked" }),
          },
        ],
        structuredContent: { run, tool: d.name, args_redacted: goalMeta.args_redacted },
      };
    },
  });
}
