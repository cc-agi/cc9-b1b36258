import { createFileRoute } from "@tanstack/react-router";
import { convertToModelMessages, streamText, stepCountIs, tool, type UIMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import {
  openMcpConnections,
  closeMcpConnections,
  mergeMcpTools,
  type McpConnectionRow,
} from "@/lib/mcp-client.server";

type ChatMode = "task" | "chat";
type ModelProvider = "llm-token" | "minimax";
type ChatBody = {
  messages?: UIMessage[];
  connectionIds?: string[];
  model?: string;
  mode?: ChatMode;
  provider?: ModelProvider;
};

const LOVABLE_MODEL_PREFIXES = ["google/", "openai/"];

const EXTERNAL_PROVIDER_CONFIG: Record<
  ModelProvider,
  { baseURL: string; envKey: string; name: string }
> = {
  "llm-token": {
    baseURL: "https://api.llm-token.cn/v1",
    envKey: "LLM_TOKEN_API_KEY",
    name: "llm-token",
  },
  minimax: {
    baseURL: "https://minimax-m23.wbzmt.cn/v1",
    envKey: "MINIMAX_API_KEY",
    name: "minimax",
  },
};

const SYSTEM_TASK = `你是 SENTINEL — 一个完全自主的桌面控制 Agent。
你的宿主是一台需要你远程操作以完成用户目标的计算机。
你通过 MCP 工具（浏览器、桌面、SaaS）执行动作。

工作原则：
1. 收到任务后先用 1-2 句话给出思考大纲，然后立即调用工具执行。
2. 每一步观察工具返回值，判断是否达成子目标；出错就调整策略再试。
3. 不向用户反复求证；只在必须的关键决策点（例如提交订单、发送邮件）等待批准。
4. 完成后用简洁的 Markdown 汇报：目标 → 执行摘要 → 交付物 / 后续建议。
5. 无可用工具时明确告诉用户"没有工具可以完成这个任务"，并建议要接入的 MCP 服务器类型。`;

const SYSTEM_CHAT = `你是 SENTINEL 的创作伙伴 —— 面向自由对话、图像与视频创作。

能力：
- 直接用自然语言对话，回答问题、头脑风暴、写作、解释。
- 需要生成图片时调用 \`generate_image\` 工具（输入英文更准；中文会自动翻译成英文再生成）。
- 需要生成视频时调用 \`generate_video\` 工具（当前处于占位状态，会提示尚未接入视频提供商）。

规范：
- 使用 Markdown。图像/视频生成后简短点评并给出改进建议。
- 一次仅调用一个媒体生成工具；生成失败时说明原因，不重复调用。
- 不要在 chat 模式里假装执行浏览器/桌面动作 —— 那些能力在"新建任务"模式。`;

async function generateImageViaGateway(prompt: string, apiKey: string) {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash-image",
      messages: [{ role: "user", content: prompt }],
      modalities: ["image", "text"],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image gen failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        images?: Array<{ image_url?: { url?: string } }>;
      };
    }>;
  };
  const msg = json.choices?.[0]?.message;
  const imageUrl = msg?.images?.[0]?.image_url?.url;
  if (!imageUrl) throw new Error("模型没有返回图片");
  return { imageUrl, note: msg?.content ?? "" };
}


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
        const selectedModel = body.model?.trim() || "google/gemini-3.5-flash";
        const mode: ChatMode = body.mode === "chat" ? "chat" : "task";
        const externalProvider: ModelProvider =
          body.provider === "minimax" ? "minimax" : "llm-token";
        console.log(`[agent] user=${userId.slice(0, 8)} mode=${mode} provider=${externalProvider} model=${selectedModel}`);

        // MCP is only wired in task mode
        const connections = mode === "task" ? await loadConnections(userId, connectionIds) : [];
        const opened = await openMcpConnections(connections);
        const mcpTools = mergeMcpTools(opened);

        const isLovableNative = LOVABLE_MODEL_PREFIXES.some((p) => selectedModel.startsWith(p));
        const lovableKey = process.env.LOVABLE_API_KEY;
        let model;
        if (isLovableNative) {
          if (!lovableKey) {
            await closeMcpConnections(opened);
            return new Response("Missing LOVABLE_API_KEY", { status: 500 });
          }
          model = createLovableAiGatewayProvider(lovableKey)(selectedModel);
        } else {
          const cfg = EXTERNAL_PROVIDER_CONFIG[externalProvider];
          const extKey = process.env[cfg.envKey];
          if (!extKey) {
            await closeMcpConnections(opened);
            return new Response(`Missing ${cfg.envKey}`, { status: 500 });
          }
          const provider = createOpenAICompatible({
            name: cfg.name,
            baseURL: cfg.baseURL,
            headers: { Authorization: `Bearer ${extKey}` },
          });
          model = provider(selectedModel);
        }

        // Assemble tools per mode
        const creativeTools =
          mode === "chat" && lovableKey
            ? {
                generate_image: tool({
                  description:
                    "根据文字提示生成一张图片，返回 data URL。适合插画、封面、示意图、概念图等。",
                  inputSchema: z.object({
                    prompt: z
                      .string()
                      .min(1)
                      .describe("详细的英文图像描述；中文会先翻译成英文。"),
                  }),
                  execute: async ({ prompt }) => {
                    try {
                      const { imageUrl, note } = await generateImageViaGateway(
                        prompt,
                        lovableKey,
                      );
                      return { ok: true, imageUrl, note };
                    } catch (err) {
                      return {
                        ok: false,
                        error: err instanceof Error ? err.message : "生成失败",
                      };
                    }
                  },
                }),
                generate_video: tool({
                  description:
                    "根据文字提示生成一段短视频。当前处于占位状态：调用后请告知用户尚未接入视频提供商。",
                  inputSchema: z.object({
                    prompt: z.string().min(1),
                  }),
                  execute: async ({ prompt }) => {
                    return {
                      ok: false,
                      pending: true,
                      prompt,
                      error:
                        "视频生成未接入。请在设置里接入视频提供商（如 Runway / Kling / 火山 MotionCLIP）后再试。",
                    };
                  },
                }),
              }
            : {};

        const tools = (mode === "task" ? mcpTools : creativeTools) as Record<string, ReturnType<typeof tool>>;
        const system = mode === "task" ? SYSTEM_TASK : SYSTEM_CHAT;

        try {
          const result = streamText({
            model,
            system,
            messages: await convertToModelMessages(messages),
            tools,
            stopWhen: stepCountIs(mode === "task" ? 50 : 8),
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
