# Sentinel OS — Production acceptance script (P0-R2c)
#
# Runs against your paired Helper + live Sentinel Cloud.
# Prereqs:
#   1. Helper installed + paired: `helper\install-helper.ps1` then
#      `helper\start-helper.ps1 -PairingCode <CODE>`
#   2. Chrome running with `--remote-debugging-port=9222`
#   3. You've deleted+re-added the cc9 MCP connection in ChatGPT/Claude
#
# In ChatGPT (with the cc9 MCP connector re-attached), send:
#
# ── Scenario 1 (read-only navigation)
#   Call cc9.create_agent_run with:
#     goal: "打开 https://example.com，返回当前页面标题和主标题 (h1)"
#     max_attempts: 1
#   Then call cc9.list_agent_events every 5s until status is terminal.
#
#   Expected timeline (event_type values):
#     run.created (from create tool)
#     [Helper heartbeat starts]
#     claim_next_agent_run  →  agent_runs.status = claimed → running
#     cdp.checked (reachable: true)
#     run.started (helper_version: 0.3.0)
#     step.executing tool=browser_goto
#     step.completed tool=browser_goto
#     step.executing tool=browser_extract selector="h1"   (or similar)
#     step.completed
#     agent_runs.status = succeeded
#     final_output contains "Example Domain" (title) + "Example Domain" (h1)
#
# ── Scenario 2 (logged-in Alibaba seller backend, READ-ONLY)
#   Prereq: log into Alibaba seller backend in the SAME Chrome instance the Helper drives.
#   Call cc9.create_agent_run with:
#     goal: "打开已登录的 Alibaba 国际站卖家后台首页，返回当前 URL、页面标题、和主要功能区标题列表（不要点击任何提交/购买/发布/删除类按钮）"
#     max_attempts: 1
#
#   Expected:
#     status = succeeded
#     final_output includes seller backend URL, page title, and a bullet list of nav labels
#   Any step attempting a submit/purchase/delete tool call MUST be rejected server-side
#   with TOOL_NOT_WHITELISTED, or Helper-side with CLICK_DENIED_KEYWORD / CLICK_NOT_NAVIGATIONAL.
#
# ── Negative tests (must ALL pass)
#   (a) Stop the Helper (`helper\stop-helper.ps1`). Wait 15s. Call cc9.create_agent_run.
#       Expect: create_agent_run responds with `blocked / WORKER_OFFLINE` within 10s.
#   (b) With Helper running but Chrome not started with CDP: expect `blocked / CDP_UNREACHABLE`.
#   (c) Ask the model to `browser_eval("...")` explicitly (in goal). Orchestrator MUST NOT
#       emit that intent (TOOL_NOT_WHITELISTED); no such intent is written to agent_step_intents.
#   (d) Revoke the Worker Token via cc9 Console. Helper's next request → 401 and daemon stops.
#   (e) Owner calls cc9.cancel_agent_run mid-run. Helper reports helper.cancelling then
#       run finalizes as cancelled (never succeeded).
#   (f) Owner calls cc9.retry_agent_run on a failed/blocked run: attempts++, prior last_error
#       preserved, status = queued, run.retry_requested event written.
#
# Rollback plan (if any scenario fails):
#   1. Revoke the paired Worker Token(s) in cc9 Console.
#   2. `helper\stop-helper.ps1` on every paired machine.
#   3. In ChatGPT/Claude, remove the cc9 MCP connector.
#   4. On the Cloud side, no data-destroying migration was shipped in P0-R2c; every
#      migration is additive. To revert application code, redeploy the prior published
#      build via Lovable's version history. The database keeps the new columns/tables
#      — they are backwards compatible with the earlier build (all fields are nullable
#      or default-populated).
Write-Host "This file is documentation. Follow the numbered steps in the header."
