// Sentinel Helper — read-only browser executor over CDP (P0-R2c).
// Only the P0-R2c whitelist is implemented; unknown/writeful tools throw.
//
// This module is imported by helper/src/index.mjs (Worker daemon).
// The older docs/sentinel-helper/server.mjs is deprecated as of v0.3.0 and will
// be rewritten on top of this same executor in a follow-up (kept for now so the
// web console file-browser flow does not regress).
import { chromium } from "playwright-core";

const CLICK_DENY_KEYWORDS = [
  "submit","confirm","delete","remove","purchase","buy","pay","checkout",
  "publish","send","post","upload","reply","comment","subscribe",
  "确认","删除","移除","购买","支付","结算","下单","发布","发送","上传","提交","回复","订阅",
];

let sharedBrowser = null;

async function getBrowser(cdpUrl) {
  if (sharedBrowser && sharedBrowser.isConnected?.()) return sharedBrowser;
  sharedBrowser = await chromium.connectOverCDP(cdpUrl, { timeout: 8000 });
  return sharedBrowser;
}

async function pickPage(browser) {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const p of pages) {
      const url = p.url();
      if (url && !url.startsWith("chrome://") && !url.startsWith("devtools://") && !url.startsWith("about:")) return p;
    }
  }
  const ctx = contexts[0] ?? (await browser.newContext());
  return ctx.newPage();
}

function isNavigationalClickTarget(el) {
  // Called via evaluate; el is HTMLElement
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && el.getAttribute("href")) return { ok: true, reason: "anchor" };
  const role = el.getAttribute("role");
  if (role && ["link","menuitem","tab","option","navigation"].includes(role)) return { ok: true, reason: "role" };
  if (tag === "button" && (el.getAttribute("type") === "submit"))
    return { ok: false, reason: "submit_button" };
  const nav = el.closest("nav,aside,[role=navigation],[role=menu],[role=menubar],[role=tablist]");
  if (nav) return { ok: true, reason: "in_nav" };
  return { ok: false, reason: "not_navigational" };
}

export async function executeTool(cdpUrl, toolName, args) {
  const started = Date.now();
  const browser = await getBrowser(cdpUrl);
  const page = await pickPage(browser);
  const result = await runOne(page, toolName, args);
  result.latency_ms = Date.now() - started;
  return result;
}

async function runOne(page, toolName, args) {
  switch (toolName) {
    case "browser_goto": {
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { ok: true, result: { url: page.url(), title: await page.title() } };
    }
    case "browser_wait_for": {
      await page.waitForSelector(args.selector, { timeout: args.timeoutMs ?? 10000 });
      return { ok: true, result: { url: page.url(), title: await page.title() } };
    }
    case "browser_extract": {
      const value = await page.$eval(
        args.selector,
        (el, attr) => (attr ? el.getAttribute(attr) : el.innerText),
        args.attr ?? null,
      ).catch(() => null);
      return { ok: true, result: { value, url: page.url() } };
    }
    case "browser_screenshot": {
      // Save to per-run temp path; do NOT return image bytes to Cloud (privacy).
      const path = `/tmp/sentinel-${Date.now()}-${(args.name || "shot").replace(/[^a-z0-9-]/gi, "_")}.png`;
      await page.screenshot({ path, fullPage: false });
      return { ok: true, result: { path, url: page.url() } };
    }
    case "browser_inspect_candidates": {
      const cands = await page.evaluate((needle) => {
        const out = [];
        const all = Array.from(document.querySelectorAll("a,button,[role],nav *,aside *"));
        for (const el of all.slice(0, 500)) {
          const t = (el.innerText || "").trim().slice(0, 120);
          if (!t) continue;
          if (!t.toLowerCase().includes(String(needle).toLowerCase())) continue;
          const rect = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            text: t,
            href: el.getAttribute("href"),
            visible: rect.width > 0 && rect.height > 0,
            inNav: !!el.closest("nav,aside,[role=navigation]"),
          });
          if (out.length >= 20) break;
        }
        return out;
      }, args.textOrSelector);
      return { ok: true, result: { candidates: cands, url: page.url() } };
    }
    case "browser_click": {
      // Denylist by aria/text
      const label = String(args.selector).toLowerCase();
      if (CLICK_DENY_KEYWORDS.some((k) => label.includes(k))) {
        return { ok: false, error_code: "CLICK_DENIED_KEYWORD", error_message: `refused: label contains banned keyword` };
      }
      const beforeUrl = page.url();
      const beforeTitle = await page.title();
      const target = await page.$(args.selector);
      if (!target) return { ok: false, error_code: "CLICK_NOT_FOUND", error_message: "selector not found" };
      const gate = await target.evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === "a" && el.getAttribute("href")) return { ok: true, reason: "anchor" };
        const role = el.getAttribute("role");
        if (role && ["link","menuitem","tab","option","navigation"].includes(role)) return { ok: true, reason: "role" };
        if (tag === "button" && (el.getAttribute("type") === "submit"))
          return { ok: false, reason: "submit_button" };
        if (el.closest("nav,aside,[role=navigation],[role=menu],[role=menubar],[role=tablist]")) return { ok: true, reason: "in_nav" };
        return { ok: false, reason: "not_navigational" };
      });
      if (!gate.ok) return { ok: false, error_code: "CLICK_NOT_NAVIGATIONAL", error_message: gate.reason };
      await target.click({ timeout: 5000 });
      // Best-effort wait for change
      try { await page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch { /* ignore */ }
      return { ok: true, result: {
        before: { url: beforeUrl, title: beforeTitle },
        after: { url: page.url(), title: await page.title() },
        reason: gate.reason,
      } };
    }
    default:
      return { ok: false, error_code: "TOOL_NOT_WHITELISTED", error_message: `unknown tool: ${toolName}` };
  }
}

export { CLICK_DENY_KEYWORDS, isNavigationalClickTarget };
