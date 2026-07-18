/**
 * P0-R5 Desktop Operator — shared Zod schemas for the 13 desktop_* tools.
 *
 * These schemas are the SINGLE source of truth for:
 *   - MCP tool inputSchema on the Cloud side
 *   - Intent-shape validation before an intent is queued
 *   - Helper-side pre-execution validation (belt & braces)
 *
 * Design rules:
 *   - Every action carries an idempotency_key so replay is a no-op.
 *   - Bounded numeric ranges (coords, wait_ms) — no unbounded loops or waits.
 *   - Text-bearing fields (`text`, `keys`, `clipboard.value`) are ONLY validated
 *     for length here; redaction for logs happens in ./redact.ts.
 *   - No path/command/eval fields anywhere — desktop_launch takes a whitelisted
 *     `app_id` OR a normalized `app_path` that MUST already resolve on disk
 *     (Helper checks). No shell interpolation, no argv, no `cmd /c`.
 */
import { z } from "zod";

// ---------- Primitives ----------
export const IdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "idempotency_key must be [A-Za-z0-9_.:-]+");

export const RunId = z.string().uuid();
export const Sequence = z.number().int().min(1).max(1_000_000);

const Coord = z.number().finite().int().min(-32_768).max(32_767);
const PositiveInt = (max: number) => z.number().int().min(1).max(max);

export const MouseButton = z.enum(["left", "right", "middle"]);
export const HotkeyModifier = z.enum(["ctrl", "shift", "alt", "win"]);

// Named key list — deliberately closed so the Helper never sends an unknown
// scan code. Extensions require a code change on BOTH sides.
export const NamedKey = z.enum([
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

// ---------- Session envelope ----------
// Every desktop_* intent must reference the currently-active local
// DesktopOperatorSession (started by start-desktop-operator.bat). The Helper
// rejects any intent whose `session_id` is unknown or expired.
export const DesktopSessionRef = z.object({
  session_id: z.string().uuid().describe("Active Desktop Operator Session id."),
});

const WithEnvelope = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      idempotency_key: IdempotencyKey,
      ...shape,
    })
    .merge(DesktopSessionRef);

// ---------- Tool inputs ----------
export const DesktopSnapshotInput = WithEnvelope({
  monitor: z.union([z.literal("all"), z.number().int().min(0).max(15)]).default("all"),
  format: z.enum(["png"]).default("png"),
  // Whether to include a per-monitor bounds report alongside images.
  include_bounds: z.boolean().default(true),
});

export const DesktopListWindowsInput = WithEnvelope({
  include_minimized: z.boolean().default(true),
  process_name: z.string().trim().max(128).optional(),
  max_results: PositiveInt(500).default(200),
});

export const DesktopInspectInput = WithEnvelope({
  window_handle: z.string().trim().min(1).max(64).optional(),
  x: Coord.optional(),
  y: Coord.optional(),
  max_depth: z.number().int().min(1).max(8).default(4),
});

export const DesktopFocusWindowInput = WithEnvelope({
  window_handle: z.string().trim().min(1).max(64),
  action: z.enum(["focus", "restore", "minimize", "maximize"]).default("focus"),
});

export const DesktopClickInput = WithEnvelope({
  x: Coord,
  y: Coord,
  button: MouseButton.default("left"),
  clicks: z.number().int().min(1).max(3).default(1),
  modifiers: z.array(HotkeyModifier).max(4).default([]),
});

// Server-side redaction converts `text` -> length + sha256 before persisting
// audit or step events. See ./redact.ts.
export const DesktopTypeInput = WithEnvelope({
  text: z.string().min(1).max(4000),
  // Rate-limit human-like typing (chars per second). Not a security control.
  chars_per_second: z.number().int().min(1).max(50).default(20),
});

export const DesktopPressInput = WithEnvelope({
  key: NamedKey,
  presses: z.number().int().min(1).max(10).default(1),
});

export const DesktopHotkeyInput = WithEnvelope({
  modifiers: z.array(HotkeyModifier).min(1).max(4),
  key: z.union([NamedKey, z.string().regex(/^[A-Za-z0-9]$/)]),
});

export const DesktopScrollInput = WithEnvelope({
  x: Coord,
  y: Coord,
  delta_y: z.number().int().min(-10_000).max(10_000).default(0),
  delta_x: z.number().int().min(-10_000).max(10_000).default(0),
});

export const DesktopDragInput = WithEnvelope({
  from_x: Coord,
  from_y: Coord,
  to_x: Coord,
  to_y: Coord,
  button: MouseButton.default("left"),
  duration_ms: z.number().int().min(0).max(5_000).default(200),
});

// P0-R6: `desktop_clipboard` is split into two closed-op tools so tools/list
// on ChatGPT/Claude can pick each operation directly (no shared `op` enum
// discriminator, and no ambiguous 14th "op" argument to guess).
export const DesktopClipboardGetInput = WithEnvelope({});
export const DesktopClipboardSetInput = WithEnvelope({
  value: z.string().max(50_000),
});

// desktop_launch is deliberately narrow: `app_id` is a Helper-side whitelist
// (notepad, calc, mspaint, etc.) OR `app_path` is a fully-qualified path that
// must already resolve on disk. Never a raw command line. No arguments.
export const DesktopLaunchInput = WithEnvelope({
  app_id: z
    .enum([
      "notepad",
      "calc",
      "mspaint",
      "explorer",
      "cmd_readonly", // opens cmd; Helper explicitly starts with no /c argument
      "chrome",
      "edge",
    ])
    .optional(),
  app_path: z
    .string()
    .trim()
    .min(3)
    .max(400)
    .regex(/^[A-Za-z]:\\/, "app_path must be an absolute Windows path (C:\\...)")
    .optional(),
}).refine((v) => Boolean(v.app_id) !== Boolean(v.app_path), {
  message: "provide exactly one of app_id or app_path",
});

export const DesktopWaitInput = WithEnvelope({
  duration_ms: z.number().int().min(1).max(30_000),
});

// ---------- Uniform tool result ----------
export const DesktopToolResult = z.object({
  ok: z.boolean(),
  tool: z.string(),
  session_id: z.string().uuid(),
  idempotency_key: IdempotencyKey,
  replay: z
    .boolean()
    .default(false)
    .describe(
      "True when a prior intent with the same idempotency_key already executed and the stored result was returned.",
    ),
  redacted: z
    .record(z.any())
    .optional()
    .describe("Redacted view: hashes/lengths/metadata of sensitive fields."),
  evidence: z
    .record(z.any())
    .optional()
    .describe(
      "Structured evidence (bounds, focused window, screenshot path, etc.). Screenshot BYTES are NEVER inline; only a local path.",
    ),
  error_code: z.string().optional(),
  error_message: z.string().max(500).optional(),
  latency_ms: z.number().int().min(0).optional(),
});

export type DesktopToolResultT = z.infer<typeof DesktopToolResult>;

// ---------- Tool descriptor table ----------
// Keeps the MCP tool files tiny — each file just imports its entry.
export const DESKTOP_TOOLS = [
  {
    name: "desktop_snapshot",
    title: "Desktop screen snapshot",
    description:
      "Capture a snapshot of one or all monitors. Screenshot bytes are stored locally on the Helper machine; only a local file path plus per-monitor bounds are returned. Requires an active Desktop Operator Session.",
    input: DesktopSnapshotInput,
    readOnly: true,
    destructive: false,
  },
  {
    name: "desktop_list_windows",
    title: "List desktop windows",
    description:
      "Enumerate visible (and optionally minimized) top-level windows with title, process name, bounds, and window state. Requires an active Desktop Operator Session.",
    input: DesktopListWindowsInput,
    readOnly: true,
    destructive: false,
  },
  {
    name: "desktop_inspect",
    title: "Inspect UI element",
    description:
      "Return UI Automation properties (name, control type, bounding rect, is_enabled) for the element at (x,y) or the focused element of a window. Falls back to Win32 metrics when UIA is unavailable.",
    input: DesktopInspectInput,
    readOnly: true,
    destructive: false,
  },
  {
    name: "desktop_focus_window",
    title: "Focus/restore/minimize/maximize a window",
    description: "Bring a top-level window to focus, restore, minimize, or maximize it.",
    input: DesktopFocusWindowInput,
    readOnly: false,
    destructive: false,
  },
  {
    name: "desktop_click",
    title: "Mouse click",
    description:
      "Move mouse and click at absolute virtual-screen coordinates. Supports left/right/middle button, 1-3 clicks (single/double/triple), and modifier keys held during the click.",
    input: DesktopClickInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_type",
    title: "Type text",
    description:
      "Synthesize a Unicode key sequence into the focused control. The `text` value is redacted (length + sha256) from all logs; it appears only in the direct tool result returned to the caller.",
    input: DesktopTypeInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_press",
    title: "Press a named key",
    description:
      "Press a named non-character key (Enter, Tab, Esc, arrows, F-keys...) one or more times.",
    input: DesktopPressInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_hotkey",
    title: "Chord hotkey",
    description:
      "Hold modifiers (ctrl/shift/alt/win) and press a single named or alphanumeric key.",
    input: DesktopHotkeyInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_scroll",
    title: "Mouse scroll",
    description:
      "Scroll the wheel at absolute coordinates. delta_y > 0 scrolls up; delta_x < 0 scrolls left.",
    input: DesktopScrollInput,
    readOnly: false,
    destructive: false,
  },
  {
    name: "desktop_drag",
    title: "Mouse drag",
    description:
      "Press a button at (from_x,from_y), move to (to_x,to_y) over duration_ms, then release.",
    input: DesktopDragInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_clipboard_get",
    title: "Read the clipboard",
    description:
      "Read the current text clipboard. The returned value is redacted (length + sha256) from all logs; only the direct tool result to the caller carries plaintext.",
    input: DesktopClipboardGetInput,
    readOnly: true,
    destructive: false,
  },
  {
    name: "desktop_clipboard_set",
    title: "Write the clipboard",
    description:
      "Write a text value to the clipboard. The value is redacted (length + sha256) from all logs.",
    input: DesktopClipboardSetInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_launch",
    title: "Launch an application",
    description:
      "Launch a Helper-whitelisted app (`app_id`) or an absolute Windows path (`app_path`). NEVER accepts a command line, arguments, or shell metacharacters.",
    input: DesktopLaunchInput,
    readOnly: false,
    destructive: true,
  },
  {
    name: "desktop_wait",
    title: "Wait",
    description:
      "Sleep for a bounded number of milliseconds (max 30s). Pure Helper-side timer; no I/O.",
    input: DesktopWaitInput,
    readOnly: true,
    destructive: false,
  },
] as const;

export type DesktopToolName = (typeof DESKTOP_TOOLS)[number]["name"];

export const DESKTOP_TOOL_NAMES = DESKTOP_TOOLS.map((t) => t.name) as readonly DesktopToolName[];

export function isDesktopToolName(name: string): name is DesktopToolName {
  return DESKTOP_TOOLS.some((t) => t.name === name);
}

export function getDesktopToolDescriptor(name: DesktopToolName) {
  const d = DESKTOP_TOOLS.find((t) => t.name === name);
  if (!d) throw new Error(`unknown desktop tool: ${name}`);
  return d;
}
