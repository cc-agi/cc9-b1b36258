// sentinel-helper — local companion daemon for Sentinel OS
//
// Endpoints (default port 9223):
//   POST /launch                       -> spawn Chrome with --remote-debugging-port
//   POST /stop                         -> kill spawned Chrome
//   POST /playwright/run               -> start a Playwright run over CDP, returns { runId }
//   GET  /playwright/logs/:runId (SSE) -> stream run logs
//   POST /playwright/cancel/:runId     -> cancel a run
//
// Usage:
//   npm install
//   node server.mjs
//
// Configure the web UI to point at http://127.0.0.1:9223

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

const PORT = Number(process.env.SENTINEL_HELPER_PORT || 9223);

// ------- File sandbox -------
// Allowed roots for file browsing / read / write. Override with
// SENTINEL_HELPER_ROOTS="/path/a:/path/b" (":" or ";" separated).
const DEFAULT_ROOTS = [
  path.join(os.homedir(), "SentinelFiles"),
  os.tmpdir(),
];
const ROOTS = (process.env.SENTINEL_HELPER_ROOTS
  ? process.env.SENTINEL_HELPER_ROOTS.split(/[:;]/)
  : DEFAULT_ROOTS
)
  .map((p) => path.resolve(p))
  .filter(Boolean);

// Ensure default root exists.
for (const r of ROOTS) {
  try {
    await fs.mkdir(r, { recursive: true });
  } catch {
    /* ignore */
  }
}

function resolveSafe(p) {
  if (!p) throw new Error("path is required");
  const abs = path.resolve(p);
  const ok = ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) throw new Error(`路径不在允许根目录内: ${abs}`);
  return abs;
}

const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".log", ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".ini", ".toml", ".env", ".sql", ".py", ".go",
  ".rs", ".java", ".rb", ".php", ".vue", ".svelte",
]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

// ------- CORS -------
function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Chrome Private Network Access: HTTPS 页面访问 127.0.0.1 需要显式允许
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
}


async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ------- Chrome lifecycle -------
let chromeProc = null;

function defaultChromeBinary() {
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return "google-chrome";
}

function defaultUserDataDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "SentinelChromeProfile");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "SentinelChromeProfile");
  }
  return path.join(os.homedir(), ".config", "SentinelChromeProfile");
}

async function probeVersion(host, port, timeoutMs = 1000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host}:${port}/json/version`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.Browser && j.webSocketDebuggerUrl) return j;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function handleLaunch(body) {
  const host = body.host || "127.0.0.1";
  const port = String(body.port || "9222");

  // If a Chrome is already listening on the port, don't relaunch.
  const existing = await probeVersion(host, port, 800);
  if (existing) {
    const external = !chromeProc;
    return {
      ok: true,
      alreadyRunning: true,
      external,
      pid: chromeProc?.pid ?? null,
      browser: existing.Browser,
      webSocketDebuggerUrl: existing.webSocketDebuggerUrl,
      userDataDir: chromeProc ? chromeProc.__userDataDir : null,
    };
  }

  const binary = body.binaryPath || defaultChromeBinary();
  const userDataDir = body.userDataDir || defaultUserDataDir();
  await fs.mkdir(userDataDir, { recursive: true }).catch(() => {});
  const allowOrigin = body.remoteAllowOrigin || "*";
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-allow-origins=${allowOrigin}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (body.extraFlags) args.push(...String(body.extraFlags).split(/\s+/).filter(Boolean));
  const child = spawn(binary, args, { detached: false, stdio: "ignore" });
  child.__userDataDir = userDataDir;
  child.on("exit", () => {
    if (chromeProc === child) chromeProc = null;
  });
  chromeProc = child;

  // Poll /json/version until Chrome is ready (up to ~15s)
  const deadline = Date.now() + 15000;
  let info = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    info = await probeVersion(host, port, 800);
    if (info) break;
    if (child.exitCode !== null) break;
  }
  if (!info) {
    return {
      ok: false,
      error: "Chrome 启动后未能在 15s 内响应 /json/version",
      pid: child.pid,
      userDataDir,
      binary,
      args,
    };
  }
  return {
    ok: true,
    alreadyRunning: false,
    external: false,
    pid: child.pid,
    userDataDir,
    binary,
    browser: info.Browser,
    webSocketDebuggerUrl: info.webSocketDebuggerUrl,
  };
}

async function handleStop(body = {}) {
  const host = body.host || "127.0.0.1";
  const port = String(body.port || "9222");
  if (!chromeProc) {
    const info = await probeVersion(host, port, 500);
    if (info) {
      return {
        ok: true,
        wasRunning: false,
        external: true,
        message: "端口 9222 上的 Chrome 是外部启动，需手动关闭",
        browser: info.Browser,
      };
    }
    return { ok: true, wasRunning: false };
  }
  try {
    chromeProc.kill();
  } catch {
    /* ignore */
  }
  chromeProc = null;
  return { ok: true, wasRunning: true };
}

async function handleChromeStatus(body = {}) {
  const host = body.host || "127.0.0.1";
  const port = String(body.port || "9222");
  const info = await probeVersion(host, port, 800);
  if (!info) {
    return { ok: true, running: false, external: false, pid: chromeProc?.pid ?? null };
  }
  return {
    ok: true,
    running: true,
    external: !chromeProc,
    pid: chromeProc?.pid ?? null,
    userDataDir: chromeProc?.__userDataDir ?? null,
    browser: info.Browser,
    webSocketDebuggerUrl: info.webSocketDebuggerUrl,
  };
}


// ------- Playwright runs -------
const runs = new Map(); // runId -> { subscribers: Set<res>, cancelled, browser, context }

function emit(runId, event, payload) {
  const run = runs.get(runId);
  if (!run) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of run.subscribers) {
    try {
      res.write(data);
    } catch {
      /* ignore */
    }
  }
}

function log(runId, level, message) {
  emit(runId, "log", { level, message });
}

async function executeStep(runId, page, step, index) {
  emit(runId, "step", { index, type: step.type, target: step.target });
  switch (step.type) {
    case "goto":
      await page.goto(step.target, { waitUntil: "domcontentloaded" });
      log(runId, "ok", `已打开 ${page.url()}`);
      break;
    case "wait": {
      const timeout = Number(step.value) || 10000;
      await page.waitForSelector(step.target, { timeout });
      log(runId, "ok", `选择器出现: ${step.target}`);
      break;
    }
    case "click":
      await page.click(step.target);
      log(runId, "ok", `已点击 ${step.target}`);
      break;
    case "fill":
      await page.fill(step.target, step.value ?? "");
      log(runId, "ok", `已填写 ${step.target}`);
      break;
    case "upload": {
      const paths = String(step.value || "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (paths.length === 0) throw new Error("upload 步骤缺少文件路径 (value)");
      for (const p of paths) resolveSafe(p);
      await page.setInputFiles(step.target, paths);
      log(runId, "ok", `已上传 ${paths.length} 个文件到 ${step.target}`);
      break;
    }
    case "open": {
      const p = resolveSafe(step.target);
      const url = "file://" + (p.startsWith("/") ? p : "/" + p.replace(/\\/g, "/"));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      log(runId, "ok", `已打开本地文件 ${url}`);
      break;
    }
    case "press":
      await page.keyboard.press(step.target);
      log(runId, "ok", `已按键 ${step.target}`);
      break;
    case "screenshot": {
      const name = (step.target || `shot-${index}`).replace(/[^\w.-]/g, "_");
      const file = path.join(os.tmpdir(), `${name}.png`);
      await page.screenshot({ path: file });
      log(runId, "ok", `截图已保存: ${file}`);
      break;
    }
    case "extract": {
      const attr = (step.value || "").trim();
      const el = await page.$(step.target);
      if (!el) throw new Error(`未找到元素: ${step.target}`);
      const value = attr ? await el.getAttribute(attr) : (await el.innerText()).trim();
      emit(runId, "result", { key: `${step.target}${attr ? "@" + attr : ""}`, value });
      break;
    }
    case "eval": {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${step.target})`)();
      const value = await page.evaluate(fn);
      emit(runId, "result", { key: "eval", value });
      break;
    }
    default:
      throw new Error(`未知步骤类型: ${step.type}`);
  }
}

async function handleRun(body) {
  const runId = randomUUID();
  runs.set(runId, { subscribers: new Set(), cancelled: false });

  // Start async
  (async () => {
    const run = runs.get(runId);
    const attach = body.attach || { host: "127.0.0.1", port: "9222" };
    const wsBase = `http://${attach.host}:${attach.port}`;
    const started = Date.now();

    // Wait briefly for at least one subscriber so the earliest logs aren't lost.
    for (let i = 0; i < 40 && run.subscribers.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    log(runId, "info", `附加到 CDP: ${wsBase}`);

    let browser;
    try {
      browser = await chromium.connectOverCDP(wsBase);
      run.browser = browser;
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = context.pages()[0] || (await context.newPage());
      log(runId, "ok", `已附加，页面 ${context.pages().length} · ${page.url()}`);

      const steps = Array.isArray(body.steps) ? body.steps : [];
      for (let i = 0; i < steps.length; i++) {
        if (run.cancelled) {
          log(runId, "warn", "已取消");
          break;
        }
        await executeStep(runId, page, steps[i], i);
      }
      emit(runId, "done", { ms: Date.now() - started });
    } catch (e) {
      emit(runId, "error-event", { message: e?.message || String(e) });
    } finally {
      try {
        // connectOverCDP: do not close() the real browser; just detach.
        // playwright disconnects when Node exits or via browser.close() on the CDP session.
        await browser?.close();
      } catch {
        /* ignore */
      }
      // Give SSE a moment to flush, then close subscribers.
      setTimeout(() => {
        const r = runs.get(runId);
        if (!r) return;
        for (const res of r.subscribers) {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        }
        runs.delete(runId);
      }, 500);
    }
  })();

  return { runId };
}

// ------- File system operations -------
async function handleFsRoots() {
  const entries = await Promise.all(
    ROOTS.map(async (r) => {
      try {
        const st = await fs.stat(r);
        return { path: r, exists: true, isDirectory: st.isDirectory() };
      } catch {
        return { path: r, exists: false, isDirectory: false };
      }
    }),
  );
  return { roots: entries };
}

async function handleFsList(body) {
  const dir = resolveSafe(body.path || ROOTS[0]);
  const st = await fs.stat(dir);
  if (!st.isDirectory()) throw new Error("不是目录");
  const items = await fs.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    items.map(async (it) => {
      const full = path.join(dir, it.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = await fs.stat(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        /* ignore */
      }
      return {
        name: it.name,
        path: full,
        isDirectory: it.isDirectory(),
        size,
        mtime,
        kind: it.isDirectory() ? "dir" : kindOf(it.name),
      };
    }),
  );
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: dir, parent: path.dirname(dir), entries };
}

async function handleFsRead(body) {
  const file = resolveSafe(body.path);
  const st = await fs.stat(file);
  if (st.isDirectory()) throw new Error("不能读取目录");
  const maxBytes = Number(body.maxBytes) || 2 * 1024 * 1024;
  if (st.size > maxBytes) {
    throw new Error(`文件过大 (${st.size} bytes)，超过 ${maxBytes}`);
  }
  const buf = await fs.readFile(file);
  const kind = kindOf(file);
  const encoding = body.encoding || (kind === "text" ? "utf8" : "base64");
  if (encoding === "utf8") {
    return { path: file, encoding: "utf8", size: st.size, kind, content: buf.toString("utf8") };
  }
  return { path: file, encoding: "base64", size: st.size, kind, content: buf.toString("base64") };
}

async function handleFsWrite(body) {
  const file = resolveSafe(body.path);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const encoding = body.encoding || "utf8";
  const buf =
    encoding === "base64"
      ? Buffer.from(String(body.content || ""), "base64")
      : Buffer.from(String(body.content || ""), "utf8");
  await fs.writeFile(file, buf);
  const st = await fs.stat(file);
  return { ok: true, path: file, size: st.size };
}

async function handleFsMkdir(body) {
  const dir = resolveSafe(body.path);
  await fs.mkdir(dir, { recursive: true });
  return { ok: true, path: dir };
}

async function handleFsDelete(body) {
  const target = resolveSafe(body.path);
  if (ROOTS.includes(target)) throw new Error("不能删除根目录");
  await fs.rm(target, { recursive: true, force: true });
  return { ok: true, path: target };
}

// ------- HTTP server -------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    // Echo PNA header explicitly when Chrome asks for it (belt & suspenders — setCors already sets it).
    if (req.headers["access-control-request-private-network"]) {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    res.writeHead(204);
    res.end();
    return;
  }


  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- launch/stop ----
    if (req.method === "POST" && pathname === "/launch") {
      const body = await readJson(req);
      const result = await handleLaunch(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/stop") {
      const body = await readJson(req).catch(() => ({}));
      const result = await handleStop(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && pathname === "/chrome/status") {
      const body = req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
      const result = await handleChromeStatus(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }


    // ---- playwright ----
    if (req.method === "POST" && pathname === "/playwright/run") {
      const body = await readJson(req);
      const result = await handleRun(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    const cancelMatch = pathname.match(/^\/playwright\/cancel\/([^/]+)$/);
    if (req.method === "POST" && cancelMatch) {
      const run = runs.get(cancelMatch[1]);
      if (run) run.cancelled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const logsMatch = pathname.match(/^\/playwright\/logs\/([^/]+)$/);
    if (req.method === "GET" && logsMatch) {
      const runId = logsMatch[1];
      let run = runs.get(runId);
      if (!run) {
        // Allow the client to subscribe before the async run has registered its subscribers.
        run = { subscribers: new Set(), cancelled: false };
        runs.set(runId, run);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": origin || "*",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ runId })}\n\n`);
      run.subscribers.add(res);
      req.on("close", () => {
        run.subscribers.delete(res);
      });
      return;
    }

    // ---- filesystem ----
    if (req.method === "GET" && pathname === "/fs/roots") {
      const result = await handleFsRoots();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/fs/list") {
      const result = await handleFsList(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/fs/read") {
      const result = await handleFsRead(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/fs/write") {
      const result = await handleFsWrite(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/fs/mkdir") {
      const result = await handleFsMkdir(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.method === "POST" && pathname === "/fs/delete") {
      const result = await handleFsDelete(await readJson(req));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "sentinel-helper", ok: true, port: PORT }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e?.message || String(e) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`sentinel-helper listening on http://127.0.0.1:${PORT}`);
});
