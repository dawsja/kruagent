import assert from "node:assert/strict";
import { test } from "node:test";
import { BOTS, STAGE_BOT, botForStage, getBot } from "../lib/hq/bots/registry.ts";
import { boardSummary, loadSoul, systemPromptFor } from "../lib/hq/bots/souls.ts";
import { BOT_IDS } from "../lib/hq/types.ts";

test("every bot has a SOUL that opens with its name", () => {
  for (const id of BOT_IDS) {
    const bot = getBot(id);
    const soul = loadSoul(id);
    assert.ok(soul.startsWith(`# ${bot.name}\n`), `${id} SOUL starts with its name`);
    assert.match(soul, /## Role/);
    assert.match(soul, /## Rules/);
  }
});

test("the lineup matches the spec", () => {
  assert.deepEqual(BOTS.map((bot) => bot.id), ["pip", "momo", "kiko", "lulu", "bibi"]);
  assert.deepEqual(BOTS.map((bot) => bot.color), ["#3B82F6", "#FF5A0F", "#14B8A6", "#8B5CF6", "#EC4899"]);
  assert.equal(getBot("pip").expression, "wink");
  assert.deepEqual(STAGE_BOT, { build: "momo", test: "kiko", review: "lulu", scribe: "bibi" });
  assert.equal(botForStage("test")?.name, "Kiko");
  assert.equal(botForStage("done"), null);
});

test("the system prompt carries the SOUL, the crew and the board", () => {
  const at = new Date().toISOString();
  const card = { id: "c1", title: "Add dark mode", body: "", column: "run" as const, repo: "o/r", model: null, status: "running" as const, runId: "r1", createdAt: at, updatedAt: at };
  const job = { id: "j1", cardId: "c1", stage: "test" as const, runId: "r1", rounds: 0, testReport: null, reviewVerdict: null, error: null, claimedBy: null, createdAt: at, updatedAt: at };
  const prompt = systemPromptFor(getBot("lulu"), { cards: [card], jobs: [job] });
  assert.match(prompt, /^# Lulu/);
  assert.match(prompt, /@momo \(Momo, builder\)/);
  assert.match(prompt, /"Add dark mode" · run · running · o\/r, crew: test/);
  assert.equal(boardSummary([], []), "The board is empty.");
  // The house rule is honest about the one push that happens without a click.
  assert.match(prompt, /Nothing reaches GitHub without the person, with one exception/);
  assert.match(prompt, /auto-push/);
});
