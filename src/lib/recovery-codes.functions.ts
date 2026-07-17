import { createServerFn } from "@tanstack/react-start";
import { requireSentinelOwner } from "@/lib/owner-guard";
import { createHash, randomBytes } from "crypto";

function hashCode(code: string) {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

function generateCode() {
  // 10 位十六进制，形如 a1b2-c3d4-e5
  const raw = randomBytes(5).toString("hex");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
}

/** 生成 10 个新恢复码，替换旧的（旧的作废）。返回明文，仅这次可见。 */
export const regenerateRecoveryCodes = createServerFn({ method: "POST" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const codes = Array.from({ length: 10 }, () => generateCode());
    const rows = codes.map((c) => ({
      user_id: context.userId,
      code_hash: hashCode(c),
    }));

    // 先删除旧的
    const del = await context.supabase
      .from("user_recovery_codes")
      .delete()
      .eq("user_id", context.userId);
    if (del.error) throw new Error(del.error.message);

    const ins = await context.supabase.from("user_recovery_codes").insert(rows);
    if (ins.error) throw new Error(ins.error.message);

    return { codes, generatedAt: new Date().toISOString() };
  });

/** 查询恢复码剩余数量与最近生成时间。 */
export const getRecoveryCodesStatus = createServerFn({ method: "GET" })
  .middleware([requireSentinelOwner])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_recovery_codes")
      .select("used_at, created_at")
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    const total = data?.length ?? 0;
    const remaining = (data ?? []).filter((r) => !r.used_at).length;
    const generatedAt = (data ?? [])
      .map((r) => r.created_at)
      .sort()
      .at(-1) ?? null;
    return { total, remaining, generatedAt };
  });
