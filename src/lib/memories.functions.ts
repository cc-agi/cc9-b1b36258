import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listMemories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_memories")
      .select("id, content, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const addMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ content: z.string().trim().min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("user_memories")
      .insert({ user_id: context.userId, content: data.content })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        content: z.string().trim().min(1).max(2000),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_memories")
      .update({ content: data.content })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_memories")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearAllMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await context.supabase
      .from("user_memories")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Auto-generate long-term memory entries by having the AI read the user's
 * recent chat history and distill durable facts, preferences, and working
 * conventions worth remembering across conversations.
 */
export const autoGenerateMemories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // 1) Pull recent conversation messages for this user (RLS scoped).
    const { data: rows, error: readErr } = await context.supabase
      .from("conversation_messages")
      .select("role, message, created_at")
      .order("created_at", { ascending: false })
      .limit(400);
    if (readErr) throw new Error(readErr.message);
    if (!rows || rows.length === 0) {
      return { added: 0, candidates: [] as string[], reason: "empty_history" };
    }

    // 2) Existing memories to dedupe against.
    const { data: existingRows } = await context.supabase
      .from("user_memories")
      .select("content")
      .limit(500);
    const existing = new Set(
      (existingRows ?? []).map((r) => String(r.content).trim().toLowerCase()),
    );

    // 3) Flatten UIMessage parts → plain text; keep chronological order.
    const ordered = [...rows].reverse();
    const transcript = ordered
      .map((r) => {
        const parts = ((r.message as { parts?: unknown[] } | null)?.parts ?? []) as Array<{
          type?: string;
          text?: string;
        }>;
        const text = parts
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join(" ")
          .trim();
        if (!text) return "";
        const who = r.role === "user" ? "USER" : "ASSISTANT";
        return `${who}: ${text}`;
      })
      .filter(Boolean)
      .join("\n")
      .slice(-24000); // hard cap ~24k chars

    if (!transcript) {
      return { added: 0, candidates: [] as string[], reason: "no_text" };
    }

    // 4) Ask Lovable AI for a JSON array of memory candidates.
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const system = [
      "你是 Sentinel 的记忆整理助手。基于用户与助手的历史对话，提炼出值得长期记住的条目。",
      "只提炼以下类型：",
      "1) 用户身份/角色/所在行业/公司/职位",
      "2) 长期偏好（语言、风格、代码/技术栈、输出格式偏好）",
      "3) 工作/业务对象（如经营的店铺类型、核心平台、常做的任务类型）",
      "4) 明确的禁止事项 / 安全边界",
      "禁止提炼：",
      "- 一次性问题、临时任务、聊天寒暄",
      "- 账号密码、验证码、支付信息、隐私敏感数据",
      "- 猜测、不确定的推断",
      "输出规则：",
      "- 严格返回 JSON：{\"memories\": string[]}",
      "- 每条 memories 是完整的中文陈述句，20-120 字，可直接作为「长期记忆」使用",
      "- 最多 8 条；如果历史中没有值得记忆的内容，返回空数组",
      "- 不要重复语义相同的条目",
    ].join("\n");

    const userPrompt = [
      "以下是用户的历史对话摘录（可能被截断）：",
      "----",
      transcript,
      "----",
      existing.size
        ? `已保存的记忆（避免重复）：\n- ${Array.from(existing).slice(0, 50).join("\n- ")}`
        : "（当前没有已保存记忆）",
    ].join("\n");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-3.5-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`AI gateway ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "{}";
    let candidates: string[] = [];
    try {
      const parsed = JSON.parse(raw) as { memories?: unknown };
      if (Array.isArray(parsed.memories)) {
        candidates = parsed.memories
          .filter((v): v is string => typeof v === "string")
          .map((s) => s.trim())
          .filter((s) => s.length >= 5 && s.length <= 300);
      }
    } catch {
      /* ignore parse errors → empty */
    }

    // 5) Dedupe and insert.
    const fresh = candidates.filter(
      (c) => !existing.has(c.toLowerCase()),
    );
    if (fresh.length === 0) {
      return { added: 0, candidates, reason: "no_new" };
    }
    const { error: insErr } = await context.supabase
      .from("user_memories")
      .insert(fresh.map((content) => ({ user_id: context.userId, content })));
    if (insErr) throw new Error(insErr.message);

    return { added: fresh.length, candidates: fresh, reason: "ok" };
  });

