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
check("version consistency @ 0.3.1", () => {
  const versionTs = readFileSync(resolve(ROOT, "src/lib/mcp/version.ts"), "utf8");
  const mustMatch = {
    MCP_CODE_VERSION: "0.3.1",
    MCP_MANIFEST_VERSION: "0.3.1",
    MIN_HELPER_VERSION: "0.3.1",
  };
  for (const [k, v] of Object.entries(mustMatch)) {
    const re = new RegExp(`${k}\\s*=\\s*"([^"]+)"`);
    const m = versionTs.match(re);
    if (!m) throw new Error(`${k} not found in src/lib/mcp/version.ts`);
    if (m[1] !== v) throw new Error(`${k}=${m[1]} (expected ${v})`);
  }
  const manifest = JSON.parse(
    readFileSync(resolve(ROOT, ".lovable/mcp/manifest.json"), "utf8"),
  );
  const manifestVersion = manifest.server?.version ?? manifest.version;
  if (manifestVersion !== "0.3.1") {
    throw new Error(`.lovable/mcp/manifest.json server.version=${manifestVersion} (expected 0.3.1)`);
  }
  const helperPkg = JSON.parse(readFileSync(resolve(ROOT, "helper/package.json"), "utf8"));
  if (helperPkg.version !== "0.3.1") {
    throw new Error(`helper/package.json version=${helperPkg.version} (expected 0.3.1)`);
  }
  const indexMjs = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  const im = indexMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!im || im[1] !== "0.3.1") {
    throw new Error(`helper/src/index.mjs VERSION=${im?.[1]} (expected 0.3.1)`);
  }
  const pairMjs = readFileSync(resolve(ROOT, "helper/src/pair.mjs"), "utf8");
  const pm = pairMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!pm || pm[1] !== "0.3.1") {
    throw new Error(`helper/src/pair.mjs VERSION=${pm?.[1]} (expected 0.3.1)`);
  }
});

// 6. Static preflight of helper/start-sentinel.bat.
//    On Linux CI (this environment) we cannot execute a .bat file; instead
//    verify that the file is present, contains the --ci-check branch, exits
//    with a numeric code, uses UTF-8 (chcp 65001), and references
//    start-helper.ps1 + npm install.
check("helper/start-sentinel.bat static preflight", () => {
  const p = resolve(ROOT, "helper/start-sentinel.bat");
  if (!existsSync(p)) throw new Error("missing helper/start-sentinel.bat");
  if (statSync(p).size < 200) throw new Error("start-sentinel.bat suspiciously small");
  const s = readFileSync(p, "utf8");
  const required = [
    "chcp 65001",
    "--ci-check",
    "--preflight",
    "start-helper.ps1",
    "npm.cmd",
    "9222",
    "exit /b",
  ];
  for (const token of required) {
    if (!s.includes(token)) throw new Error(`start-sentinel.bat missing required token: ${token}`);
  }
  // Fail-open guard: reject `errorlevel ... 2>nul || true` or trailing `|| exit /b 0` patterns.
  if (/\|\|\s*true/i.test(s) || /\|\|\s*exit \/b\s+0/i.test(s)) {
    throw new Error("start-sentinel.bat contains fail-open pattern");
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
  console.log(
    `  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(40)} exit=${r.code} ${r.ms}ms`,
  );
}
console.log(`[verify:release] ${passed}/${total} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
