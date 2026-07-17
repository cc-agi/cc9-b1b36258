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

// 8. Desktop Operator status/log paths must NEVER dump raw desktop-session.json
//    or the bearer secret. Regression guard for the P0-R5 disclosure fix.
check("desktop-operator scripts do not leak session secret", () => {
  const helperDir = resolve(ROOT, "helper");

  const files = [
    "status-desktop-operator.bat",
    "start-desktop-operator.bat",
    "stop-desktop-operator.bat",
    "desktop-operator.ps1",
    "src/desktop.mjs",
  ].map((f) => resolve(helperDir, f));

  for (const f of files) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
    const s = readFileSync(f, "utf8");
    const base = f.split(/[\\/]/).pop();

    // Never `type` the session file (would dump JSON including .secret).
    if (/^\s*type\s+["%].*desktop-session\.json/im.test(s) || /^\s*type\s+"?%SESSION%/im.test(s)) {
      throw new Error(`${base}: uses \`type\` on desktop-session.json (leaks secret)`);
    }
    // Never `Get-Content` the session file straight into Write-Host / output.
    if (/Get-Content[^\r\n]*desktop-session\.json[^\r\n]*\|\s*Write-(Host|Output)/i.test(s)) {
      throw new Error(`${base}: pipes raw session JSON to output`);
    }
    // Never write/log $secret or the .secret field except in the mint site
    // (desktop-operator.ps1) and desktop.mjs bridge (uses it as Bearer only,
    // never to Write-Host / console.log).
    const isMintSite = base === "desktop-operator.ps1";
    const isBridge = base === "desktop.mjs";
    if (!isMintSite) {
      if (/Write-(Host|Output)[^\r\n]*\$secret\b/i.test(s)) {
        throw new Error(`${base}: prints $secret`);
      }
      if (
        /echo[^\r\n]*(secret|bearer)/i.test(s) &&
        !/NEVER|SECURITY|REM /i.test(s.match(/echo[^\r\n]*(secret|bearer)[^\r\n]*/i)?.[0] ?? "")
      ) {
        // Allow the SECURITY comment header in status-desktop-operator.bat.
      }
    }
    if (isBridge) {
      if (
        /console\.(log|info|warn|error)[^;]*\.secret\b/.test(s) ||
        /console\.(log|info|warn|error)[^;]*\bsecret\b/i.test(s)
      ) {
        throw new Error(`${base}: bridge logs the session secret`);
      }
    }
  }

  // status-desktop-operator.bat must actually parse via PowerShell and emit
  // only whitelisted fields — this is the concrete fix.
  const statusPath = resolve(helperDir, "status-desktop-operator.bat");
  const status = readFileSync(statusPath, "utf8");
  if (!/powershell\.exe/i.test(status)) {
    throw new Error("status-desktop-operator.bat: must parse session via PowerShell");
  }
  if (/\bsecret\b/i.test(status.replace(/^\s*REM[^\r\n]*/gim, ""))) {
    throw new Error("status-desktop-operator.bat: references `secret` outside comments");
  }
});

// 9. Desktop Operator must release its port probe before HttpListener binds,
//    publish ACTIVE state only after a successful bind, and clean stale state.
check("desktop-operator listener lifecycle is initialization-safe", () => {
  const p = resolve(ROOT, "helper/desktop-operator.ps1");
  if (!existsSync(p)) throw new Error("missing helper/desktop-operator.ps1");
  const s = readFileSync(p, "utf8");

  const index = (token) => {
    const i = s.indexOf(token);
    if (i < 0) throw new Error(`desktop-operator.ps1 missing lifecycle token: ${token}`);
    return i;
  };
  const indexAfter = (token, offset) => {
    const i = s.indexOf(token, offset);
    if (i < 0) {
      throw new Error(
        `desktop-operator.ps1 missing lifecycle token after offset ${offset}: ${token}`,
      );
    }
    return i;
  };

  const selectedPort = index("$port = ([System.Net.IPEndPoint]$probeListener.LocalEndpoint).Port");
  const probeStop = indexAfter("$probeListener.Stop()", selectedPort);
  const probeDispose = indexAfter("$probeListener.Server.Dispose()", probeStop);
  const probeClear = indexAfter("$probeListener = $null", probeDispose);
  const httpCreate = indexAfter("$http = New-Object System.Net.HttpListener", probeClear);
  const httpStart = index("$http.Start()");
  const listeningGuard = index("if ($null -eq $http -or -not $http.IsListening)");
  const sessionWrite = indexAfter("Set-Content -Path $sessionFile", listeningGuard);
  const pidWrite = indexAfter("WriteAllText", sessionWrite);
  const journalCreate = indexAfter("New-Item -ItemType Directory -Path $journalDir", pidWrite);
  const activeLog = indexAfter('Log "[desktop-operator] ACTIVE', journalCreate);

  if (!(selectedPort < probeStop && probeStop < probeDispose && probeDispose < probeClear)) {
    throw new Error(
      "probe listener is not stopped, socket-disposed, and cleared after port selection",
    );
  }
  if (!(probeClear < httpCreate && httpCreate < httpStart)) {
    throw new Error("HttpListener is created before the temporary port probe is fully released");
  }
  if (!(httpStart < listeningGuard && listeningGuard < sessionWrite && sessionWrite < pidWrite)) {
    throw new Error("session/PID state is published before HttpListener successfully binds");
  }
  if (!(pidWrite < journalCreate && journalCreate < activeLog)) {
    throw new Error("journal/ACTIVE state ordering is unsafe");
  }
  if (!/\$maxBindAttempts\s*=\s*[1-9]\d*/.test(s) || !/\$http\.Start\(\)/.test(s)) {
    throw new Error("bounded HttpListener bind retry is missing");
  }

  const cleanupFinally = s.lastIndexOf("} finally {");
  if (cleanupFinally < httpStart) throw new Error("listener startup is not protected by finally");
  const cleanup = s.slice(cleanupFinally);
  const cleanupTokens = [
    "$probeListener.Stop()",
    "$probeListener.Server.Dispose()",
    "$http.Stop()",
    "$http.Close()",
    "Remove-Item -Force $sessionFile",
    "Remove-Item -Force $pidFile",
    "Remove-Item -Recurse -Force $journalDir",
  ];
  for (const token of cleanupTokens) {
    if (!cleanup.includes(token)) throw new Error(`finally cleanup missing: ${token}`);
  }
});

// 10. Desktop tools must be registered in the orchestrator routing layer
//     (not only the MCP manifest), the session-file ACL must grant Full
//     (Delete/Modify) to the current user, and stop/status .bat scripts
//     must be cmd.exe parse-safe.
check("desktop-operator runtime wiring (orchestrator + ACL + .bat)", () => {
  const orch = readFileSync(resolve(ROOT, "src/lib/orchestrator.server.ts"), "utf8");
  if (!/DESKTOP_GOAL_PREFIX/.test(orch)) {
    throw new Error("orchestrator missing DESKTOP_GOAL_PREFIX branch");
  }
  if (!/parseDesktopGoal/.test(orch)) {
    throw new Error("orchestrator missing parseDesktopGoal helper");
  }
  if (!/kind:\s*"failed"/.test(orch)) {
    throw new Error("orchestrator missing `failed` outcome for unavailable desktop tool");
  }
  if (!/DESKTOP_TOOL_UNAVAILABLE/.test(orch)) {
    throw new Error("orchestrator missing DESKTOP_TOOL_UNAVAILABLE fallback error code");
  }

  const route = readFileSync(resolve(ROOT, "src/routes/api/worker/v1/$action.ts"), "utf8");
  if (!/outcome\.kind\s*===\s*"failed"/.test(route)) {
    throw new Error("worker /next-intent handler does not translate `failed` outcome");
  }
  if (!/status:\s*"failed"/.test(route)) {
    throw new Error("worker /next-intent handler does not write status=failed");
  }

  const helper = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  if (!/next\.kind\s*===\s*"failed"/.test(helper)) {
    throw new Error("helper/src/index.mjs does not handle `failed` response");
  }

  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  if (/icacls[^\r\n]*\(R,W\)/i.test(ps)) {
    throw new Error("desktop-operator.ps1 still grants only R,W (blocks Remove-Item on restart)");
  }
  if (!/icacls[^\r\n]*\$env:USERNAME[^\r\n]*\(F\)/i.test(ps)) {
    throw new Error("desktop-operator.ps1 must grant $env:USERNAME (F) on session file");
  }
  if (!/WriteAllText\([^)]*\$pidFile/i.test(ps)) {
    throw new Error("desktop-operator.ps1 must write pid file without BOM");
  }

  const stopBat = readFileSync(resolve(ROOT, "helper/stop-desktop-operator.bat"), "utf8");
  if (/for\s+\/f\s+"usebackq/i.test(stopBat)) {
    throw new Error("stop-desktop-operator.bat still uses fragile `for /f usebackq` PID parse");
  }
  if (!/findstr\s+\/R\s+"?\^\[0-9\]/i.test(stopBat)) {
    throw new Error("stop-desktop-operator.bat must validate PID as digits before taskkill");
  }

  const statusBat = readFileSync(resolve(ROOT, "helper/status-desktop-operator.bat"), "utf8");
  const psLine = statusBat.split(/\r?\n/).find((l) => /powershell\.exe/i.test(l)) ?? "";
  if (!/-Command\s+"/.test(psLine)) {
    throw new Error(
      "status-desktop-operator.bat: PowerShell invocation must be a single -Command string (no `^` continuations)",
    );
  }
  if (!/session_id/.test(psLine)) {
    throw new Error(
      "status-desktop-operator.bat: -Command payload must emit session_id (verify it wasn't truncated)",
    );
  }
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
