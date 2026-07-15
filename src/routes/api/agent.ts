import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, stepCountIs, type UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import {
  openMcpConnections,
  closeMcpConnections,
  mergeMcpTools,
  type McpConnectionRow,
} from "@/lib/mcp-client.server";

type ChatBody = {
  messages?: UIMessage[];
  connectionIds?: string[];
  model?: string;
};

const LOVABLE_MODEL_PREFIXES = ["google/", "openai/"];


const SYSTEM = `你是 SENTINEL — 一个完全自主的桌面控制 Agent。
你的宿主是一台需要你远程操作以完成用户目标的计算机。
你通过 MCP 工具（浏览器、桌面、SaaS）执行动作。

工作原则：
1. 收到任务后先用 1-2 句话给出思考大纲，然后立即调用工具执行。
2. 每一步观察工具返回值，判断是否达成子目标；出错就调整策略再试。
3. 不向用户反复求证；只在必须的关键决策点（例如提交订单、发送邮件）等待批准。
4. 完成后用简洁的 Markdown 汇报：目标 → 执行摘要 → 交付物 / 后续建议。
5. 无可用工具时明确告诉用户"没有工具可以完成这个任务"，并建议要接入的 MCP 服务器类型。`;

async function loadConnections(userId: string, ids: string[]): Promise<McpConnectionRow[]> {
  if (ids.length === 0) return [];
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return [];
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("mcp_connections")
    .select("id, name, url, transport, auth_type, auth_metadata")
    .eq("user_id", userId)
    .in("id", ids)
    .eq("state", "ready");
  if (error) {
    console.error("[agent] load connections:", error);
    return [];
  }
  return (data ?? []) as McpConnectionRow[];
}

async function verifyUser(request: Request): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (token.split(".").length !== 3) return null;
  const supabase = createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  return data.claims.sub;
}

export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const userId = await verifyUser(request);
        if (!userId) return new Response("Unauthorized", { status: 401 });

        const body = (await request.json()) as ChatBody;
        const messages = body.messages ?? [];
        const connectionIds = body.connectionIds ?? [];

        const apiKey = process.env.LOVABLE_API_KEY;
        if (!apiKey) return new Response("Missing LOVABLE_API_KEY", { status: 500 });

        const connections = await loadConnections(userId, connectionIds);
        const opened = await openMcpConnections(connections);
        const mcpTools = mergeMcpTools(opened);

        const gateway = createLovableAiGatewayProvider(apiKey);
        const model = gateway("google/gemini-3.5-flash");

        try {
          const result = streamText({
            model,
            system: SYSTEM,
            messages: await convertToModelMessages(messages),
            tools: mcpTools,
            stopWhen: stepCountIs(50),
            onFinish: async () => {
              await closeMcpConnections(opened);
            },
            onError: async (err) => {
              console.error("[agent] stream error:", err);
              await closeMcpConnections(opened);
            },
          });

          return result.toUIMessageStreamResponse({
            originalMessages: messages,
            sendReasoning: true,
          });
        } catch (err) {
          await closeMcpConnections(opened);
          console.error("[agent] fatal:", err);
          return new Response(
            JSON.stringify({ error: err instanceof Error ? err.message : "Agent failed" }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
