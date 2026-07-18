# Sentinel OS Helper (Worker daemon)

Local Node.js daemon that pairs with your Sentinel OS Cloud account and executes
agent runs on your machine. Chrome is driven over CDP.

## What lives here

| File | Purpose |
|---|---|
| `src/index.mjs` | Long-running daemon (heartbeat + claim + execute) |
| `src/pair.mjs` | One-time pairing: exchanges a pairing code for a Worker Token |
| `install-helper.ps1` | Windows install — copies files, installs deps |
| `start-helper.ps1` | Start the daemon in a detached window |
| `stop-helper.ps1` | Stop the daemon |
| `status-helper.ps1` | Check daemon status + config path |
| `uninstall-helper.ps1` | Remove config from `%LOCALAPPDATA%\SentinelOS` |

`docs/sentinel-helper/server.mjs` (the older local HTTP server for the web console's
file-browser / manual Playwright flows) is retained for backwards compatibility;
the two will be merged into a single daemon in a follow-up. Only `helper/` is
required to run agent runs from ChatGPT/Claude.

## Requirements

- **Windows 10/11** (primary) or macOS/Linux (systemd example not included here)
- **Node.js 20+** (or Bun 1.0+)
- Chrome/Edge started with remote debugging: `chrome.exe --remote-debugging-port=9222`

## Quick start (Windows)

```powershell
# 1) In Sentinel OS Console, click "Generate pairing code" and copy the code.
# 2) In the extracted package directory (the ZIP root is helper/):
cd helper
npm install
node src\pair.mjs XXXXXXXX --cloud https://cc9.lovable.app
node src\index.mjs
```

Or via the PowerShell / batch wrappers:

```powershell
.\install-helper.ps1
.\start-helper.ps1 -PairingCode XXXXXXXX
.\status-helper.ps1
```

Full local runtime requires BOTH the Helper (Chrome/CDP + cloud heartbeat)
AND the Desktop Operator bridge (mouse / keyboard / screenshot). Neither
starts the other:

```cmd
.\start-sentinel.bat
.\start-desktop-operator.bat
```

`start-sentinel.bat` starts the Helper daemon + Chrome with CDP only. It
does NOT start the Desktop Operator. Desktop tools (`desktop_snapshot`,
`desktop_click`, ...) return `DESKTOP_SESSION_INACTIVE` until
`start-desktop-operator.bat` is also run.


## Security

- The Worker Token is stored at `%LOCALAPPDATA%\SentinelOS\worker.json`
  (POSIX: `~/.sentinel-os/worker.json`), file mode `0600`.
- The Helper **never** stores your Supabase key or your Lovable OAuth session.
- All Worker API traffic uses `Authorization: Bearer <workerToken>` + `X-Worker-Id`.
- CDP is probed with an **8-second hard timeout**; `CDP_UNREACHABLE` /
  `CDP_CONNECT_TIMEOUT` cause the current run to `block`, never fake-succeed.
- Local HTTP surface (the older file browser in `docs/sentinel-helper/server.mjs`)
  binds only to `127.0.0.1` and requires its own random token.

## Rotating a token

```powershell
# Revoke in Console → generate new pairing code → re-pair
node src\pair.mjs NEWCODE
```

## Known limits (this build)

- The Cloud → Helper step-intent bridge (`agent_step_intents`) is not yet wired.
  Claimed runs currently `block` with `NOT_IMPLEMENTED_ORCHESTRATOR_WIRING`
  after CDP preflight — that is by design, so nothing fakes success.
- Full test suite (`bun test`) is scaffolded but not populated.
