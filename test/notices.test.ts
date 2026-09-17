import assert from "node:assert/strict";
import { test } from "node:test";
import { crewNotice, unreadBot } from "../lib/hq/bots/notices.ts";
import type { BotJob, ChatMessage } from "../lib/hq/types";

function job(stage: BotJob["stage"], rounds = 0, id = "j1"): BotJob {
  return {
    id,
    cardId: "c1",
    stage,
    runId: null,
    rounds,
    testReport: null,
    reviewVerdict: null,
    error: null,
    claimedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function line(author: ChatMessage["author"], createdAt: string): ChatMessage {
  return { id: createdAt, author, kind: "event", body: "x", mentions: [], cardId: null, replyTo: null, depth: 0, createdAt };
}

test("each stage change is one plain line from Pip", () => {
  assert.equal(crewNotice(undefined, job("build"), "Add dark mode"), 'Momo picked up "Add dark mode"');
  assert.equal(crewNotice(job("build"), job("test"), "Add dark mode"), 'Kiko is running checks on "Add dark mode"');
  assert.equal(crewNotice(job("test"), job("review"), "Add dark mode"), 'Lulu is starting review of "Add dark mode"');
  assert.equal(crewNotice(job("review"), job("build", 1), "Add dark mode"), 'Momo picked up "Add dark mode" again');
  assert.equal(crewNotice(job("review"), job("scribe"), "Add dark mode"), 'Bibi is writing up "Add dark mode"');
  assert.equal(crewNotice(job("scribe"), job("done"), "Add dark mode"), '"Add dark mode" is ready for review');
  assert.equal(crewNotice(job("test"), job("failed"), "Add dark mode"), '"Add dark mode" stopped while testing');
  assert.equal(crewNotice(undefined, job("failed"), "Add dark mode"), '"Add dark mode" stopped');
});

test("a follow-up names its pull request, and says when the crew pushed it", () => {
  assert.equal(crewNotice(undefined, job("build"), "A", { followUp: 12 }), 'Momo is following up on PR #12 for "A"');
  assert.equal(crewNotice(job("review"), job("build", 1), "A", { followUp: 12 }), 'Momo picked up "A" again');
  assert.equal(crewNotice(job("scribe"), job("done"), "A", { followUp: 12 }), '"A" is ready to push to PR #12');
  assert.equal(crewNotice(job("scribe"), job("done"), "A", { followUp: 12, pushed: true }), 'Pushed a follow-up to PR #12 for "A"');
  assert.equal(crewNotice(job("scribe"), job("done"), "A", { followUp: null, pushed: true }), '"A" is ready for review');
});

test("a planned retry is mentioned, and the retry itself says so", () => {
  assert.equal(crewNotice(job("build"), { ...job("failed"), retryAt: "2026-01-01T00:02:00.000Z" }, "A"), '"A" stopped while building; the crew will try again shortly');
  assert.equal(crewNotice(undefined, { ...job("build", 0, "j2"), attempts: 1 }, "A"), 'Momo is trying "A" again');
});

test("nothing to say when the job didn't move or you cancelled it", () => {
  assert.equal(crewNotice(job("test"), job("test"), "A"), null);
  assert.equal(crewNotice(job("build"), job("cancelled"), "A"), null);
});

test("long titles are shortened", () => {
  const text = crewNotice(undefined, job("done"), "x".repeat(200))!;
  assert.ok(text.length < 90);
  assert.match(text, /…" is ready for review$/);
});

test("the dot is the last bot to post after the room was read", () => {
  const room = [line("momo", "2026-01-01T00:00:01Z"), line("kiko", "2026-01-01T00:00:02Z"), line("you", "2026-01-01T00:00:03Z")];
  assert.equal(unreadBot(room, "2026-01-01T00:00:00Z"), "kiko");
  assert.equal(unreadBot(room, "2026-01-01T00:00:02Z"), null);
  assert.equal(unreadBot(room, null), null);
  assert.equal(unreadBot([line("you", "2026-01-01T00:00:05Z")], "2026-01-01T00:00:00Z"), null);
});
