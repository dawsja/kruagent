import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FLAG_FLOORS,
  argsKeyFor,
  atLeast,
  flagsFor,
  isResumeFailure,
  isUnknownOption,
  parseVersion,
  sessionArgs,
  settle,
  stripCredentialEnv,
  systemReminder,
  loggable,
  userMessage,
} from "../box/agents.mjs";
import { handleRpc, takeLines } from "../box/kru-mcp.mjs";

test("agents: versions parse and gate flags by their floors", () => {
  assert.deepEqual(parseVersion("2.1.14 (Claude Code)"), [2, 1, 14]);
  assert.equal(parseVersion("nope"), null);
  assert.equal(atLeast([2, 0, 30], "2.0.30"), true);
  assert.equal(atLeast([2, 0, 29], "2.0.30"), false);
  assert.equal(atLeast([1, 0, 5], "1.0.30"), false);
  const old = flagsFor([1, 0, 10]);
  assert.equal(old.has("--strict-mcp-config"), false);
  assert.equal(old.has("--input-format"), true);
  const unknown = flagsFor(null);
  for (const flag of Object.keys(FLAG_FLOORS)) assert.equal(unknown.has(flag), true);
});

test("agents: session args resume or start, and drop optional flags on demand", () => {
  const allowed = flagsFor([2, 1, 0]);
  const fresh = sessionArgs({ model: "claude-sonnet-4-5", effort: "high", maxTurns: 12, systemPromptFile: "/p", mcpConfigFile: "/m", sessionId: "s1", resume: false, allowed });
  assert.deepEqual(fresh.slice(0, 7), ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model"]);
  assert.ok(fresh.includes("--session-id") && fresh.includes("s1") && !fresh.includes("--resume"));
  assert.ok(fresh.includes("--mcp-config") && fresh.includes("--strict-mcp-config") && fresh.includes("--allowedTools"));
  assert.ok(fresh.includes("--effort") && fresh.includes("--setting-sources"));
  assert.ok(fresh.includes("--dangerously-skip-permissions"));
  const resumed = sessionArgs({ model: "m", systemPromptFile: "/p", mcpConfigFile: null, sessionId: "s1", resume: true, allowed, optional: false });
  assert.ok(resumed.includes("--resume") && !resumed.includes("--session-id"));
  assert.ok(!resumed.includes("--strict-mcp-config") && !resumed.includes("--setting-sources") && !resumed.includes("--mcp-config"));
  assert.notEqual(argsKeyFor({ model: "a", toolNames: ["x"] }), argsKeyFor({ model: "a", toolNames: ["y"] }));
  assert.equal(argsKeyFor({ model: "a", toolNames: ["x"] }), argsKeyFor({ model: "a", effort: null, toolNames: ["x"] }));
});

test("agents: results settle, task notifications don't", () => {
  assert.equal(settle({ type: "assistant" }), null);
  assert.equal(settle({ type: "result", origin: { kind: "task-notification" } }), null);
  const done = settle({ type: "result", result: "hi", stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 } });
  assert.deepEqual(done, { ok: true, text: "hi", stopReason: "end_turn", cost: 0.01, usage: { input: 100, output: 5, cachedInput: 90 } });
  assert.equal(settle({ type: "result", is_error: true })?.ok, false);
});

test("agents: failures are classified and the env is scrubbed", () => {
  assert.equal(isResumeFailure({ resume: true, sawInit: false, stderr: "No conversation found with session ID abc", exitCode: 1 }), true);
  assert.equal(isResumeFailure({ resume: true, sawInit: true, stderr: "No conversation found", exitCode: 1 }), false);
  assert.equal(isResumeFailure({ resume: false, sawInit: false, stderr: "No conversation found", exitCode: 1 }), false);
  assert.equal(isUnknownOption("error: unknown option '--strict-mcp-config'"), true);
  assert.equal(isUnknownOption("not logged in"), false);
  const env = stripCredentialEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "x", CLAUDE_CODE_OAUTH_TOKEN: "y" });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.match(systemReminder("new"), /<system-reminder>[\s\S]*new[\s\S]*<\/system-reminder>\n\n$/);
  assert.deepEqual(userMessage("hi"), { type: "user", message: { role: "user", content: "hi" } });
  const multi = userMessage("look", [{ mediaType: "image/png", data: "AAA" }]);
  assert.equal(multi.message.content.length, 2);
  assert.equal(multi.message.content[0].type, "image");
  const docs = userMessage("read", [
    { mediaType: "application/pdf", data: "JVBE", name: "spec.pdf" },
    { mediaType: "application/zip", data: "UEs=" },
  ]);
  assert.deepEqual(docs.message.content[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" }, title: "spec.pdf" });
  assert.equal(docs.message.content.length, 2);
  assert.equal(loggable(docs).message.content[0].source.data, "[4 base64 characters]");
});

test("mcp bridge: answers the handful of methods the CLI uses", async () => {
  const calls: unknown[] = [];
  const bridge = async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "tools/list") return { tools: [{ name: "list_cards", description: "d", inputSchema: {} }] };
    return { content: "3 cards", isError: false };
  };
  const init = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, bridge);
  assert.equal(init?.result.serverInfo.name, "kru");
  assert.equal(await handleRpc({ method: "notifications/initialized" }, bridge), null);
  const list = await handleRpc({ id: 2, method: "tools/list" }, bridge);
  assert.equal(list?.result.tools[0].name, "list_cards");
  const call = await handleRpc({ id: 3, method: "tools/call", params: { name: "list_cards", arguments: { column: "drop" } } }, bridge);
  assert.deepEqual(call?.result, { content: [{ type: "text", text: "3 cards" }], isError: false });
  assert.deepEqual(calls[1], ["tools/call", { name: "list_cards", arguments: { column: "drop" } }]);
  assert.equal((await handleRpc({ id: 4, method: "tools/call", params: {} }, bridge))?.error.code, -32602);
  assert.equal((await handleRpc({ id: 5, method: "prompts/list" }, bridge))?.error.code, -32601);
  const state = { pending: "" };
  assert.deepEqual(takeLines(state, '{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(takeLines(state, "2}\r\n"), ['{"b":2}']);
  assert.equal(state.pending, "");
});
