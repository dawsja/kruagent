import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionReconnectError } from "../lib/hq/openai-oauth.ts";
import {
  codexFetch,
  collapseResponsesStream,
  parseSse,
  shapeCodexBody,
  xaiOAuthFetch,
} from "../lib/hq/subscription-fetch.ts";
import type { Connection } from "../lib/hq/types";

function connection(accessToken: string): Connection {
  return {
    id: "sub_openai",
    provider: "openai",
    accessToken,
    refreshToken: "rt",
    expiresAt: null,
    label: "ChatGPT",
    meta: { auth: "oauth", accountId: "acct_1", baseUrl: "https://chatgpt.com/backend-api/codex" },
  };
}

type Call = { url: string; init: RequestInit };

function recorder(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const sse = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  "",
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc"}}',
  "",
  'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash","arguments":"{\\"command\\":\\"ls\\"}","status":"completed"}}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_1","created_at":1700000000,"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":5},"incomplete_details":null}}',
  "",
].join("\n");

test("the Codex body is shaped: nothing stored, instructions present, encrypted reasoning included", () => {
  const shaped = shapeCodexBody(
    { model: "gpt-5.4", input: [], store: true, previous_response_id: "x", include: ["a"] },
    true,
  );
  assert.equal(shaped.store, false);
  assert.equal(shaped.stream, true);
  assert.ok(typeof shaped.instructions === "string" && shaped.instructions.length > 0);
  assert.deepEqual(shaped.include, ["a", "reasoning.encrypted_content"]);
  assert.equal("previous_response_id" in shaped, false);
  assert.equal(shapeCodexBody({ instructions: "Do the task" }, false).instructions, "Do the task");
  assert.equal("stream" in shapeCodexBody({}, false), false);
});

test("a streamed reply folds into the non-streaming shape", () => {
  assert.equal(parseSse(sse).length, 4);
  const folded = collapseResponsesStream(sse, "fallback");
  assert.equal(folded.id, "resp_1");
  assert.equal(folded.model, "gpt-5.4");
  assert.equal(folded.created_at, 1700000000);
  assert.deepEqual(folded.usage, { input_tokens: 10, output_tokens: 5 });
  const output = folded.output as { type: string }[];
  assert.deepEqual(
    output.map((item) => item.type),
    ["reasoning", "function_call"],
  );
});

test("a failed stream becomes the error object the SDK reports", () => {
  const failed = 'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"Too many"}}}\n\n';
  assert.deepEqual(collapseResponsesStream(failed), {
    error: { message: "Too many", type: "server_error", param: null, code: "rate_limit_exceeded" },
  });
  const errored = 'data: {"type":"error","code":"boom","message":"Went wrong"}\n\n';
  assert.equal((collapseResponsesStream(errored).error as { message: string }).message, "Went wrong");
});

test("codexFetch sends the account headers, a fresh bearer, the shaped body, and folds the stream", async () => {
  process.env.KRU_CODEX_FORCE_STREAM = "1";
  const { calls, fetchImpl } = recorder([
    () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
  ]);
  const send = codexFetch({
    connectionId: "sub_openai",
    fetchImpl,
    fresh: async () => connection("tok_1"),
    accountHeaders: { "chatgpt-account-id": "acct_1", originator: "kru", "OpenAI-Beta": "responses=experimental" },
  });
  const res = await send("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer subscription" },
    body: JSON.stringify({ model: "gpt-5.4", input: [], instructions: "Work" }),
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer tok_1");
  assert.equal(headers.get("chatgpt-account-id"), "acct_1");
  assert.equal(headers.get("originator"), "kru");
  assert.equal(headers.get("openai-beta"), "responses=experimental");
  const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(sent.instructions, "Work");
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as { output: unknown[]; usage: { input_tokens: number } };
  assert.equal(body.output.length, 2);
  assert.equal(body.usage.input_tokens, 10);
});

test("a 401 gets one forced refresh and one retry, then asks to sign in again", async () => {
  const forced: boolean[] = [];
  const fresh = async (force: boolean) => {
    forced.push(force);
    return connection(force ? "tok_2" : "tok_1");
  };
  const { calls, fetchImpl } = recorder([
    () => new Response("", { status: 401 }),
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const res = await xaiOAuthFetch({ connectionId: "sub_xai", fetchImpl, fresh })("https://api.x.ai/v1/responses", {
    method: "POST",
    body: "{}",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(forced, [false, true]);
  assert.equal(new Headers(calls[1].init.headers).get("authorization"), "Bearer tok_2");

  const twice = recorder([() => new Response("", { status: 401 }), () => new Response("", { status: 401 })]);
  await assert.rejects(
    xaiOAuthFetch({ connectionId: "sub_xai", fetchImpl: twice.fetchImpl, fresh })("https://api.x.ai/v1/models"),
    SubscriptionReconnectError,
  );
});

test("non-Responses requests and JSON replies pass through untouched", async () => {
  process.env.KRU_CODEX_FORCE_STREAM = "1";
  const { calls, fetchImpl } = recorder([
    () => new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const send = codexFetch({
    connectionId: "sub_openai",
    fetchImpl,
    fresh: async () => connection("tok_1"),
    accountHeaders: { originator: "kru" },
  });
  const res = await send("https://chatgpt.com/backend-api/codex/models", { method: "GET" });
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(await res.json(), { data: [] });
});
