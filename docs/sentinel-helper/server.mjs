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

import fsSync from "node:fs";

function browserCandidates() {
  const home = os.homedir();
  const localAppData =
    process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
  const programFilesX86 =
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  const list = [];
  if (process.platform === "win32") {
    list.push(
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
    // Playwright bundled Chromium: %LOCALAPPDATA%\ms-playwright\chromium-*\chrome-win64\chrome.exe
    try {
      const pwRoot = path.join(localAppData, "ms-playwright");
      for (const name of fsSync.readdirSync(pwRoot)) {
        if (name.startsWith("chromium")) {
          list.push(path.join(pwRoot, name, "chrome-win64", "chrome.exe"));
          list.push(path.join(pwRoot, name, "chrome-win", "chrome.exe"));
        }
      }
    } catch {
      /* ignore */
    }
  } else if (process.platform === "darwin") {
    list.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    list.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    );
  }
  return list;
}

function existsSyncSafe(p) {
  try {
    return fsSync.existsSync(p);
  } catch {
    return false;
  }
}

function detectBrowser() {
  const candidates = browserCandidates();
  const results = candidates.map((p) => ({ path: p, exists: existsSyncSafe(p) }));
  const detected = results.find((r) => r.exists)?.path ?? null;
  return { detected, candidates: results };
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
      protocolVersion: existing["Protocol-Version"],
      webSocketDebuggerUrl: existing.webSocketDebuggerUrl,
      userDataDir: chromeProc ? chromeProc.__userDataDir : null,
    };
  }

  // Resolve executable: explicit binaryPath > auto-detected candidate.
  // Never fall back to a bare `chrome` command that relies on PATH.
  let binary = body.binaryPath && String(body.binaryPath).trim();
  if (binary && !existsSyncSafe(binary)) {
    return {
      ok: false,
      error: `指定的浏览器可执行文件不存在: ${binary}`,
      triedBinary: binary,
    };
  }
  if (!binary) {
    const detection = detectBrowser();
    if (!detection.detected) {
      return {
        ok: false,
        error:
          "未找到任何 Chrome/Edge/Chromium 可执行文件，请在设置中填写「浏览器可执行文件路径」",
        candidates: detection.candidates,
      };
    }
    binary = detection.detected;
  }

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
  let child;
  try {
    child = spawn(binary, args, { detached: false, stdio: "ignore" });
  } catch (e) {
    return {
      ok: false,
      error: `启动失败: ${e?.message || String(e)}`,
      binary,
      args,
    };
  }
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
    protocolVersion: info["Protocol-Version"],
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

const GOTO_TIMEOUT_MS = 20000;
const CLICK_NAV_TIMEOUT_MS = 5000;
const CLICKABLE_SELECTOR = 'a[href], button, [role="menuitem"], [role="link"], [onclick]';
const TEXT_ONLY_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "SPAN", "P", "DIV"]);

class StepError extends Error {
  constructor(errorCode, message) {
    super(`[${errorCode}] ${message}`);
    this.errorCode = errorCode;
  }
}

function extractTextHint(target = "") {
  const s = String(target || "").trim();
  const hasText = s.match(/:has-text\((['"])(.*?)\1\)/i);
  if (hasText?.[2]) return hasText[2].trim();
  const textEq = s.match(/^text\s*=\s*(['"]?)(.*?)\1$/i);
  if (textEq?.[2]) return textEq[2].trim();
  const quoted = s.match(/(['"])([^'"]{1,80})\1/);
  if (quoted?.[2] && /[\p{Script=Han}\w]/u.test(quoted[2])) return quoted[2].trim();
  if (/^[\p{Script=Han}\w\s·・（）()\-]{1,40}$/u.test(s)) return s;
  return "";
}

function isAlibabaHost(hostname = "") {
  const h = String(hostname || "").toLowerCase();
  return h === "alibaba.com" || h.endsWith(".alibaba.com") || h.endsWith(".1688.com");
}

function urlsEquivalent(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b, ua.href);
    ua.hash = "";
    ub.hash = "";
    return ua.href === ub.href;
  } catch {
    return false;
  }
}

async function hrefExistsInDom(page, requestedUrl) {
  const values = [];
  for (const frame of page.frames()) {
    try {
      const hrefs = await frame.evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .map((a) => a.href)
          .filter(Boolean)
          .slice(0, 2000),
      );
      values.push(...hrefs);
    } catch {
      /* cross-origin / detached frame */
    }
  }
  return values.some((href) => urlsEquivalent(href, requestedUrl));
}

async function shouldBlockGuessedGoto(page, requestedUrl) {
  let current;
  let requested;
  try {
    current = new URL(page.url());
    requested = new URL(requestedUrl, current.href);
  } catch {
    return { block: false };
  }
  if (!isAlibabaHost(current.hostname) || !isAlibabaHost(requested.hostname)) return { block: false };
  if (urlsEquivalent(current.href, requested.href)) return { block: false };
  const exists = await hrefExistsInDom(page, requested.href);
  if (exists) return { block: false };
  return {
    block: true,
    errorCode: "GUESSED_URL_BLOCKED",
    message: "Alibaba 后台内部地址必须来自当前 DOM 中的真实 href，禁止根据菜单文字猜测 URL。",
  };
}

async function documentSnapshot(scope) {
  try {
    return await scope.evaluate(() => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const active = Array.from(
        document.querySelectorAll(
          '[aria-current="page"], [aria-selected="true"], .active, .selected, .current, [class*="active"], [class*="selected"]',
        ),
      )
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .map((el) => clean(el.textContent))
        .filter(Boolean)
        .slice(0, 12)
        .join(" | ");
      const mainTitle = clean(
        document.querySelector('main h1, main h2, [role="main"] h1, [role="main"] h2, h1, h2')?.textContent,
      );
      const keyText = clean(document.body?.innerText).slice(0, 1000);
      return { title: document.title || "", mainTitle, active, keyText };
    });
  } catch {
    return { title: "", mainTitle: "", active: "", keyText: "" };
  }
}

function snapshotChanged(before, after) {
  return Boolean(
    before.title !== after.title ||
      before.mainTitle !== after.mainTitle ||
      before.active !== after.active ||
      before.keyText !== after.keyText,
  );
}

async function collectCandidatesInFrame(frame, frameIndex, target) {
  const textHint = extractTextHint(target);
  return await frame.evaluate(
    ({ target, textHint, frameIndex, clickableSelector }) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      };
      const cssPath = (el) => {
        if (!el || !(el instanceof Element)) return "";
        const parts = [];
        let cur = el;
        for (let depth = 0; cur && cur.nodeType === 1 && depth < 7; depth += 1) {
          let sel = cur.tagName.toLowerCase();
          if (cur.id) {
            sel += `#${CSS.escape(cur.id)}`;
            parts.unshift(sel);
            break;
          }
          const role = cur.getAttribute("role");
          if (role && ["navigation", "menu", "menuitem", "link"].includes(role)) {
            sel += `[role="${role}"]`;
          }
          const parent = cur.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
            if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
          }
          parts.unshift(sel);
          cur = parent;
        }
        return parts.join(" > ");
      };
      const ownText = (el) =>
        clean(
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent || "")
            .join(" "),
        );
      const elementText = (el) =>
        clean(el.getAttribute("aria-label") || el.getAttribute("title") || ownText(el) || el.textContent || "");
      const scopeKind = (el) => {
        if (el.closest("nav")) return "nav";
        if (el.closest("aside")) return "aside";
        if (el.closest('[role="navigation"]')) return "role=navigation";
        if (el.closest('[role="menu"]')) return "role=menu";
        const side = el.closest("[data-sentinel-left-fixed]");
        if (side) return "visible-left-fixed";
        return "global";
      };
      const clickablePriority = (el, matched) => {
        if (!el) return 99;
        if (el.matches("a[href]")) return 1;
        if (el.matches("button")) return 2;
        if (el.matches('[role="menuitem"]')) return 3;
        if (el.matches('[role="link"]')) return 4;
        if (el.matches("[onclick]")) return 5;
        return el === matched ? 9 : 6;
      };
      const clickableInfo = (matched) => {
        const exact = matched.matches(clickableSelector) ? matched : null;
        const closest = matched.closest(clickableSelector);
        const el = exact || closest;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: elementText(el).slice(0, 160),
          href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href") || "",
          selector: cssPath(el),
          priority: clickablePriority(el, matched),
          boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      };
      const addLeftFixedMarkers = () => {
        for (const el of Array.from(document.body?.querySelectorAll("*") || [])) {
          const r = el.getBoundingClientRect();
          if (r.left <= 8 && r.width >= 80 && r.width <= 420 && r.height >= Math.min(240, window.innerHeight * 0.45)) {
            const pos = window.getComputedStyle(el).position;
            if (["fixed", "sticky", "absolute"].includes(pos)) el.setAttribute("data-sentinel-left-fixed", "true");
          }
        }
      };
      addLeftFixedMarkers();
      const scopes = Array.from(
        document.querySelectorAll('nav, aside, [role="navigation"], [role="menu"], [data-sentinel-left-fixed]'),
      ).filter(isVisible);
      const scopeSet = new Set(scopes);
      const selectorMatches = [];
      try {
        selectorMatches.push(...Array.from(document.querySelectorAll(target)));
      } catch {
        /* Playwright-only selector or plain text */
      }
      const all = Array.from(document.querySelectorAll("body *"));
      const textMatches = textHint
        ? all.filter((el) => {
            if (!isVisible(el)) return false;
            const txt = elementText(el);
            if (!txt || txt.length > 180) return false;
            return txt.includes(textHint);
          })
        : [];
      const seen = new Set();
      const merged = [...selectorMatches, ...textMatches].filter((el) => {
        if (!el || seen.has(el)) return false;
        seen.add(el);
        return true;
      });
      const candidates = merged.map((el, order) => {
        const r = el.getBoundingClientRect();
        const clickable = clickableInfo(el);
        const inPreferredScope = scopes.some((scope) => scope === el || scope.contains(el));
        const kind = scopeKind(el);
        return {
          frameIndex,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: elementText(el).slice(0, 240),
          href: el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href") || "",
          isVisible: isVisible(el),
          boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
          clickableAncestor: clickable,
          clickableSelector: clickable?.selector || "",
          containerPath: cssPath(el.parentElement || el),
          selector: cssPath(el),
          scope: inPreferredScope ? kind : "global",
          isPreferredScope: inPreferredScope,
          isPureTextElement: ["h1", "h2", "h3", "h4", "h5", "h6", "span", "p"].includes(el.tagName.toLowerCase()),
          order,
          score:
            (inPreferredScope ? 0 : 100) +
            (clickable?.priority ?? 99) +
            (clean(el.textContent) === textHint ? -5 : 0) +
            (kind === "global" ? 20 : 0),
        };
      });
      candidates.sort((a, b) => a.score - b.score || a.order - b.order);
      return {
        candidates: candidates.slice(0, 40),
        frame: { frameIndex, url: location.href, title: document.title || "" },
        scopeCount: scopeSet.size,
        textHint,
      };
    },
    { target, textHint, frameIndex, clickableSelector: CLICKABLE_SELECTOR },
  );
}

async function inspectCandidates(page, target) {
  const frames = [];
  const candidates = [];
  const allFrames = page.frames();
  for (let i = 0; i < allFrames.length; i += 1) {
    const frame = allFrames[i];
    try {
      const result = await collectCandidatesInFrame(frame, i, target);
      frames.push(result.frame);
      candidates.push(...result.candidates.map((c) => ({ ...c, frameUrl: result.frame.url, frameTitle: result.frame.title })));
    } catch (e) {
      frames.push({ frameIndex: i, url: frame.url(), title: "", error: e?.message || String(e) });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.frameIndex - b.frameIndex || a.order - b.order);
  return { target, textHint: extractTextHint(target), frames, candidates: candidates.slice(0, 60) };
}

async function waitForClickChange(page, frame, beforePage, beforeFrame, timeoutMs) {
  const startedUrl = page.url();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const pageAfter = await documentSnapshot(page);
    const frameAfter = frame === page.mainFrame() ? pageAfter : await documentSnapshot(frame);
    if (page.url() !== startedUrl) return { ok: true, reason: "url_changed", pageAfter, frameAfter };
    if (snapshotChanged(beforePage, pageAfter)) return { ok: true, reason: "main_content_changed", pageAfter, frameAfter };
    if (snapshotChanged(beforeFrame, frameAfter)) return { ok: true, reason: "frame_content_changed", pageAfter, frameAfter };
  }
  const pageAfter = await documentSnapshot(page);
  const frameAfter = frame === page.mainFrame() ? pageAfter : await documentSnapshot(frame);
  return { ok: false, reason: "CLICK_NO_NAVIGATION", pageAfter, frameAfter };
}

async function smartClick(page, target, runId, index) {
  const started = Date.now();
  const inspection = await inspectCandidates(page, target);
  emit(runId, "result", { key: "clickCandidates", value: inspection });
  log(runId, "info", `候选元素 ${inspection.candidates.length} · frames ${inspection.frames.length}`);
  const eligible = inspection.candidates.filter((c) => c.isVisible && c.clickableSelector && c.clickableAncestor);
  if (eligible.length === 0) {
    const file = path.join(os.tmpdir(), `click_no_candidate_${index}_${Date.now()}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    const value = {
      ok: false,
      errorCode: "CLICK_NO_CANDIDATE",
      error: `未找到可点击候选元素: ${target}`,
      target,
      candidates: inspection.candidates,
      frames: inspection.frames,
      screenshot: file,
      finalUrl: page.url(),
      title: await page.title().catch(() => ""),
      durationMs: Date.now() - started,
    };
    emit(runId, "result", { key: "click", value });
    throw new StepError("CLICK_NO_CANDIDATE", value.error);
  }

  const attempts = [];
  const frames = page.frames();
  for (const candidate of eligible.slice(0, 3)) {
    const frame = frames[candidate.frameIndex];
    if (!frame) continue;
    const beforePage = await documentSnapshot(page);
    const beforeFrame = frame === page.mainFrame() ? beforePage : await documentSnapshot(frame);
    const beforeUrl = page.url();
    const beforeTitle = await page.title().catch(() => "");
    const attempt = {
      candidate,
      frameIndex: candidate.frameIndex,
      frameUrl: candidate.frameUrl,
      clickedSelector: candidate.clickableSelector,
      clickedElement: candidate.clickableAncestor,
      beforeUrl,
      beforeTitle,
    };
    try {
      log(runId, "info", `点击候选 frame=${candidate.frameIndex} ${candidate.clickableAncestor.tagName} ${candidate.clickableAncestor.text}`);
      const locator = frame.locator(candidate.clickableSelector).first();
      await locator.click({ timeout: 3000 });
      const change = await waitForClickChange(page, frame, beforePage, beforeFrame, CLICK_NAV_TIMEOUT_MS);
      const afterTitle = await page.title().catch(() => "");
      Object.assign(attempt, {
        ok: change.ok,
        navigationReason: change.reason,
        finalUrl: page.url(),
        title: afterTitle,
      });
      attempts.push(attempt);
      if (change.ok) {
        const value = {
          ok: true,
          target,
          clicked: candidate.clickableAncestor,
          clickedSelector: candidate.clickableSelector,
          frameIndex: candidate.frameIndex,
          frameUrl: candidate.frameUrl,
          frameTitle: candidate.frameTitle,
          finalUrl: page.url(),
          title: afterTitle,
          durationMs: Date.now() - started,
          navigation: { reason: change.reason, beforeUrl, afterUrl: page.url(), beforeTitle, afterTitle },
          candidates: inspection.candidates,
          frames: inspection.frames,
          attempts,
        };
        emit(runId, "result", { key: "click", value });
        log(runId, "ok", `已点击并检测到变化: ${change.reason} · ${page.url()}`);
        return;
      }
      const shot = path.join(os.tmpdir(), `click_no_navigation_${index}_${attempts.length}_${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      attempt.screenshot = shot;
      log(runId, "warn", `CLICK_NO_NAVIGATION，尝试下一个候选 · 截图 ${shot}`);
    } catch (e) {
      attempt.ok = false;
      attempt.errorCode = "CLICK_FAILED";
      attempt.error = e?.message || String(e);
      attempts.push(attempt);
      log(runId, "warn", `点击候选失败: ${attempt.error}`);
    }
  }
  const shot = path.join(os.tmpdir(), `click_failed_${index}_${Date.now()}.png`);
  await page.screenshot({ path: shot }).catch(() => {});
  const last = attempts[attempts.length - 1];
  const anyClicked = attempts.some((a) => a.clickedElement);
  const errorCode = anyClicked ? "CLICK_NO_NAVIGATION" : "CLICK_FAILED";
  const value = {
    ok: false,
    errorCode,
    error: anyClicked ? `点击后 ${CLICK_NAV_TIMEOUT_MS}ms 内未检测到 URL / 标题 / active / 主内容变化` : `候选元素均点击失败: ${target}`,
    target,
    clicked: last?.clickedElement ?? null,
    clickedSelector: last?.clickedSelector ?? "",
    finalUrl: page.url(),
    title: await page.title().catch(() => ""),
    durationMs: Date.now() - started,
    screenshot: shot,
    candidates: inspection.candidates,
    frames: inspection.frames,
    attempts,
  };
  emit(runId, "result", { key: "click", value });
  throw new StepError(errorCode, value.error);
}

async function executeStep(runId, page, step, index) {
  emit(runId, "step", { index, type: step.type, target: step.target });
  switch (step.type) {
    case "goto": {
      const requestedUrl = step.target;
      const started = Date.now();
      const beforeUrl = page.url();
      const block = await shouldBlockGuessedGoto(page, requestedUrl);
      if (block.block) {
        const durationMs = Date.now() - started;
        const finalUrl = page.url();
        const title = await page.title().catch(() => "");
        emit(runId, "result", {
          key: "goto",
          value: {
            ok: false,
            errorCode: block.errorCode,
            error: block.message,
            requestedUrl,
            finalUrl,
            title,
            durationMs,
            navigationState: "blocked_not_in_dom_href",
          },
        });
        throw new StepError(block.errorCode, block.message);
      }
      try {
        const response = await page.goto(requestedUrl, {
          waitUntil: "domcontentloaded",
          timeout: GOTO_TIMEOUT_MS,
        });
        const durationMs = Date.now() - started;
        const finalUrl = page.url();
        let title = "";
        try { title = await page.title(); } catch { /* ignore */ }
        const navigationState = response?.url() && !urlsEquivalent(response.url(), requestedUrl)
          ? "redirected"
          : "domcontentloaded";
        emit(runId, "result", {
          key: "goto",
          value: { ok: true, requestedUrl, finalUrl, title, durationMs, navigationState },
        });
        log(runId, "ok", `已打开 ${finalUrl} (${durationMs}ms)`);
      } catch (e) {
        const durationMs = Date.now() - started;
        const msg = e?.message || String(e);
        const errorCode = /Timeout/i.test(msg)
          ? "TIMEOUT"
          : /net::ERR_NAME_NOT_RESOLVED/i.test(msg)
          ? "DNS_ERROR"
          : /net::ERR_/i.test(msg)
          ? "NET_ERROR"
          : "GOTO_FAILED";
        let finalUrl = "";
        let title = "";
        let bodyText = "";
        try { finalUrl = page.url(); } catch { /* ignore */ }
        try { title = await page.title(); } catch { /* ignore */ }
        try { bodyText = await page.locator("body").innerText({ timeout: 1000 }); } catch { /* ignore */ }
        const hasRenderedPage = Boolean(finalUrl && finalUrl !== beforeUrl && (title || bodyText.trim().length > 0));
        emit(runId, "result", {
          key: "goto",
          value: {
            ok: hasRenderedPage,
            errorCode: hasRenderedPage ? "TIMEOUT_WITH_PAGE" : errorCode,
            error: msg,
            requestedUrl,
            finalUrl,
            title,
            durationMs,
            navigationState: hasRenderedPage ? "timeout_with_page" : "timeout",
          },
        });
        if (hasRenderedPage) {
          log(runId, "warn", `导航超时但页面已渲染: ${finalUrl} (${durationMs}ms)`);
          break;
        }
        throw new StepError(errorCode, msg);
      }
      break;
    }
    case "inspectCandidates": {
      const started = Date.now();
      const result = await inspectCandidates(page, step.target);
      emit(runId, "result", {
        key: "inspectCandidates",
        value: {
          ok: true,
          ...result,
          finalUrl: page.url(),
          title: await page.title().catch(() => ""),
          durationMs: Date.now() - started,
        },
      });
      log(runId, "ok", `已检查候选: ${result.candidates.length}`);
      break;
    }
    case "wait": {
      const timeout = Number(step.value) || 10000;
      await page.waitForSelector(step.target, { timeout });
      log(runId, "ok", `选择器出现: ${step.target}`);
      break;
    }
    case "click":
      await smartClick(page, step.target, runId, index);
      break;
    case "fill":
      await page.fill(step.target, step.value ?? "", { timeout: 15000 });
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
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

// Locate or create the Sentinel automation page. We tag one page in the CDP
// context via window.__sentinelAutomation__ so subsequent runs reuse it
// instead of hijacking whatever tab happens to be at index 0.
const AUTOMATION_MARKER = "__sentinelAutomation__";
async function pickAutomationPage(context) {
  for (const p of context.pages()) {
    try {
      const marked = await p.evaluate(`window.${AUTOMATION_MARKER} === true`);
      if (marked) return p;
    } catch {
      /* page may be about:blank or navigating */
    }
  }
  // Fall back to first page (usually about:blank when Chrome just started).
  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.evaluate(`window.${AUTOMATION_MARKER} = true;`);
  } catch {
    /* ignore — will be re-tagged after first navigation */
  }
  return page;
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

    // Preflight: /json/version must respond, otherwise connectOverCDP hangs.
    const info = await probeVersion(attach.host, attach.port, 2000);
    if (!info) {
      emit(runId, "error-event", {
        errorCode: "CDP_UNREACHABLE",
        message: `Chrome CDP 未在 ${attach.host}:${attach.port} 响应 /json/version，请先启动 Chrome。`,
      });
      return;
    }

    let browser;
    try {
      // Hard cap the connect so a wedged CDP endpoint can't stall the run.
      browser = await Promise.race([
        chromium.connectOverCDP(wsBase),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("[CDP_CONNECT_TIMEOUT] connectOverCDP 超时")), 8000),
        ),
      ]);
      run.browser = browser;
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = await pickAutomationPage(context);
      log(runId, "ok", `已附加，页面 ${context.pages().length} · ${page.url()}`);

      const steps = Array.isArray(body.steps) ? body.steps : [];
      for (let i = 0; i < steps.length; i++) {
        if (run.cancelled) {
          log(runId, "warn", "已取消");
          emit(runId, "error-event", { errorCode: "CANCELLED", message: "已取消" });
          return;
        }
        await executeStep(runId, page, steps[i], i);
      }
      emit(runId, "done", { ms: Date.now() - started });
    } catch (e) {
      emit(runId, "error-event", { errorCode: e?.errorCode, message: e?.message || String(e) });
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
    if ((req.method === "GET" || req.method === "POST") && pathname === "/detect-browser") {
      const result = detectBrowser();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && pathname === "/cdp/status") {
      const body =
        req.method === "POST" ? await readJson(req).catch(() => ({})) : {};
      const qHost = url.searchParams.get("host");
      const qPort = url.searchParams.get("port");
      const host = body.host || qHost || "127.0.0.1";
      const port = String(body.port || qPort || "9222");
      const info = await probeVersion(host, port, 1500);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (info) {
        res.end(
          JSON.stringify({
            ok: true,
            connected: true,
            host,
            port,
            browser: info.Browser,
            protocolVersion: info["Protocol-Version"],
            webSocketDebuggerUrl: info.webSocketDebuggerUrl,
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            ok: true,
            connected: false,
            host,
            port,
            error: `Chrome CDP 未在 ${host}:${port} 响应 /json/version`,
          }),
        );
      }
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
