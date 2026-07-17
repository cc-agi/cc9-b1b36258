import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve(process.cwd(), "helper/desktop-operator.ps1"), "utf8");

function position(pattern: RegExp): number {
  const match = pattern.exec(script);
  expect(match, `missing lifecycle token: ${pattern}`).not.toBeNull();
  return match!.index;
}

function positionAfter(pattern: RegExp, offset: number): number {
  const match = pattern.exec(script.slice(offset));
  expect(match, `missing lifecycle token after offset ${offset}: ${pattern}`).not.toBeNull();
  return offset + match!.index;
}

describe("desktop-operator HTTP listener lifecycle", () => {
  it("releases and clears the probe listener before creating HttpListener", () => {
    const selectedPort = position(
      /\$port\s*=\s*\(\[System\.Net\.IPEndPoint\]\$probeListener\.LocalEndpoint\)\.Port/,
    );
    const probeStop = positionAfter(/\$probeListener\.Stop\(\)/, selectedPort);
    const probeDispose = positionAfter(/\$probeListener\.Server\.Dispose\(\)/, probeStop);
    const probeClear = positionAfter(/\$probeListener\s*=\s*\$null/, probeDispose);
    const httpCreate = positionAfter(
      /\$http\s*=\s*New-Object System\.Net\.HttpListener/,
      probeClear,
    );

    expect(selectedPort).toBeLessThan(probeStop);
    expect(probeStop).toBeLessThan(probeDispose);
    expect(probeDispose).toBeLessThan(probeClear);
    expect(probeClear).toBeLessThan(httpCreate);
  });

  it("uses a bounded retry loop around the real HTTP bind", () => {
    expect(script).toMatch(/\$maxBindAttempts\s*=\s*5/);
    expect(script).toMatch(/for \(\$bindAttempt = 1; \$bindAttempt -le \$maxBindAttempts;/);
    expect(script).toMatch(/\$http\.Start\(\)/);
    expect(script).toMatch(/if \(\$bindAttempt -ge \$maxBindAttempts\) \{ throw \$bindError \}/);
  });

  it("publishes session, PID, journal, and ACTIVE only after a successful bind", () => {
    const httpStart = position(/\$http\.Start\(\)/);
    const listeningGuard = position(/if \(\$null -eq \$http -or -not \$http\.IsListening\)/);
    const sessionWrite = positionAfter(/Set-Content -Path \$sessionFile/, listeningGuard);
    const pidWrite = positionAfter(/WriteAllText\([^)]*\$pidFile/, sessionWrite);
    const journalCreate = positionAfter(
      /New-Item -ItemType Directory -Path \$journalDir/,
      pidWrite,
    );
    const activeOutput = positionAfter(/Log "\[desktop-operator\] ACTIVE/, journalCreate);

    expect(httpStart).toBeLessThan(listeningGuard);
    expect(listeningGuard).toBeLessThan(sessionWrite);
    expect(sessionWrite).toBeLessThan(pidWrite);
    expect(pidWrite).toBeLessThan(journalCreate);
    expect(journalCreate).toBeLessThan(activeOutput);
  });

  it("wraps startup and execution in finally cleanup for all listener and state artifacts", () => {
    const lifecycleTry = position(/try \{\s*for \(\$bindAttempt/s);
    const httpStart = position(/\$http\.Start\(\)/);
    const cleanupFinally = script.lastIndexOf("} finally {");
    const cleanup = script.slice(cleanupFinally);

    expect(lifecycleTry).toBeLessThan(httpStart);
    expect(cleanupFinally).toBeGreaterThan(httpStart);
    expect(cleanup).toMatch(/\$probeListener\.Stop\(\)/);
    expect(cleanup).toMatch(/\$probeListener\.Server\.Dispose\(\)/);
    expect(cleanup).toMatch(/\$http\.Stop\(\)/);
    expect(cleanup).toMatch(/\$http\.Close\(\)/);
    expect(cleanup).toMatch(/Remove-Item -Force \$sessionFile/);
    expect(cleanup).toMatch(/Remove-Item -Force \$pidFile/);
    expect(cleanup).toMatch(/Remove-Item -Recurse -Force \$journalDir/);
  });
});
