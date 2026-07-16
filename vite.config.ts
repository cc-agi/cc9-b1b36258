// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { mcpPlugin } from "@lovable.dev/mcp-js/stacks/tanstack/vite";
import { fileURLToPath } from "node:url";

// pkce-challenge (pulled in by @modelcontextprotocol/sdk) has no workerd export
// condition. Alias the bare specifier to an absolute path to bypass the exports
// field entirely; the browser build uses Web Crypto and works in Workers.
const pkceBrowser = fileURLToPath(
  new URL("./node_modules/pkce-challenge/dist/index.browser.js", import.meta.url),
);

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [mcpPlugin()],
    resolve: {
      alias: {
        "pkce-challenge": pkceBrowser,
      },
    },
  },
});
