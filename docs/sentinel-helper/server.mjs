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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

async function handleLaunch(body) {
  if (chromeProc && !chromeProc.killed) {
    return { ok: true, alreadyRunning: true, pid: chromeProc.pid };
  }
  const binary = body.binaryPath || defaultChromeBinary();
  const host = body.host || "127.0.0.1";
  const port = String(body.port || "9222");
  const userDataDir = body.userDataDir || path.join(os.tmpdir(), "sentinel-chrome-profile");
  const allowOrigin = body.remoteAllowOrigin || "*";
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${host}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-allow-origins=${allowOrigin}`,
  ];
  if (body.extraFlags) args.push(...String(body.extraFlags).split(/\s+/).filter(Boolean));
  const child = spawn(binary, args, { detached: false, stdio: "ignore" });
  child.on("exit", () => {
    if (chromeProc === child) chromeProc = null;
  });
  chromeProc = child;
  return { ok: true, pid: child.pid };
}

async function handleStop() {
  if (!chromeProc) return { ok: true, wasRunning: false };
  try {
    chromeProc.kill();
  } catch {
    /* ignore */
  }
  chromeProc = null;
  return { ok: true, wasRunning: true };
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

// ------- HTTP server -------
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
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
      const result = await handleStop();
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

    // Healthcheck
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
