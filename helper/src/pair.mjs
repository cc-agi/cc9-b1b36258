// Sentinel OS Helper pairing tool.
// Usage: node src/pair.mjs <PAIRING_CODE> [--cloud https://cc9.lovable.app] [--worker-id my-desktop]
import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import path from "node:path";
import process from "node:process";
import { fetch } from "undici";

const VERSION = "0.4.21";

function configDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(),
      "SentinelOS",
    );
  }
  return path.join(process.env.HOME || process.cwd(), ".sentinel-os");
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : def;
}

async function main() {
  const code = process.argv[2];
  if (!code || code.startsWith("--")) {
    console.error("Usage: sentinel-helper pair <PAIRING_CODE> [--cloud <url>] [--worker-id <id>]");
    process.exit(2);
  }
  const cloud = arg("--cloud", process.env.SENTINEL_CLOUD_URL || "https://cc9.lovable.app").replace(
    /\/$/,
    "",
  );
  const workerId = arg("--worker-id", `${hostname()}-${process.pid}`);

  const res = await fetch(`${cloud}/api/worker/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      worker_id: workerId,
      version: VERSION,
      platform: platform(),
      label: hostname(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`pair failed [${res.status}]: ${body.error ?? "unknown"}`);
    process.exit(1);
  }
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "worker.json");
  await writeFile(
    file,
    JSON.stringify(
      { cloud_base_url: cloud, worker_id: body.worker_id, token: body.token },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`✓ Paired. Config written to ${file}`);
  console.log(`  worker_id: ${body.worker_id}`);
  console.log(`  Now run:  npm --prefix helper start`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
