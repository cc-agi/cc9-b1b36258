// P0-R5 R2 regression — desktop-session.json MUST be BOM-less and helper MUST
// tolerate a stray BOM. Under Windows PowerShell 5.1, `Set-Content -Encoding UTF8`
// prepends U+FEFF, which JSON.parse rejects. That silently produced
// DESKTOP_SESSION_INACTIVE on real Windows even though the loopback bridge was
// ACTIVE.
//
// This file contains BOTH:
//   (a) static regression checks over helper/desktop-operator.ps1 and helper/src/desktop.mjs
//   (b) a REAL end-to-end integration test that:
//         - fakes %LOCALAPPDATA% with a BOM-prefixed desktop-session.json
//         - overrides process.platform to "win32"
//         - fresh dynamic-imports helper/src/desktop.mjs
//         - starts a real node:http server on 127.0.0.1 ephemeral port
//         - asserts readDesktopSessionMeta / executeDesktopTool succeed twice
//         - verifies the bridge saw exactly two authenticated calls
//         - rewrites the session BOM-less between calls to prove re-read works
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { describe, expect, it, afterEach } from "vitest";

const ps = readFileSync(resolve(__dirname, "../helper/desktop-operator.ps1"), "utf8");
const mjs = readFileSync(resolve(__dirname, "../helper/src/desktop.mjs"), "utf8");

describe("desktop-session.json BOM handling (static)", () => {
  it("desktop-operator.ps1 does not use Set-Content -Encoding UTF8 for the session file", () => {
    expect(ps).not.toMatch(/Set-Content[^\r\n]*\$sessionFile[^\r\n]*-Encoding\s+UTF8/i);
  });

  it("desktop-operator.ps1 centralizes writes in Write-SessionDoc using BOM-less UTF8Encoding", () => {
    expect(ps).toMatch(/function\s+Write-SessionDoc/);
    expect(ps).toMatch(/\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    expect(ps).toMatch(/\[System\.IO\.File\]::WriteAllText\([^)]*\$tmp/);
  });

  it("Write-SessionDoc publishes atomically via a unique same-directory temp file + Replace/Move", () => {
    // Unique temp name using PID + Guid inside the SAME directory as $sessionFile.
    expect(ps).toMatch(/\$tmp\s*=\s*Join-Path[^\r\n]*sentinelDir/);
    expect(ps).toMatch(/Guid\]::NewGuid/i);
    expect(ps).toMatch(/\[System\.IO\.File\]::(Replace|Move)/);
  });

  it("Write-SessionDoc removes its temp file in finally if still present", () => {
    // A `finally` block that Remove-Item $tmp -ErrorAction SilentlyContinue if Test-Path.
    expect(ps).toMatch(/finally\s*\{[^}]*Remove-Item[^}]*\$tmp/s);
  });

  it("Write-SessionDoc re-applies the owner-only ACL after every publish", () => {
    // File.Replace is not guaranteed to preserve destination ACL on WinPS 5.1 — we
    // reapply the owner Full-Control rule INSIDE Write-SessionDoc via the shared
    // Set-OwnerOnlyAcl helper (0.4.1 uses fully-qualified WindowsIdentity name,
    // not bare $env:USERNAME, so domain-joined boxes still get the correct ACE).
    const fn = ps.match(/function\s+Write-SessionDoc[\s\S]*?\n\}\s*\n/);
    expect(fn, "Write-SessionDoc body not found").toBeTruthy();
    expect(fn![0]).toMatch(/Set-OwnerOnlyAcl\s+\$sessionFile/);
    // The helper itself must use WindowsIdentity + icacls with (F) and inheritance:r.
    expect(ps).toMatch(/WindowsIdentity\]::GetCurrent\(\)\.Name/);
    expect(ps).toMatch(/icacls[^\r\n]*\$\{?ownerPrincipal\}?:\(F\)/);
    expect(ps).toMatch(/inheritance:r/);
  });

  it("initial ACTIVE session publish and Bump-Activity both go through Write-SessionDoc", () => {
    const matches = ps.match(/Write-SessionDoc\s+\$/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("helper/src/desktop.mjs strips a leading BOM before JSON.parse (defense in depth)", () => {
    expect(mjs).toMatch(/replace\(\s*\/\^\\uFEFF\/\s*,\s*""\s*\)/);
  });
});

describe("desktop.mjs integration — BOM-prefixed session + real loopback bridge", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalAppData = process.env.APPDATA;

  let tmpRoot: string | null = null;
  let server: http.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    tmpRoot = null;
  });

  it("reads a BOM-prefixed session and executes desktop_snapshot twice against the real bridge", async () => {
    // 1. Fake %LOCALAPPDATA%/SentinelOS/ and write a BOM-prefixed session doc.
    tmpRoot = resolve(tmpdir(), `sentinel-bom-${process.pid}-${Date.now()}`);
    const sentinelDir = resolve(tmpRoot, "SentinelOS");
    mkdirSync(sentinelDir, { recursive: true });
    const sessionFile = resolve(sentinelDir, "desktop-session.json");

    // 2. Start a real loopback HTTP bridge on an ephemeral port.
    const secret = "test-bearer-" + Math.random().toString(36).slice(2);
    const calls: Array<{ auth: string | undefined; tool: string }> = [];

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const auth = req.headers.authorization;
        let parsed: { tool?: string } = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          /* leave empty */
        }
        calls.push({ auth, tool: parsed.tool });

        if (auth !== `Bearer ${secret}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error_code: "UNAUTHORIZED" }));
          return;
        }
        if (parsed.tool !== "desktop_snapshot") {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error_code: "BAD_TOOL" }));
          return;
        }

        // After the FIRST successful request, rewrite the session doc BOM-LESS
        // with an updated last_activity_at. The client must re-read successfully.
        if (calls.length === 1) {
          const updated = {
            port,
            secret,
            session_id: "sid-int-1",
            worker_id: "w-int",
            started_at: Date.now() - 1000,
            last_activity_at: Date.now(),
            idle_ttl_ms: 1_800_000,
            log_path: "",
          };
          writeFileSync(sessionFile, JSON.stringify(updated), { encoding: "utf8" });
        }

        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { call: calls.length } }));
      });
    });

    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    // Now write the INITIAL session doc with a leading UTF-8 BOM (the exact
    // regression WinPS 5.1 `Set-Content -Encoding UTF8` produced).
    const initialDoc = {
      port,
      secret,
      session_id: "sid-int-1",
      worker_id: "w-int",
      started_at: Date.now(),
      last_activity_at: Date.now(),
      idle_ttl_ms: 1_800_000,
      log_path: "",
    };
    writeFileSync(sessionFile, "\uFEFF" + JSON.stringify(initialDoc), { encoding: "utf8" });

    // Sanity: the raw file starts with a BOM byte sequence EF BB BF.
    const rawBytes = readFileSync(sessionFile);
    expect(rawBytes[0]).toBe(0xef);
    expect(rawBytes[1]).toBe(0xbb);
    expect(rawBytes[2]).toBe(0xbf);

    // 3. Override process.platform (configurable per Node docs) and LOCALAPPDATA
    //    BEFORE the fresh dynamic import so sessionFilePath() resolves into our tmp.
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
      writable: false,
      enumerable: true,
    });
    process.env.LOCALAPPDATA = tmpRoot;

    // Fresh import bust to avoid Vitest module cache. desktop.mjs has no
    // module-scope side effects, but we still want a clean instance.
    const mod = await import("../helper/src/desktop.mjs?bomtest=" + Date.now());

    // 4. readDesktopSessionMeta must succeed against the BOM-prefixed file.
    const meta = await mod.readDesktopSessionMeta();
    expect(meta, "meta must be non-null with BOM present").toBeTruthy();
    expect(meta.active).toBe(true);
    expect(meta.session_id).toBe("sid-int-1");
    expect(meta.worker_id).toBe("w-int");

    // 5. Two consecutive executeDesktopTool calls MUST both succeed.
    const r1 = await mod.executeDesktopTool("desktop_snapshot", { session_id: "sid-int-1" });
    expect(r1.ok, `first call must succeed: ${JSON.stringify(r1)}`).toBe(true);

    const r2 = await mod.executeDesktopTool("desktop_snapshot", { session_id: "sid-int-1" });
    expect(r2.ok, `second call must succeed after BOM-less rewrite: ${JSON.stringify(r2)}`).toBe(
      true,
    );

    // 6. The bridge must have received EXACTLY two authenticated snapshot calls.
    expect(calls.length).toBe(2);
    expect(calls[0].auth).toBe(`Bearer ${secret}`);
    expect(calls[0].tool).toBe("desktop_snapshot");
    expect(calls[1].auth).toBe(`Bearer ${secret}`);
    expect(calls[1].tool).toBe("desktop_snapshot");
  });

  it("forwards the trusted orchestration envelope and rejects a mismatched session_id (0.4.1)", async () => {
    tmpRoot = resolve(tmpdir(), `sentinel-env-${process.pid}-${Date.now()}`);
    const sentinelDir = resolve(tmpRoot, "SentinelOS");
    mkdirSync(sentinelDir, { recursive: true });
    const sessionFile = resolve(sentinelDir, "desktop-session.json");

    const secret = "test-envelope-" + Math.random().toString(36).slice(2);
    const seen: Array<{ tool: string; envelope: unknown }> = [];

    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        seen.push({ tool: parsed.tool, envelope: parsed.envelope });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: {} }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    writeFileSync(
      sessionFile,
      JSON.stringify({
        port,
        secret,
        session_id: "sid-real",
        worker_id: "w-env",
        started_at: Date.now(),
        last_activity_at: Date.now(),
        idle_ttl_ms: 1_800_000,
        log_path: "",
      }),
      { encoding: "utf8" },
    );

    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
      writable: false,
      enumerable: true,
    });
    process.env.LOCALAPPDATA = tmpRoot;

    const mod = await import("../helper/src/desktop.mjs?envtest=" + Date.now());

    // (a) matching session_id + envelope forwarded verbatim
    const ok = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: "sid-real" },
      { run_id: "run-1", intent_id: "int-1", idempotency_key: "att1:seq1" },
    );
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0].envelope).toEqual({
      run_id: "run-1",
      intent_id: "int-1",
      idempotency_key: "att1:seq1",
    });

    // (b) mismatched session_id must fail closed WITHOUT calling the bridge
    const mismatch = await mod.executeDesktopTool(
      "desktop_snapshot",
      { session_id: "sid-wrong" },
      { run_id: "run-1", intent_id: "int-2", idempotency_key: "att1:seq2" },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error_code).toBe("DESKTOP_SESSION_MISMATCH");
    expect(seen.length).toBe(1); // bridge NOT called on mismatch
  });
});
