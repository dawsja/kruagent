import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanSummary,
  diffDigest,
  formatTestReport,
  nextStageAfterReview,
  parseVerdict,
  repoInstructionsSection,
  retryPlan,
  retryStillWanted,
  reviewNotesIn,
  reviewPrompt,
  testHeadline,
  testPlan,
  testsPassed,
} from "../lib/hq/bots/pipeline-logic.ts";
import type { Card, Run } from "../lib/hq/types";

test("retryPlan retries only failures of the work, within the budget", () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  assert.equal(retryPlan("work", 0, now, 1, 120_000), "2026-09-17T10:02:00.000Z");
  assert.equal(retryPlan("work", 1, now, 1, 120_000), null, "out of retries");
  assert.equal(retryPlan("work", 1, now, 2, 120_000), "2026-09-17T10:02:00.000Z");
  assert.equal(retryPlan("setup", 0, now, 1), null, "only the person can fix it");
  assert.equal(retryPlan("handed", 0, now, 1), null, "the change already reached the person");
  assert.equal(retryPlan("work", 0, now, 0), null, "retries turned off");
});

test("retryStillWanted steps aside once the person moved the card on", () => {
  const failed = { id: "j1", runId: "r1" };
  assert.equal(retryStillWanted(failed, { status: "error", runId: "r1" }, "j1"), true);
  assert.equal(retryStillWanted({ id: "j1", runId: null }, { status: "error", runId: null }, "j1"), true);
  assert.equal(retryStillWanted(failed, { status: "running", runId: "r2" }, "j1"), false, "retried by hand");
  assert.equal(retryStillWanted(failed, { status: "open", runId: "r1" }, "j1"), false, "moved back to Drop");
  assert.equal(retryStillWanted(failed, { status: "error", runId: "r2" }, "j1"), false, "a newer run failed");
  assert.equal(retryStillWanted(failed, { status: "error", runId: "r1" }, "j2"), false, "a newer job");
  assert.equal(retryStillWanted(failed, null, "j1"), false, "deleted");
});

test("Lulu's notes are read back from a run log, and repo instructions reach her prompt", () => {
  assert.deepEqual(
    reviewNotesIn(["Agent started", "Review by Lulu: CHANGES\n- a.ts: off by one", "Lulu: $ bun test a", "Review by Lulu: PASS"]),
    [
      { verdict: "changes", notes: "- a.ts: off by one" },
      { verdict: "pass", notes: "" },
    ],
  );
  assert.equal(repoInstructionsSection("  "), "");
  assert.equal(repoInstructionsSection("Use pnpm"), "Standing instructions for this repo, from the person:\nUse pnpm");
  const at = new Date().toISOString();
  const card: Card = { id: "c", title: "t", body: "", column: "run", repo: "o/r", model: null, status: "needs_approval", runId: "r", createdAt: at, updatedAt: at };
  const run: Run = { id: "r", cardId: "c", status: "needs_approval", log: [], proposedWrites: [], prUrl: null, error: null, createdAt: at, updatedAt: at };
  assert.match(reviewPrompt(card, run, null, "Never touch migrations/"), /Standing instructions for this repo, from the person:\nNever touch migrations\//);
  assert.doesNotMatch(reviewPrompt(card, run, null), /Standing instructions/);
});

test("verdicts are read from the first line, and nonsense passes with a note", () => {
  assert.deepEqual(parseVerdict("VERDICT: PASS\nLooks right."), { verdict: "pass", notes: "Looks right." });
  assert.deepEqual(parseVerdict("**VERDICT: CHANGES**\n- fix a.ts"), { verdict: "changes", notes: "- fix a.ts" });
  assert.deepEqual(parseVerdict("verdict: changes"), { verdict: "changes", notes: "" });
  assert.equal(parseVerdict("I think it's fine").verdict, "pass");
  assert.match(parseVerdict("I think it's fine").notes, /inconclusive/);
  assert.equal(parseVerdict(null).verdict, "pass");
});

test("review rounds are bounded", () => {
  assert.equal(nextStageAfterReview("pass", 0, 2), "scribe");
  assert.equal(nextStageAfterReview("changes", 0, 2), "build");
  assert.equal(nextStageAfterReview("changes", 1, 2), "build");
  assert.equal(nextStageAfterReview("changes", 2, 2), "scribe");
  assert.equal(nextStageAfterReview("changes", 0, 0), "scribe");
});

test("the test plan follows the repo's scripts and package manager", () => {
  const pkg = { scripts: { build: "next build", test: "node --test", lint: "eslint", dev: "next dev" } };
  assert.deepEqual(testPlan(pkg, true), ["bun run lint", "bun run test", "bun run build"]);
  assert.deepEqual(testPlan({ scripts: { test: "jest" } }, false), ["npm run test"]);
  assert.deepEqual(testPlan({ scripts: { test: "" } }, false), []);
  assert.deepEqual(testPlan(null, true), []);
  assert.deepEqual(testPlan("nope", true), []);
});

test("test reports keep failures and headline the count", () => {
  const results = [
    { command: "bun run lint", exitCode: 0, timedOut: false, output: "ok" },
    { command: "bun run test", exitCode: 1, timedOut: false, output: "1 failing\nexpected 2 got 3" },
    { command: "bun run build", exitCode: 0, timedOut: true, output: "" },
  ];
  assert.equal(testsPassed(results), false);
  assert.equal(testsPassed(results.slice(0, 1)), true);
  assert.equal(testHeadline(results), "2 of 3 failed (test, build)");
  assert.equal(testHeadline(results.slice(0, 1)), "all 1 passed");
  assert.equal(testHeadline([]), "nothing to run");
  const report = formatTestReport(results);
  assert.match(report, /\$ bun run lint\npassed/);
  assert.match(report, /failed \(exit 1\)\n1 failing/);
  assert.match(report, /timed out/);
  assert.match(formatTestReport([]), /No checks to run/);
});

test("prompts quote the diff within a budget and summaries are trimmed", () => {
  const at = new Date().toISOString();
  const card: Card = { id: "c", title: "Do it", body: "Carefully", column: "run", repo: "o/r", model: null, status: "needs_approval", runId: "r", createdAt: at, updatedAt: at };
  const run: Run = {
    id: "r", cardId: "c", status: "needs_approval", log: [], prUrl: null, error: null, summary: "Did it", createdAt: at, updatedAt: at,
    proposedWrites: [
      { path: "a.ts", content: "", message: "", diff: "x".repeat(41_000) },
      { path: "b.ts", content: "", message: "", deleted: true, diff: "gone" },
    ],
  };
  const digest = diffDigest(run);
  assert.match(digest, /changed a\.ts\nx+\n\[… diff truncated …\]/);
  assert.match(digest, /deleted b\.ts$/);
  const prompt = reviewPrompt(card, run, "$ bun run test\npassed");
  assert.match(prompt, /Task: Do it/);
  assert.match(prompt, /Details:\nCarefully/);
  assert.match(prompt, /builder's summary: Did it/);
  assert.match(prompt, /Kiko's checks:\n\$ bun run test/);
  assert.doesNotMatch(prompt, /follow-up/);
  // A follow-up on a pull request: Lulu hears what was asked and that the
  // diff is only this round's addition.
  const followUp = reviewPrompt(card, { ...run, prUrl: "https://github.com/o/r/pull/9", prNumber: 9, headBranch: "kru/x", revisionNote: "Rename the flag" }, null);
  assert.match(followUp, /follow-up on pull request #9/);
  assert.match(followUp, /What this round was asked to do:\nRename the flag/);
  assert.match(reviewPrompt(card, { ...run, revisionNote: "Smaller hero" }, null), /asked to do:\nSmaller hero/);
  assert.equal(cleanSummary("  "), null);
  assert.equal(cleanSummary("fine"), "fine");
  assert.equal(cleanSummary("y".repeat(2_500))?.length, 2_001);
});
