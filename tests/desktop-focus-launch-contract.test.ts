// Sentinel OS 0.4.22-C2 — Focus & Launch verification contract tests.
//
// These tests exercise the pure verdict helpers plus the normalize +
// evaluate pipeline in verification-contract.ts, which is exactly what the
// worker route uses to gate step.completed / agent_runs.status.

import { describe, expect, it } from "vitest";
import {
  computeFocusWindowVerdict,
  computeLaunchVerdict,
  DESKTOP_ERROR_CODES,
  VERIFICATION_KINDS,
  type FocusWindowInput,
  type LaunchInput,
  type FocusWindowSnapshot,
} from "@/lib/desktop/verifier";
import {
  evaluateVerificationOutcome,
  normalizeVerification,
  EVIDENCE_ALLOWED_FIELDS,
} from "@/lib/desktop/verification-contract";

// -------- Focus helpers --------

const baseSnapshot = (over: Partial<FocusWindowSnapshot> = {}): FocusWindowSnapshot => ({
  windowHandle: "12345",
  windowExists: true,
  visible: true,
  isIconic: false,
  isZoomed: false,
  foregroundHandle: "12345",
  processId: 4242,
  windowClass: "Notepad",
  ...over,
});

const focusInput = (over: Partial<FocusWindowInput> = {}): FocusWindowInput => ({
  requestedWindowHandle: "12345",
  action: "focus",
  pre: baseSnapshot({ foregroundHandle: "99999" }),
  post: baseSnapshot(),
  apiReported: { setForegroundReturned: true, showWindowReturned: true },
  ...over,
});

// -------- Launch helpers --------

const launchInput = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  expectedProcessNames: ["notepad"],
  pre: {
    processes: [{ pid: 100, processName: "explorer" }],
    windows: [{ handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" }],
    foregroundHandle: "10",
  },
  post: {
    processes: [
      { pid: 100, processName: "explorer" },
      { pid: 555, processName: "notepad" },
    ],
    windows: [
      { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
      { handle: "222", processId: 555, visible: true, windowClass: "Notepad" },
    ],
    foregroundHandle: "222",
  },
  shellExecuteSucceeded: true,
  elapsedMs: 400,
  timeoutMs: 4000,
  ...over,
});

// ================================================================ Table

describe("verification identifier tables — 0.4.22-C2", () => {
  it("registers new verification kinds", () => {
    expect(VERIFICATION_KINDS).toContain("foreground_window_verified");
    expect(VERIFICATION_KINDS).toContain("process_or_window_appeared");
  });
  it("registers new error codes", () => {
    for (const code of [
      "FOCUS_VERIFICATION_FAILED",
      "FOCUS_TARGET_NOT_FOUND",
      "FOCUS_TARGET_NOT_VISIBLE",
      "FOCUS_WINDOW_STATE_MISMATCH",
      "LAUNCH_VERIFICATION_FAILED",
      "LAUNCH_PROCESS_NOT_OBSERVED",
      "LAUNCH_WINDOW_NOT_OBSERVED",
      "LAUNCH_WRONG_PROCESS",
      "LAUNCH_TIMEOUT",
    ]) {
      expect(DESKTOP_ERROR_CODES).toContain(code as never);
    }
  });
  it("whitelists focus/launch evidence fields", () => {
    for (const key of [
      "requested_window_handle",
      "window_exists",
      "window_visible",
      "is_iconic",
      "is_zoomed",
      "window_state",
      "window_rect",
      "process_id",
      "process_name",
      "window_class",
      "expected_target",
      "new_process_ids",
      "new_window_handles",
      "matched_process_id",
      "matched_window_handle",
      "existing_window_reactivated",
      "elapsed_ms",
      "poll_attempts",
    ]) {
      expect(EVIDENCE_ALLOWED_FIELDS).toContain(key);
    }
  });
});

// ================================================================ Focus

describe("computeFocusWindowVerdict — desktop_focus_window", () => {
  it("verifies a normal focus that brings the window to foreground", () => {
    const v = computeFocusWindowVerdict(focusInput());
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("foreground_window_verified");
    expect(v.error_code).toBeNull();
    expect(v.target_still_foreground).toBe(true);
    expect(v.success_reason).toBe("requested_window_is_foreground");
  });

  it("verifies restore when the window is no longer iconic and is foreground", () => {
    const v = computeFocusWindowVerdict(
      focusInput({
        action: "restore",
        pre: baseSnapshot({ isIconic: true, foregroundHandle: "99999" }),
        post: baseSnapshot({ isIconic: false }),
      }),
    );
    expect(v.verified).toBe(true);
  });

  it("verifies maximize only when window is zoomed", () => {
    const ok = computeFocusWindowVerdict(
      focusInput({ action: "maximize", post: baseSnapshot({ isZoomed: true }) }),
    );
    expect(ok.verified).toBe(true);
    const bad = computeFocusWindowVerdict(
      focusInput({ action: "maximize", post: baseSnapshot({ isZoomed: false }) }),
    );
    expect(bad.verified).toBe(false);
    expect(bad.error_code).toBe("FOCUS_WINDOW_STATE_MISMATCH");
  });

  it("verifies minimize as iconic regardless of foreground", () => {
    const v = computeFocusWindowVerdict(
      focusInput({
        action: "minimize",
        post: baseSnapshot({ isIconic: true, foregroundHandle: "99999" }),
      }),
    );
    expect(v.verified).toBe(true);
    expect(v.success_reason).toBe("window_minimized_as_requested");
  });

  it("fails when the requested handle is no longer live", () => {
    const v = computeFocusWindowVerdict(
      focusInput({ post: baseSnapshot({ windowExists: false }) }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_TARGET_NOT_FOUND");
  });

  it("fails when the window is invisible after focus", () => {
    const v = computeFocusWindowVerdict(
      focusInput({ post: baseSnapshot({ visible: false }) }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_TARGET_NOT_VISIBLE");
  });

  it("fails when foreground is a different window", () => {
    const v = computeFocusWindowVerdict(
      focusInput({ post: baseSnapshot({ foregroundHandle: "99999" }) }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_VERIFICATION_FAILED");
    expect(v.target_still_foreground).toBe(false);
  });

  it("reports FOCUS_TARGET_LOST when the window had foreground but lost it", () => {
    const v = computeFocusWindowVerdict(
      focusInput({
        pre: baseSnapshot({ foregroundHandle: "12345" }),
        post: baseSnapshot({ foregroundHandle: "99999" }),
      }),
    );
    expect(v.error_code).toBe("FOCUS_TARGET_LOST");
  });

  it("fails restore when the window is still minimized", () => {
    const v = computeFocusWindowVerdict(
      focusInput({
        action: "restore",
        pre: baseSnapshot({ isIconic: true, foregroundHandle: "99999" }),
        post: baseSnapshot({ isIconic: true }),
      }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("FOCUS_WINDOW_STATE_MISMATCH");
  });

  it("does NOT trust apiReported.setForegroundReturned=true when post evidence disagrees", () => {
    const v = computeFocusWindowVerdict(
      focusInput({
        apiReported: { setForegroundReturned: true, showWindowReturned: true },
        post: baseSnapshot({ foregroundHandle: "99999" }),
      }),
    );
    expect(v.verified).toBe(false);
  });
});

// ================================================================ Launch

describe("computeLaunchVerdict — desktop_launch", () => {
  it("verifies when a new expected window appears", () => {
    const v = computeLaunchVerdict(launchInput());
    expect(v.verified).toBe(true);
    expect(v.verification_kind).toBe("process_or_window_appeared");
    expect(v.matched_process_id).toBe(555);
    expect(v.matched_window_handle).toBe("222");
    expect(v.existing_window_reactivated).toBe(false);
  });

  it("verifies existing app reactivation when foreground becomes an expected process", () => {
    const v = computeLaunchVerdict(
      launchInput({
        pre: {
          processes: [
            { pid: 100, processName: "explorer" },
            { pid: 555, processName: "notepad" },
          ],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
            { handle: "222", processId: 555, visible: true, windowClass: "Notepad" },
          ],
          foregroundHandle: "10",
        },
        post: {
          processes: [
            { pid: 100, processName: "explorer" },
            { pid: 555, processName: "notepad" },
          ],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
            { handle: "222", processId: 555, visible: true, windowClass: "Notepad" },
          ],
          foregroundHandle: "222",
        },
      }),
    );
    expect(v.verified).toBe(true);
    expect(v.existing_window_reactivated).toBe(true);
  });

  it("fails when a new process starts but has no visible window", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [
            { pid: 100, processName: "explorer" },
            { pid: 555, processName: "notepad" },
          ],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
          ],
          foregroundHandle: "10",
        },
      }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("LAUNCH_WINDOW_NOT_OBSERVED");
    expect(v.matched_process_id).toBe(555);
  });

  it("fails when a new window belongs to a non-expected process", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [
            { pid: 100, processName: "explorer" },
            { pid: 777, processName: "someother" },
          ],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
            { handle: "333", processId: 777, visible: true, windowClass: "SomeOther" },
          ],
          foregroundHandle: "333",
        },
      }),
    );
    expect(v.verified).toBe(false);
    expect(v.error_code).toBe("LAUNCH_WRONG_PROCESS");
  });

  it("returns LAUNCH_TIMEOUT when nothing appeared before deadline", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [{ pid: 100, processName: "explorer" }],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
          ],
          foregroundHandle: "10",
        },
        elapsedMs: 5000,
        timeoutMs: 4000,
      }),
    );
    expect(v.error_code).toBe("LAUNCH_TIMEOUT");
  });

  it("returns LAUNCH_PROCESS_NOT_OBSERVED when ShellExecute succeeded but nothing new appeared before timeout", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [{ pid: 100, processName: "explorer" }],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
          ],
          foregroundHandle: "10",
        },
        elapsedMs: 1000,
        timeoutMs: 4000,
        shellExecuteSucceeded: true,
      }),
    );
    expect(v.error_code).toBe("LAUNCH_PROCESS_NOT_OBSERVED");
  });

  it("returns LAUNCH_VERIFICATION_FAILED when ShellExecute failed and nothing appeared", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [{ pid: 100, processName: "explorer" }],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
          ],
          foregroundHandle: "10",
        },
        elapsedMs: 1000,
        timeoutMs: 4000,
        shellExecuteSucceeded: false,
      }),
    );
    expect(v.error_code).toBe("LAUNCH_VERIFICATION_FAILED");
  });
});

// ================================================================ Contract

describe("focus/launch verification contract wiring", () => {
  it("focus success flows through the contract as succeeded", () => {
    const v = computeFocusWindowVerdict(focusInput());
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      failure_reason: v.failure_reason,
      success_reason: v.success_reason,
      error_code: v.error_code,
      verification_attempts: 3,
      verification_elapsed_ms: 850,
      pre: { foreground_window_handle: "99999", requested_window_handle: "12345" },
      post: {
        foreground_window_handle: "12345",
        requested_window_handle: "12345",
        window_visible: true,
      },
      target_still_foreground: v.target_still_foreground,
    });
    expect(contract).not.toBeNull();
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.errorCode).toBeNull();
  });

  it("focus failure with require_verified=true forces step.failed", () => {
    const v = computeFocusWindowVerdict(
      focusInput({ post: baseSnapshot({ foregroundHandle: "99999" }) }),
    );
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      failure_reason: v.failure_reason,
      success_reason: v.success_reason,
      error_code: v.error_code,
      verification_attempts: 6,
      verification_elapsed_ms: 1600,
      pre: {},
      post: {},
      target_still_foreground: v.target_still_foreground,
    });
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("FOCUS_VERIFICATION_FAILED");
  });

  it("launch failure with require_verified=true forces step.failed", () => {
    const v = computeLaunchVerdict(
      launchInput({
        post: {
          processes: [{ pid: 100, processName: "explorer" }],
          windows: [
            { handle: "10", processId: 100, visible: true, windowClass: "Shell_TrayWnd" },
          ],
          foregroundHandle: "10",
        },
        elapsedMs: 5000,
        timeoutMs: 4000,
      }),
    );
    const contract = normalizeVerification({
      require_verified: true,
      verified: v.verified,
      verification_kind: v.verification_kind,
      failure_reason: v.failure_reason,
      success_reason: v.success_reason,
      error_code: v.error_code,
      verification_attempts: 8,
      verification_elapsed_ms: 5000,
      pre: {},
      post: { new_process_ids: v.new_process_ids, new_window_handles: v.new_window_handles },
      target_still_foreground: null,
    });
    const outcome = evaluateVerificationOutcome({ verification: contract });
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("LAUNCH_TIMEOUT");
  });

  it("evidence normalization drops sensitive/unknown fields (no user path leakage)", () => {
    const contract = normalizeVerification({
      require_verified: true,
      verified: false,
      verification_kind: "process_or_window_appeared",
      failure_reason: "no_observable_effect_after_launch_attempt",
      success_reason: null,
      error_code: "LAUNCH_VERIFICATION_FAILED",
      verification_attempts: 1,
      verification_elapsed_ms: 4000,
      pre: {
        expected_target: "notepad",
        // Any non-whitelisted key MUST be dropped by normalizeVerification
        // to guarantee the audit trail cannot leak a user's absolute path.
        app_path: "C:/Users/alice/secret/launch.exe",
        launched: "C:/Users/alice/secret/launch.exe",
      },
      post: {},
      target_still_foreground: null,
    });
    expect(contract).not.toBeNull();
    const pre = contract!.pre ?? {};
    expect(pre.expected_target).toBe("notepad");
    expect(pre.app_path).toBeUndefined();
    expect(pre.launched).toBeUndefined();
  });
});
