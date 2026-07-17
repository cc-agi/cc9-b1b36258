import { createServerFn } from "@tanstack/react-start";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { z } from "zod";


const KindSchema = z.enum(["task", "chat"]);

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("conversations")
      .select("id, kind, title, model, provider, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z
      .object({
        kind: KindSchema.default("task"),
        title: z.string().trim().max(120).optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("conversations")
      .insert({
        user_id: context.userId,
        kind: data.kind,
        title: data.title?.trim() || (data.kind === "chat" ? "新聊天" : "新任务"),
        model: data.model ?? null,
        provider: data.provider ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const renameConversation = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversations")
      .update({ title: data.title })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("conversations")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getConversationMessages = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .handler(async ({ data, context }): Promise<any[]> => {
    const { data: rows, error } = await context.supabase
      .from("conversation_messages")
      .select("message, created_at")
      .eq("conversation_id", data.id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => r.message);
  });

export const saveConversationMessages = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        messages: z.array(z.record(z.string(), z.unknown())),
        title: z.string().trim().min(1).max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // Verify ownership
    const { data: conv, error: convErr } = await context.supabase
      .from("conversations")
      .select("id, user_id, title")
      .eq("id", data.id)
      .single();
    if (convErr || !conv) throw new Error(convErr?.message ?? "会话不存在");
    if (conv.user_id !== context.userId) throw new Error("无权访问该会话");

    // Wipe and rewrite (simple + correct for streaming rewrites)
    const { error: delErr } = await context.supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", data.id);
    if (delErr) throw new Error(delErr.message);

    if (data.messages.length > 0) {
      const rows = data.messages.map((m) => ({
        conversation_id: data.id,
        user_id: context.userId,
        role: (m.role as string) ?? "assistant",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: m as any,
      }));
      const { error: insErr } = await context.supabase
        .from("conversation_messages")
        .insert(rows);
      if (insErr) throw new Error(insErr.message);
    }

    // Bump updated_at + optional title
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: any = { updated_at: new Date().toISOString() };
    if (data.title) patch.title = data.title;
    await context.supabase.from("conversations").update(patch).eq("id", data.id);

    return { ok: true };
  });

