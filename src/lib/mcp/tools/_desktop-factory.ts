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
  // P0-R6.1 — Unwrap ZodEffects (from .refine()) to reach the underlying
  // ZodObject shape so mcp-js publishes a real JSON Schema. Without this,
  // `.refine()`-wrapped schemas (e.g. desktop_launch) expose no `.shape`
  // and end up with `inputSchema: null`, which strict MCP clients (ChatGPT)
  // reject — silently dropping ALL desktop_* tools from tools/list.
  const refined = d.input as unknown as z.ZodTypeAny;
  const objectSchema = (
    refined instanceof z.ZodEffects ? refined._def.schema : refined
  ) as z.ZodObject<z.ZodRawShape>;
  if (!objectSchema || typeof (objectSchema as { shape?: unknown }).shape !== "object") {
    throw new Error(
      `[desktop-factory] descriptor '${name}' input schema does not resolve to a ZodObject (got ${refined?.constructor?.name}).`,
    );
  }
  return defineTool({
    name: d.name,
    title: d.title,
    description: d.description,
    // Feed the raw shape so mcp-js publishes a real JSON Schema.
    inputSchema: objectSchema.shape,
    annotations: {
      readOnlyHint: d.readOnly,
      destructiveHint: d.destructive,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (rawArgs: unknown, ctx: ToolContext) => {
      if (!ctx.isAuthenticated())
        return { content: [{ type: "text", text: "Not authenticated" }], isError: true };

      // Validate against the REFINED schema so refinements like
      // "exactly one of app_id/app_path" still apply at runtime.
      const parsed = refined.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: JSON.stringify(parsed.error.issues) }],
          isError: true,
        };
      }
      const args = parsed.data as Record<string, unknown>;

      const sb = supabaseForUser(ctx);

      // Pre-flight: require a live Helper heartbeat AND active Desktop Session.
      // Uses the typed `desktop_session_active` column (0.4.1). Falls back to
      // the legacy `platform.includes("desktop-session:")` marker only when the
      // column has never been populated (untyped select to survive pre-regen).
      const cutoff = new Date(Date.now() - 10_000).toISOString();
      const { data: aliveRaw } = await sb
        .from("worker_heartbeats")
        .select("worker_id,platform,last_seen_at,desktop_session_active,desktop_session_id" as "*")
        .gte("last_seen_at", cutoff)
        .limit(1)
        .maybeSingle();
      const alive = aliveRaw as {
        worker_id: string;
        platform: string | null;
        desktop_session_active?: boolean | null;
        desktop_session_id?: string | null;
      } | null;

      let status: "queued" | "blocked" = "queued";
      let error_code: string | null = null;
      let last_error: string | null = null;
      const desktopActive =
        alive?.desktop_session_active === true ||
        (typeof alive?.platform === "string" && alive.platform.includes("desktop-session:"));
      if (!alive) {
        status = "blocked";
        error_code = "WORKER_OFFLINE";
        last_error = "No local Sentinel Helper heartbeat within 10s. Start the Helper and retry.";
      } else if (!desktopActive) {
        status = "blocked";
        error_code = "DESKTOP_SESSION_INACTIVE";
        last_error =
          "Helper is online but no active Desktop Operator Session. Run start-desktop-operator.bat on the paired machine.";
      }

      const goalMeta = {
        kind: "desktop",
        tool: d.name,
        args, // raw args are required by orchestrator to emit a desktop intent
        args_redacted: redactDesktopArgs(d.name, args),
        session_id: (args as { session_id?: string }).session_id ?? null,
        idempotency_key: (args as { idempotency_key?: string }).idempotency_key ?? null,
      };

      const { data: run, error } = await sb
        .from("agent_runs")
        .insert({
          user_id: ctx.getUserId(),
          goal: `[DESKTOP:${d.name}] ${JSON.stringify(goalMeta).slice(0, 3800)}`,
          status,
          error_code,
          last_error,
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
