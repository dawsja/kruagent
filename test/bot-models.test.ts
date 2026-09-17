import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand, runCommand } from "../lib/hq/bots/commands.ts";
import { defaultCardModel, ensureCardModel, findModel, switchCardModel, switchChatModel } from "../lib/hq/bots/models.ts";
import { getBotsModel, getCard, insertCard, saveOnboarding, upsertConnection } from "../lib/hq/data.ts";
import type { Card } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

function seedConnections() {
  delete process.env.KRU_BOX_URL;
  upsertConnection({ id: "ep_xai", provider: "xai", label: "xAI", accessToken: "k", refreshToken: null, expiresAt: null, meta: { listedModels: "grok-4.6,grok-4.5" } });
  upsertConnection({ id: "sub_xai", provider: "xai", label: "SuperGrok", accessToken: "t", refreshToken: null, expiresAt: null, meta: { auth: "oauth", name: "SuperGrok", baseUrl: "https://api.x.ai/v1", listedModels: "grok-4.6" } });
}

function card(id: string, patch: Partial<Card> = {}): Card {
  const at = new Date().toISOString();
  return { id, title: id, body: "", column: "drop", repo: "o/r", model: null, status: "open", runId: null, createdAt: at, updatedAt: at, ...patch };
}

test("commands: /models and /model parse; anything else is chat", () => {
  assert.deepEqual(parseCommand("/models"), { name: "models" });
  assert.deepEqual(parseCommand("  /model grok sub "), { name: "model", query: "grok sub" });
  assert.deepEqual(parseCommand("/Model"), { name: "model", query: "" });
  assert.equal(parseCommand("@pip /model grok"), null);
  assert.equal(parseCommand("/modelx"), null);
});

test("switching the chat model by loose name, with ambiguity and unknowns reported", async () => {
  const temp = useTempDataDir();
  try {
    seedConnections();
    const ambiguous = await switchChatModel("grok");
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /could be more than one/);
    assert.equal(getBotsModel(), null);

    const sub = await switchChatModel("gork sub");
    assert.equal(sub.ok, true);
    assert.equal(getBotsModel(), "sub_xai:grok-4.6");
    assert.match(sub.message, /SuperGrok/);

    const api = await switchChatModel("grok 4.5 api");
    assert.equal(getBotsModel(), "ep_xai:grok-4.5");
    assert.equal(api.ok, true);

    const unknown = await findModel("claude opus 5");
    assert.equal(unknown.ok, false, "Claude Code isn't signed in here, so it isn't listed");
    assert.match(unknown.message, /No model matches/);

    assert.match(await runCommand({ name: "models" }), /1\. Grok 4\.6 · xAI API/);
    assert.match(await runCommand({ name: "model", query: "" }), /chats with Grok 4\.5/);
    assert.match(await runCommand({ name: "model", query: "3" }), /SuperGrok/);
  } finally {
    temp.cleanup();
  }
});

test("new and model-less cards get the crew's model; busy cards can't switch", async () => {
  const temp = useTempDataDir();
  try {
    assert.equal(await defaultCardModel(), null, "nothing connected");
    seedConnections();
    assert.equal(await defaultCardModel(), "ep_xai:grok-4.6", "first available");
    saveOnboarding({ complete: true, model: "sub_xai:grok-4.6", repo: null });
    assert.equal(await defaultCardModel(), "sub_xai:grok-4.6", "setup's pick when usable");
    await switchChatModel("grok 4.5");
    assert.equal(await defaultCardModel(), "ep_xai:grok-4.5", "the crew's model first");

    insertCard(card("c1"));
    const settled = await ensureCardModel(getCard("c1")!);
    assert.equal(settled.card.model, "ep_xai:grok-4.5");
    assert.equal(settled.assigned, "Grok 4.5");
    insertCard(card("c2", { model: "claude-code:claude-opus-5" }));
    assert.equal((await ensureCardModel(getCard("c2")!)).assigned, null, "a named model is kept");

    assert.equal((await switchCardModel("c1", "grok sub")).ok, true);
    assert.equal(getCard("c1")?.model, "sub_xai:grok-4.6");
    insertCard(card("c3", { status: "running", column: "run" }));
    assert.match((await switchCardModel("c3", "grok sub")).message, /being worked on/);
  } finally {
    temp.cleanup();
  }
});
