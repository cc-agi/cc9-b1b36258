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
check("version consistency @ 0.4.11", () => {
  const versionTs = readFileSync(resolve(ROOT, "src/lib/mcp/version.ts"), "utf8");
  const mustMatch = {
    MCP_CODE_VERSION: "0.4.11",
    MCP_MANIFEST_VERSION: "0.4.11",
    MIN_HELPER_VERSION: "0.4.11",
  };
  for (const [k, v] of Object.entries(mustMatch)) {
    const re = new RegExp(`${k}\\s*=\\s*"([^"]+)"`);
    const m = versionTs.match(re);
    if (!m) throw new Error(`${k} not found in src/lib/mcp/version.ts`);
    if (m[1] !== v) throw new Error(`${k}=${m[1]} (expected ${v})`);
  }
  const manifest = JSON.parse(readFileSync(resolve(ROOT, ".lovable/mcp/manifest.json"), "utf8"));
  const manifestVersion = manifest.mcp?.server?.version ?? manifest.server?.version;
  if (manifestVersion !== "0.4.11") {
    throw new Error(
      `.lovable/mcp/manifest.json server.version=${manifestVersion} (expected 0.4.11)`,
    );
  }
  const helperPkg = JSON.parse(readFileSync(resolve(ROOT, "helper/package.json"), "utf8"));
  if (helperPkg.version !== "0.4.11") {
    throw new Error(`helper/package.json version=${helperPkg.version} (expected 0.4.11)`);
  }
  const indexMjs = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  const im = indexMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!im || im[1] !== "0.4.11") {
    throw new Error(`helper/src/index.mjs VERSION=${im?.[1]} (expected 0.4.11)`);
  }
  const pairMjs = readFileSync(resolve(ROOT, "helper/src/pair.mjs"), "utf8");
  const pm = pairMjs.match(/VERSION\s*=\s*"([^"]+)"/);
  if (!pm || pm[1] !== "0.4.11") {
    throw new Error(`helper/src/pair.mjs VERSION=${pm?.[1]} (expected 0.4.11)`);
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
  const httpCreate = indexAfter("$script:http = New-Object System.Net.HttpListener", probeClear);
  const httpStart = index("$script:http.Start()");
  const listeningGuard = index("if ($null -eq $script:http -or -not $script:http.IsListening)");
  const sessionWrite = indexAfter("Write-SessionDoc $sessionDoc", listeningGuard);
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
  if (!/\$maxBindAttempts\s*=\s*[1-9]\d*/.test(s) || !/\$script:http\.Start\(\)/.test(s)) {
    throw new Error("bounded HttpListener bind retry is missing");
  }

  const cleanupFinally = s.lastIndexOf("} finally {");
  if (cleanupFinally < httpStart) throw new Error("listener startup is not protected by finally");
  const cleanup = s.slice(cleanupFinally);
  const cleanupTokens = [
    "$probeListener.Stop()",
    "$probeListener.Server.Dispose()",
    "$script:http.Stop()",
    "$script:http.Close()",
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
  if (!/icacls[^\r\n]*\$\{?ownerPrincipal\}?:\(F\)/i.test(ps)) {
    throw new Error("desktop-operator.ps1 must grant ownerPrincipal (F) on session file");
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
  const psLine =
    statusBat.split(/\r?\n/).find((l) => /powershell\.exe[^\r\n]*-Command/i.test(l)) ?? "";
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

// 12. desktop-session.json MUST be written BOM-less. Windows PowerShell 5.1
//     `Set-Content -Encoding UTF8` emits a UTF-8 BOM which JSON.parse in
//     helper/src/desktop.mjs rejects, causing DESKTOP_SESSION_INACTIVE even
//     when the bridge is ACTIVE. Helper must also strip a stray BOM as
//     defense-in-depth.
check("desktop-session.json is written BOM-less and helper tolerates BOM", () => {
  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  if (/Set-Content[^\r\n]*\$sessionFile[^\r\n]*-Encoding\s+UTF8/i.test(ps)) {
    throw new Error(
      "desktop-operator.ps1 still uses `Set-Content -Encoding UTF8` on $sessionFile (emits BOM under WinPS 5.1)",
    );
  }
  if (!/UTF8Encoding[^)]*\$false/.test(ps)) {
    throw new Error("desktop-operator.ps1 must construct UTF8Encoding($false) for BOM-less writes");
  }
  if (!/function\s+Write-SessionDoc/.test(ps)) {
    throw new Error("desktop-operator.ps1 must centralize session writes in Write-SessionDoc");
  }
  if (!/\[System\.IO\.File\]::Replace|\[System\.IO\.File\]::Move/.test(ps)) {
    throw new Error("Write-SessionDoc must publish atomically via Replace/Move from a temp file");
  }
  // R3 hotfix: File.Replace($tmp, $sessionFile, $null) throws under WinPS 5.1
  // ("The given path's format is not supported."). BAN the $null backup form
  // and require a real same-directory $backup path that is removed in finally.
  if (/\[System\.IO\.File\]::Replace\([^)]*,\s*\$null\s*\)/.test(ps)) {
    throw new Error(
      "Write-SessionDoc must NOT call File.Replace(..., $null) — WinPS 5.1 rejects the null backup arg",
    );
  }
  // R2 follow-up: unique same-directory temp name + finally cleanup + ACL reassert.
  const fn = ps.match(/function\s+Write-SessionDoc[\s\S]*?\n\}\s*\n/);
  if (!fn) {
    throw new Error("Write-SessionDoc body not found for cleanup/ACL checks");
  }
  const body = fn[0];
  if (!/\$tmp\s*=\s*Join-Path[^\r\n]*sentinelDir/.test(body) || !/Guid\]::NewGuid/i.test(body)) {
    throw new Error(
      "Write-SessionDoc must use a unique same-directory temp path (Join-Path $sentinelDir + Guid)",
    );
  }
  if (!/\$backup\s*=\s*Join-Path[^\r\n]*sentinelDir/.test(body)) {
    throw new Error(
      "Write-SessionDoc must construct a unique same-directory $backup path for File.Replace",
    );
  }
  if (!/\[System\.IO\.File\]::Replace\([^)]*,\s*\$sessionFile\s*,\s*\$backup\s*\)/.test(body)) {
    throw new Error(
      "Write-SessionDoc must pass a non-null $backup to File.Replace($tmp, $sessionFile, $backup)",
    );
  }
  if (!/finally\s*\{[\s\S]*?Remove-Item[^}]*\$tmp/.test(body)) {
    throw new Error(
      "Write-SessionDoc must remove its temp file in a finally block if still present",
    );
  }
  if (!/finally\s*\{[\s\S]*?Remove-Item[^}]*\$backup/.test(body)) {
    throw new Error(
      "Write-SessionDoc must remove its $backup file in the finally block (previous session doc contains the prior bearer)",
    );
  }
  if (!/finally\s*\{[\s\S]*?icacls[^}]*\$backup/.test(body)) {
    throw new Error("Write-SessionDoc must re-apply owner-only ACL to $backup before deleting it");
  }
  if (!/Set-OwnerOnlyAcl\s+\$sessionFile/.test(body)) {
    throw new Error(
      "Write-SessionDoc must reapply owner-only Full-Control ACL via Set-OwnerOnlyAcl after every publish",
    );
  }

  const mjs = readFileSync(resolve(ROOT, "helper/src/desktop.mjs"), "utf8");
  if (!/replace\(\s*\/\^\\uFEFF\/\s*,\s*""\s*\)/.test(mjs)) {
    throw new Error(
      "helper/src/desktop.mjs must strip a leading BOM before JSON.parse (defense in depth)",
    );
  }

  // R2 follow-up: the BOM regression test must contain a REAL integration test
  // that dynamically imports desktop.mjs, spins up a loopback http server, and
  // asserts TWO consecutive desktop_snapshot calls. Static-only coverage does
  // not satisfy the acceptance request.
  const testFile = readFileSync(resolve(ROOT, "tests/desktop-session-bom.test.ts"), "utf8");
  if (!/import\s*\(\s*"\.\.\/helper\/src\/desktop\.mjs\?bomtest/.test(testFile)) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must fresh-dynamic-import helper/src/desktop.mjs",
    );
  }
  if (!/http\.createServer/.test(testFile) || !/listen\(0,\s*"127\.0\.0\.1"/.test(testFile)) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must start a real node:http server on 127.0.0.1 ephemeral port",
    );
  }
  if (!/readDesktopSessionMeta\(\)/.test(testFile)) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must call the exported readDesktopSessionMeta()",
    );
  }
  const execCalls = testFile.match(/executeDesktopTool\(\s*"desktop_snapshot"/g) ?? [];
  if (execCalls.length < 2) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must call executeDesktopTool('desktop_snapshot', ...) at least twice",
    );
  }
  if (!/calls\.length[^;]*\bto(Be|Equal)\b[^;]*2/.test(testFile)) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must assert the bridge received exactly 2 calls",
    );
  }
  if (!/Object\.defineProperty\(process,\s*"platform"/.test(testFile)) {
    throw new Error(
      "tests/desktop-session-bom.test.ts must override process.platform to 'win32' via defineProperty",
    );
  }
});
check("0.4.7 hotfix: qualified ACL principal, bounded heartbeat, envelope journal", () => {
  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  const idx = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  const dsk = readFileSync(resolve(ROOT, "helper/src/desktop.mjs"), "utf8");
  const route = readFileSync(resolve(ROOT, "src/routes/api/worker/v1/$action.ts"), "utf8");
  const testFile = readFileSync(resolve(ROOT, "tests/desktop-session-bom.test.ts"), "utf8");

  // (1) Fully qualified WindowsIdentity for ACL, no more bare $env:USERNAME.
  if (!/WindowsIdentity\]::GetCurrent\(\)\.Name/.test(ps)) {
    throw new Error(
      "desktop-operator.ps1 must resolve owner via WindowsIdentity.GetCurrent().Name",
    );
  }
  if (/icacls[^\r\n]*\$env:USERNAME/.test(ps)) {
    throw new Error("desktop-operator.ps1 still uses bare $env:USERNAME in icacls");
  }
  if (!/Set-OwnerOnlyAcl\s+\$sessionFile/.test(ps)) {
    throw new Error("desktop-operator.ps1 must funnel ACL calls through Set-OwnerOnlyAcl");
  }
  if (!/\$LASTEXITCODE\s*-ne\s*0/.test(ps)) {
    throw new Error("Set-OwnerOnlyAcl must fail closed on icacls nonzero exit");
  }

  // (2) Heartbeat platform stays bounded and desktop metadata ships in its own field.
  if (!/\.slice\(0,\s*64\)/.test(idx)) {
    throw new Error("helper/src/index.mjs must .slice(0, 64) the platform string");
  }
  if (/platform:[^,\n]*desktop-session:/.test(idx)) {
    throw new Error("helper/src/index.mjs must NOT embed desktop-session JSON into platform");
  }
  if (!/desktop_session:\s*desktopSession/.test(idx)) {
    throw new Error("helper/src/index.mjs must send a dedicated desktop_session heartbeat field");
  }
  if (
    !/desktop_session:\s*z\s*\n?\s*\.object/.test(route) &&
    !/desktop_session:\s*z\.object/.test(route)
  ) {
    throw new Error("worker heartbeat schema must accept a typed desktop_session object");
  }
  if (!/desktop_session_active/.test(route)) {
    throw new Error("worker heartbeat must persist desktop_session_active column");
  }

  // (3) HttpListener single-task loop — no per-iteration task leak.
  if (!/\$ctxTask\s*=\s*\$null[\s\S]{0,400}if\s*\(\s*\$null\s*-eq\s*\$ctxTask\s*\)/.test(ps)) {
    throw new Error("desktop-operator.ps1 must reuse a single GetContextAsync task across polls");
  }

  // (4) Envelope forwarded from helper to bridge and journaled by trusted identity.
  if (!/envelope:\s*envelopeOut/.test(dsk)) {
    throw new Error("helper/src/desktop.mjs must forward the trusted envelope to the bridge body");
  }
  if (!/run_id:\s*String\(envelope/.test(dsk)) {
    throw new Error(
      "helper/src/desktop.mjs envelope must include run_id/intent_id/idempotency_key",
    );
  }
  if (!/\$env\s*=\s*\$body\.envelope/.test(ps)) {
    throw new Error("desktop-operator.ps1 Journal-Key must consume the envelope, not args");
  }
  if (/\$args\.idempotency_key/.test(ps)) {
    throw new Error("desktop-operator.ps1 must not derive the journal key from caller args");
  }

  // (5) Regression tests present (envelope forward + session_id mismatch).
  if (!/DESKTOP_SESSION_MISMATCH/.test(testFile)) {
    throw new Error("desktop-session-bom.test.ts must assert DESKTOP_SESSION_MISMATCH path");
  }
  if (!/envelope[^\n]*\)[\s\S]*run_id:\s*"run-1"/.test(testFile)) {
    throw new Error("desktop-session-bom.test.ts must assert the envelope is forwarded verbatim");
  }
});

// 14. Bump-Activity must FAIL CLOSED on Set-OwnerOnlyAcl / republish failure.
//     A bare `catch {}` around Write-SessionDoc silently leaves the bridge
//     ACTIVE after ACL enforcement failed, violating the fail-closed contract.
check("Bump-Activity fails closed on ACL/republish failure", () => {
  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  const m = ps.match(/function\s+Bump-Activity[\s\S]*?\n\}\s*\n/);
  if (!m) throw new Error("Bump-Activity function body not found");
  const body = m[0];
  // MUST NOT wrap the Write-SessionDoc call in `try { ... } catch {}` that swallows.
  if (/try\s*\{[^}]*Write-SessionDoc[^}]*\}\s*catch\s*\{\s*\}/s.test(body)) {
    throw new Error("Bump-Activity still swallows Write-SessionDoc failure with `catch {}`");
  }
  // MUST route republish failures into Invoke-FatalSessionInvalidate.
  if (!/Invoke-FatalSessionInvalidate/.test(body)) {
    throw new Error("Bump-Activity must call Invoke-FatalSessionInvalidate on republish failure");
  }
  // Fatal invalidator must exist and stop the listener + remove the session file.
  const fnv = ps.match(/function\s+Invoke-FatalSessionInvalidate[\s\S]*?\n\}\s*\n/);
  if (!fnv) throw new Error("Invoke-FatalSessionInvalidate function not defined");
  const fnvBody = fnv[0];
  if (!/\$script:AbortRequested\s*=\s*\$true/.test(fnvBody)) {
    throw new Error("Invoke-FatalSessionInvalidate must set $script:AbortRequested");
  }
  if (!/\$script:http\.Stop\(\)/.test(fnvBody)) {
    throw new Error("Invoke-FatalSessionInvalidate must stop the HttpListener");
  }
  if (!/Remove-Item[^\r\n]*\$sessionFile/.test(fnvBody)) {
    throw new Error("Invoke-FatalSessionInvalidate must best-effort remove $sessionFile");
  }
  // Never echo the bearer secret in fatal path.
  if (/\$secret\b/.test(fnvBody)) {
    throw new Error("Invoke-FatalSessionInvalidate must not reference $secret");
  }
  // Main loop must check the abort flag AND use $script:http, not $http.
  if (!/while\s*\(\s*\$script:http\.IsListening\s*\)/.test(ps)) {
    throw new Error("main loop must iterate on $script:http.IsListening");
  }
  if (!/if\s*\(\s*\$script:AbortRequested\s*\)/.test(ps)) {
    throw new Error("main loop must break on $script:AbortRequested");
  }
});

// 15. Static enforcement of Journal-Key composite formula and presence of
//     the trusted-envelope + routing integration test.
check("Journal-Key formula + envelope/routing integration tests present", () => {
  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  // composite = sessionId|env.run_id|env.intent_id|env.idempotency_key
  if (!/"\$sessionId\|\$runId\|\$intentId\|\$idem"/.test(ps)) {
    throw new Error(
      'desktop-operator.ps1 Journal-Key must build composite as "$sessionId|$runId|$intentId|$idem"',
    );
  }

  const p = resolve(ROOT, "tests/desktop-operator-journal.test.ts");
  if (!existsSync(p)) throw new Error("missing tests/desktop-operator-journal.test.ts");
  const t = readFileSync(p, "utf8");
  const required = [
    /startJournalBridge/,
    /getDispatchCount\(\)\s*\)\.toBe\(1\)/, // (a)
    /getDispatchCount\(\)\s*\)\.toBe\(2\)/, // (b)
    /idempotency_key:\s*"att1:seq1"/, // shared orchestrator key
    /attacker-key-/, // (c) caller-provided args.idempotency_key
    /parseDesktopGoal/, // routing round-trip
    /508d0efd-6306-4a2f-be7a-76fcaf600d9e9/, // exact UUID from review
    /DESKTOP_SESSION_MISMATCH/, // negative path
  ];
  for (const re of required) {
    if (!re.test(t)) {
      throw new Error(`tests/desktop-operator-journal.test.ts missing required assertion: ${re}`);
    }
  }
});

// 16. Windows-only delayed-listener regression script must exist with the
//     required contract. Linux CI cannot run HttpListener; the Owner
//     executes this file during the Windows runtime regression.
check("helper/regression-desktop-delayed-listener.ps1 present and contracted", () => {
  const p = resolve(ROOT, "helper/regression-desktop-delayed-listener.ps1");
  if (!existsSync(p)) throw new Error("missing helper/regression-desktop-delayed-listener.ps1");
  const s = readFileSync(p, "utf8");
  const required = [
    "desktop-operator.ps1",
    "IdleTtlSeconds",
    "Start-Sleep -Seconds 13",
    "desktop_snapshot",
    "att1:seq1",
    "Bearer ",
    "TimeoutSec 20",
    "exit 0",
  ];
  for (const token of required) {
    if (!s.includes(token))
      throw new Error(`regression-desktop-delayed-listener.ps1 missing token: ${token}`);
  }
  if (/\|\|\s*true/.test(s)) {
    throw new Error("regression-desktop-delayed-listener.ps1 contains fail-open `|| true`");
  }
});

// 17. Helper start must refuse to launch when the pid file identifies a
//     still-running Helper, using tasklist (cross-elevation visible).
check("start-helper.ps1 refuses duplicate launch across elevation", () => {
  const p = resolve(ROOT, "helper/start-helper.ps1");
  const s = readFileSync(p, "utf8");
  if (!/Test-TasklistPidAlive\s+-TargetPid\s+\$existingPid/.test(s)) {
    throw new Error(
      "start-helper.ps1 must probe existing PID via shared Test-TasklistPidAlive (locale-safe, cross-elevation)",
    );
  }

  if (!/Refusing to launch a duplicate/.test(s)) {
    throw new Error("start-helper.ps1 must refuse duplicate launch with a clear message");
  }
  if (!/exit\s+4/.test(s)) {
    throw new Error("start-helper.ps1 must exit with a distinct code (4) on duplicate refusal");
  }
  // Must not overwrite the pid file while the existing PID is alive:
  // the refusal branch must precede `Out-File -FilePath $pidFile`.
  const refuseIdx = s.indexOf("Refusing to launch a duplicate");
  const writeIdx = s.indexOf("Out-File -FilePath $pidFile");
  if (refuseIdx < 0 || writeIdx < 0 || refuseIdx > writeIdx) {
    throw new Error(
      "start-helper.ps1: duplicate refusal must occur BEFORE the pid file is overwritten",
    );
  }
  // Elevation guidance must reference Administrator.
  if (!/Administrator/i.test(s)) {
    throw new Error("start-helper.ps1 must guide the Owner to Administrator when duplicate found");
  }
});

// 18. Helper stop must distinguish process-absent vs access-denied and MUST
//     NOT delete the pid file when the target PID is alive but inaccessible.
check("stop-helper.ps1 elevation-aware (absent vs access-denied)", () => {
  const p = resolve(ROOT, "helper/stop-helper.ps1");
  const s = readFileSync(p, "utf8");
  if (!/Test-TasklistPidAlive\s+-TargetPid\s+\$targetPid/.test(s)) {
    throw new Error(
      "stop-helper.ps1 must probe existence via shared Test-TasklistPidAlive (locale-safe)",
    );
  }

  if (!/access denied/i.test(s)) {
    throw new Error("stop-helper.ps1 must explicitly report `access denied` for elevated targets");
  }
  if (!/Administrator/i.test(s)) {
    throw new Error(
      "stop-helper.ps1 must instruct the Owner to rerun as Administrator on access denial",
    );
  }
  if (!/exit\s+3/.test(s)) {
    throw new Error(
      "stop-helper.ps1 must exit with a distinct code (3) on access-denied (never report `not running`)",
    );
  }
  // The access-denied branches (both the CIM-inspection branch and the
  // Stop-Process catch) MUST NOT remove the pid file. Match every occurrence
  // of a `Refusing to clear pid file` / `Pid file NOT deleted` guard message
  // and confirm no Remove-Item on $pidFile appears before the following exit 3.
  const guardMatches = [
    ...s.matchAll(/(Refusing to clear pid file|Pid file NOT deleted)[\s\S]*?exit\s+3/gi),
  ];
  if (guardMatches.length < 2) {
    throw new Error(
      "stop-helper.ps1: expected access-denied guard message in BOTH inspection and Stop-Process branches",
    );
  }
  for (const m of guardMatches) {
    if (/Remove-Item[^\r\n]*\$pidFile/.test(m[0])) {
      throw new Error(
        "stop-helper.ps1: access-denied branch must NOT delete $pidFile (would orphan the elevated Helper)",
      );
    }
  }
});

// 19. Delayed-listener regression script must refuse to consume an
//     already-active Desktop Operator, must not read a stale session file,
//     and must clean the test operator's session + pid state in finally.
check("regression-desktop-delayed-listener.ps1 refuses live operator + cleans state", () => {
  const p = resolve(ROOT, "helper/regression-desktop-delayed-listener.ps1");
  const s = readFileSync(p, "utf8");
  if (!/Test-TasklistPidAlive\s+-TargetPid/.test(s)) {
    throw new Error(
      "regression script must probe an already-running operator via shared Test-TasklistPidAlive",
    );
  }

  if (!/Desktop Operator already active/i.test(s)) {
    throw new Error(
      "regression script must abort with a clear message when Desktop Operator is active",
    );
  }
  // Stale-session cleanup BEFORE launching the hidden test operator.
  const preLaunch = s.slice(0, s.indexOf("Start-Process"));
  if (!/Remove-Item[^\r\n]*\$sessionFile/.test(preLaunch)) {
    throw new Error(
      "regression script must remove any stale $sessionFile BEFORE launching its test operator",
    );
  }
  // Post-run cleanup in finally: session + pid.
  const finallyIdx = s.lastIndexOf("finally");
  if (finallyIdx < 0) throw new Error("regression script missing finally cleanup");
  const finallyBody = s.slice(finallyIdx);
  if (!/Remove-Item[^\r\n]*\$sessionFile/.test(finallyBody)) {
    throw new Error("regression script finally must remove $sessionFile of its test operator");
  }
  if (!/Remove-Item[^\r\n]*\$pidFile/.test(finallyBody)) {
    throw new Error("regression script finally must remove $pidFile of its test operator");
  }
});

// 20. Locale-independent tasklist PID parser must be shared across every
//     Helper script. Ban the legacy `-notmatch '^INFO:'` detection that
//     misclassifies Chinese Windows (信息: 没有运行的任务...) as a live PID.
check("shared locale-safe tasklist PID parser is wired everywhere", () => {
  const shared = resolve(ROOT, "helper/lib/tasklist-pid.ps1");
  if (!existsSync(shared)) throw new Error("missing helper/lib/tasklist-pid.ps1");
  const sharedSrc = readFileSync(shared, "utf8");
  if (!/function\s+Test-TasklistPidAlive/.test(sharedSrc)) {
    throw new Error("helper/lib/tasklist-pid.ps1 must define Test-TasklistPidAlive");
  }
  // The parser must key off a quoted CSV process row, not localized prose.
  if (!/'\^"\[\^"\]\*","\(\\d\+\)","'/.test(sharedSrc)) {
    throw new Error(
      'Test-TasklistPidAlive must use the anchored quoted-CSV regex ^"[^"]*","(\\d+)",',
    );
  }
  if (!/\[int\]\$Matches\[1\]\s*-eq\s*\$TargetPid/.test(sharedSrc)) {
    throw new Error("Test-TasklistPidAlive must compare captured PID exactly to $TargetPid");
  }
  if (!/\$exit\s*-ne\s*0[\s\S]{0,120}ok\s*=\s*\$false/.test(sharedSrc)) {
    throw new Error("Test-TasklistPidAlive must fail closed (ok=$false) on tasklist non-zero exit");
  }
  // Ban locale-dependent probes in the shared parser itself.
  if (/-notmatch\s+'\^INFO:'/.test(sharedSrc)) {
    throw new Error("helper/lib/tasklist-pid.ps1 must not match/exclude localized prose");
  }

  // JS mirror exists so Linux CI can regression-test the contract.
  const mjs = resolve(ROOT, "helper/lib/tasklist-pid.mjs");
  if (!existsSync(mjs)) throw new Error("missing helper/lib/tasklist-pid.mjs");
  const mjsSrc = readFileSync(mjs, "utf8");
  if (!/export\s+function\s+classifyTasklistResult/.test(mjsSrc)) {
    throw new Error("helper/lib/tasklist-pid.mjs must export classifyTasklistResult");
  }
  if (!/\/\^"\[\^"\]\*","\(\\d\+\)","\//.test(mjsSrc)) {
    throw new Error("helper/lib/tasklist-pid.mjs must use the same quoted-CSV regex");
  }
  // (No banned executable patterns in JS mirror — the regex above enforces
  // the required shape; comment mentions of "INFO:" / "信息:" are allowed.)

  // All three consumers must dot-source the shared parser and use it, and
  // MUST NOT retain the banned locale-dependent detection.
  const consumers = [
    "helper/start-helper.ps1",
    "helper/stop-helper.ps1",
    "helper/regression-desktop-delayed-listener.ps1",
  ];
  for (const rel of consumers) {
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) throw new Error(`missing ${rel}`);
    const s = readFileSync(p, "utf8");
    if (!/\.\s+\(Join-Path[^\r\n]*tasklist-pid\.ps1/.test(s)) {
      throw new Error(`${rel} must dot-source helper/lib/tasklist-pid.ps1`);
    }
    if (!/Test-TasklistPidAlive/.test(s)) {
      throw new Error(`${rel} must call Test-TasklistPidAlive for PID probes`);
    }
    if (/-notmatch\s+'\^INFO:'/.test(s)) {
      throw new Error(`${rel} still uses locale-dependent -notmatch '^INFO:' detection`);
    }
    // Fail-closed contract: probe.ok=$false must NOT proceed to overwrite pid
    // file or launch anything.
    if (!/-not\s+\$probe\.ok|\$probe\d*\.ok\s*-eq\s*\$false/.test(s)) {
      throw new Error(`${rel} must inspect probe.ok before acting on probe.alive`);
    }
  }

  // Regression test file exists.
  const t = resolve(ROOT, "tests/tasklist-pid.test.ts");
  if (!existsSync(t)) throw new Error("missing tests/tasklist-pid.test.ts");
  const tsrc = readFileSync(t, "utf8");
  const required = [
    /INFO: No tasks/,
    /信息: 没有运行的任务/,
    /"node\.exe","\$\{TARGET_PID\}"/,
    /"node\.exe","\$\{OTHER_PID\}"/,
    /exitCode:\s*1/,
    /alive:\s*true/,
  ];
  for (const re of required) {
    if (!re.test(tsrc)) {
      throw new Error(`tests/tasklist-pid.test.ts missing required assertion: ${re}`);
    }
  }
});

// Gate 21 — P0-R6.1 — Runtime MCP tools/list must expose every source-defined
// desktop_* tool with a real object JSON Schema that requires session_id.
// The 0.4.7 field regression proved that a single `inputSchema: null` (from
// a `.refine()`-wrapped Zod schema) causes strict MCP clients (ChatGPT) to
// silently drop the entire desktop_* group from tools/list. Manifest ==
// bundled tools/list; assert both structure and count here.
check("MCP manifest exposes all 14 desktop_* tools with valid session_id schema", () => {
  const p = resolve(ROOT, ".lovable/mcp/manifest.json");
  if (!existsSync(p)) throw new Error("missing .lovable/mcp/manifest.json");
  const m = JSON.parse(readFileSync(p, "utf8"));
  const tools = m?.mcp?.tools;
  if (!Array.isArray(tools)) throw new Error("manifest.mcp.tools is not an array");

  const EXPECTED_DESKTOP = [
    "desktop_snapshot",
    "desktop_list_windows",
    "desktop_inspect",
    "desktop_focus_window",
    "desktop_click",
    "desktop_type",
    "desktop_press",
    "desktop_hotkey",
    "desktop_scroll",
    "desktop_drag",
    "desktop_clipboard_get",
    "desktop_clipboard_set",
    "desktop_launch",
    "desktop_wait",
  ];

  const byName = new Map(tools.map((t) => [t.name, t]));
  const missing = EXPECTED_DESKTOP.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new Error(`manifest missing desktop tools: ${missing.join(", ")}`);
  }
  const present = EXPECTED_DESKTOP.filter((n) => byName.has(n));
  if (present.length !== 14) {
    throw new Error(`expected exactly 14 desktop_* tools, got ${present.length}`);
  }

  for (const name of EXPECTED_DESKTOP) {
    const t = byName.get(name);
    const s = t.inputSchema;
    if (!s || typeof s !== "object") {
      throw new Error(
        `${name}.inputSchema must be an object, got ${s === null ? "null" : typeof s}`,
      );
    }
    if (s.type !== "object") {
      throw new Error(`${name}.inputSchema.type must be "object", got ${s.type}`);
    }
    if (!s.properties || typeof s.properties !== "object") {
      throw new Error(`${name}.inputSchema.properties missing`);
    }
    if (!s.properties.session_id) {
      throw new Error(`${name}.inputSchema.properties.session_id missing`);
    }
    if (s.properties.session_id.format !== "uuid") {
      throw new Error(`${name}.session_id must be format:uuid`);
    }
    if (!Array.isArray(s.required) || !s.required.includes("session_id")) {
      throw new Error(`${name} must list session_id in required[]`);
    }
    if (!s.properties.idempotency_key) {
      throw new Error(`${name}.inputSchema missing idempotency_key`);
    }
  }
});

// Gate 22 — P0-R6.1 — The factory that publishes desktop tool schemas MUST
// unwrap ZodEffects (from `.refine()`) so `.shape` is reachable. Regressing
// to `input.shape` on a ZodEffects yields `inputSchema: null` and silently
// drops the whole group. Guard the source shape.
check("desktop tool factory unwraps ZodEffects before publishing inputSchema", () => {
  const p = resolve(ROOT, "src/lib/mcp/tools/_desktop-factory.ts");
  if (!existsSync(p)) throw new Error("missing src/lib/mcp/tools/_desktop-factory.ts");
  const s = readFileSync(p, "utf8");
  if (!/ZodEffects/.test(s)) {
    throw new Error("_desktop-factory.ts must reference z.ZodEffects to unwrap refined schemas");
  }
  if (!/_def\.schema/.test(s)) {
    throw new Error(
      "_desktop-factory.ts must access ZodEffects._def.schema to reach the ZodObject",
    );
  }
  // The old broken form `input.shape` alone would leave desktop_launch null.
  if (/inputSchema:\s*input\.shape\b/.test(s)) {
    throw new Error("_desktop-factory.ts still uses the pre-fix `inputSchema: input.shape` form");
  }
  if (!/inputSchema:\s*objectSchema\.shape/.test(s)) {
    throw new Error("_desktop-factory.ts must publish inputSchema from the unwrapped ZodObject");
  }
});

// Gate 23 — P0-R9: foreground calls execute in disposable, bounded workers;
// failures retain Win32 diagnostics through Helper and persisted Run events.
check("0.4.11 isolated foreground escalation and diagnostics propagation", () => {
  const ps = readFileSync(resolve(ROOT, "helper/desktop-operator.ps1"), "utf8");
  const desktop = readFileSync(resolve(ROOT, "helper/src/desktop.mjs"), "utf8");
  const helper = readFileSync(resolve(ROOT, "helper/src/index.mjs"), "utf8");
  const route = readFileSync(resolve(ROOT, "src/routes/api/worker/v1/$action.ts"), "utf8");
  const worker = readFileSync(resolve(ROOT, "helper/focus-window-worker.ps1"), "utf8");
  const focusTest = readFileSync(resolve(ROOT, "tests/desktop-focus-window.test.ts"), "utf8");
  const focusRuntime = `${ps}\n${worker}`;
  for (const token of [
    "ShowWindowAsync",
    "SetWindowPos",
    "SetActiveWindow",
    "SetFocus",
    "tidForeground",
    "attach_foreground_thread_input_ok",
  ]) {
    if (!focusRuntime.includes(token)) {
      throw new Error(`desktop foreground strategy missing ${token}`);
    }
  }
  if (
    !/SetForegroundWindow\(IntPtr hWnd\)/.test(focusRuntime) ||
    !/Marshal\]::GetLastWin32Error\(\)/.test(focusRuntime)
  ) {
    throw new Error("foreground strategy must capture SetForegroundWindow last-error immediately");
  }
  if (/\[SI_FG\]::GetLastError\(\)/.test(focusRuntime)) {
    throw new Error(
      "foreground strategy still uses the unreliable secondary GetLastError P/Invoke",
    );
  }
  if (!/result:\s*payload\.result\s*\?\?\s*payload/.test(desktop)) {
    throw new Error("desktop.mjs drops bridge diagnostics on non-2xx responses");
  }
  if (!/diagnostics:\s*stepResult\.result\s*\?\?\s*null/.test(helper)) {
    throw new Error("Helper step.failed does not carry diagnostics");
  }
  if (!/const redactPayload = \(value: unknown\)/.test(route)) {
    throw new Error("worker event route must deep-redact nested diagnostics");
  }
  for (const token of [
    "function Invoke-FocusStage",
    "System.Diagnostics.ProcessStartInfo",
    "UseShellExecute = $false",
    "CreateNoWindow = $true",
    "-EncodedCommand",
    "TerminateProcess($proc.Handle",
    "FOCUS_STAGE_TIMEOUT",
    "last_checkpoint",
  ]) {
    if (!ps.includes(token)) throw new Error(`isolated focus runner missing ${token}`);
  }
  const stageStart = ps.indexOf("function Invoke-FocusStage");
  const stageEnd = ps.indexOf("function Merge-FocusDiagnostics", stageStart);
  const stageRunner = ps.slice(stageStart, stageEnd);
  if (/Start-Process|WaitForExit\(|\.Kill\(/.test(stageRunner)) {
    throw new Error("focus runner may still inherit or block on the interactive console");
  }
  const logStart = ps.indexOf("function Log");
  const logEnd = ps.indexOf("# Ephemeral", logStart);
  if (/Write-Host/.test(ps.slice(logStart, logEnd))) {
    throw new Error("request-path logging may block the bridge in console QuickEdit mode");
  }
  if (/\[Console\]::/.test(worker)) {
    throw new Error("focus worker must not access an inherited interactive console");
  }
  if (
    !/AllowSetForegroundWindow\(\[uint32\]::MaxValue\)/.test(worker) ||
    /AllowSetForegroundWindow\(0xFFFFFFFF\)/.test(worker)
  ) {
    throw new Error("ASFW_ANY must bind as UInt32.MaxValue in Windows PowerShell 5.1");
  }
  if (
    !/ReadAllText\(\$outputPath,\s*\[System\.Text\.Encoding\]::UTF8\)/.test(ps) ||
    !/ReadAllText\(\$checkpointPath,\s*\[System\.Text\.Encoding\]::UTF8\)/.test(ps) ||
    !/ReadAllText\(\$RequestPath,\s*\[System\.Text\.Encoding\]::UTF8\)/.test(worker)
  ) {
    throw new Error("focus stage JSON files must be read as explicit UTF-8");
  }
  if (
    !/\$action\s+-eq\s+'focus'\s+-and\s+-not\s+\$iconicBefore/.test(worker) ||
    !worker.includes("show_window_skipped_normal_focus")
  ) {
    throw new Error("normal focus must not clear foreground with an unnecessary SW_RESTORE");
  }
  for (const token of ["PeekMessage", "message_queue_initialized", "alt_tap_same_process"]) {
    if (!worker.includes(token)) {
      throw new Error(`attached focus worker missing ${token}`);
    }
  }
  for (const token of [
    "before_alt_key_down",
    "before_attach_target_thread",
    "before_switch_to_this_window",
  ]) {
    if (!worker.includes(token)) throw new Error(`focus worker checkpoint missing ${token}`);
  }
  if (!focusTest.includes("isolated escalation")) {
    throw new Error("focus isolation regression test missing");
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
