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
你通过两类工具执行动作：
- 浏览器工具 (browser_*)：通过本机 Helper 附加到用户已启动的 Chrome，实时驱动网页 (打开 URL / 点击 / 填写 / 等待 / 抽取文本 / 截图 / 执行 JS)。
- MCP 工具：连接到远程 SaaS / 桌面服务的能力。

浏览器工具使用规范：
- 需要在真实网页上执行动作时，典型链路：browser_goto → browser_wait_for → browser_fill → browser_press → browser_wait_for → browser_eval / browser_extract。
- 每次调用都是同步：结果里的 logs 告诉你是否成功；出错就换选择器或调整策略再试。
- 用户必须已经在设置里启动了 Chrome；若 browser_* 连续失败并提示 Helper 不可达，请提示用户到"电脑操控"面板启动 Chrome。

关键规则 — 绝不提前结束：
- 仅打开页面、仅输入关键词、仅按 Enter，都不算完成任务。必须继续调用下一个工具，直到已经在页面上"抽取到用户真正想要的数据"。
- 提交搜索 (browser_press Enter) 之后，下一步必须是 browser_wait_for 例如 { selector: "div#search div.MjjYud h3, div#rso div.g h3", timeoutMs: 10000 }，然后 browser_eval 抽取结果。
- Google 搜索结果抽取必须严格按"自然结果容器 → 主标题 → 主链接"的方式，并按用户查询语义打分过滤。禁止直接抓取全页 a h3。推荐 browser_eval 表达式（示例针对"WAIC 官网"这类"官网"查询，请根据实际查询调整 queryTokens / officialHints）：
    () => {
      const queryTokens = ['waic','world artificial intelligence','世界人工智能','上海','shanghai','官网','official','大会','conference'];
      const officialHints = ['官网','official','世界人工智能','world artificial intelligence'];
      const badDomains = ['google.','googleusercontent.','youtube.com','webflow.io','webflow.com'];
      const badPathRe = /^\\/(search|url|imgres|preferences|advanced_search|maps|shopping|travel|finance|policies|intl|aclk)/i;
      const adModuleRe = '[data-text-ad], .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, g-section-with-header, .ULSxyf, .related-question-pair, .cUnQKe, .xpdopen, .kno-kp, .liYKde, .M8OgIe, .ruTcId, [aria-label="广告"], [aria-label="Ads"]';
      // 稳健容器定位：优先 div.g / div.MjjYud，且必须在主结果区 (#search/#rso) 内、包含可见 h3、不落在广告或知识面板/推荐模块。回退策略：任意包含直接可见 h3 + 外链 a 的 block。
      const rawContainers = Array.from(document.querySelectorAll('#search div.g, #rso div.g, #search div.MjjYud, #rso div.MjjYud'));
      const seenBox = new Set();
      const containers = [];
      const isVisible = (el) => !!el && !!el.offsetParent && el.getClientRects().length > 0;
      const pushBox = (box) => {
        if (!box || seenBox.has(box)) return;
        // 跳过嵌套：若已选中祖先容器，跳过其子容器（避免 sitelink 子块被当作独立结果）
        for (const prev of seenBox) if (prev.contains(box)) return;
        if (box.closest(adModuleRe)) return;
        const h3 = box.querySelector('h3');
        if (!isVisible(h3)) return;
        seenBox.add(box);
        containers.push(box);
      };
      for (const box of rawContainers) pushBox(box);
      // 回退：主结果区内含可见 h3 + 外链 a 的其它 block
      if (containers.length < 3) {
        const fallback = Array.from(document.querySelectorAll('#search [data-hveid], #rso [data-hveid]'));
        for (const box of fallback) pushBox(box);
      }
      const results = [];
      const rejected = [];
      const seenDomain = new Set();
      for (const box of containers) {
        const h3 = box.querySelector('h3');
        if (!isVisible(h3)) continue;

        const a = h3.closest('a[href]') || box.querySelector('a[href] h3')?.closest('a[href]');
        if (!a) continue;
        let url; try { url = new URL(a.href); } catch { continue; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (badDomains.some(d => url.hostname.includes(d))) continue;
        if (url.hostname.endsWith('google.com') || badPathRe.test(url.pathname)) continue;
        const domain = url.hostname.replace(/^www\\./,'');
        if (seenDomain.has(domain)) continue; // 合并 sitelinks 到主结果
        const title = (h3.textContent || '').trim();
        const snippet = (box.querySelector('div[data-sncf], div.VwiC3b, .kb0PBd')?.textContent || '').trim();
        const hay = (title + ' ' + snippet + ' ' + domain).toLowerCase();
        let score = 0;
        for (const t of queryTokens) if (hay.includes(t.toLowerCase())) score += 1;
        const relevanceScore = Math.min(1, score / Math.max(3, Math.ceil(queryTokens.length/2)));
        const officialConfidence = officialHints.some(h => hay.includes(h.toLowerCase())) ? 'high' : (relevanceScore >= 0.5 ? 'medium' : 'low');
        const entry = { title, url: a.href, domain, snippet, relevanceScore, officialConfidence };
        if (relevanceScore < 0.34) { rejected.push({ ...entry, reason: 'low semantic relevance to query (same acronym or unrelated site)' }); continue; }
        seenDomain.add(domain);
        results.push(entry);
        if (results.length >= 3) break;
      }
      results.sort((a,b) => (b.officialConfidence==='high'?1:0)-(a.officialConfidence==='high'?1:0) || b.relevanceScore-a.relevanceScore);
      results.forEach((r,i) => r.rank = i+1);
      return { ok: results.length>0, results, rejected, note: results.length<3 ? '仅返回高度相关结果，其余候选因语义不相关被过滤' : undefined };
    }
- 拿到抽取结果后，用有序列表输出 results 里的真实标题+URL；若 results.length < 3，明确说明"找到 N 条高度相关结果，其余候选因语义不相关被过滤"，可附上 rejected 中的原因。禁止为凑满 3 条返回无关结果，禁止在还未抽取时声称"已找到"。

工作原则：
1. 收到任务后先用 1-2 句话给出思考大纲，然后立即调用工具执行。
2. 每一步观察工具返回值，判断是否达成子目标；出错就调整策略再试。
3. 不向用户反复求证；只在必须的关键决策点（例如提交订单、发送邮件）等待批准。
4. 工具调用成功后 **必须** 判断是否已经完成用户目标；未完成就继续调用工具，不要停下来等待用户说"继续"。
5. 完成后用简洁的 Markdown 汇报：目标 → 执行摘要 → 交付物 / 后续建议。
6. 完全没有可用工具时才说"没有工具可以完成这个任务"。`;


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

        // Browser tools have NO execute() — they run in the browser via the
        // local Sentinel Helper. The client's useChat onToolCall intercepts
        // browser_* calls, forwards to http://127.0.0.1:9223, and returns the
        // result via addToolResult.
        const browserTools = {
          browser_goto: tool({
            description: "在受控 Chrome 中打开一个 URL 并等待 DOM 加载。",
            inputSchema: z.object({ url: z.string().url() }),
          }),
          browser_wait_for: tool({
            description: "等待某个 CSS 选择器出现在当前页面。",
            inputSchema: z.object({
              selector: z.string().min(1),
              timeoutMs: z.number().int().positive().max(60000).optional(),
            }),
          }),
          browser_click: tool({
            description: "点击匹配 CSS 选择器的元素。",
            inputSchema: z.object({ selector: z.string().min(1) }),
          }),
          browser_fill: tool({
            description: "在匹配选择器的输入框 / textarea 中填入文本。",
            inputSchema: z.object({ selector: z.string().min(1), value: z.string() }),
          }),
          browser_press: tool({
            description: "在当前页面模拟一次按键 (Enter / Tab / ArrowDown 等)。",
            inputSchema: z.object({ key: z.string().min(1) }),
          }),
          browser_extract: tool({
            description:
              "抽取匹配元素的文本或属性；attr 留空返回 innerText，否则返回该属性值。",
            inputSchema: z.object({
              selector: z.string().min(1),
              attr: z.string().optional(),
            }),
          }),
          browser_screenshot: tool({
            description: "对当前页面截图，返回保存在本机临时目录的文件路径。",
            inputSchema: z.object({ name: z.string().min(1) }),
          }),
          browser_eval: tool({
            description:
              "在页面上下文中执行一段箭头函数 JS 表达式，例如 '() => document.title'。",
            inputSchema: z.object({ expression: z.string().min(1) }),
          }),
        };

        const tools = (
          mode === "task" ? { ...browserTools, ...mcpTools } : creativeTools
        ) as Record<string, ReturnType<typeof tool>>;
        const system = mode === "task" ? SYSTEM_TASK : SYSTEM_CHAT;


        const maxToolIterations = mode === "task" ? 15 : 8;
        const lastUserText = (() => {
          const u = [...messages].reverse().find((m) => m.role === "user");
          if (!u) return "";
          return (u.parts ?? [])
            .map((p) => (p.type === "text" ? (p as { text: string }).text : ""))
            .join(" ")
            .trim()
            .slice(0, 160);
        })();
        let toolIteration = 0;
        console.log(
          `[agent] taskGoal=${JSON.stringify(lastUserText)} maxToolIterations=${maxToolIterations}`,
        );

        try {
          const result = streamText({
            model,
            system,
            messages: await convertToModelMessages(messages),
            tools,
            stopWhen: stepCountIs(maxToolIterations),
            onStepFinish: ({ toolCalls, finishReason }) => {
              toolIteration += 1;
              const nextPlannedAction =
                toolCalls?.map((c) => c.toolName).join(",") || "(none)";
              console.log(
                `[agent] toolIteration=${toolIteration}/${maxToolIterations} finishReason=${finishReason} nextPlannedAction=${nextPlannedAction}`,
              );
            },
            onFinish: async ({ finishReason }) => {
              console.log(
                `[agent] stopReason=${finishReason} toolIteration=${toolIteration} goalCompleted=${
                  finishReason === "stop"
                }`,
              );
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
