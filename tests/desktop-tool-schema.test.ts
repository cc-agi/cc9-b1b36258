/**
 * P0-R6.1 regression — `desktop_launch` (and every other refined desktop tool)
 * must produce a real JSON-Schema-friendly ZodObject shape from the factory.
 *
 * The 0.4.3 field bug: `DesktopLaunchInput` uses `.refine()`, which returns
 * a `ZodEffects`. The factory did `input.shape`, undefined on ZodEffects, so
 * mcp-js published `inputSchema: null`. Strict MCP clients (ChatGPT) reject
 * the whole desktop_* group when even one tool has `null` inputSchema — so
 * tools/list drops all 14 desktop tools and shows only 20.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DESKTOP_TOOL_NAMES } from "@/lib/desktop/schemas";
import { makeDesktopTool } from "@/lib/mcp/tools/_desktop-factory";

describe("desktop tool factory (P0-R6.1)", () => {
  for (const name of DESKTOP_TOOL_NAMES) {
    it(`${name} publishes a ZodObject-shaped inputSchema with session_id`, () => {
      const t = makeDesktopTool(name) as unknown as {
        inputSchema: Record<string, z.ZodTypeAny> | undefined;
        name: string;
      };
      expect(t.inputSchema, `${name}.inputSchema must not be undefined`).toBeDefined();
      expect(typeof t.inputSchema, `${name}.inputSchema must be an object`).toBe("object");
      const shape = t.inputSchema!;
      expect(shape.session_id, `${name}.session_id must be present`).toBeDefined();
      expect(shape.idempotency_key, `${name}.idempotency_key must be present`).toBeDefined();
    });
  }

  it("desktop_launch specifically survives the ZodEffects unwrap", () => {
    const t = makeDesktopTool("desktop_launch") as unknown as {
      inputSchema: Record<string, z.ZodTypeAny>;
    };
    expect(t.inputSchema.app_id).toBeDefined();
    expect(t.inputSchema.app_path).toBeDefined();
    expect(t.inputSchema.session_id).toBeDefined();
  });
});
