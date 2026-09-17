import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneRefFor, inheritedFollowUp, newRun, replayNeeded, retryBase } from "../lib/hq/runs-logic.ts";
import type { Card, Run } from "../lib/hq/types";

const at = "2026-09-17T10:00:00Z";
const PR = "https://github.com/o/r/pull/4";

function card(): Card {
  return { id: "c1", title: "t", body: "", column: "review", repo: "o/r", model: "ep:m", status: "approved", runId: "r1", createdAt: at, updatedAt: at };
}

test("cloneRefFor and replayNeeded follow the run's origin", () => {
  assert.equal(cloneRefFor({ headBranch: null, prUrl: null }, "main"), "main");
  assert.equal(cloneRefFor({ headBranch: "kru/abc", prUrl: null }, "main"), "main");
  assert.equal(cloneRefFor({ headBranch: "kru/abc", prUrl: "u" }, "main"), "kru/abc");
  assert.equal(replayNeeded(null), false);
  assert.equal(replayNeeded({ status: "approved" }), false);
  assert.equal(replayNeeded({ status: "merged" }), false);
  assert.equal(replayNeeded({ status: "cancelled" }), true);
  assert.equal(replayNeeded({ status: "needs_approval" }), true);
});

test("a follow-up sits on the pull request's branch, and a revision of it stays there", () => {
  const approved: Run = { id: "r1", cardId: "c1", status: "approved", log: [], proposedWrites: [], prUrl: PR, prNumber: 4, headBranch: "kru/abc", baseBranch: "main", prState: "open", error: null, createdAt: at, updatedAt: at };
  const followUp = newRun(
    "r2",
    card(),
    { of: approved, note: "Fix the test" },
    { bot: "momo", followUp: { prUrl: PR, prNumber: 4, headBranch: "kru/abc", baseBranch: "main", reason: "check" } },
    at,
  );
  assert.equal(followUp.headBranch, "kru/abc");
  assert.equal(followUp.baseBranch, "main");
  assert.equal(followUp.prUrl, PR);
  assert.equal(followUp.prNumber, 4);
  assert.equal(followUp.prState, "open");
  assert.equal(followUp.followUpReason, "check");
  assert.equal(followUp.revisionOf, "r1");
  assert.equal(followUp.bot, "momo");
  assert.equal(followUp.status, "running");
  assert.equal(followUp.log[1], "Following up on pull request #4. Request: Fix the test");

  // Lulu sends the follow-up back: the new round inherits the branch, and
  // reads as a revision since the parent was never approved.
  const cancelled: Run = { ...followUp, status: "cancelled" };
  const again = newRun("r3", card(), { of: cancelled, note: "Also the docs" }, { bot: "momo" }, at);
  assert.equal(again.headBranch, "kru/abc");
  assert.equal(again.prUrl, PR);
  assert.equal(again.prNumber, 4);
  assert.equal(again.followUpReason, "check");
  assert.equal(again.revisionOf, "r2");
  assert.equal(again.log[1], "Revising the previous result. Request: Also the docs");
  assert.deepEqual(inheritedFollowUp(cancelled), { prUrl: PR, prNumber: 4, headBranch: "kru/abc", baseBranch: "main", reason: "check" });

  // A plain revision of a reviewed run has none of it.
  const reviewed: Run = { ...approved, status: "needs_approval", prUrl: null, headBranch: null, prNumber: null, prState: null };
  const revision = newRun("r4", card(), { of: reviewed, note: "Smaller" }, {}, at);
  assert.equal(revision.headBranch, null);
  assert.equal(revision.prUrl, null);
  assert.equal(revision.followUpReason, null);
  assert.equal(inheritedFollowUp(reviewed), null);
  assert.equal(inheritedFollowUp(undefined), null);

  const plain = newRun("r5", card(), undefined, {}, at);
  assert.deepEqual(plain.log, ["Agent started"]);
  assert.equal(plain.revisionOf, null);
});

test("a failed follow-up is retried as one; anything else starts over", () => {
  const failed: Run = { id: "r2", cardId: "c1", status: "error", log: [], proposedWrites: [], prUrl: PR, prNumber: 4, headBranch: "kru/abc", prState: "open", revisionNote: "Fix the test", error: "box down", createdAt: at, updatedAt: at };
  assert.deepEqual(retryBase(failed), { of: failed, note: "Fix the test" });
  assert.equal(retryBase({ ...failed, revisionNote: null })?.note, "Continue the follow-up on the pull request.");
  const retried = newRun("r3", card(), retryBase(failed), {}, at);
  assert.equal(retried.headBranch, "kru/abc");
  assert.equal(retried.prUrl, PR);
  assert.equal(retried.log[1], "Following up on pull request #4. Request: Fix the test");
  // Not a follow-up, or its pull request is done: start over.
  assert.equal(retryBase({ ...failed, prUrl: null, headBranch: null }), undefined);
  assert.equal(retryBase({ ...failed, prState: "closed" }), undefined);
  assert.equal(retryBase({ ...failed, status: "approved" }), undefined);
  assert.equal(retryBase(null), undefined);
});
