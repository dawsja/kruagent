import assert from "node:assert/strict";
import { test } from "node:test";
import { createRun, insertCard } from "../lib/hq/data.ts";
import { resetPrPick, resolvePrChat } from "../lib/hq/bots/pr-request.ts";
import { parseReviseRequest } from "../lib/hq/bots/revise-request-logic.ts";
import { resetRevisePick, resolveReviseChat } from "../lib/hq/bots/revise-request.ts";
import type { Card, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

test("requests for changes are recognised in plain words, with the card and the note apart", () => {
  const explicit = (query: string, note: string) => ({ query, note, explicit: true });
  assert.deepEqual(parseReviseRequest("on the landing page one, make the hero smaller"), explicit("landing page", "make the hero smaller"));
  assert.deepEqual(parseReviseRequest("revise the blur fix, it's too dark now"), explicit("blur fix", "it's too dark now"));
  assert.deepEqual(parseReviseRequest("@pip can you revise the blur fix? it's too dark"), explicit("blur fix", "it's too dark"));
  assert.deepEqual(parseReviseRequest("revise the blur fix so it's lighter"), explicit("blur fix", "so it's lighter"));
  assert.deepEqual(parseReviseRequest("send the blur fix back: too dark"), explicit("blur fix", "too dark"));
  assert.deepEqual(parseReviseRequest("send back the theme toggle card - use a moon icon"), explicit("theme toggle", "use a moon icon"));
  assert.deepEqual(parseReviseRequest("send it back, the hero is too big"), explicit("", "the hero is too big"));
  assert.deepEqual(parseReviseRequest("make a change to the landing page: smaller hero"), explicit("landing page", "smaller hero"));
  assert.deepEqual(parseReviseRequest("I'd like some changes on the orange accent one. Use #f80 instead"), explicit("orange accent", "Use #f80 instead"));
  assert.deepEqual(parseReviseRequest("for the theme toggle card use a moon icon instead"), explicit("theme toggle", "use a moon icon instead"));
  assert.deepEqual(parseReviseRequest("fix the login one, the redirect is still wrong"), explicit("login", "the redirect is still wrong"));
  assert.deepEqual(parseReviseRequest("can you make the hero smaller on the landing page card?"), explicit("landing page", "make the hero smaller"));
  assert.deepEqual(parseReviseRequest("change the button color to orange on the landing page one"), explicit("landing page", "change the button color to orange"));
  assert.deepEqual(
    parseReviseRequest("on the landing page one,\nmake the hero smaller\nand the text bigger"),
    explicit("landing page", "make the hero smaller\nand the text bigger"),
    "a note keeps its lines",
  );
  assert.deepEqual(parseReviseRequest("revise the blur fix"), explicit("blur fix", ""), "a card but no note");
});

test("without a word for the card, a message is only maybe about one", () => {
  assert.deepEqual(parseReviseRequest("on the landing page, make the hero smaller"), { query: "landing page", note: "make the hero smaller", explicit: false });
  assert.deepEqual(parseReviseRequest("update the README, it's outdated"), { query: "readme", note: "it's outdated", explicit: false });
});

test("questions, thanks, other bots' work and other requests aren't requests for changes", () => {
  for (const text of [
    "on the landing page one, why is the hero so big?",
    "what's going on with the landing page one",
    "great work on the landing page one",
    "on the landing page one, great work!",
    "make a card for the landing page one",
    "for the theme toggle one, make the PR",
    "move the landing page card back to drop",
    "don't revise the blur fix yet",
    "@kiko on the landing page one, run the tests",
    "make the PR for the theme toggle one",
    "hello there",
    "2",
  ]) {
    assert.equal(parseReviseRequest(text), null, text);
  }
});

function seedCard(id: string, title: string, status: Card["status"], runStatus: Run["status"] | null, extra: Partial<Run> = {}) {
  const at = new Date(Date.now() + Number(id.replace(/\D/g, "") || 0)).toISOString();
  const column = status === "running" || status === "error" ? "run" : status === "open" ? "drop" : "review";
  insertCard({ id, title, body: "", column: "drop", repo: "o/r", model: "ep_x:m", status: "open", runId: null, createdAt: at, updatedAt: at });
  if (!runStatus) return;
  const run: Run = { id: `run-${id}`, cardId: id, status: runStatus, log: [], proposedWrites: [], prUrl: null, error: null, createdAt: at, updatedAt: at, ...extra };
  createRun(run, { column, status, runId: run.id });
}

test("the board resolver sends one reviewed card back, asks about several, and explains the rest", () => {
  const temp = useTempDataDir();
  resetRevisePick();
  resetPrPick();
  try {
    seedCard("c1", "Redesign the landing page", "needs_approval", "needs_approval", { summary: "A new hero with a gradient" });
    seedCard("c2", "Fix the backdrop blur on modals", "needs_approval", "needs_approval");
    seedCard("c3", "Orange accent on buttons", "needs_approval", "needs_approval");
    seedCard("c4", "Orange accent on links", "needs_approval", "needs_approval");
    seedCard("c5", "Rewrite the README", "approved", "approved", { prUrl: "https://github.com/o/r/pull/7" });
    seedCard("c6", "Speed up search", "running", "running");
    seedCard("c7", "Add a pricing table", "open", null);
    seedCard("c8", "Migrate the settings form", "error", "error");

    const landing = resolveReviseChat("on the landing page one, make the hero smaller");
    assert.deepEqual(landing?.revise && { runId: landing.revise.runId, note: landing.revise.note }, { runId: "run-c1", note: "make the hero smaller" });
    assert.equal(landing?.cardId, "c1");
    const blur = resolveReviseChat("revise the blur fix, it's too dark now");
    assert.deepEqual(blur?.revise && { runId: blur.revise.runId, note: blur.revise.note }, { runId: "run-c2", note: "it's too dark now" });
    assert.equal(resolveReviseChat("revise the gradient hero: less purple")?.revise?.runId, "run-c1", "the summary counts");
    assert.equal(resolveReviseChat("on the landng page, make the hero smaller")?.revise?.runId, "run-c1", "loose words and a typo still find a card in Review");
    assert.equal(resolveReviseChat("send c2 back, too dark")?.revise?.runId, "run-c2", "a pasted card id is exact");

    const ambiguous = resolveReviseChat("on the orange accent one, use #f80 instead");
    assert.equal(ambiguous?.revise, null);
    assert.match(ambiguous?.reply ?? "", /could be more than one card/);
    assert.match(ambiguous?.reply ?? "", /1\. "Orange accent on (links|buttons)"/);
    assert.match(ambiguous?.reply ?? "", /2\. "Orange accent on (links|buttons)"/);
    assert.equal(resolvePrChat("2"), null, "the number isn't a PR pick");
    const second = ambiguous?.reply.includes('2. "Orange accent on links"') ? "run-c4" : "run-c3";
    const picked = resolveReviseChat("2");
    assert.deepEqual(picked?.revise && { runId: picked.revise.runId, note: picked.revise.note }, { runId: second, note: "use #f80 instead" });
    assert.equal(resolveReviseChat("2"), null, "the list is used up once picked");

    assert.equal(resolveReviseChat("on the orange accent one, use #f80 instead")?.revise, null);
    assert.equal(resolveReviseChat("what's up?"), null);
    assert.equal(resolveReviseChat("1"), null, "any other message closes the list");

    assert.match(resolveReviseChat("revise the blur fix")?.reply ?? "", /What should change on "Fix the backdrop blur on modals"\?/);

    const merged = resolveReviseChat("revise the readme rewrite, add a badge");
    assert.equal(merged?.revise, null);
    assert.match(merged?.reply ?? "", /already has a pull request \(https:\/\/github.com\/o\/r\/pull\/7\)/);
    assert.match(resolveReviseChat("on the search speed one, cache the index")?.reply ?? "", /still being worked on/);
    assert.match(resolveReviseChat("on the pricing table one, add a free tier")?.reply ?? "", /still in Drop/);
    assert.match(resolveReviseChat("revise the settings form migration, keep the old labels")?.reply ?? "", /stopped with an error/);

    const unknown = resolveReviseChat("revise the payments page, add Apple Pay");
    assert.equal(unknown?.revise, null);
    assert.match(unknown?.reply ?? "", /No card waiting in Review matches "payments page"/);
    assert.equal(resolveReviseChat("1")?.revise?.note, "add Apple Pay", "the note waits for the pick");

    assert.equal(resolveReviseChat("on the payments page, add Apple Pay"), null, "loose words that fit no card in Review are left to the crew");
    assert.equal(resolveReviseChat("update the README, it's outdated"), null, "and so are ones that fit a card elsewhere");
  } finally {
    resetRevisePick();
    resetPrPick();
    temp.cleanup();
  }
});

test("with one card in Review, \"send it back\" means that card", () => {
  const temp = useTempDataDir();
  resetRevisePick();
  try {
    assert.match(resolveReviseChat("send it back, the hero is too big")?.reply ?? "", /No cards are waiting in Review/);
    seedCard("c1", "Redesign the landing page", "needs_approval", "needs_approval");
    assert.equal(resolveReviseChat("send it back, the hero is too big")?.revise?.runId, "run-c1");
  } finally {
    resetRevisePick();
    temp.cleanup();
  }
});
