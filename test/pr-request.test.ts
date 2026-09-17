import assert from "node:assert/strict";
import { test } from "node:test";
import { createRun, insertCard } from "../lib/hq/data.ts";
import { matchCard, parsePick, parsePrRequest, scoreCard, wordSimilarity } from "../lib/hq/bots/pr-request-logic.ts";
import { resetPrPick, resolvePrChat } from "../lib/hq/bots/pr-request.ts";
import type { Card, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

test("PR requests are recognised in plain words, and other messages aren't", () => {
  assert.deepEqual(parsePrRequest("make the PR for the theme toggle one"), { query: "theme toggle" });
  assert.deepEqual(parsePrRequest("open the PR for the orange accent card"), { query: "orange accent" });
  assert.deepEqual(parsePrRequest("@pip can you open a pull request for dark mode?"), { query: "dark mode" });
  assert.deepEqual(parsePrRequest("ok, go ahead and make the theme toggle PR please"), { query: "theme toggle" });
  assert.deepEqual(parsePrRequest("approve the orange accent card"), { query: "orange accent" });
  assert.deepEqual(parsePrRequest("Looks good, ship the PR"), { query: "" });
  assert.deepEqual(parsePrRequest("pr for login fix"), null, "no verb, no request");
  assert.equal(parsePrRequest("why didn't the PR for theme toggle open?"), null);
  assert.equal(parsePrRequest("don't make the PR yet"), null);
  assert.equal(parsePrRequest("make a card for the theme toggle"), null);
  assert.equal(parsePrRequest("approved"), null);
  assert.equal(parsePrRequest("the approve button is broken"), null);
});

test("words match loosely: plurals, prefixes, typos", () => {
  assert.equal(wordSimilarity("toggle", "toggle"), 1);
  assert.ok(wordSimilarity("toggles", "toggle") > 0.9);
  assert.ok(wordSimilarity("accent", "accents") > 0.9);
  assert.ok(wordSimilarity("ornage", "orange") > 0);
  assert.ok(wordSimilarity("dark", "darkmode") > 0);
  assert.equal(wordSimilarity("red", "rad"), 0, "short words must be exact");
  assert.equal(wordSimilarity("theme", "table"), 0);
});

const cards = [
  { id: "a", title: "Add a theme toggle to the header", body: "Light and dark." },
  { id: "b", title: "Use an orange accent on buttons", body: "" },
  { id: "c", title: "Fix login redirect", body: "", summary: "Changed the orange-free callback handling" },
  { id: "d", title: "Orange accent for links", body: "" },
];

test("a card is matched by its title, body or summary", () => {
  assert.deepEqual(matchCard("theme toggle", cards), { status: "match", card: cards[0] });
  assert.deepEqual(matchCard("theme toggel", cards), { status: "match", card: cards[0] });
  assert.deepEqual(matchCard("dark light", cards), { status: "match", card: cards[0] });
  assert.deepEqual(matchCard("callback", cards), { status: "match", card: cards[2] });
  assert.deepEqual(matchCard("orange accent buttons", cards), { status: "match", card: cards[1] });
  assert.deepEqual(matchCard("payments page", cards), { status: "none" });
  assert.ok(scoreCard("theme toggle", cards[0]) > scoreCard("theme toggle", cards[1]));
});

test("close matches are ambiguous, not guessed", () => {
  const result = matchCard("orange accent", cards);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.status === "ambiguous" && result.candidates.map((card) => card.id).sort(), ["b", "d"]);
  assert.deepEqual(matchCard("", [cards[0]]), { status: "match", card: cards[0] });
  assert.equal(matchCard("", cards).status, "ambiguous");
  assert.deepEqual(matchCard("theme", []), { status: "none" });
});

test("picks from a numbered list", () => {
  assert.equal(parsePick("2"), 2);
  assert.equal(parsePick("#1"), 1);
  assert.equal(parsePick("number 3."), 3);
  assert.equal(parsePick("@pip the second one"), 2);
  assert.equal(parsePick("1 please"), 1);
  assert.equal(parsePick("0"), null);
  assert.equal(parsePick("2 cards are stuck"), null);
  assert.equal(parsePick("make the PR"), null);
});

function seedCard(id: string, title: string, status: Card["status"], runStatus: Run["status"] | null, extra: Partial<Run> = {}) {
  const at = new Date(Date.now() + Number(id.replace(/\D/g, "") || 0)).toISOString();
  const column = status === "running" ? "run" : status === "open" ? "drop" : "review";
  insertCard({ id, title, body: "", column: "drop", repo: "o/r", model: "ep_x:m", status: "open", runId: null, createdAt: at, updatedAt: at });
  if (!runStatus) return;
  const run: Run = { id: `run-${id}`, cardId: id, status: runStatus, log: [], proposedWrites: [], prUrl: null, error: null, createdAt: at, updatedAt: at, ...extra };
  createRun(run, { column, status, runId: run.id });
}

test("the board resolver approves one waiting card, asks about several, and explains the rest", () => {
  const temp = useTempDataDir();
  resetPrPick();
  try {
    seedCard("c1", "Add a theme toggle", "needs_approval", "needs_approval", { summary: "A sun/moon switch in the header" });
    seedCard("c2", "Orange accent on buttons", "needs_approval", "needs_approval");
    seedCard("c3", "Orange accent on links", "needs_approval", "needs_approval");
    seedCard("c4", "Rewrite the README", "approved", "approved", { prUrl: "https://github.com/o/r/pull/7" });
    seedCard("c5", "Speed up search", "running", "running");

    const toggle = resolvePrChat("make the PR for the theme toggle one");
    assert.equal(toggle?.approve?.runId, "run-c1");
    assert.equal(toggle?.cardId, "c1");
    assert.equal(resolvePrChat("open the PR for the moon switch")?.approve?.runId, "run-c1", "the summary counts");

    const ambiguous = resolvePrChat("open the PR for the orange accent card");
    assert.equal(ambiguous?.approve, null);
    assert.match(ambiguous?.reply ?? "", /1\. "Orange accent on (links|buttons)"/);
    assert.match(ambiguous?.reply ?? "", /2\. "Orange accent on (links|buttons)"/);
    const second = ambiguous?.reply.includes('2. "Orange accent on links"') ? "run-c3" : "run-c2";
    assert.equal(resolvePrChat("2")?.approve?.runId, second);
    assert.equal(resolvePrChat("2"), null, "the list is used up once picked");

    assert.equal(resolvePrChat("approve the orange accent card")?.approve, null);
    assert.equal(resolvePrChat("what's up?"), null);
    assert.equal(resolvePrChat("1"), null, "any other message closes the list");

    const done = resolvePrChat("make the PR for the readme rewrite");
    assert.equal(done?.approve, null);
    assert.match(done?.reply ?? "", /already has a pull request: https:\/\/github.com\/o\/r\/pull\/7/);
    assert.match(resolvePrChat("open the pr for speed up search")?.reply ?? "", /still being worked on/);

    const unknown = resolvePrChat("make the PR for the payments page");
    assert.equal(unknown?.approve, null);
    assert.match(unknown?.reply ?? "", /No card waiting for review matches "payments page"/);

    assert.equal(resolvePrChat("approve c2")?.approve?.runId, "run-c2", "a pasted card id is exact");
  } finally {
    resetPrPick();
    temp.cleanup();
  }
});
