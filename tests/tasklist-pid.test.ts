// P0-R5 R4 — locale-independent tasklist PID parser regression.
//
// The shared PowerShell probe (helper/lib/tasklist-pid.ps1) and its JS mirror
// (helper/lib/tasklist-pid.mjs) MUST classify Windows `tasklist` output
// identically on every locale. The Chinese absent-PID line
//   信息: 没有运行的任务匹配指定标准。
// must return alive=false, exactly like the English
//   INFO: No tasks are running which match the specified criteria.
//
// A tasklist non-zero exit MUST fail closed (ok=false) so callers refuse to
// launch a duplicate Helper and refuse to delete the pid file.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyTasklistResult } from "../helper/lib/tasklist-pid.mjs";

const TARGET_PID = 11696;
const OTHER_PID = 22222;

describe("classifyTasklistResult — locale-independent tasklist parse", () => {
  it("English absent output returns alive=false", () => {
    // Real tasklist on English Windows emits this on absent PID (exit 0).
    const stdout = "INFO: No tasks are running which match the specified criteria.\r\n";
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout })).toEqual({
      ok: true,
      alive: false,
      exit: 0,
    });
  });

  it("Chinese absent output returns alive=false (信息:)", () => {
    // Real Owner-observed line on zh-CN Windows for an absent PID (exit 0).
    const stdout = "信息: 没有运行的任务匹配指定标准。\r\n";
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout })).toEqual({
      ok: true,
      alive: false,
      exit: 0,
    });
  });

  it("Japanese-style absent output also returns alive=false", () => {
    // Any localized prose that isn't a quoted CSV row must be treated as absent.
    const stdout = "情報: 指定された条件と一致する実行中のタスクはありません。\r\n";
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout }).alive).toBe(false);
  });

  it("CSV row for the requested PID returns alive=true", () => {
    const stdout = `"node.exe","${TARGET_PID}","Console","2","123,456 K"\r\n`;
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout })).toEqual({
      ok: true,
      alive: true,
      exit: 0,
    });
  });

  it("CSV row for a different PID returns alive=false", () => {
    const stdout = `"node.exe","${OTHER_PID}","Console","2","123,456 K"\r\n`;
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout }).alive).toBe(false);
  });

  it("tasklist non-zero exit fails closed (ok=false)", () => {
    // Callers must refuse to delete pid file / launch duplicate on this result.
    const result = classifyTasklistResult(TARGET_PID, { exitCode: 1, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.alive).toBe(false);
    expect(result.exit).toBe(1);
  });

  it("empty stdout with exit 0 returns alive=false, ok=true", () => {
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout: "" }).alive).toBe(false);
  });

  it("PID that is a substring of another PID does not false-match", () => {
    // A row for 116960 must not be classified as PID 11696.
    const stdout = `"node.exe","116960","Console","2","1 K"\r\n`;
    expect(classifyTasklistResult(TARGET_PID, { exitCode: 0, stdout }).alive).toBe(false);
  });
});

describe("PowerShell parser mirrors the JS parser contract", () => {
  const ps = readFileSync(resolve(__dirname, "../helper/lib/tasklist-pid.ps1"), "utf8");

  it("uses the anchored quoted-CSV regex, not localized prose", () => {
    expect(ps).toMatch(/'\^"\[\^"\]\*","\(\\d\+\)","'/);
    // Ban executable locale-dependent detection (comments referencing INFO:
    // or 信息: are allowed for documentation).
    expect(ps).not.toMatch(/-notmatch\s+'\^INFO:'/);
  });


  it("fails closed when tasklist exits non-zero", () => {
    expect(ps).toMatch(/\$exit\s*-ne\s*0[\s\S]*ok\s*=\s*\$false/);
  });

  it("compares the captured PID as an integer against $TargetPid", () => {
    expect(ps).toMatch(/\[int\]\$Matches\[1\]\s*-eq\s*\$TargetPid/);
  });
});

describe("consumers dot-source the shared parser (no inline INFO: parsing)", () => {
  const files = [
    "helper/start-helper.ps1",
    "helper/stop-helper.ps1",
    "helper/regression-desktop-delayed-listener.ps1",
  ];
  for (const rel of files) {
    it(`${rel} dot-sources tasklist-pid.ps1 and uses Test-TasklistPidAlive`, () => {
      const s = readFileSync(resolve(__dirname, "..", rel), "utf8");
      expect(s).toMatch(/lib[\\/]tasklist-pid\.ps1/);
      expect(s).toMatch(/Test-TasklistPidAlive/);
      // BAN the locale-dependent detection that broke on Chinese Windows.
      expect(s).not.toMatch(/-notmatch\s+'\^INFO:'/);
    });
  }
});
