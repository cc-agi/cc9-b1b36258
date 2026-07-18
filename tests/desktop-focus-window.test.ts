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
    expect(tool).toMatch(/FOCUS_NOT_ACQUIRED/);
    expect(tool).toMatch(/verified=\$false/);
    expect(tool).toMatch(/verify\.result\.acquired/);
    expect(tool).toMatch(/verify\.result\.state_ok/);
  });

  it("keeps minimize separate and never runs focus escalation after minimize", () => {
    const minimize = tool.indexOf("if ($act -eq 'minimize')");
    const direct = tool.indexOf("Invoke-FocusStage 'direct'");
    expect(minimize).toBeGreaterThan(0);
    expect(direct).toBeGreaterThan(minimize);
    expect(tool.slice(minimize, direct)).toMatch(/return @\{ ok=\$true/);
  });

  it("runs each foreground fallback as a separate stage", () => {
    for (const stage of [
      "prepare",
      "direct",
      "alt_tap",
      "attached_focus",
      "switch_window",
      "verify",
    ]) {
      expect(tool).toContain(`Invoke-FocusStage '${stage}'`);
    }
    expect(worker).toMatch(
      /ValidateSet\('prepare','direct','alt_tap','attached_focus','switch_window','verify'\)/,
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
    expect(stageRunner).toMatch(/Get-Content\s+-LiteralPath\s+\$checkpointPath/);
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
