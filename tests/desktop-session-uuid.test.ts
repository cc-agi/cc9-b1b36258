/**
 * 0.4.14 — session_id canonical UUID regression.
 *
 * The Desktop Operator (helper/desktop-operator.ps1) must generate its
 * session_id via [guid]::NewGuid().ToString("D") and reject any value that
 * does not match the canonical 36-char 8-4-4-4-12 UUID form. The MCP
 * schemas must keep `.uuid()` strict.
 *
 * We cannot exec PowerShell in CI, so we (1) assert the runtime generator +
 * validator strings are present in the .ps1 source, and (2) generate 100
 * UUIDs via Node's crypto.randomUUID (same canonical format) and confirm
 * they all satisfy the exact same regex the .ps1 uses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PS_PATH = resolve(__dirname, "..", "helper", "desktop-operator.ps1");
const SCHEMAS_PATH = resolve(__dirname, "..", "src", "lib", "desktop", "schemas.ts");

// The exact regex enforced by desktop-operator.ps1 (mirror, not import).
const UUID_D_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("desktop-operator session_id", () => {
  const ps = readFileSync(PS_PATH, "utf8");

  it('generates session_id via [guid]::NewGuid().ToString("D")', () => {
    expect(ps).toMatch(/\$sessionId = \[guid\]::NewGuid\(\)\.ToString\("D"\)/);
    // Must NOT fall back to the argumentless form on the sessionId line.
    expect(ps).not.toMatch(/\$sessionId\s*=\s*\[guid\]::NewGuid\(\)\.ToString\(\)\s*$/m);
  });

  it("validates session_id with TryParse + length + regex before advertising ACTIVE", () => {
    expect(ps).toMatch(/\[guid\]::TryParse\(\$sessionId,\s*\[ref\]/);
    expect(ps).toMatch(/\$sessionId\.Length\s*-ne\s*36/);
    expect(ps).toMatch(/\$sessionId\s+-notmatch\s+\$__uuidRe/);
    expect(ps).toMatch(/Refusing to start\./);
  });

  it("100 canonically-generated UUIDs all satisfy the operator's regex", () => {
    for (let i = 0; i < 100; i++) {
      const id = randomUUID(); // 8-4-4-4-12 lowercase hex, same as .ToString("D")
      expect(id).toHaveLength(36);
      expect(UUID_D_REGEX.test(id)).toBe(true);
    }
  });

  it("rejects the malformed 37-char id observed in the 0.4.13 field report", () => {
    const malformed = "b243ae7f-d686-48ef-9327-34a7bf562913d"; // 13-char tail
    expect(malformed).toHaveLength(37);
    expect(UUID_D_REGEX.test(malformed)).toBe(false);
  });

  it("MCP schemas keep session_id strictly .uuid()", () => {
    const schemas = readFileSync(SCHEMAS_PATH, "utf8");
    expect(schemas).toMatch(/session_id:\s*z\.string\(\)\.uuid\(\)/);
  });
});
