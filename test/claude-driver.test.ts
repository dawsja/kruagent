import assert from "node:assert/strict";
import { test } from "node:test";
import { tool } from "ai";
import { z } from "zod";
import { agentToolsFor, toolInputSchema } from "../lib/hq/bots/claude-driver.ts";

test("driver: AI SDK tools become MCP tool listings", () => {
  const tools = {
    create_card: tool({
      description: "Create a card",
      inputSchema: z.object({ title: z.string().min(1), body: z.string().optional() }),
      execute: async () => "ok",
    }),
  };
  const listed = agentToolsFor(tools);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "create_card");
  assert.equal(listed[0].description, "Create a card");
  const schema = listed[0].inputSchema as { type: string; properties: Record<string, unknown>; required?: string[] };
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties), ["title", "body"]);
  assert.deepEqual(schema.required, ["title"]);
  assert.deepEqual(toolInputSchema({ jsonSchema: { type: "object" } }), { type: "object" });
  assert.deepEqual(toolInputSchema(undefined), { type: "object", properties: {} });
});
