import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIndex,
  editDistance,
  formatIndex,
  resolveModel,
  tokenize,
  type IndexedOption,
} from "../lib/hq/bots/model-index.ts";

const OPTIONS: IndexedOption[] = [
  { id: "ep_xai:grok-4.6", name: "Grok 4.6", provider: "xAI API", badge: "Default" },
  { id: "ep_xai:grok-4.5", name: "Grok 4.5", provider: "xAI API" },
  { id: "sub_xai:grok-4.6", name: "Grok 4.6", provider: "SuperGrok", badge: "Default" },
  { id: "sub_openai:gpt-5.4", name: "GPT-5.4", provider: "ChatGPT", badge: "Default" },
  { id: "ep_oa:gpt-5.4", name: "GPT-5.4", provider: "OpenAI API", badge: "Default" },
  { id: "ep_oa:gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "OpenAI API" },
  { id: "claude-code:claude-fable-5-1", name: "Claude Fable 5.1", provider: "Claude Code", badge: "Default" },
  { id: "claude-code:claude-opus-5", name: "Claude Opus 5", provider: "Claude Code" },
  { id: "claude-code:claude-sonnet-5", name: "Claude Sonnet 5", provider: "Claude Code" },
  { id: "ep_ant:claude-opus-4-5", name: "Claude Opus 4.5", provider: "Claude API" },
];

const index = buildIndex(OPTIONS);
const pick = (query: string) => {
  const result = resolveModel(query, index);
  return result.status === "match" ? result.entry.option.id : result.status;
};

test("tokens split letters from digits and keep versions whole", () => {
  assert.deepEqual(tokenize("Claude Opus5"), ["claude", "opus", "5"]);
  assert.deepEqual(tokenize("grok-4.6"), ["grok", "4.6"]);
  assert.deepEqual(tokenize("GPT-5.4 mini"), ["gpt", "5.4", "mini"]);
  assert.equal(editDistance("opsu", "opus"), 1);
  assert.equal(editDistance("sonet", "sonnet"), 1);
});

test("the switches from the request resolve: grok api, grok sub, claude opus 5", () => {
  assert.equal(pick("grok api"), "ep_xai:grok-4.6");
  assert.equal(pick("grok sub"), "sub_xai:grok-4.6");
  assert.equal(pick("supergrok"), "sub_xai:grok-4.6");
  assert.equal(pick("claude opus 5"), "claude-code:claude-opus-5");
  assert.equal(pick("use claude opus 5 please"), "claude-code:claude-opus-5");
});

test("small misspellings still find the model", () => {
  assert.equal(pick("claude opsu 5"), "claude-code:claude-opus-5");
  assert.equal(pick("sonet 5"), "claude-code:claude-sonnet-5");
  assert.equal(pick("gork sub"), "sub_xai:grok-4.6");
  assert.equal(pick("chatgtp"), "sub_openai:gpt-5.4");
});

test("versions must match, and api vs subscription is never guessed", () => {
  assert.equal(pick("opus 4.5"), "ep_ant:claude-opus-4-5");
  assert.equal(pick("grok 4.5"), "ep_xai:grok-4.5");
  assert.equal(pick("opus 9"), "none");
  const both = resolveModel("grok", index);
  assert.equal(both.status, "ambiguous");
  assert.deepEqual(both.status === "ambiguous" ? both.candidates.map((c) => c.connectionId) : [], ["ep_xai", "sub_xai"]);
  assert.equal(pick("gpt 5.4 mini"), "ep_oa:gpt-5.4-mini");
  assert.equal(pick("nothing like this"), "none");
});

test("a number picks from the indexed list, and exact refs pass through", () => {
  assert.equal(pick("3"), "sub_xai:grok-4.6");
  assert.equal(pick("#8"), "claude-code:claude-opus-5");
  assert.equal(pick("99"), "none");
  assert.equal(pick("claude-code:claude-sonnet-5"), "claude-code:claude-sonnet-5");
  assert.equal(pick("claude-opus-4-5"), "ep_ant:claude-opus-4-5");
  const listed = formatIndex(index, "claude-code:claude-opus-5");
  assert.match(listed, /^1\. Grok 4\.6 · xAI API · API key · grok-4\.6$/m);
  assert.match(listed, /^8\. Claude Opus 5 · Claude Code · Claude Code · claude-opus-5 \(current\)$/m);
  assert.equal(formatIndex([]), "No models are available.");
});
