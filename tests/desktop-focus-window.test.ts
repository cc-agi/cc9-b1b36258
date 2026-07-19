/**
 * P0-R9 regression — foreground escalation must never wedge the persistent
 * single-thread Desktop Operator. Every risky user32 sequence runs in a
 * disposable process with a hard timeout and checkpoint diagnostics.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const operator = readFileSync(path.join(ROOT, "helper", "desktop-operator.ps1"), "utf8");
const worker = readFileSync(path.join(ROOT, "helper", "focus-window-worker.ps1"), "utf8");

function extractFn(source: string, name: string): string {
  const re = new RegExp(
    `function\\s+${name}(?:\\([^)]*\\))?\\s*\\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`could not extract ${name}`);
  return match[0];
}

describe("desktop_focus_window isolated escalation (P0-R9)", () => {
  const tool = extractFn(operator, "Tool-FocusWindow");
  const stageRunner = extractFn(operator, "Invoke-FocusStage");
  const log = extractFn(operator, "Log");

  it("never writes request-path logs to the interactive console", () => {
    expect(log).toContain("Add-Content");
    expect(log).not.toContain("Write-Host");
  });

  it("validates handle/action and preserves no-false-success verification", () => {
    expect(tool).toMatch(/TryParse/);
    expect(tool).toMatch(/WINDOW_HANDLE_INVALID/);
    expect(tool).toMatch(/ACTION_INVALID/);
    // 0.4.22-C2 replaces the FOCUS_NOT_ACQUIRED sentinel with contract-based
    // error codes surfaced from the pre/post snapshot verdict.
    expect(tool).toMatch(/FOCUS_VERIFICATION_FAILED/);
    expect(tool).toMatch(/FOCUS_TARGET_NOT_FOUND/);
    expect(tool).toMatch(/verification_kind/);
    expect(tool).toMatch(/Build-FocusVerification/);
  });

  it("keeps minimize separate and never runs focus escalation after minimize", () => {
    // 0.4.22-C2 rewires the tool so minimize skips escalation via a guard on
    // $act -ne 'minimize' around the direct/alt/attached/managed/switch chain.
    const guard = tool.indexOf("if ($act -ne 'minimize')");
    const direct = tool.indexOf("Invoke-FocusStage 'direct'");
    expect(guard).toBeGreaterThan(0);
    expect(direct).toBeGreaterThan(guard);
  });

  it("runs each foreground fallback as a separate stage", () => {
    for (const stage of [
      "prepare",
      "direct",
      "alt_tap",
      "attached_focus",
      "managed_focus",
      "switch_window",
      "verify",
    ]) {
      expect(tool).toContain(`Invoke-FocusStage '${stage}'`);
    }
    expect(worker).toMatch(
      /ValidateSet\('prepare','direct','alt_tap','attached_focus','managed_focus','switch_window','verify'\)/,
    );
  });

  it("starts workers without inheriting the interactive console", () => {
    expect(stageRunner).toMatch(/System\.Diagnostics\.ProcessStartInfo/);
    expect(stageRunner).toMatch(/UseShellExecute\s*=\s*\$false/);
    expect(stageRunner).toMatch(/CreateNoWindow\s*=\s*\$true/);
    expect(stageRunner).toMatch(/-EncodedCommand/);
    expect(stageRunner).not.toMatch(/Start-Process/);
    expect(worker).not.toMatch(/\[Console\]::/);
  });

  it("uses PowerShell 5.1-safe UInt32 and explicit UTF-8 file reads", () => {
    expect(worker).toMatch(/AllowSetForegroundWindow\(\[uint32\]::MaxValue\)/);
    expect(worker).not.toMatch(/AllowSetForegroundWindow\(0xFFFFFFFF\)/);
    expect(worker).toMatch(/ReadAllText\(\$RequestPath,\s*\[System\.Text\.Encoding\]::UTF8\)/);
    expect(stageRunner).toMatch(/ReadAllText\(\$outputPath,\s*\[System\.Text\.Encoding\]::UTF8\)/);
    expect(stageRunner).toMatch(
      /ReadAllText\(\$checkpointPath,\s*\[System\.Text\.Encoding\]::UTF8\)/,
    );
  });

  it("does not clear foreground when focusing an already-normal window", () => {
    expect(worker).toMatch(/\$action\s+-eq\s+'focus'\s+-and\s+-not\s+\$iconicBefore/);
    expect(worker).toContain("show_window_skipped_normal_focus");
    expect(worker).toContain("show_window_attempted");
  });

  it("creates a message queue and keeps Alt unlock in the attached-focus process", () => {
    expect(worker).toMatch(/PeekMessage\(\[ref\]\$message/);
    expect(worker).toContain("message_queue_initialized");
    expect(worker).toContain("alt_tap_same_process");
    const attachedStart = worker.indexOf("'attached_focus' {");
    const attachedEnd = worker.indexOf("'switch_window' {", attachedStart);
    const attached = worker.slice(attachedStart, attachedEnd);
    expect(attached).toMatch(/keybd_event[\s\S]*AllowSetForegroundWindow/);
  });

  it("uses bounded UIA and AppActivate fallbacks for UWP windows", () => {
    expect(tool).toContain("Invoke-FocusStage 'managed_focus'");
    const managedStart = worker.indexOf("'managed_focus' {");
    const managedEnd = worker.indexOf("'switch_window' {", managedStart);
    const managed = worker.slice(managedStart, managedEnd);
    expect(managed).toMatch(/AutomationElement\]::FromHandle\(\$h\)/);
    expect(managed).toMatch(/\.SetFocus\(\)/);
    expect(managed).toMatch(/AppActivate\(\[int\]\$targetPid\)/);
    expect(managed).toMatch(/GetWindowThreadProcessId\(\$h,\s*\[ref\]\$targetPid\)/);
    expect(managed).toContain("uia_focus_ok");
    expect(managed).toContain("app_activate_ok");
  });

  it("hard-limits and terminates a blocked execution process", () => {
    expect(stageRunner).toMatch(/\[int\]\$timeoutMs\s*=\s*1600/);
    expect(stageRunner).toMatch(/Stopwatch\]::StartNew/);
    expect(stageRunner).toMatch(/ElapsedMilliseconds\s*-lt\s*\$timeoutMs/);
    expect(stageRunner).toMatch(/TerminateProcess\(\$proc\.Handle/);
    expect(stageRunner).not.toMatch(/WaitForExit\(/);
    expect(stageRunner).not.toMatch(/\.Kill\(/);
    expect(stageRunner).toMatch(/FOCUS_STAGE_TIMEOUT/);
    expect(stageRunner).toMatch(/execution_terminated/);
    expect(stageRunner).toMatch(/execution_restarted\s*=\s*\$true/);
  });

  it("returns the last durable checkpoint on timeout", () => {
    expect(stageRunner).toMatch(/ReadAllText\(\$checkpointPath/);
    expect(stageRunner).toMatch(/last_checkpoint\s*=\s*\$checkpoint/);
    expect(worker).toMatch(/function Write-Checkpoint/);
  });

  it("checkpoints before and after each dangerous call", () => {
    const pairs = [
      ["before_alt_key_down", "after_alt_key_down"],
      ["before_alt_key_up", "after_alt_key_up"],
      ["before_attach_foreground_thread", "after_attach_foreground_thread"],
      ["before_attach_target_thread", "after_attach_target_thread"],
      ["before_show_window_async", "after_show_window_async"],
      ["before_bring_window_to_top", "after_bring_window_to_top"],
      ["before_set_window_topmost", "after_set_window_topmost"],
      ["before_set_window_notopmost", "after_set_window_notopmost"],
      ["before_set_active_window", "after_set_active_window"],
      ["before_set_focus", "after_set_focus"],
      ["before_switch_to_this_window", "after_switch_to_this_window"],
      ["before_detach_target_thread", "after_detach_target_thread"],
      ["before_detach_foreground_thread", "after_detach_foreground_thread"],
    ];
    for (const [before, after] of pairs) {
      expect(worker).toContain(`'${before}'`);
      expect(worker).toContain(`'${after}'`);
      expect(worker.indexOf(before)).toBeLessThan(worker.indexOf(after));
    }
  });

  it("verifies actual foreground/state and captures last-error immediately", () => {
    expect(worker).toMatch(/GetForegroundWindow/);
    expect(worker).toMatch(/IsWindow/);
    expect(worker).toMatch(/IsIconic/);
    expect(worker).toMatch(/IsZoomed/);
    expect(worker).toMatch(/SetForegroundWindow\(\$h\)[\s\S]*?Marshal\]::GetLastWin32Error\(\)/);
  });

  it("detaches attached input queues inside finally", () => {
    const attachedStart = worker.indexOf("'attached_focus' {", worker.indexOf("switch ($Stage)"));
    const attachedEnd = worker.indexOf("'switch_window' {", attachedStart);
    const attached = worker.slice(attachedStart, attachedEnd);
    expect(attached).toMatch(/finally\s*\{/);
    expect(attached).toMatch(/AttachThreadInput\(\$tidCurrent,\s*\$tidTarget,\s*\$false\)/);
    expect(attached).toMatch(/AttachThreadInput\(\$tidCurrent,\s*\$tidForeground,\s*\$false\)/);
  });

  it("retains field diagnostics for run-event propagation", () => {
    expect(tool).toMatch(/requested_window_handle/);
    for (const key of [
      "foreground_before",
      "target_thread_id",
      "attach_thread_input_ok",
      "attach_foreground_thread_input_ok",
      "set_foreground_last_error",
      "bring_window_to_top_ok",
      "show_window_async_ok",
    ]) {
      expect(worker).toContain(key);
    }
  });
});
