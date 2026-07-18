/**
 * 0.4.20 drag regressions from the field — encoded as pure verdict tests
 * so a schema/logic drift in verifier.ts trips the CI gate before any
 * Windows regression pass.
 */
import { describe, it, expect } from "vitest";
import { computeDragVerdict } from "@/lib/desktop/verifier";

describe("drag verdict — content-area drag never claims verified", () => {
  it("non-titlebar drag inside the client area leaves bounds unchanged → DRAG_NO_EFFECT", () => {
    // Field capture: agent tried to drag inside the document body of a text
    // editor, expecting the window to move. Only the caret selection changes;
    // the top-level window rect stays put. The engine MUST NOT report verified.
    const before = { L: 200, T: 150, R: 900, B: 700 };
    const after = { L: 200, T: 150, R: 900, B: 700 };
    const v = computeDragVerdict(before, after);
    expect(v.verified).toBe(false);
    if (!v.verified) {
      expect(v.error_code).toBe("DRAG_NO_EFFECT");
      expect(v.reason).toBe("target_rect_unchanged");
    }
  });
});

describe("drag verdict — titlebar drag from (55,413) to (255,183)", () => {
  it("target window bounds shift by the drag delta → verified=true", () => {
    // Field capture: agent dragged the Notepad titlebar from (55,413) to
    // (255,183). Delta = (+200, -230). The engine MUST report
    // verified=true / target_window_moved and NOT downgrade to input_only.
    const before = { L: 40, T: 380, R: 640, B: 780 };
    const after = { L: 40 + 200, T: 380 - 230, R: 640 + 200, B: 780 - 230 };
    const v = computeDragVerdict(before, after);
    expect(v.verified).toBe(true);
    if (v.verified) expect(v.reason).toBe("target_window_moved");
  });

  it("resize-only drag (bounds change size, same origin) → verified=true / resized", () => {
    const before = { L: 100, T: 100, R: 500, B: 400 };
    const after = { L: 100, T: 100, R: 700, B: 550 };
    const v = computeDragVerdict(before, after);
    expect(v.verified).toBe(true);
    if (v.verified) expect(v.reason).toBe("target_window_resized");
  });

  it("target vanished mid-drag → TARGET_WINDOW_VANISHED, not DRAG_NO_EFFECT", () => {
    const v = computeDragVerdict({ L: 0, T: 0, R: 10, B: 10 }, null);
    expect(v.verified).toBe(false);
    if (!v.verified) expect(v.error_code).toBe("TARGET_WINDOW_VANISHED");
  });
});
