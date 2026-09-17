import assert from "node:assert/strict";
import { test } from "node:test";
import { detailStale, summarizeRun, throttle } from "../lib/hq/board-logic.ts";
import {
  appendRunLog,
  createRun,
  deleteCard,
  insertCard,
  insertChatMessage,
  insertCardForIssue,
  patchCard,
  setBotsEnabled,
  transitionRun,
} from "../lib/hq/data.ts";
import { emit, listenerCount, subscribe, type LiveEvent } from "../lib/hq/events.ts";
import type { Card, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string): Card {
  return { id, title: id, body: "", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, createdAt: at, updatedAt: at };
}

function record() {
  const events: LiveEvent[] = [];
  const stop = subscribe((event) => events.push(event));
  return {
    take() {
      return events.splice(0).map((e) => (e.topic === "run" ? `run:${e.runId}` : e.topic));
    },
    stop,
  };
}

test("the bus reaches every listener and drops one that throws", () => {
  const seen: string[] = [];
  const stopA = subscribe((e) => seen.push(`a:${e.topic}`));
  const stopB = subscribe(() => {
    throw new Error("broken tab");
  });
  const before = listenerCount();
  emit({ topic: "chat" });
  emit({ topic: "board" });
  assert.deepEqual(seen, ["a:chat", "a:board"]);
  assert.equal(listenerCount(), before - 1, "the broken listener is gone");
  stopA();
  stopB();
});

test("writes announce what changed, once, and only when something did", () => {
  const temp = useTempDataDir();
  const events = record();
  try {
    insertCard(card("c1"));
    assert.deepEqual(events.take(), ["board"]);

    assert.equal(patchCard("missing", { title: "x" }), null);
    assert.deepEqual(events.take(), [], "nothing changed, nothing said");

    const run: Run = { id: "r1", cardId: "c1", status: "running", log: ["Agent started"], proposedWrites: [], prUrl: null, error: null, createdAt: at, updatedAt: at };
    createRun(run, { column: "run", status: "running", runId: "r1" });
    assert.deepEqual(events.take().sort(), ["board", "run:r1"], "run and card changes fold into one board event");

    appendRunLog("r1", "$ ls");
    assert.deepEqual(events.take().sort(), ["board", "run:r1"]);

    assert.equal(transitionRun("r1", ["needs_approval"], "approved"), false);
    assert.deepEqual(events.take(), [], "a refused transition says nothing");
    transitionRun("r1", ["running"], "cancelled");
    assert.deepEqual(events.take().sort(), ["board", "run:r1"]);
    assert.equal(appendRunLog("r1", "after cancel"), false);
    assert.deepEqual(events.take(), []);

    // Nested writes (an issue import inserts a card inside its own write) announce once.
    insertCardForIssue({ ...card("c2"), issueNumber: 3, issueUrl: null }, { id: 3, repo: "o/r", number: 3 });
    assert.deepEqual(events.take(), ["board"]);
    assert.equal(insertCardForIssue({ ...card("c3"), issueNumber: 3, issueUrl: null }, { id: 3, repo: "o/r", number: 3 }), false);
    assert.deepEqual(events.take(), []);

    insertChatMessage({ id: "m1", author: "you", kind: "message", body: "hi", mentions: [], cardId: null, replyTo: null, depth: 0, createdAt: at });
    assert.deepEqual(events.take(), ["chat"]);

    setBotsEnabled(true);
    deleteCard("c1");
    assert.deepEqual(events.take(), ["board", "board"]);

    // A write that throws announces nothing.
    assert.throws(() => insertCard(card("c2")));
    assert.deepEqual(events.take(), []);
  } finally {
    events.stop();
    temp.cleanup();
  }
});

test("summarizeRun keeps what the board shows and leaves the log and contents out", () => {
  const run: Run = {
    id: "r1",
    cardId: "c1",
    status: "needs_approval",
    log: ["Agent started", "PR opened https://github.com/o/r/pull/1", "Review by Lulu: CHANGES\n- a.ts", "Lulu: $ bun test", "Review by Lulu: PASS", "Waiting for approval"],
    proposedWrites: [
      { path: "a.ts", content: "x".repeat(50_000), message: "m", diff: "--- a/a.ts\n+++ b/a.ts\n@@\n-old\n+new\n+more" },
      { path: "b.ts", content: "", message: "gone", deleted: true },
    ],
    prUrl: null,
    error: null,
    summary: "Did it",
    createdAt: at,
    updatedAt: at,
  };
  const summary = summarizeRun(run);
  assert.equal("log" in summary, false);
  assert.equal("proposedWrites" in summary, false);
  assert.equal(summary.lastLog, "Waiting for approval");
  assert.equal(summary.logCount, 6);
  assert.deepEqual(summary.files, [
    { path: "a.ts", message: "m", added: 2, removed: 1 },
    { path: "b.ts", message: "gone", deleted: true, added: 0, removed: 0 },
  ]);
  assert.deepEqual(summary.reviews, [
    { verdict: "changes", notes: "- a.ts" },
    { verdict: "pass", notes: "" },
  ]);
  assert.equal(summary.pushedLine, "PR opened https://github.com/o/r/pull/1");
  assert.equal(summary.summary, "Did it");
  assert.ok(JSON.stringify(summary).length < 1_000);
  assert.equal(summarizeRun({ ...run, log: [] }).lastLog, null);

  assert.equal(detailStale(summary, null), true);
  assert.equal(detailStale(summary, run), false);
  assert.equal(detailStale(summary, { ...run, log: run.log.slice(1) }), true, "a new log line");
  assert.equal(detailStale(summary, { ...run, updatedAt: "2026-09-17T11:00:00Z" }), true);
  assert.equal(detailStale(summary, { ...run, id: "r2" }), true);
});

test("throttle runs at once, folds a burst into one trailing call, then runs at once again", () => {
  let now = 0;
  const timers: { at: number; cb: () => void }[] = [];
  const clock = { now: () => now, set: (cb: () => void, ms: number) => timers.push({ at: now + ms, cb }) };
  let calls = 0;
  const fire = throttle(() => calls++, 500, clock);

  fire();
  assert.equal(calls, 1, "leading call");
  now = 100;
  fire();
  fire();
  fire();
  assert.equal(calls, 1, "the burst waits");
  assert.equal(timers.length, 1, "one trailing call for the whole burst");
  now = 500;
  timers.shift()!.cb();
  assert.equal(calls, 2);
  now = 700;
  fire();
  assert.equal(calls, 2, "still inside the window after the trailing call");
  now = 1000;
  timers.shift()!.cb();
  assert.equal(calls, 3);
  now = 2000;
  fire();
  assert.equal(calls, 4, "quiet long enough: at once");
});
