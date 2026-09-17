import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEEDBACK_SETTLE_MS,
  checkFollowUpsSoFar,
  due,
  followUpAction,
  prOwners,
  runsSharingPr,
  staleClaims,
} from "../lib/hq/pr-sync-logic.ts";
import type { BotJob, Card, PrFeedback, Run } from "../lib/hq/types";

const at = "2026-09-17T10:00:00Z";
const PR = "https://github.com/o/r/pull/5";

function run(id: string, patch: Partial<Run> = {}): Run {
  return { id, cardId: "c1", status: "approved", log: [], proposedWrites: [], prUrl: PR, prState: "open", headBranch: "kru/x", error: null, createdAt: at, updatedAt: at, ...patch };
}

function card(patch: Partial<Card> = {}): Card {
  return { id: "c1", title: "t", body: "", column: "review", repo: "o/r", model: "ep:m", status: "approved", runId: "r1", createdAt: at, updatedAt: at, ...patch };
}

function feedback(id: string, patch: Partial<PrFeedback> = {}): PrFeedback {
  return { id, cardId: "c1", runId: "r1", prUrl: PR, kind: "issue_comment", author: "a", body: "please change", path: null, line: null, url: null, state: null, githubUpdatedAt: at, seenAt: at, handledBy: null, ...patch };
}

test("prOwners picks the newest approved run per open pull request", () => {
  const owners = prOwners([
    run("r1", { createdAt: "2026-09-17T09:00:00Z" }),
    run("r2", { createdAt: "2026-09-17T11:00:00Z" }),
    run("r3", { prUrl: "https://github.com/o/r/pull/6", prState: "merged" }),
    run("r4", { prUrl: "https://github.com/o/r/pull/7", prState: "closed" }),
    run("r5", { prUrl: "https://github.com/o/r/pull/8", status: "merged" }),
    run("r6", { prUrl: "https://github.com/o/r/pull/9", status: "needs_approval" }),
    run("r7", { prUrl: null }),
    run("r8", { prUrl: "https://github.com/o/r/pull/10", prState: null }),
  ]);
  assert.deepEqual(owners.map((o) => o.id).sort(), ["r2", "r8"]);
  assert.deepEqual(runsSharingPr([run("r1"), run("r2"), run("r9", { status: "cancelled" })], PR, "r2").map((r) => r.id), ["r1"]);
});

test("due claims the runs whose interval passed, oldest-checked first, up to the limit", () => {
  const checked = new Map<string, number>([["a", 100], ["b", 0], ["c", 50]]);
  const runs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual(due(runs, checked, 110, 20).map((r) => r.id), ["b", "d", "c"]);
  assert.deepEqual(due(runs, checked, 110, 20, 2).map((r) => r.id), ["b", "d"]);
  assert.deepEqual(due(runs, checked, 105, 20).map((r) => r.id), ["b", "d", "c"]);
  assert.deepEqual(staleClaims(checked, [{ id: "a" }]), ["b", "c"]);
});

test("checkFollowUpsSoFar counts only check-started follow-ups on the pull request", () => {
  const runs = [run("r1"), run("r2", { followUpReason: "check" }), run("r3", { followUpReason: "review" }), run("r4", { followUpReason: "check", prUrl: "other" })];
  assert.equal(checkFollowUpsSoFar(runs, PR), 1);
});

test("followUpAction: skip, wait, revise, start and the check cap", () => {
  const owner = run("r1");
  const settled = Date.parse(at) + FEEDBACK_SETTLE_MS + 1;
  const base = { card: card(), ownerRun: owner, cardRun: owner, activeJob: null, botsEnabled: true, now: settled, checkFollowUps: 0 };

  assert.equal(followUpAction({ ...base, pending: [] }).kind, "skip");
  assert.equal(followUpAction({ ...base, pending: [feedback("f1", { body: "LGTM" })] }).kind, "skip");

  const pending = [feedback("f1")];
  assert.deepEqual(followUpAction({ ...base, pending, now: Date.parse(at) + 1000 }), { kind: "wait", why: "feedback still arriving" });
  assert.equal(followUpAction({ ...base, pending, activeJob: { id: "j" } as BotJob }).kind, "wait");
  assert.equal(followUpAction({ ...base, pending, card: card({ status: "running" }) }).kind, "wait");
  assert.equal(followUpAction({ ...base, pending, cardRun: run("r2", { status: "applying" }) }).kind, "wait");
  assert.deepEqual(followUpAction({ ...base, pending, botsEnabled: false }), { kind: "skip", why: "the crew is off" });

  const started = followUpAction({ ...base, pending });
  assert.equal(started.kind, "start");
  assert.deepEqual(started.kind === "start" ? started.items.map((i) => i.id) : [], ["f1"]);

  // A follow-up already waiting for the person takes the new feedback.
  const waiting = run("r2", { status: "needs_approval", createdAt: "2026-09-17T12:00:00Z" });
  const folded = followUpAction({ ...base, pending, cardRun: waiting, card: card({ status: "needs_approval", runId: "r2" }) });
  assert.deepEqual(folded.kind === "revise" ? folded.runId : null, "r2");
  // But not a plain waiting run that has no pull request behind it.
  const fresh = run("r3", { status: "needs_approval", prUrl: null, headBranch: null });
  assert.equal(followUpAction({ ...base, pending, cardRun: fresh, card: card({ status: "needs_approval", runId: "r3" }) }).kind, "start");

  const checks = [feedback("check:1", { kind: "check", author: "test", state: "failure" })];
  assert.equal(followUpAction({ ...base, pending: checks, checkFollowUps: 3 }).kind, "skip");
  assert.equal(followUpAction({ ...base, pending: checks, checkFollowUps: 2 }).kind, "start");
  // A person's comment alongside a failing check is never capped.
  assert.equal(followUpAction({ ...base, pending: [...checks, ...pending], checkFollowUps: 3 }).kind, "start");

  assert.equal(followUpAction({ ...base, pending, ownerRun: run("r1", { prState: "merged" }) }).kind, "skip");
});
