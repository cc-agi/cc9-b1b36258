# 对接外部 MCP Server (单向调用)

本系统作为 MCP Client,连接对方平台已就绪的 Streamable HTTP + Supabase OAuth 2.1 MCP Server。每个用户各自在本系统里完成 OAuth 授权,授权 token 加密保存到本系统数据库;用户点按钮时,后端用该用户的 token 调用对方 MCP 工具并把结果返回前端。

## 目标 MCP Server 信息

- Endpoint: `https://qjihfiixqkfjaxelfuia.supabase.co/functions/v1/mcp`
- Transport: Streamable HTTP (MCP 2025-06-18)
- Auth: OAuth 2.1 + Dynamic Client Registration
- Issuer: `https://qjihfiixqkfjaxelfuia.supabase.co/auth/v1`
- 常用工具: `search_resources` / `get_mcp_detail` / `list_categories` 等

## 架构

```text
用户浏览器
  ↓ 点"连接 cc6"按钮
  → server fn: startConnect  →  返回 OAuth authorize URL
  ↓ 新窗口打开 authorize URL,用户在 cc6 完成登录+consent
  → 回调 /api/oauth/cc6/callback (server route)  →  用 code 换 token  →  加密写入 user_mcp_connections
  ↓ 弹窗关闭,前端刷新连接状态
  → 用户点"调用工具 X"
  → server fn: callMcpTool  →  加载该用户 token  →  createMCPClient  →  client.tools()[name].execute()
  → 结果返回前端渲染
```

## 数据模型 (新增 migration)

```sql
CREATE TABLE public.user_mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  server_id text NOT NULL,               -- 常量 'cc6'
  server_url text NOT NULL,
  issuer text NOT NULL,
  tokens_ciphertext text NOT NULL,       -- 加密后的 {access_token, refresh_token, expires_at}
  client_registration_ciphertext text,   -- DCR 结果 (client_id/secret)
  state text NOT NULL DEFAULT 'ready',   -- ready | authenticating | failed
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, server_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_mcp_connections TO service_role;
ALTER TABLE public.user_mcp_connections ENABLE ROW LEVEL SECURITY;
-- 只有 service_role 通过 supabaseAdmin 读写,不给 anon/authenticated 授权

CREATE TABLE public.mcp_oauth_pending (
  state text PRIMARY KEY,               -- OAuth state 参数
  user_id uuid NOT NULL,
  server_id text NOT NULL,
  code_verifier text NOT NULL,          -- PKCE
  client_registration_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.mcp_oauth_pending TO service_role;
ALTER TABLE public.mcp_oauth_pending ENABLE ROW LEVEL SECURITY;
```

Secret: 用 `generate_secret` 生成 `MCP_TOKEN_ENC_KEY` (32 字节 base64),用来 AES-GCM 加密 token/client_registration。

## 依赖

`bun add ai @ai-sdk/mcp` (若 @ai-sdk/mcp 与安全窗口冲突,加入 bunfig 的 `minimumReleaseAgeExcludes`)。

## 新增文件

1. `supabase/migrations/<ts>_user_mcp_connections.sql` — 上面两张表
2. `src/lib/mcp/crypto.server.ts` — AES-GCM 加解密 (读 `process.env.MCP_TOKEN_ENC_KEY`)
3. `src/lib/mcp/registry.server.ts` — DCR、discovery、token 交换、token 刷新 (原生 fetch,不引 SDK)
4. `src/lib/mcp/connections.server.ts` — 读写 `user_mcp_connections` / `mcp_oauth_pending`,自动刷新过期 token
5. `src/lib/mcp/client.server.ts` — `createMcpClientForUser(userId)`: 载入 token → 用 `@ai-sdk/mcp` `createMCPClient({ transport: { type:"http", url, authProvider }, redirect:"error" })`
6. `src/lib/mcp/cc6.functions.ts` — 三个 server fn:
   - `getCc6Status()` — 返回是否已授权
   - `startCc6Connect()` — 生成 PKCE + DCR + 写 pending + 返回 authorize URL
   - `callCc6Tool({ name, args })` — 加载 client → `await client.tools()` → 调用 → 关闭 client → 返回结果
   - `disconnectCc6()` — 删连接
   全部挂 `.middleware([requireSupabaseAuth])`
7. `src/routes/api/oauth.cc6.callback.ts` — server route (public 前缀不需要,登录用户回调),接收 `code`+`state`,查 pending,POST token,加密入库,重定向到 `/console?cc6=connected`,渲染一个自关闭的小 HTML
8. 前端: 在插件详情弹窗 (MCP tab 里 cc6 卡片) 新增"连接 / 断开 / 调用工具"按钮组;新增 `Cc6Panel` 组件,列出可用工具并允许输入参数、显示结果

## 前端交互

- MCP 市场卡片"cc6" (新增到 MARKET_MCPS): 详情弹窗底部新增 `Cc6ConnectSection`
  - 未授权: 显示"连接 cc6"按钮 → 调 `startCc6Connect` → `window.open(authorizeUrl, 'cc6-oauth', 'width=520,height=640')`
  - 已授权: 显示绿色"已连接"+"断开"
  - 通过 `useQuery(['cc6-status'], getCc6Status)` 同步状态;`window` 上监听回调页发的 `postMessage('cc6-connected')` 后 `invalidateQueries`
- 详情弹窗新增"工具"区: 6 个公开工具按钮,点击弹参数表单 → 调 `callCc6Tool` → 结果 JSON 折叠展示

## 安全

- `redirect: "error"` 传给 MCP HTTP transport
- `server_url` 白名单硬编码只允许 `https://qjihfiixqkfjaxelfuia.supabase.co/functions/v1/mcp`
- token 只在 server fn 内解密,永不返回给浏览器
- 每次 `callCc6Tool` 结束 `await client.close()`(在 finally 里)
- pending 记录 10 分钟后视为过期,回调时校验

## 验收

- 未登录本系统: 弹窗按钮 disabled + 提示登录
- 首次点击"连接": 打开对方 consent 页,授权后自动关窗,状态变已连接
- 刷新页面后连接仍在
- 点击工具按钮能返回真实数据 (Playwright 截图)
- 断开后 token 从库删除,再调用返回未授权

## 需要你确认

1. 允许我在本项目 Cloud 里新增上述两张表 + `MCP_TOKEN_ENC_KEY` secret 吗?
2. 前端入口就放在现在的插件市场 MCP tab → "cc6" 卡片详情弹窗里,可以吗? 还是希望在侧边栏或主界面再加一个专门入口?
3. 首批工具只暴露 6 个公开只读工具即可,`search_my_capabilities` 等需要 OAuth 后才能用的工具也暴露吗?
