# 自主桌面控制器 V1 — 实施计划

## 产品定位

一个 **Web 控制台**，用户下达任务后，Agent 大脑自主循环思考并调用工具，通过 **MCP 协议** 操作外部世界（浏览器 / 桌面 / SaaS），全程用户零干预可观察。首版不自建远程沙箱，通过接入现成的 MCP server（Playwright MCP、browser-use MCP、用户自建 MCP）实现"操作电脑"能力。

## 核心架构

```text
┌─────────────────────────────────────────────────────┐
│  Web 控制台 (TanStack Start)                         │
│  ┌──────────────┬──────────────┬──────────────────┐ │
│  │ 任务输入     │ Agent 时间轴 │ MCP 工具面板     │ │
│  │ + 目标描述   │ 思考/工具    │ 已连接服务器     │ │
│  │              │ 调用/结果    │ 可用工具列表     │ │
│  └──────────────┴──────────────┴──────────────────┘ │
└──────────────────────────┬──────────────────────────┘
                           │  SSE stream
┌──────────────────────────▼──────────────────────────┐
│  /api/agent  (server route, streamText 循环)         │
│  Lovable AI Gateway → google/gemini-3.1-pro-preview  │
│  stopWhen: stepCountIs(50)                           │
│  tools = [内置工具..., ...MCP 动态工具]              │
└──────────────────────────┬──────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────┐
│  MCP 客户端层 (@ai-sdk/mcp)                          │
│  ├─ 内置托管: Playwright MCP (可选预设 URL)          │
│  └─ 用户自配: URL + OAuth/Token                      │
│  → 每次请求 client.tools() 动态注入                  │
└─────────────────────────────────────────────────────┘
```

## V1 功能范围

1. **任务控制台**：单栏对话式输入 + 目标/子目标显示。
2. **Agent 自主循环**：streamText + tool-calling，最多 50 步；每一步的 reasoning / tool call / tool result 实时流式渲染。
3. **MCP 连接管理**：
   - 页面：添加/删除 MCP server，测试连接，列出该 server 暴露的工具。
   - 两种模式：**托管**（后端预置常用 MCP URL，如 Playwright MCP 公共实例）+ **自定义**（用户粘贴 URL / 完成 OAuth）。
4. **运行历史**：每次任务保存到 Cloud DB — 目标、步骤流、最终产物，可回看。
5. **停止 / 中断**：AbortController 支持用户手动打断循环。
6. **危险操作确认**：写入类工具（提交表单、发消息）标记 `needsApproval`，UI 弹出批准框。

## 首版明确不做（排入后续）

- 自建远程浏览器沙箱（Docker + noVNC / Browserbase 集成）
- 多 Agent 协作 / 计划-执行分离架构
- 长任务后台运行 + 完成通知
- 团队协作 / 多用户共享 MCP

## 技术要点

- **后端**：TanStack Start server route `/api/agent`（流式）+ `createServerFn` 处理 MCP CRUD。
- **AI 模型**：Lovable AI Gateway，默认 `google/gemini-3.1-pro-preview`（长上下文 + 强工具调用）。
- **MCP**：`createMCPClient({ transport: { type: "http", url, authProvider } })`；每次调用打开短生命周期 client，`await client.tools()` 注入到 `streamText` tools，响应结束后关闭。
- **持久化**：Lovable Cloud
  - `mcp_connections`：id, user_id, name, url, state, auth 元数据
  - `agent_runs`：id, user_id, goal, status, created_at
  - `agent_events`：run_id, step_index, type(thinking/tool_call/tool_result), payload
- **鉴权**：Lovable Cloud 邮箱 + Google 登录，所有表 RLS 按 user_id 隔离。
- **UI**：AI Elements 消息流 + 工具调用可展开卡片，Tailwind + shadcn。

## 分阶段实施

**阶段 1 — 骨架（本轮）**
- 启用 Lovable Cloud + Auth（Email + Google）
- 数据表 + RLS + 迁移
- 空控制台布局（左：MCP 服务器列表 / 右：任务时间轴 / 底部：输入）
- 设计系统 tokens（深色科技感）

**阶段 2 — Agent 大脑**
- `/api/agent` 流式路由，Lovable AI Gateway 接入
- 前端 `useChat` 消费流，渲染 message.parts 中 text / tool-call / tool-result

**阶段 3 — MCP 接入**
- 添加 MCP 连接页（URL + 可选 OAuth）
- 后端在 agent 请求时聚合当前用户的 ready 连接工具
- 内置一到两个预置托管 MCP（如公共 Playwright MCP，若可用）

**阶段 4 — 历史 + 中断 + 审批**
- 运行持久化 + 回放
- Abort + needsApproval UX

---

**待确认后再动工**：
- 阶段 1 是否符合你的方向？还是要我先出几个 UI 设计方向（深色科技感 vs 极简 vs 终端 CLI 感）供你挑？
- 你之前说"我会给你几款功能"——如果有更具体的场景（例如"每天自动登录 X 网站抓 Y 数据"），告诉我后我在阶段 2/3 会针对性内置提示词模板和工具预设。
