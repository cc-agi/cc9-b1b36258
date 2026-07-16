import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  tool,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
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
你**只能**调用下面这份白名单里的工具，工具名必须**逐字符**匹配，禁止臆造 / 加前缀 / 加命名空间（例如禁止 \`browserbase__start\`、\`mcp.xxx\`、\`chrome_open\` 等未列出的名字）。
可用工具白名单（当前会话唯一可用的工具，此外没有任何 MCP / 云浏览器 / 第三方工具）：
- browser_goto(url)
- browser_inspect_candidates({ textOrSelector })
- browser_wait_for({ selector, timeoutMs? })
- browser_click(selector)
- browser_fill({ selector, value })
- browser_press(key)
- browser_extract({ selector, attr? })
- browser_screenshot(name)
- browser_eval(expression)
这些 browser_* 工具通过本机 Helper 附加到用户已启动的 Chrome，实时驱动网页。
如果你想调用的能力不在上表里，就**不要调用工具**，直接在最终答案里说明该能力当前不可用。


浏览器工具使用规范：
- 需要在真实网页上执行动作时，典型链路：browser_goto → browser_wait_for → browser_fill → browser_press → browser_wait_for → browser_eval / browser_extract。
- 后台 / SPA 菜单导航（尤其 Alibaba 国际站）必须使用：browser_inspect_candidates("菜单文字") → 选择返回候选里的真实 clickableAncestor / href → browser_click("菜单文字或候选 selector") → 等待 URL / 主标题 / active 菜单 / 关键元素任一变化 → browser_eval 抽取当前 title、URL 和页面数据。
- 点击“商品管理”等菜单文字前，必须先调用 browser_inspect_candidates，检查候选的 tagName、role、text、href、isVisible、boundingBox、clickableAncestor、containerPath、frameIndex、frameUrl；优先 nav / aside / [role=navigation] / [role=menu] / 可见左侧固定栏里的候选，不要全局点击主内容区同名标题。
- 禁止直接点击 h1/h2/h3/span/p 等纯文本元素；只能点击 a[href]、button、[role=menuitem]、[role=link]、[onclick] 或候选返回的最近 clickableAncestor。
- 不允许猜测后台内部业务 URL；只有候选 DOM 中存在真实 href 时，才可以 browser_goto 该 href。不得根据“商品管理”等文字拼接 /product/manage.htm。
- Alibaba 等复杂 SPA 不等待 networkidle；点击后以 URL 改变、主内容标题改变、新菜单 active、关键元素出现任一条件作为成功。若工具返回 CLICK_NO_NAVIGATION，换候选重试，不要立即猜 URL。
- 如果候选位于 iframe，必须使用工具返回的 frameIndex / frameUrl 对应候选继续点击；工具会自动在正确 frame 内执行。
- 每次调用都是同步：结果里的 logs 告诉你是否成功；出错就换选择器或调整策略再试。
- 用户必须已经在设置里启动了 Chrome；若 browser_* 连续失败并提示 Helper 不可达，请提示用户到"电脑操控"面板启动 Chrome。

输出纪律 — 绝对禁止规划独白（HARD RULE，违反视为任务失败）：
- 面向用户的 text 通道**只允许两种内容**，二选一：
  (a) **不输出任何 text**，直接调用下一个工具（tool call）；
  (b) **所有工具执行完毕后**，输出一次简洁的最终答案（Markdown，直接给结论 / 数据 / 链接 / 结果表格，不复述过程、不总结自己做了哪些步骤）。
- 严禁在 text 通道出现任何以下形式的"规划独白 / 自言自语 / 内心 OS"，无论中英文、无论长短：
  · "Let's ..." / "Let me ..." / "I'll ..." / "I will ..." / "First, I need to ..." / "Next, ..." / "Now let's ..." / "Okay, ..." / "Alright, ..." / "Let's see." / "Let's go!" / "Let's try ..."
  · "让我 ..." / "我先 ..." / "我要 ..." / "我需要 ..." / "接下来 ..." / "下一步 ..." / "首先 ..." / "然后 ..." / "现在 ..." / "好的，我来 ..." / "我们来 ..." / "让我们 ..."
  · 任何描述"我打算调用哪个工具 / 我打算用哪个选择器 / 我打算怎么做"的句子。
- 如果需要思考、规划、比较策略、猜测选择器 —— 全部走 reasoning 通道（内部推理），**绝不能**写进 text。
- 中间步骤**默认零 text 输出**。仅在工具连续失败需要向用户求助时，才允许输出一句 ≤ 20 字的状态说明（例："Helper 未连接，请启动 Chrome"）。
- 违反示例（禁止）：
  ✗ "Let's first look for the search bar. Let's use input#search. Let's fill and press Enter."
  ✗ "接下来我要打开 YouTube，然后搜索世界杯，最后提取前三条结果。"
- 正确示例：
  ✓ 直接发出 browser_goto 工具调用，text 为空。
  ✓ 全部工具跑完后，text 输出："**世界杯最新资讯**\n1. [标题](url)\n2. [标题](url)\n3. [标题](url)"



关键规则 — 绝不提前结束：
- 仅打开页面、仅输入关键词、仅按 Enter，都不算完成任务。必须继续调用下一个工具，直到已经在页面上"抽取到用户真正想要的数据"。
- 提交搜索 (browser_press Enter) 之后，下一步必须是 browser_wait_for 例如 { selector: "div#search div.MjjYud h3, div#rso div.g h3", timeoutMs: 10000 }，然后 browser_eval 抽取结果。
- Google 搜索结果抽取必须严格按"自然结果容器 → 主标题 → 主链接 → 实体匹配 → 域名类型"的流程。**先做目标实体匹配 (entityMatch)，再定 sourceType；仅缩写相同的其他组织（如 waic.org 的 Western Association of Independent Camps）必须归 unrelated，绝不进官方组。** 推荐 browser_eval 表达式（示例针对"WAIC 官网"，请按查询调整 targetEntities / officialDomains / disqualifyPhrases）：
    () => {
      // === 按查询调整的目标实体配置 ===
      // 目标实体的关键描述短语（正向证据；命中任意一项即 entityMatch=true）
      const targetEntities = ['世界人工智能大会','world artificial intelligence conference','world artificial intelligence','上海人工智能','shanghai artificial intelligence','shanghai ai conference','waic shanghai','waic 上海'];
      // 已确认属于目标实体的官方域名（主域 -> official_site；其子域 -> official_subdomain）
      const officialDomains = ['worldaic.com.cn'];
      // 明确无关的短语（负向证据；命中即 entityMatch=false，不看域名）
      const disqualifyPhrases = ['western association of independent camps','independent camps'];
      // === 通用配置 ===
      const queryTokens = ['waic','world artificial intelligence','世界人工智能','上海','shanghai','大会','conference'];
      const badDomains = ['google.','googleusercontent.','youtube.com','webflow.io','webflow.com'];
      const badPathRe = /^\\/(search|url|imgres|preferences|advanced_search|maps|shopping|travel|finance|policies|intl|aclk)/i;
      const adModuleSel = '[data-text-ad], .commercial-unit-desktop-top, .commercial-unit-desktop-rhs, g-section-with-header, .ULSxyf, .related-question-pair, .cUnQKe, .xpdopen, .kno-kp, .liYKde, .M8OgIe, .ruTcId, [aria-label="广告"], [aria-label="Ads"]';
      const govTlds = ['.gov','.gov.cn','.gob.','.gouv.','.go.jp','.gov.uk'];
      const eduTlds = ['.edu','.edu.cn','.ac.uk','.ac.jp'];
      const encyclopediaDomains = ['baike.baidu.com','zh.wikipedia.org','en.wikipedia.org','wikipedia.org','baike.sogou.com','zhidao.baidu.com','wiki.mbalib.com'];
      const mediaDomains = ['sina.com','sina.cn','sohu.com','163.com','qq.com','ifeng.com','xinhuanet.com','people.com.cn','chinadaily.com.cn','thepaper.cn','36kr.com','huxiu.com','jiemian.com','yicai.com','caixin.com','nytimes.com','bbc.com','bbc.co.uk','cnn.com','reuters.com','bloomberg.com','techcrunch.com','theverge.com','wired.com'];
      // 实体匹配：正向短语命中且没有负向短语命中
      const matchEntity = (title, snippet, domain) => {
        const hay = (title + ' ' + snippet).toLowerCase();
        const dq = disqualifyPhrases.find(p => hay.includes(p.toLowerCase()));
        if (dq) return { entityMatch: false, matchedEntity: null, entityEvidence: 'disqualifying phrase in title/snippet: "' + dq + '"' };
        const hit = targetEntities.find(e => hay.includes(e.toLowerCase()));
        if (hit) return { entityMatch: true, matchedEntity: hit, entityEvidence: 'title/snippet contains "' + hit + '"' };
        // 官方主域也算直接证据（即便 title/snippet 语言不同）
        const domHit = officialDomains.find(d => domain === d || domain.endsWith('.'+d));
        if (domHit) return { entityMatch: true, matchedEntity: domHit, entityEvidence: 'domain is confirmed official (' + domHit + ')' };
        return { entityMatch: false, matchedEntity: null, entityEvidence: 'no target-entity phrase in title/snippet; domain not in confirmed official list' };
      };
      // sourceType：仅在 entityMatch=true 时才可能是 official_*
      const classifySource = (domain, entityMatch) => {
        if (encyclopediaDomains.some(d => domain === d || domain.endsWith('.'+d))) return 'encyclopedia';
        if (mediaDomains.some(d => domain === d || domain.endsWith('.'+d))) return 'media';
        if (govTlds.some(t => domain.includes(t))) return 'government';
        if (eduTlds.some(t => domain.includes(t))) return 'education';
        if (!entityMatch) return 'unrelated';
        const rootHit = officialDomains.find(d => domain === d);
        if (rootHit) return 'official_site';
        const subHit = officialDomains.find(d => domain.endsWith('.'+d));
        if (subHit) return 'official_subdomain';
        return 'unrelated';
      };
      const confidenceFromSource = (src) => {
        if (src === 'official_site' || src === 'government') return 'high';
        if (src === 'official_subdomain' || src === 'education') return 'medium';
        return 'none';
      };
      const rawContainers = Array.from(document.querySelectorAll('#search div.g, #rso div.g, #search div.MjjYud, #rso div.MjjYud'));
      const seenBox = new Set();
      const containers = [];
      const isVisible = (el) => !!el && !!el.offsetParent && el.getClientRects().length > 0;
      const pushBox = (box) => {
        if (!box || seenBox.has(box)) return;
        for (const prev of seenBox) if (prev.contains(box)) return;
        if (box.closest(adModuleSel)) return;
        const h3 = box.querySelector('h3');
        if (!isVisible(h3)) return;
        seenBox.add(box); containers.push(box);
      };
      for (const box of rawContainers) pushBox(box);
      if (containers.length < 3) {
        for (const box of Array.from(document.querySelectorAll('#search [data-hveid], #rso [data-hveid]'))) pushBox(box);
      }
      const cssPath = (el) => {
        if (!el) return '';
        const parts = []; let cur = el;
        for (let i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
          let sel = cur.tagName.toLowerCase();
          if (cur.id) { sel += '#' + cur.id; parts.unshift(sel); break; }
          if (cur.classList && cur.classList.length) sel += '.' + Array.from(cur.classList).slice(0,2).join('.');
          parts.unshift(sel); cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const candidates = [];
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
        const domain = url.hostname.replace(/^www\\./,'').toLowerCase();
        if (seenDomain.has(domain)) continue;
        seenDomain.add(domain);
        const title = (h3.textContent || '').trim();
        const href = a.href;
        const snippet = (box.querySelector('div[data-sncf], div.VwiC3b, .kb0PBd')?.textContent || '').trim();
        const hay = (title + ' ' + snippet + ' ' + domain).toLowerCase();
        let score = 0; for (const t of queryTokens) if (hay.includes(t.toLowerCase())) score += 1;
        const relevanceScore = Math.min(1, score / Math.max(3, Math.ceil(queryTokens.length/2)));
        const em = matchEntity(title, snippet, domain);
        const sourceType = classifySource(domain, em.entityMatch);
        const officialConfidence = em.entityMatch ? confidenceFromSource(sourceType) : 'none';
        const containerSelector = cssPath(box);
        const linkSelector = cssPath(a);
        candidates.push({ title, href, url: href, domain, snippet, relevanceScore, entityMatch: em.entityMatch, matchedEntity: em.matchedEntity, entityEvidence: em.entityEvidence, sourceType, officialConfidence, containerSelector, linkSelector });
      }
      // 分组：只有 entityMatch=true 才能进 official / related；entityMatch=false 一律 rejected（含 waic.org 这类同名不同实体）
      const official = [], related = [], rejected = [];
      for (const c of candidates) {
        if (!c.entityMatch) {
          rejected.push({ ...c, rejectionReason: c.entityEvidence.startsWith('disqualifying') ? 'same acronym, different organization' : 'entity mismatch — no evidence of target entity in title/snippet and domain not confirmed official' });
          continue;
        }
        if (c.sourceType === 'official_site' || c.sourceType === 'official_subdomain') official.push(c);
        else if (c.sourceType === 'media' || c.sourceType === 'encyclopedia' || c.sourceType === 'government' || c.sourceType === 'education') related.push(c);
        else rejected.push({ ...c, rejectionReason: 'entityMatch=true but source not classified as official/media/enc/gov/edu' });
      }
      const rank = { official_site: 4, official_subdomain: 3, government: 5, education: 2, media: 1, encyclopedia: 0 };
      const bySource = (a,b) => (rank[b.sourceType] ?? -1) - (rank[a.sourceType] ?? -1) || b.relevanceScore - a.relevanceScore;
      official.sort(bySource); related.sort(bySource);
      official.forEach((r,i) => r.rank = i+1); related.forEach((r,i) => r.rank = i+1);
      return { ok: official.length + related.length > 0, official, related, rejected, officialCount: official.length, note: official.length===0 ? '未在前若干条结果中识别到官方站点' : undefined };
    }
- 最终回答必须**严格按抽取返回的三个数组分组**输出，不得根据常识调整：
  1. **官方网站** — 使用 official 数组；每条列出真实 title 与 href；数组为空写"未找到官方网站"。
  2. **相关参考结果** — 使用 related 数组；同样只输出 DOM 抽取的真实 title/href；数组为空写"无其它相关参考"。
  3. （可选）**已排除** — 简要列 rejected 中的 domain + rejectionReason。
  绝对禁止：把 rejected 里的条目挪进官方或相关；根据常识补写标题或 URL；因为域名含关键词就当作官方。


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

async function streamImageViaGateway(
  prompt: string,
  apiKey: string,
  onProgress: (frac: number) => void,
) {
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
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const text = res.body ? await res.text().catch(() => "") : "";
    throw new Error(`image gen failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let imageUrl = "";
  let note = "";
  let chunks = 0;
  onProgress(0.05);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              images?: Array<{ image_url?: { url?: string } }>;
            };
            message?: {
              content?: string;
              images?: Array<{ image_url?: { url?: string } }>;
            };
          }>;
        };
        chunks += 1;
        const choice = j.choices?.[0];
        const src = choice?.delta ?? choice?.message;
        const img = src?.images?.[0]?.image_url?.url;
        if (img) imageUrl = img;
        if (typeof src?.content === "string") note += src.content;
        // Real event pulses; asymptotic mapping toward 0.95 until final result.
        onProgress(Math.min(0.95, 0.08 + 1 - Math.pow(0.85, chunks)));
      } catch {
        // ignore non-JSON keepalive lines
      }
    }
  }
  if (!imageUrl) throw new Error("模型没有返回图片");
  onProgress(1);
  return { imageUrl, note };
}

function emitToolProgress(
  writer: UIMessageStreamWriter,
  toolCallId: string,
  pct: number,
) {
  writer.write({
    type: "data-tool-progress",
    id: toolCallId,
    data: { pct: Math.round(Math.max(0, Math.min(100, pct))) },
  });
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

        // Browser tools have NO execute() — they run in the browser via the
        // local Sentinel Helper. The client's useChat onToolCall intercepts
        // browser_* calls, forwards to http://127.0.0.1:9223, and returns the
        // result via addToolResult.
        const browserTools = {
          browser_goto: tool({
            description: "在受控 Chrome 中打开一个 URL，等待 DOM 加载；后台内部 URL 必须来自 DOM 中真实 href，不要猜测拼接。",
            inputSchema: z.object({ url: z.string().url() }),
          }),
          browser_inspect_candidates: tool({
            description:
              "点击菜单/链接前先检查候选元素；返回 tagName、role、text、href、isVisible、boundingBox、clickableAncestor、containerPath、frameIndex、frameUrl，并优先侧边栏/导航作用域。",
            inputSchema: z.object({ textOrSelector: z.string() }),
          }),
          browser_wait_for: tool({
            description: "等待某个 CSS 选择器出现在当前页面。",
            inputSchema: z.object({
              selector: z.string().min(1),
              timeoutMs: z.number().int().positive().max(60000).optional(),
            }),
          }),
          browser_click: tool({
            description:
              "智能点击文本或选择器：先收集候选，禁止直接点纯文本标题，优先可点击祖先；点击后等待 URL/标题/active/内容变化，5 秒无变化返回 CLICK_NO_NAVIGATION。",
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
          const stream = createUIMessageStream({
            originalMessages: messages,
            execute: async ({ writer }) => {
              // Creative tools need the writer to emit real progress events
              // (data-tool-progress) keyed by toolCallId.
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
                        execute: async ({ prompt }, { toolCallId }) => {
                          try {
                            emitToolProgress(writer, toolCallId, 3);
                            const { imageUrl, note } = await streamImageViaGateway(
                              prompt,
                              lovableKey,
                              (frac) =>
                                emitToolProgress(writer, toolCallId, frac * 100),
                            );
                            emitToolProgress(writer, toolCallId, 100);
                            return { ok: true, imageUrl, note };
                          } catch (err) {
                            emitToolProgress(writer, toolCallId, 100);
                            return {
                              ok: false,
                              error:
                                err instanceof Error ? err.message : "生成失败",
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
                        execute: async ({ prompt }, { toolCallId }) => {
                          emitToolProgress(writer, toolCallId, 100);
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
              const tools = (
                mode === "task"
                  ? { ...browserTools, ...mcpTools }
                  : creativeTools
              ) as Record<string, ReturnType<typeof tool>>;

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

              writer.merge(
                result.toUIMessageStream({ sendReasoning: true }),
              );
            },
          });

          return createUIMessageStreamResponse({ stream });
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
