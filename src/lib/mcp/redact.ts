/**
 * MCP 连接 URL 通常在 query string 里携带 API Key（例如
 * https://mcp.browserbase.com/mcp?browserbaseApiKey=sk-live-xxx）。
 * 直接把原始 URL 返回给客户端 / MCP 调用方会泄露密钥。
 *
 * redactMcpUrl 会保留 protocol / host / path，但把所有 query 值替换成
 * "***"（长度≥8 的值）或保持原样（短枚举值，例如 ?transport=sse）。
 * fragment 一律去掉。
 */
const KEY_LIKE_PARAMS = new Set([
  "apikey",
  "api_key",
  "apitoken",
  "api_token",
  "browserbaseapikey",
  "key",
  "token",
  "access_token",
  "auth",
  "authorization",
  "secret",
  "password",
  "pass",
  "sig",
  "signature",
]);

export function redactMcpUrl(raw: string | null | undefined): string {
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 无法解析——保守起见只保留前 24 个字符
    return raw.length > 24 ? raw.slice(0, 24) + "…" : raw;
  }
  const params = new URLSearchParams(url.search);
  const next = new URLSearchParams();
  for (const [k, v] of params.entries()) {
    const lower = k.toLowerCase();
    const looksLikeKey =
      KEY_LIKE_PARAMS.has(lower) ||
      lower.endsWith("key") ||
      lower.endsWith("token") ||
      lower.endsWith("secret") ||
      v.length >= 20;
    next.append(k, looksLikeKey ? "***" : v);
  }
  url.search = next.toString() ? `?${next.toString()}` : "";
  url.hash = "";
  // Basic auth 也可能带凭证
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  return url.toString();
}
