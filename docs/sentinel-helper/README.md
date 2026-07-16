# sentinel-helper

Sentinel OS 的本地伴生守护进程 —— 负责启动/停止 Chrome，并通过 Playwright 附加到已启动的 Chrome 上执行步骤，把日志实时回传给 Web 前端。

## 为什么需要它

浏览器沙箱不能直接启动本机进程或读写本地文件。所有涉及"打开 Chrome / 用 Playwright 点点点 / 抓取页面数据"的动作，都由本机上运行的 `sentinel-helper` 完成，Web 端只发指令并订阅日志流。

## 快速开始

```bash
cd docs/sentinel-helper
npm install     # 会自动下载 Chromium（作为 Playwright 后备）
npm start       # 监听 http://127.0.0.1:9223
```

然后在 Sentinel OS 的 **设置 → 电脑操控 → Google Chrome → 开发者模式** 里：

1. 打开"启用完整 CDP 访问权限"
2. 保持默认 Helper 地址 `http://127.0.0.1:9223`
3. 点"启动 Chrome" — Helper 用 `--remote-debugging-port=9222` 拉起一个独立 profile 的 Chrome，并追加你所在源到 `--remote-allow-origins`
4. 面板自动探测 DevTools 端点，可达后进入 **Playwright 执行** 面板

## 复用登录态

Helper 启动 Chrome 时使用固定的 `--user-data-dir`（默认 `~/tmp/sentinel-chrome-profile`）。你在这个 Chrome 里手动登录任何网站后，登录态会持久保存；后续 Playwright 附加时直接复用当前 Context 和 Cookies，不需要再脚本化登录。

如果想改成使用你系统里的默认 profile，把 `userDataDir` 改成 Chrome 的实际数据目录（macOS：`~/Library/Application Support/Google/Chrome`；Windows：`%LOCALAPPDATA%\Google\Chrome\User Data`）。⚠️ 使用真实 profile 时请先退出所有 Chrome 窗口，否则会锁库。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/launch` | 启动 Chrome，`{ binaryPath?, host?, port?, userDataDir?, extraFlags?, remoteAllowOrigin? }` |
| POST | `/stop` | 结束由 Helper 启动的 Chrome 进程 |
| POST | `/playwright/run` | `{ attach:{host,port}, steps:Step[] }` → `{ runId }` |
| GET  | `/playwright/logs/:runId` | SSE 流；事件：`hello / log / step / result / done / error-event` |
| POST | `/playwright/cancel/:runId` | 请求取消运行 |
| GET  | `/fs/roots` | 返回允许根目录列表 |
| POST | `/fs/list` | `{ path }` → `{ path, parent, entries[] }` |
| POST | `/fs/read` | `{ path, encoding?, maxBytes? }` → `{ encoding, kind, size, content }` |
| POST | `/fs/write` | `{ path, content, encoding? }` (encoding: `utf8` \| `base64`) |
| POST | `/fs/mkdir` | `{ path }` |
| POST | `/fs/delete` | `{ path }` |

### 文件沙箱

`/fs/*` 只允许访问 **根目录白名单** 内的路径：默认 `~/SentinelFiles` 与系统临时目录。可用环境变量覆盖：

```bash
SENTINEL_HELPER_ROOTS="$HOME/Work:$HOME/Downloads" npm start
```

越权路径会返回 `路径不在允许根目录内`。

### 步骤 DSL

```ts
type Step =
  | { type: "goto"; target: string }                            // URL
  | { type: "open"; target: string }                            // 本地文件路径 → file:// URL
  | { type: "wait"; target: string; value?: string }            // selector, timeout ms
  | { type: "click"; target: string }                           // selector
  | { type: "fill"; target: string; value: string }             // selector, value
  | { type: "upload"; target: string; value: string }           // input[type=file] selector, 逗号/换行分隔的路径
  | { type: "press"; target: string }                           // key
  | { type: "screenshot"; target: string }                      // filename (无扩展名)
  | { type: "extract"; target: string; value?: string }         // selector, attr(留空=innerText)
  | { type: "eval"; target: string };                           // "() => document.title"
```

`target` / `value` 支持插值变量（在前端选中文件后自动替换）：
`{{file.path}}`、`{{file.name}}`、`{{file.dir}}`、`{{file.url}}`、`{{file.content}}`（仅文本文件）。

`upload` / `open` 路径必须位于 Helper 的根目录白名单内，否则会拒绝。

`extract` / `eval` 会作为 `result` 事件回传，其它步骤仅回 `log`。

## 安全提示

- Helper 只监听 `127.0.0.1`，不接受来自其它主机的请求。
- `eval` 步骤允许在页面上下文执行任意 JS，若担心误操作请自行改成允许白名单。
- Web 端与 Helper 之间没有鉴权，因为绑定在环回口；若要暴露到局域网，请先加 token。

## 常见问题

**"无法访问本地 Helper"** — 检查 9223 端口是否被占用：`lsof -i :9223`。

**Chrome 启动了但 DevTools 端点不通** — 老版本 Chrome 不支持 `--remote-allow-origins`，请升级到 111+；或临时把 `--remote-debugging-address` 换成 `0.0.0.0`（仅调试用）。

**Playwright 报 "Target closed"** — 你可能手动关掉了那个 Chrome 窗口。重新点"启动 Chrome"再运行。
