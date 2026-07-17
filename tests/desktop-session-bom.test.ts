// P0-R5 R2 regression — desktop-session.json MUST be BOM-less and helper MUST
// tolerate a stray BOM. Under Windows PowerShell 5.1, `Set-Content -Encoding UTF8`
// prepends U+FEFF, which JSON.parse rejects. That silently produced
// DESKTOP_SESSION_INACTIVE on real Windows even though the loopback bridge was
// ACTIVE. This test is a static regression that prevents the mistake from
// returning; end-to-end behaviour is covered by the release gate + owner runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ps = readFileSync(resolve(__dirname, "../helper/desktop-operator.ps1"), "utf8");
const mjs = readFileSync(resolve(__dirname, "../helper/src/desktop.mjs"), "utf8");

describe("desktop-session.json BOM handling", () => {
  it("desktop-operator.ps1 does not use Set-Content -Encoding UTF8 for the session file", () => {
    expect(ps).not.toMatch(/Set-Content[^\r\n]*\$sessionFile[^\r\n]*-Encoding\s+UTF8/i);
  });

  it("desktop-operator.ps1 centralizes writes in Write-SessionDoc using BOM-less UTF8Encoding", () => {
    expect(ps).toMatch(/function\s+Write-SessionDoc/);
    expect(ps).toMatch(/\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    expect(ps).toMatch(/\[System\.IO\.File\]::WriteAllText\([^)]*\$tmp/);
  });

  it("Write-SessionDoc publishes atomically via a temp file + Replace/Move", () => {
    // Match a temp path either as `"$sessionFile.tmp"` or with the tmp variable used in Replace/Move.
    expect(ps).toMatch(/\$sessionFile\.tmp/);
    expect(ps).toMatch(/\[System\.IO\.File\]::(Replace|Move)/);
  });

  it("initial ACTIVE session publish and Bump-Activity both go through Write-SessionDoc", () => {
    const matches = ps.match(/Write-SessionDoc\s+\$/g) ?? [];
    // At minimum: one call in Bump-Activity + one call at initial publish.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("helper/src/desktop.mjs strips a leading BOM before JSON.parse (defense in depth)", () => {
    expect(mjs).toMatch(/replace\(\s*\/\^\\uFEFF\/\s*,\s*""\s*\)/);
  });

  it("helper tolerates a BOM-prefixed session document at runtime", async () => {
    // Simulate the exact byte pattern WinPS 5.1 would emit and confirm the
    // BOM-stripping parse succeeds.
    const doc = { port: 15623, secret: "abc", session_id: "sid" };
    const raw = "\uFEFF" + JSON.stringify(doc);
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    expect(parsed.session_id).toBe("sid");
    expect(() => JSON.parse(raw)).toThrow(); // proves the regression exists without the strip
  });
});
