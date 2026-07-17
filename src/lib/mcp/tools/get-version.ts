import { defineTool } from "@lovable.dev/mcp-js";
import {
  MCP_CODE_VERSION,
  MCP_MANIFEST_VERSION,
  MCP_DB_SCHEMA_VERSION,
  MIN_HELPER_VERSION,
} from "../version";

export default defineTool({
  name: "get_version",
  title: "Get version",
  description:
    "Return Sentinel OS MCP versions: code, manifest, database schema, and minimum required local Helper version. Callers should compare their Helper build against `min_helper_version` and prompt the Owner to upgrade if older.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: () => {
    const info = {
      code_version: MCP_CODE_VERSION,
      manifest_version: MCP_MANIFEST_VERSION,
      db_schema_version: MCP_DB_SCHEMA_VERSION,
      min_helper_version: MIN_HELPER_VERSION,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(info) }],
      structuredContent: info,
    };
  },
});
