import { describe, it, expect } from "vitest";
import {
  DESKTOP_TOOLS,
  isDesktopToolName,
  DesktopClickInput,
  DesktopTypeInput,
  DesktopLaunchInput,
  DesktopClipboardGetInput,
  DesktopClipboardSetInput,
  DesktopWaitInput,
  DesktopHotkeyInput,
  DesktopSnapshotInput,
} from "@/lib/desktop/schemas";

const goodEnvelope = {
  session_id: "11111111-1111-1111-1111-111111111111",
  idempotency_key: "run-1.att-1.seq-1.k-abc",
};

describe("desktop schemas", () => {
  it("registers exactly 14 tools with unique names (P0-R6 clipboard split)", () => {
    expect(DESKTOP_TOOLS).toHaveLength(14);
    const names = DESKTOP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(14);
    for (const n of names) expect(isDesktopToolName(n)).toBe(true);
    expect(names).toContain("desktop_clipboard_get");
    expect(names).toContain("desktop_clipboard_set");
    expect(names).not.toContain("desktop_clipboard");
    expect(isDesktopToolName("browser_click")).toBe(false);
  });

  it("click requires coords and rejects unbounded values", () => {
    expect(DesktopClickInput.safeParse({ ...goodEnvelope, x: 100, y: 200 }).success).toBe(true);
    expect(DesktopClickInput.safeParse({ ...goodEnvelope, x: 100 }).success).toBe(false);
    expect(DesktopClickInput.safeParse({ ...goodEnvelope, x: 1e9, y: 1 }).success).toBe(false);
    expect(DesktopClickInput.safeParse({ ...goodEnvelope, x: 0, y: 0, clicks: 99 }).success).toBe(
      false,
    );
  });

  it("type caps length and requires text", () => {
    const long = "a".repeat(5000);
    expect(DesktopTypeInput.safeParse({ ...goodEnvelope, text: long }).success).toBe(false);
    expect(DesktopTypeInput.safeParse({ ...goodEnvelope, text: "hi" }).success).toBe(true);
    expect(DesktopTypeInput.safeParse({ ...goodEnvelope, text: "" }).success).toBe(false);
  });

  it("wait bounded to 30s", () => {
    expect(DesktopWaitInput.safeParse({ ...goodEnvelope, duration_ms: 30_000 }).success).toBe(true);
    expect(DesktopWaitInput.safeParse({ ...goodEnvelope, duration_ms: 30_001 }).success).toBe(
      false,
    );
    expect(DesktopWaitInput.safeParse({ ...goodEnvelope, duration_ms: 0 }).success).toBe(false);
  });

  it("launch requires exactly one of app_id / app_path, and app_path must be absolute Windows path", () => {
    expect(DesktopLaunchInput.safeParse({ ...goodEnvelope, app_id: "notepad" }).success).toBe(true);
    expect(
      DesktopLaunchInput.safeParse({ ...goodEnvelope, app_path: "C:\\Windows\\notepad.exe" })
        .success,
    ).toBe(true);
    expect(
      DesktopLaunchInput.safeParse({
        ...goodEnvelope,
        app_id: "notepad",
        app_path: "C:\\Windows\\notepad.exe",
      }).success,
    ).toBe(false);
    expect(DesktopLaunchInput.safeParse({ ...goodEnvelope }).success).toBe(false);
    // No shell interpolation escape hatch.
    expect(
      DesktopLaunchInput.safeParse({ ...goodEnvelope, app_path: "notepad.exe /c calc" }).success,
    ).toBe(false);
    expect(
      DesktopLaunchInput.safeParse({ ...goodEnvelope, app_path: "cmd /c whoami" }).success,
    ).toBe(false);
    // Unknown app_id is rejected.
    expect(
      DesktopLaunchInput.safeParse({ ...goodEnvelope, app_id: "powershell" as never }).success,
    ).toBe(false);
  });

  it("clipboard set demands a value; get takes envelope only", () => {
    expect(DesktopClipboardGetInput.safeParse({ ...goodEnvelope }).success).toBe(true);
    expect(DesktopClipboardSetInput.safeParse({ ...goodEnvelope }).success).toBe(false);
    expect(
      DesktopClipboardSetInput.safeParse({ ...goodEnvelope, value: "hello" }).success,
    ).toBe(true);
  });

  it("hotkey requires at least one modifier", () => {
    expect(DesktopHotkeyInput.safeParse({ ...goodEnvelope, modifiers: [], key: "a" }).success).toBe(
      false,
    );
    expect(
      DesktopHotkeyInput.safeParse({ ...goodEnvelope, modifiers: ["ctrl"], key: "a" }).success,
    ).toBe(true);
  });

  it("snapshot rejects unknown monitor index", () => {
    expect(DesktopSnapshotInput.safeParse({ ...goodEnvelope, monitor: 3 }).success).toBe(true);
    expect(DesktopSnapshotInput.safeParse({ ...goodEnvelope, monitor: 16 }).success).toBe(false);
    expect(DesktopSnapshotInput.safeParse({ ...goodEnvelope, monitor: "all" }).success).toBe(true);
  });

  it("idempotency_key must be present and reasonably formatted", () => {
    expect(
      DesktopClickInput.safeParse({ session_id: goodEnvelope.session_id, x: 1, y: 1 }).success,
    ).toBe(false);
    expect(
      DesktopClickInput.safeParse({
        session_id: goodEnvelope.session_id,
        idempotency_key: "short",
        x: 1,
        y: 1,
      }).success,
    ).toBe(false);
    expect(
      DesktopClickInput.safeParse({
        session_id: goodEnvelope.session_id,
        idempotency_key: "has spaces are bad",
        x: 1,
        y: 1,
      }).success,
    ).toBe(false);
  });

  it("session_id must be a uuid", () => {
    expect(
      DesktopClickInput.safeParse({
        session_id: "not-a-uuid",
        idempotency_key: "k-".padEnd(12, "a"),
        x: 1,
        y: 1,
      }).success,
    ).toBe(false);
  });
});
