/**
 * MCP 连接 URL 脱敏。硬化版本 (P0-R2)：
 * - 白名单参数：仅这些 query 参数保留原值，其余一律 ***。
 * - 无法解析的输入返回 `[REDACTED_INVALID_URL]`，不保留原始片段。
 * - 剥离 fragment、basic-auth。
 */
const SAFE_PARAMS = new Set([
  "transport",
  "version",
  "protocol",
  "region",
  "channel",
  "format",
  "type",
  "mode",
]);

export function redactMcpUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[REDACTED_INVALID_URL]";
  }
  const params = new URLSearchParams(url.search);
  const next = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    next.append(k, SAFE_PARAMS.has(k.toLowerCase()) ? v : "***");
  }
  url.search = next.toString() ? `?${next.toString()}` : "";
  url.hash = "";
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  return url.toString();
}

/** 深度脱敏任意字符串（用于 last_error / logs / events）。 */
export function redactText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    // URL
    .replace(/https?:\/\/[^\s"')]+/gi, (m) => redactMcpUrl(m))
    // sk-... / pk-... / bearer 长 token
    .replace(/\b(sk|pk|bb|api|key|tok|tk|bearer)[-_][A-Za-z0-9_-]{12,}\b/gi, "***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer ***");
}
