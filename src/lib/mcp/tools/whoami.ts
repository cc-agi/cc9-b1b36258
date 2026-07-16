import { defineTool } from "@lovable.dev/mcp-js";

export default defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Return the Sentinel OS user id and email of the caller. Use to verify the MCP connection is authenticated.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: (_input, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            userId: ctx.getUserId(),
            email: ctx.getUserEmail(),
            clientId: ctx.getClientId(),
          }),
        },
      ],
      structuredContent: {
        userId: ctx.getUserId(),
        email: ctx.getUserEmail(),
        clientId: ctx.getClientId(),
      },
    };
  },
});
