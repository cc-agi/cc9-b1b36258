import { defineTool } from "@lovable.dev/mcp-js";
import { supabaseForUser } from "./_supabase";

export default defineTool({
  name: "get_worker_health",
  title: "Get worker health",
  description:
    "Report the caller's local Sentinel Helper worker status: last heartbeat, state, CDP reachability, current run, last error code. A worker with `last_seen_at` older than 10 seconds is considered offline — new runs will be created as `blocked / WORKER_OFFLINE`.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated())
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    const { data, error } = await supabaseForUser(ctx)
      .from("worker_heartbeats")
      .select("worker_id,version,platform,state,cdp_reachable,current_run_id,last_error_code,last_seen_at")
      .order("last_seen_at", { ascending: false });
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    const now = Date.now();
    const workers = (data ?? []).map((w) => ({
      ...w,
      age_seconds: Math.round((now - new Date(w.last_seen_at).getTime()) / 1000),
      online: now - new Date(w.last_seen_at).getTime() < 10_000,
    }));
    const any_online = workers.some((w) => w.online);
    return {
      content: [{ type: "text", text: JSON.stringify({ any_online, workers }) }],
      structuredContent: { any_online, workers },
    };
  },
});
