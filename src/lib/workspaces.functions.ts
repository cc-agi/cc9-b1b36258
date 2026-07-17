import { createServerFn } from "@tanstack/react-start";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { z } from "zod";

export const WORKSPACE_BUCKET = "workspace-cloud";

const kindSchema = z.enum(["cloud", "gdrive", "local", "custom"]);

export const listWorkspaces = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_workspaces")
      .select("id, name, kind, path, is_active, sort_index, updated_at")
      .order("sort_index", { ascending: true })
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);

    // First-time bootstrap: give the user two default rows.
    if (!data || data.length === 0) {
      const defaults = [
        { user_id: context.userId, name: "我的云端硬盘", kind: "cloud", sort_index: 0, is_active: true },
        { user_id: context.userId, name: "Google Drive", kind: "gdrive", sort_index: 1, is_active: false },
      ];
      const { data: inserted, error: insErr } = await context.supabase
        .from("user_workspaces")
        .insert(defaults)
        .select("id, name, kind, path, is_active, sort_index, updated_at");
      if (insErr) throw new Error(insErr.message);
      return inserted ?? [];
    }
    return data;
  });

export const createWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z
      .object({
        name: z.string().trim().min(1).max(80),
        kind: kindSchema.default("custom"),
        path: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("user_workspaces")
      .insert({
        user_id: context.userId,
        name: data.name,
        kind: data.kind,
        path: data.path ?? null,
        sort_index: 999,
      })
      .select("id, name, kind, path, is_active, sort_index, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const setActiveWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // Clear previous active flags then set the target.
    const { error: clearErr } = await context.supabase
      .from("user_workspaces")
      .update({ is_active: false })
      .eq("user_id", context.userId);
    if (clearErr) throw new Error(clearErr.message);
    const { error } = await context.supabase
      .from("user_workspaces")
      .update({ is_active: true })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_workspaces")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const renameWorkspace = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z
      .object({ id: z.string().uuid(), name: z.string().trim().min(1).max(80) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("user_workspaces")
      .update({ name: data.name })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/* ---------- Cloud storage: list / signed URL / delete ---------- */

export const listCloudFiles = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ prefix: z.string().max(500).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const root = context.userId;
    const sub = (data.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const folder = sub ? `${root}/${sub}` : root;
    const { data: files, error } = await context.supabase.storage
      .from(WORKSPACE_BUCKET)
      .list(folder, { limit: 200, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    return (files ?? []).map((f) => ({
      name: f.name,
      id: f.id,
      size: f.metadata?.size ?? 0,
      mime: (f.metadata?.mimetype as string | undefined) ?? null,
      updated_at: f.updated_at,
      is_folder: !f.id, // Supabase returns folders with no id
    }));
  });

export const createCloudSignedUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z
      .object({
        filename: z.string().trim().min(1).max(200),
        prefix: z.string().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const sub = (data.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const safe = data.filename.replace(/[\\/]/g, "_");
    const path = sub
      ? `${context.userId}/${sub}/${safe}`
      : `${context.userId}/${safe}`;
    const { data: signed, error } = await context.supabase.storage
      .from(WORKSPACE_BUCKET)
      .createSignedUploadUrl(path, { upsert: true });
    if (error) throw new Error(error.message);
    return { path, token: signed.token, signedUrl: signed.signedUrl };
  });

export const createCloudSignedDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ name: z.string().min(1), prefix: z.string().max(500).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const sub = (data.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const path = sub
      ? `${context.userId}/${sub}/${data.name}`
      : `${context.userId}/${data.name}`;
    const { data: signed, error } = await context.supabase.storage
      .from(WORKSPACE_BUCKET)
      .createSignedUrl(path, 60 * 5);
    if (error) throw new Error(error.message);
    return { signedUrl: signed.signedUrl };
  });

export const deleteCloudFile = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .inputValidator((input: unknown) =>
    z.object({ name: z.string().min(1), prefix: z.string().max(500).optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const sub = (data.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const path = sub
      ? `${context.userId}/${sub}/${data.name}`
      : `${context.userId}/${data.name}`;
    const { error } = await context.supabase.storage
      .from(WORKSPACE_BUCKET)
      .remove([path]);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
