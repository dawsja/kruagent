import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countPendingFeedbackByCard,
  createRun,
  getBotsAutoPush,
  getMissingGithubPermissions,
  getRun,
  insertCard,
  insertPrFeedback,
  listPrFeedback,
  markPrFeedbackHandled,
  setBotsAutoPush,
  setMissingGithubPermissions,
  transitionRun,
} from "../lib/hq/data.ts";
import type { Card, PrFeedback, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string): Card {
  return { id, title: id, body: "", column: "review", repo: "o/r", model: "ep:m", status: "approved", runId: null, createdAt: at, updatedAt: at };
}

function feedback(id: string, patch: Partial<PrFeedback> = {}): PrFeedback {
  return { id, cardId: "c1", runId: "r1", prUrl: "https://github.com/o/r/pull/1", kind: "issue_comment", author: "a", body: "b", path: null, line: null, url: null, state: null, githubUpdatedAt: at, seenAt: at, handledBy: null, ...patch };
}

test("auto-push and missing permissions default off and round-trip", () => {
  const temp = useTempDataDir();
  try {
    assert.equal(getBotsAutoPush(), false);
    setBotsAutoPush(true);
    assert.equal(getBotsAutoPush(), true);
    assert.deepEqual(getMissingGithubPermissions(), []);
    setMissingGithubPermissions(["checks", "issues", "checks"]);
    assert.deepEqual(getMissingGithubPermissions(), ["checks", "issues"]);
    setMissingGithubPermissions([]);
    assert.deepEqual(getMissingGithubPermissions(), []);
  } finally {
    temp.cleanup();
  }
});

test("insertPrFeedback stores each item once and says which were new", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    insertCard(card("c2"));
    const first = insertPrFeedback([feedback("review:1"), feedback("check:2", { kind: "check", cardId: "c2", author: "test", state: "failure" })]);
    assert.deepEqual(first.map((f) => f.id), ["review:1", "check:2"]);
    const again = insertPrFeedback([feedback("review:1", { body: "edited" }), feedback("review_comment:3", { kind: "review_comment", path: "a.ts", line: 4 })]);
    assert.deepEqual(again.map((f) => f.id), ["review_comment:3"]);
    // The first version stands; polling again does not rewrite.
    assert.equal(listPrFeedback({ cardId: "c1" }).find((f) => f.id === "review:1")?.body, "b");
    assert.equal(insertPrFeedback([]).length, 0);

    assert.deepEqual([...countPendingFeedbackByCard().entries()].sort(), [["c1", 2], ["c2", 1]]);
    markPrFeedbackHandled(["review:1", "review_comment:3"], "r9");
    assert.deepEqual(listPrFeedback({ cardId: "c1", pending: true }), []);
    assert.equal(listPrFeedback({ cardId: "c1" }).every((f) => f.handledBy === "r9"), true);
    // Already-handled items keep their run.
    markPrFeedbackHandled(["review:1"], "r10");
    assert.equal(listPrFeedback({ cardId: "c1" }).find((f) => f.id === "review:1")?.handledBy, "r9");
    assert.deepEqual([...countPendingFeedbackByCard().entries()], [["c2", 1]]);
    const stored = listPrFeedback({ cardId: "c1" }).find((f) => f.id === "review_comment:3")!;
    assert.equal(stored.path, "a.ts");
    assert.equal(stored.line, 4);
    assert.equal(stored.kind, "review_comment");
  } finally {
    temp.cleanup();
  }
});

test("runs round-trip the pull request columns and follow-up reason", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    const base: Run = { id: "r1", cardId: "c1", status: "running", log: [], proposedWrites: [], prUrl: "https://github.com/o/r/pull/4", prNumber: 4, headBranch: "kru/abc", followUpReason: "review", error: null, createdAt: at, updatedAt: at };
    createRun(base, { column: "run", status: "running", runId: "r1" });
    let run = getRun("r1")!;
    assert.equal(run.prNumber, 4);
    assert.equal(run.headBranch, "kru/abc");
    assert.equal(run.followUpReason, "review");
    assert.equal(run.prHeadSha, null);
    assert.equal(run.prEtags, null);

    assert.equal(transitionRun("r1", ["running"], null, { prHeadSha: "deadbeef", prEtags: { reviews: "W/1", checks: null }, prNumber: 5 }), true);
    run = getRun("r1")!;
    assert.equal(run.prHeadSha, "deadbeef");
    assert.deepEqual(run.prEtags, { reviews: "W/1", checks: null });
    assert.equal(run.prNumber, 5);
    assert.equal(transitionRun("r1", ["running"], null, { prEtags: null }), true);
    assert.equal(getRun("r1")!.prEtags, null);
  } finally {
    temp.cleanup();
  }
});
