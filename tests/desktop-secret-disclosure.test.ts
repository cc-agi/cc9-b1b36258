import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const H = (f: string) => resolve(ROOT, "helper", f);

describe("desktop-operator status/log paths do not leak session secret", () => {
  it("status-desktop-operator.bat does not `type` the raw session file", () => {
    const s = readFileSync(H("status-desktop-operator.bat"), "utf8");
    expect(/^\s*type\s+"?%SESSION%/im.test(s)).toBe(false);
    expect(/^\s*type\s+["%].*desktop-session\.json/im.test(s)).toBe(false);
  });

  it("status-desktop-operator.bat parses JSON via PowerShell", () => {
    const s = readFileSync(H("status-desktop-operator.bat"), "utf8");
    expect(/powershell\.exe/i.test(s)).toBe(true);
    expect(/ConvertFrom-Json/i.test(s)).toBe(true);
  });

  it("status-desktop-operator.bat emits only whitelisted fields", () => {
    const s = readFileSync(H("status-desktop-operator.bat"), "utf8");
    // Forbid printing $s.secret or the secret field via Write-Host.
    expect(/Write-Host[^\r\n]*\bsecret\b/i.test(s)).toBe(false);
    expect(/\$s\.secret\b/i.test(s)).toBe(false);
  });

  it("start-desktop-operator.bat does not echo secret/token", () => {
    const s = readFileSync(H("start-desktop-operator.bat"), "utf8");
    expect(/echo[^\r\n]*\$?secret/i.test(s)).toBe(false);
    expect(/echo[^\r\n]*bearer/i.test(s)).toBe(false);
  });

  it("stop-desktop-operator.bat does not dump session file", () => {
    const s = readFileSync(H("stop-desktop-operator.bat"), "utf8");
    expect(/^\s*type\s+["%].*desktop-session/im.test(s)).toBe(false);
    expect(/echo[^\r\n]*\$?secret/i.test(s)).toBe(false);
  });

  it("desktop-operator.ps1 never Write-Host / Add-Content the $secret variable", () => {
    const s = readFileSync(H("desktop-operator.ps1"), "utf8");
    expect(/Write-(Host|Output)[^\r\n]*\$secret\b/i.test(s)).toBe(false);
    expect(/Add-Content[^\r\n]*\$secret\b/i.test(s)).toBe(false);
  });

  it("helper/src/desktop.mjs bridge does not console.log the session secret", () => {
    const p = H("src/desktop.mjs");
    if (!existsSync(p)) return;
    const s = readFileSync(p, "utf8");
    expect(/console\.(log|info|warn|error)[^;\n]*\.secret\b/.test(s)).toBe(false);
    expect(/console\.(log|info|warn|error)[^;\n]*\bsecret\b/i.test(s)).toBe(false);
  });
});
