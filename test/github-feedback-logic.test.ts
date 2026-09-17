import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KRU_MARKER,
  MAX_NOTE_CHARS,
  annotationLines,
  approvalEvent,
  checkRunId,
  feedbackEvent,
  feedbackNote,
  followUpComment,
  isActionable,
  mergeEtags,
  normalizeCheckRuns,
  normalizeIssueComments,
  normalizeReviewComments,
  normalizeReviews,
  type FeedbackItem,
} from "../lib/hq/github-feedback-logic.ts";

const human = { login: "dawsja", type: "User" };
const bot = { login: "dependabot[bot]", type: "Bot" };

test("normalizeReviews keeps requests and comments, sets approvals apart, skips shells and bots", () => {
  const { feedback, approvals } = normalizeReviews([
    { id: 1, user: human, body: "Please rename the flag", state: "CHANGES_REQUESTED", submitted_at: "2026-09-17T10:00:00Z", html_url: "u1" },
    { id: 2, user: human, body: "", state: "COMMENTED", submitted_at: "2026-09-17T10:01:00Z" },
    { id: 3, user: human, body: "Nice work", state: "APPROVED", submitted_at: "2026-09-17T10:02:00Z" },
    { id: 4, user: bot, body: "bot says hi", state: "COMMENTED", submitted_at: "2026-09-17T10:03:00Z" },
    { id: 5, user: human, body: `automated ${KRU_MARKER}`, state: "COMMENTED", submitted_at: "2026-09-17T10:04:00Z" },
    { id: 6, user: human, body: "later", state: "DISMISSED", submitted_at: "2026-09-17T10:05:00Z" },
  ]);
  assert.deepEqual(feedback.map((f) => f.id), ["review:1"]);
  assert.equal(feedback[0].state, "CHANGES_REQUESTED");
  assert.equal(feedback[0].author, "dawsja");
  assert.equal(feedback[0].url, "u1");
  assert.deepEqual(approvals.map((a) => a.id), ["review:3"]);
});

test("review and issue comments carry file, line and author; bots and Kru's own are skipped", () => {
  const diff = normalizeReviewComments([
    { id: 10, user: human, body: "Off by one", path: "src/a.ts", line: 42, html_url: "c10", updated_at: "2026-09-17T11:00:00Z" },
    { id: 11, user: human, body: "Old line", path: "src/b.ts", line: null, original_line: 7, updated_at: "2026-09-17T11:01:00Z" },
    { id: 12, user: bot, body: "noise", path: "src/c.ts", line: 1 },
    { id: 13, user: human, body: "   ", path: "src/d.ts", line: 1 },
  ]);
  assert.deepEqual(
    diff.map((d) => [d.id, d.path, d.line]),
    [
      ["review_comment:10", "src/a.ts", 42],
      ["review_comment:11", "src/b.ts", 7],
    ],
  );
  const talk = normalizeIssueComments([
    { id: 20, user: human, body: "Can this also update the docs?", html_url: "i20", updated_at: "2026-09-17T12:00:00Z" },
    { id: 21, user: human, body: `Pushed a follow-up.\n\n${KRU_MARKER}` },
  ]);
  assert.deepEqual(talk.map((t) => t.id), ["issue_comment:20"]);
  assert.equal(talk[0].kind, "issue_comment");
});

test("normalizeCheckRuns keeps only failures on the pushed commit", () => {
  const items = normalizeCheckRuns(
    [
      { id: 1, name: "test", status: "completed", conclusion: "failure", head_sha: "abc", output: { title: "3 tests failed", summary: "see log" }, completed_at: "2026-09-17T13:00:00Z", html_url: "h1" },
      { id: 2, name: "lint", status: "completed", conclusion: "success", head_sha: "abc" },
      { id: 3, name: "build", status: "in_progress", conclusion: null, head_sha: "abc" },
      { id: 4, name: "test", status: "completed", conclusion: "failure", head_sha: "old" },
      { id: 5, name: "deploy", status: "completed", conclusion: "timed_out", head_sha: "abc", output: null },
      { id: 6, name: "scan", status: "completed", conclusion: "skipped", head_sha: "abc" },
    ],
    "abc",
  );
  assert.deepEqual(items.map((i) => i.id), ["check:1", "check:5"]);
  assert.equal(items[0].author, "test");
  assert.equal(items[0].body, "3 tests failed\nsee log");
  assert.equal(items[0].state, "failure");
  assert.equal(items[1].body, "deploy timed out");
  assert.equal(checkRunId(items[0]), 1);
  assert.equal(checkRunId({ id: "review:1", kind: "review" }), null);
  // Without a known head, every failure counts.
  assert.equal(normalizeCheckRuns([{ id: 4, name: "t", status: "completed", conclusion: "failure", head_sha: "old" }], null).length, 1);
});

test("annotationLines names the file and line for failures and warnings only", () => {
  const lines = annotationLines([
    { path: "src/a.ts", start_line: 3, annotation_level: "failure", message: "Expected 2 to be 3" },
    { path: "src/b.ts", start_line: 9, annotation_level: "notice", message: "fyi" },
    { annotation_level: "warning", message: "  deprecated\n  api  " },
  ]);
  assert.deepEqual(lines, ["src/a.ts:3 Expected 2 to be 3", "deprecated api"]);
});

test("isActionable drops acknowledgements but never a check or a change request", () => {
  const ack = (body: string): FeedbackItem => ({ id: "x", kind: "issue_comment", author: "a", body, path: null, line: null, url: null, state: null, githubUpdatedAt: "" });
  for (const body of ["LGTM", "looks good to me!", "Thanks", "👍", ":+1:", "ship it."]) {
    assert.equal(isActionable(ack(body)), false, body);
  }
  assert.equal(isActionable(ack("LGTM but rename the flag")), true);
  assert.equal(isActionable({ ...ack("thanks"), kind: "check" }), true);
  assert.equal(isActionable({ ...ack("thanks"), kind: "review", state: "CHANGES_REQUESTED" }), true);
});

function item(patch: Partial<FeedbackItem>): FeedbackItem {
  return { id: "i", kind: "issue_comment", author: "dawsja", body: "b", path: null, line: null, url: null, state: null, githubUpdatedAt: "2026-09-17T10:00:00Z", ...patch };
}

test("feedbackNote groups by kind, oldest first, checks last, and is capped", () => {
  const note = feedbackNote(
    [
      item({ id: "check:1", kind: "check", author: "test", body: "3 failed", state: "failure", githubUpdatedAt: "2026-09-17T09:00:00Z" }),
      item({ id: "rc:2", kind: "review_comment", path: "src/a.ts", line: 4, body: "second", githubUpdatedAt: "2026-09-17T10:02:00Z" }),
      item({ id: "rc:1", kind: "review_comment", path: "src/a.ts", line: 2, body: "first", githubUpdatedAt: "2026-09-17T10:01:00Z" }),
      item({ id: "review:1", kind: "review", state: "CHANGES_REQUESTED", body: "Overall: smaller please" }),
    ],
    12,
  );
  assert.match(note, /^Feedback on pull request #12:/);
  const order = ["Review by @dawsja (changes requested):\nOverall: smaller please", "@dawsja on src/a.ts:2:\nfirst", "@dawsja on src/a.ts:4:\nsecond", "CI check `test` failure:\n3 failed"];
  let last = -1;
  for (const part of order) {
    const at = note.indexOf(part);
    assert.ok(at > last, `${part} in order`);
    last = at;
  }
  assert.match(note, /Change only what the feedback needs/);
  const long = feedbackNote([item({ body: "x".repeat(10_000) })], null);
  assert.ok(long.length <= MAX_NOTE_CHARS);
  assert.match(long, /Feedback on the pull request:/);
});

test("feedbackEvent and approvalEvent are one line each and quote briefly", () => {
  assert.equal(
    feedbackEvent(item({ kind: "review", state: "CHANGES_REQUESTED", body: "Too   big\nreally" }), 7),
    "A review on PR #7 by @dawsja asked for changes: Too big really",
  );
  assert.equal(feedbackEvent(item({ kind: "review", state: "COMMENTED", body: "Hm" }), 7), "@dawsja reviewed PR #7: Hm");
  assert.equal(feedbackEvent(item({ kind: "review_comment", path: "a.ts", line: 3, body: "why" }), 7), "@dawsja commented on a.ts:3 in PR #7: why");
  assert.equal(feedbackEvent(item({ kind: "issue_comment", body: "docs?" }), null), "@dawsja commented on the PR: docs?");
  assert.equal(feedbackEvent(item({ kind: "check", author: "test", state: "failure" }), 7), "CI failed on PR #7: test");
  assert.equal(feedbackEvent(item({ kind: "check", author: "deploy", state: "timed_out" }), 7), "CI failed on PR #7: deploy (timed out)");
  const quoted = feedbackEvent(item({ body: "y".repeat(500) }), 1);
  assert.ok(quoted.length < 200);
  assert.equal(approvalEvent(item({ kind: "review", state: "APPROVED", body: "" }), 7), "@dawsja approved PR #7");
});

test("followUpComment names people and checks and carries the marker", () => {
  const text = followUpComment(
    [
      item({ kind: "review_comment", author: "ann" }),
      item({ kind: "issue_comment", author: "ann" }),
      item({ kind: "check", author: "test" }),
    ],
    "abcdef1234567",
  );
  assert.equal(text, `Pushed a follow-up (abcdef1) for @ann's comments and the failing \`test\` check.\n\n${KRU_MARKER}`);
  assert.equal(followUpComment([], null), `Pushed a follow-up.\n\n${KRU_MARKER}`);
});

test("mergeEtags keeps what a sync didn't touch", () => {
  type Etags = { reviews?: string | null; checks?: string | null; comments?: string | null };
  assert.deepEqual(mergeEtags<Etags>({ reviews: "a", checks: "c" }, { reviews: "b", comments: null }), { reviews: "b", checks: "c", comments: null });
  assert.deepEqual(mergeEtags<Etags>(null, { reviews: "a" }), { reviews: "a" });
});
