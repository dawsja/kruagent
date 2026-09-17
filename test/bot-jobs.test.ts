import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureKruDatabase, resetDatabaseReady } from "../lib/db/init.ts";
import { closeDb } from "../lib/db/sqlite.ts";
import {
  claimBotJob,
  claimDropCard,
  createRun,
  getActiveBotJobForCard,
  getBotJob,
  getRun,
  insertCard,
  latestBotJobByCard,
  listBotJobs,
  patchCard,
  releaseBotClaims,
  transitionBotJob,
} from "../lib/hq/data.ts";
import type { Card, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

function card(id: string, patch: Partial<Card> = {}): Card {
  const at = new Date().toISOString();
  return { id, title: id, body: "", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, createdAt: at, updatedAt: at, ...patch };
}

test("claimDropCard takes an open card in Drop once", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    insertCard(card("c2", { column: "run", status: "running" }));
    const job = claimDropCard("c1", "owner-a", "job1");
    assert.equal(job?.stage, "build");
    assert.equal(job?.claimedBy, "owner-a");
    assert.equal(claimDropCard("c1", "owner-b", "job2"), null, "second claim must fail");
    assert.equal(claimDropCard("c2", "owner-a", "job3"), null, "not in Drop");
    assert.equal(claimDropCard("missing", "owner-a", "job4"), null);
    assert.equal(getActiveBotJobForCard("c1")?.id, "job1");
    assert.equal(listBotJobs({ active: true }).length, 1);
  } finally {
    temp.cleanup();
  }
});

test("transitionBotJob is a compare-and-set and clears the owner when done", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    claimDropCard("c1", "me", "job1");
    assert.equal(transitionBotJob("job1", ["test"], "review"), false);
    assert.equal(transitionBotJob("job1", ["build"], "test", { runId: "r1", testReport: null }), true);
    let job = getBotJob("job1");
    assert.equal(job?.stage, "test");
    assert.equal(job?.runId, "r1");
    assert.equal(job?.claimedBy, "me");
    assert.equal(transitionBotJob("job1", ["test"], "review", { rounds: 1, reviewVerdict: "pass" }), true);
    assert.equal(transitionBotJob("job1", ["review"], "done"), true);
    job = getBotJob("job1");
    assert.equal(job?.claimedBy, null);
    assert.equal(job?.rounds, 1);
    assert.equal(getActiveBotJobForCard("c1"), null);
    // The card can be picked up again once the first job is over.
    patchCard("c1", { column: "drop", status: "open" });
    assert.equal(claimDropCard("c1", "me", "job2")?.id, "job2");
    assert.equal(latestBotJobByCard().get("c1")?.id, "job2");
  } finally {
    temp.cleanup();
  }
});

test("claims release and re-claim across a restart", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    insertCard(card("c2"));
    const at = new Date().toISOString();
    claimDropCard("c1", "old", "job1");
    claimDropCard("c2", "old", "job2");
    const base: Run = { id: "r1", cardId: "c1", status: "running", log: [], proposedWrites: [], prUrl: null, error: null, bot: "momo", createdAt: at, updatedAt: at };
    createRun(base, { column: "run", status: "running", runId: "r1" });
    transitionBotJob("job1", ["build"], "build", { runId: "r1" });
    createRun({ ...base, id: "r2", cardId: "c2", status: "needs_approval" }, { column: "run", status: "needs_approval", runId: "r2" });
    transitionBotJob("job2", ["build"], "test", { runId: "r2" });
    assert.equal(getRun("r2")?.bot, "momo");

    assert.equal(claimBotJob("job2", "new"), false, "still owned");
    releaseBotClaims();
    assert.equal(claimBotJob("job2", "new"), true);
    assert.equal(getBotJob("job2")?.claimedBy, "new");

    // A restart: the build-stage job fails with its run, the later one is freed.
    closeDb();
    resetDatabaseReady();
    ensureKruDatabase();
    assert.equal(getBotJob("job1")?.stage, "failed");
    assert.match(getBotJob("job1")?.error ?? "", /restart/);
    assert.equal(getBotJob("job2")?.stage, "test");
    assert.equal(getBotJob("job2")?.claimedBy, null);
  } finally {
    temp.cleanup();
  }
});
