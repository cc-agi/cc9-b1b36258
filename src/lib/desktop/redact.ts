/**
 * P0-R5 — Redaction for desktop_* payloads.
 *
 * ORDINARY LOGS (agent_events, orchestrator traces) must never carry:
 *   - typed text (desktop_type.text)
 *   - clipboard write/read bodies (desktop_clipboard.value / result value)
 *   - screenshot bytes (desktop_snapshot evidence)
 *
 * Only the DIRECT tool result returned to the calling MCP client may carry the
 * plaintext body when it is the caller's own data. Even then, screenshot bytes
 * NEVER travel over the wire — only a local file path plus size/hash.
 */
import { createHash } from "node:crypto";

export type Redacted = {
  redacted: true;
  length: number;
  sha256: string; // hex
  preview?: string; // first 4 code points, printable-only
};

export function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest("hex");
}

export function redactString(value: string): Redacted {
  const preview = Array.from(value)
    .slice(0, 4)
    .map((ch) => (/[\u0020-\u007e]/.test(ch) ? ch : "·"))
    .join("");
  return {
    redacted: true,
    length: value.length,
    sha256: sha256Hex(value),
    preview,
  };
}

export function redactBytes(bytes: Uint8Array): Redacted {
  return {
    redacted: true,
    length: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

/**
 * Deep-redact a desktop_* intent's arguments for the audit trail.
 * Idempotent: passing an already-redacted object leaves it unchanged.
 */
export function redactDesktopArgs(tool: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return { redacted: true };
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (tool === "desktop_type" && typeof out.text === "string") {
    out.text = redactString(out.text);
  }
  // P0-R6: split clipboard tools (get has no args worth redacting; set carries value)
  if (
    (tool === "desktop_clipboard_set" || tool === "desktop_clipboard") &&
    typeof out.value === "string"
  ) {
    out.value = redactString(out.value);
  }
  return out;
}

/**
 * Redact a desktop_* tool result before persisting it to agent_events /
 * step_results audit. The direct-return path to the MCP caller uses the
 * un-redacted body (that is the caller's own data).
 */
export function redactDesktopResult(
  tool: string,
  result: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!result) return result ?? null;
  const out: Record<string, unknown> = { ...result };

  // Snapshot: strip base64/bytes, keep path + size + sha256.
  if (tool === "desktop_snapshot" && out.evidence && typeof out.evidence === "object") {
    const ev = { ...(out.evidence as Record<string, unknown>) };
    if ("image_base64" in ev) delete ev.image_base64;
    if ("image_bytes" in ev) delete ev.image_bytes;
    if (Array.isArray(ev.monitors)) {
      ev.monitors = (ev.monitors as Array<Record<string, unknown>>).map((m) => {
        const cp = { ...m };
        delete cp.image_base64;
        delete cp.image_bytes;
        return cp;
      });
    }
    out.evidence = ev;
  }

  // Clipboard read: replace `value` with redacted meta.
  if (
    (tool === "desktop_clipboard_get" || tool === "desktop_clipboard") &&
    out.evidence &&
    typeof out.evidence === "object"
  ) {
    const ev = { ...(out.evidence as Record<string, unknown>) };
    if (typeof ev.value === "string") ev.value = redactString(ev.value);
    out.evidence = ev;
  }

  // Type: the input args are what carry text; result usually has no text but
  // guard against future evidence fields.
  if (tool === "desktop_type" && out.evidence && typeof out.evidence === "object") {
    const ev = { ...(out.evidence as Record<string, unknown>) };
    if (typeof ev.typed_text === "string") ev.typed_text = redactString(ev.typed_text);
    out.evidence = ev;
  }

  return out;
}
