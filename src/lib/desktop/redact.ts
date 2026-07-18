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

  // 0.4.20 Action Verification Engine — the pre/post evidence for click,
  // drag, hotkey, and type embeds focused_text / focused_value snapshots of
  // the target document. Scrub those from the AUDIT copy while keeping the
  // direct tool result to the MCP caller intact (that IS the caller's data).
  if (
    tool === "desktop_type" ||
    tool === "desktop_hotkey" ||
    tool === "desktop_click" ||
    tool === "desktop_drag"
  ) {
    const scrubSide = (side: unknown): unknown => {
      if (!side || typeof side !== "object") return side;
      const cp = { ...(side as Record<string, unknown>) };
      for (const k of ["focused_text", "focused_value"]) {
        if (typeof cp[k] === "string") cp[k] = redactString(cp[k] as string);
      }
      return cp;
    };
    const scrubContainer = (obj: Record<string, unknown>) => {
      const cp = { ...obj };
      if ("pre" in cp) cp.pre = scrubSide(cp.pre);
      if ("post" in cp) cp.post = scrubSide(cp.post);
      if (typeof cp.typed_text === "string") cp.typed_text = redactString(cp.typed_text as string);
      return cp;
    };
    if (out.evidence && typeof out.evidence === "object") {
      out.evidence = scrubContainer(out.evidence as Record<string, unknown>);
    }
    if (out.result && typeof out.result === "object") {
      out.result = scrubContainer(out.result as Record<string, unknown>);
    }
  }

  // Inspect: TextPattern / ValuePattern reads carry the caller's document
  // content. The DIRECT tool result keeps plaintext (that IS the requested
  // read); the audit copy replaces text/value with length + sha256.
  if (tool === "desktop_inspect") {
    const scrub = (obj: Record<string, unknown>) => {
      const cp = { ...obj };
      for (const k of ["text", "value"]) {
        if (typeof cp[k] === "string") cp[k] = redactString(cp[k] as string);
      }
      return cp;
    };
    if (out.evidence && typeof out.evidence === "object") {
      out.evidence = scrub(out.evidence as Record<string, unknown>);
    }
    if (out.result && typeof out.result === "object") {
      out.result = scrub(out.result as Record<string, unknown>);
    }
    for (const k of ["text", "value"]) {
      if (typeof out[k] === "string") out[k] = redactString(out[k] as string);
    }
  }

  return out;
}
