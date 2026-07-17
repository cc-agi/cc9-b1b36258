#!/usr/bin/env node
/**
 * P0-R4 C1 — Hard-failing release verification gate.
 *
 * Runs: tsgo --noEmit, eslint (hard), full vitest, vite build,
 *       version consistency check, and static preflight of
 *       helper/start-sentinel.bat.
 *
 * Exits non-zero on ANY failure. No `|| true`, no swallow.
 * Prints a single-line summary for CI log grepping.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const results = [];

function run(name, cmd, args, opts = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
    ...opts,
  });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  results.push({ name, ok, code: r.status ?? -1, ms });
  if (!ok) {
    console.error(`\n[verify:release] ✗ ${name} failed (exit ${r.status})`);
  }
  return ok;
}

function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    results.push({ name, ok: true, code: 0, ms: Date.now() - started });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[verify:release] ✗ ${name}: ${msg}`);
    results.push({ name, ok: false, code: 1, ms: Date.now() - started });
    return false;
  }
}

// 1. Typecheck
run("typecheck", "bunx", ["tsgo", "--noEmit"]);

// 2. Lint (hard-fail)
run("lint", "bun", ["run", "lint"]);

// 3. Full tests (no filtering, no fail-open)
run("tests", "bunx", ["vitest", "run"]);

// 4. Build
run("build", "bun", ["run", "build"]);

// 5. Version consistency: MCP code, manifest json, helper package/index/pair.
check("version consistency @ 0.4.0", () => {
  const versionTs = readFileSync(resolve(ROOT, "src/lib/mcp/version.ts"), "utf8");
  const mustMatch = {
    MCP_CODE_VERSION: "0.4.0",
    MCP_MANIFEST_VERSION: "0.4.0",
    MIN_HELPER_VERSION: "0.4.0",
  };
  for (const [k, v] of Object.entries(mustMatch)) {
    const re = new RegExp(`${k}\\s*=\\s*"([^"]+)"`);
    const m = versionTs.match(re);
    if (!m) throw new Error(`${k} not found in src/lib/mcp/version.ts`);
    if (m[1] !== v) throw new Error(`${k}=${m[1]} (expected ${v})`);
  }
  const manifest = JSON.parse(readFileSync(resolve(ROOT, ".lovable/mcp/manifest.json"), "utf8"));
  const manifestVersion = manifest.mcp?.server?.version ?? manifest.server?.version;
  if (manifestVersion !== "0.4.0") {
    throw new Error(
      `.lovable/mcp/manifest.json server.version=${manifestVersion} (expected 0.4.0)`,
    );
  }
  const helperPkg = JSON.parse(readFileSync(resolve(ROOT, "helper/package.json"), "utf8"));
  if (helperPkg.version !== "0.4.0") {
    throw new Error(`helper/package.json version=${helperPkg.version} (expected 0.4.0)`);
  }
  const indexMjs = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  const im = indexMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!im || im[1] !== "0.4.0") {
    throw new Error(`helper/src/index.mjs VERSION=${im?.[1]} (expected 0.4.0)`);
  }
  const pairMjs = readFileSync(resolve(ROOT, "helper/src/pair.mjs"), "utf8");
  const pm = pairMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!pm || pm[1] !== "0.4.0") {
    throw new Error(`helper/src/pair.mjs VERSION=${pm?.[1]} (expected 0.4.0)`);
  }
});

// 6. Static preflight of helper/start-sentinel.bat — proves CI-mode branch
//    exits BEFORE any npm install / Chrome launch / network / state mutation.
check("helper/start-sentinel.bat static preflight", () => {
  const p = resolve(ROOT, "helper/start-sentinel.bat");
  if (!existsSync(p)) throw new Error("missing helper/start-sentinel.bat");
  if (statSync(p).size < 200) throw new Error("start-sentinel.bat suspiciously small");
  const bytes = readFileSync(p);
  // ASCII-only source (allow CR/LF/TAB). Non-ASCII bytes can corrupt cmd parsing.
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b > 0x7e && !(b === 0x0d || b === 0x0a || b === 0x09)) {
      throw new Error(
        `start-sentinel.bat contains non-ASCII byte 0x${b.toString(16)} at offset ${i}`,
      );
    }
  }
  const s = bytes.toString("utf8");
  const required = [
    "chcp 65001",
    "--ci-check",
    "--preflight",
    "start-helper.ps1",
    "npm.cmd",
    "9222",
    "exit /b",
    ":ci_preflight",
  ];
  for (const token of required) {
    if (!s.includes(token)) throw new Error(`start-sentinel.bat missing required token: ${token}`);
  }
  // Fail-open guard.
  if (/\|\|\s*true/i.test(s) || /\|\|\s*exit \/b\s+0/i.test(s)) {
    throw new Error("start-sentinel.bat contains fail-open pattern");
  }

  // Prove ordering: after the FIRST `if /I "%~1"=="--ci-check"` line, the very
  // next control-flow branch touching state must be `goto :ci_preflight`, and
  // it must precede every forbidden (mutating / networked / Chrome) token.
  const ciParseIdx = s.search(/if\s+\/I\s+"%~1"=="--ci-check"/i);
  if (ciParseIdx < 0) throw new Error("start-sentinel.bat: --ci-check parse line not found");
  const gotoIdx = s.indexOf("goto :ci_preflight", ciParseIdx);
  if (gotoIdx < 0)
    throw new Error("start-sentinel.bat: missing `goto :ci_preflight` after CI parse");

  const forbiddenBeforeGoto = [
    /npm(\.cmd)?\s+install/i,
    /\bmkdir\b/i,
    /\bstart\s+""/i, // `start "" chrome.exe ...`
    /Invoke-WebRequest/i,
    /remote-debugging-port/i,
    /start-helper\.ps1/i,
    /\bpair(ing)?\b/i,
  ];
  const preGoto = s.slice(ciParseIdx, gotoIdx);
  for (const re of forbiddenBeforeGoto) {
    if (re.test(preGoto)) {
      throw new Error(
        `start-sentinel.bat: CI-mode gate is bypassed — ${re} appears before \`goto :ci_preflight\``,
      );
    }
  }

  // The :ci_preflight body itself must not perform any forbidden action.
  // Find the LABEL definition (`:ci_preflight` at start of a line), not the
  // earlier `goto :ci_preflight` reference.
  const labelMatch = s.match(/^:ci_preflight\b/m);
  if (!labelMatch)
    throw new Error("start-sentinel.bat: `:ci_preflight` label definition not found");
  const ciBodyIdx = labelMatch.index;
  const ciBody = s.slice(ciBodyIdx);
  const forbiddenInCiBody = [
    /npm(\.cmd)?\s+install/i,
    /\bmkdir\b/i,
    /\bstart\s+""/i,
    /Invoke-WebRequest/i,
    /remote-debugging-port/i,
    // start-helper.ps1 must not be INVOKED (only read-only `if exist` checks allowed).
    /powershell[^\r\n]*start-helper\.ps1/i,
    /(^|[\s&])call\s+[^\r\n]*start-helper\.ps1/i,
    /chrome\.exe/i,
    /9222/,
    /curl/i,
    /powershell.*-Command/i,
  ];
  for (const re of forbiddenInCiBody) {
    if (re.test(ciBody)) {
      throw new Error(
        `start-sentinel.bat: :ci_preflight body performs forbidden action matching ${re}`,
      );
    }
  }

  // The CI-preflight body must terminate with `exit /b 0` (successful exit)
  // and must not fall through into normal mode.
  if (!/:ci_preflight[\s\S]*exit\s+\/b\s+0\s*$/i.test(s.trimEnd() + "\n")) {
    // Softer check: ensure last non-empty line after :ci_preflight is exit /b 0.
    const tail = ciBody
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!/exit\s+\/b\s+0/i.test(tail || "")) {
      throw new Error("start-sentinel.bat: :ci_preflight must end with `exit /b 0`");
    }
  }
});

// 6b. .gitattributes enforces CRLF for *.bat so Windows cmd parses cleanly.
check(".gitattributes enforces CRLF for .bat", () => {
  const p = resolve(ROOT, ".gitattributes");
  if (!existsSync(p)) throw new Error("missing .gitattributes");
  const s = readFileSync(p, "utf8");
  if (!/\*\.bat\s+text\s+eol=crlf/i.test(s)) {
    throw new Error(".gitattributes must contain `*.bat text eol=crlf`");
  }
});

// 7. Fail-open scan: forbid `|| true` in CI workflow.
check("CI workflow has no fail-open (|| true)", () => {
  const p = resolve(ROOT, ".github/workflows/ci.yml");
  if (!existsSync(p)) throw new Error("missing .github/workflows/ci.yml");
  const s = readFileSync(p, "utf8");
  if (/\|\|\s*true/.test(s)) throw new Error(".github/workflows/ci.yml contains `|| true`");
});

// Summary
const total = results.length;
const passed = results.filter((r) => r.ok).length;
const failed = total - passed;
console.log("\n[verify:release] === summary ===");
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(40)} exit=${r.code} ${r.ms}ms`);
}
console.log(`[verify:release] ${passed}/${total} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
