import assert from "node:assert/strict";
import { test } from "node:test";
import { prBody } from "../lib/hq/approve-logic.ts";
import { KRU_MARKER } from "../lib/hq/github-feedback-logic.ts";
import {
  MAX_IMPORTS_PER_REPO,
  MAX_REPOS,
  cardFromIssue,
  cleanLabel,
  closesLine,
  hasLabel,
  issueOpenedComment,
  issueProblem,
  issueRepo,
  issuesToImport,
  nextSince,
  reposToPoll,
  type RawIssue,
} from "../lib/hq/issue-sync-logic.ts";

function issue(number: number, patch: Partial<RawIssue> = {}): RawIssue {
  return { id: 1000 + number, number, title: `Issue ${number}`, body: "", state: "open", labels: [{ name: "kru" }], html_url: `https://github.com/o/r/issues/${number}`, updated_at: "2026-09-17T10:00:00Z", ...patch };
}

test("reposToPoll puts setup's repo first and lists each repo once", () => {
  assert.deepEqual(reposToPoll([{ repo: "o/b" }, { repo: "o/a" }, { repo: "o/b" }, { repo: null }, { repo: "not a repo" }], "o/a"), ["o/a", "o/b"]);
  assert.deepEqual(reposToPoll([], null), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ repo: `o/r${i}` }));
  assert.equal(reposToPoll(many, null).length, MAX_REPOS);
});

test("issuesToImport keeps open, labelled, new issues, oldest first, and never pull requests", () => {
  const raw = [
    issue(7),
    issue(3, { labels: ["KRU"] }),
    issue(4, { pull_request: { url: "x" } }),
    issue(5, { state: "closed" }),
    issue(6, { labels: [{ name: "bug" }] }),
    issue(2),
  ];
  assert.deepEqual(issuesToImport(raw, new Set([1002]), "kru").map((i) => i.number), [3, 7]);
  const backlog = Array.from({ length: 15 }, (_, i) => issue(i + 1));
  assert.equal(issuesToImport(backlog, new Set(), "kru").length, MAX_IMPORTS_PER_REPO);
  assert.equal(hasLabel(issue(1, { labels: [] }), "kru"), false);
  assert.equal(issueProblem(issue(4, { pull_request: {} })), "#4 is a pull request, not an issue");
  assert.equal(issueProblem(issue(5, { state: "closed" })), "Issue #5 is closed");
  assert.equal(issueProblem(issue(1)), null);
});

test("cardFromIssue carries the title, the text and a link back, within limits", () => {
  assert.deepEqual(cardFromIssue(issue(9, { title: "  Dark   mode ", body: "Please\r\nadd it" }), "o/r"), {
    title: "Dark mode",
    body: "Please\nadd it\n\nFrom https://github.com/o/r/issues/9",
    repo: "o/r",
  });
  assert.equal(cardFromIssue(issue(9, { title: "", body: null, html_url: undefined }), "o/r").body, "From o/r#9");
  assert.equal(cardFromIssue(issue(9, { title: "" }), "o/r").title, "Issue #9");
  const long = cardFromIssue(issue(9, { title: "t".repeat(300), body: "b".repeat(9000) }), "o/r");
  assert.equal(long.title.length, 200);
  assert.ok(long.body.length <= 4000);
  assert.match(long.body, /…\n\nFrom https:\/\/github\.com\/o\/r\/issues\/9$/);
});

test("nextSince moves to the newest update and never backwards", () => {
  assert.equal(nextSince([issue(1, { updated_at: "2026-09-17T11:00:00Z" }), issue(2, { updated_at: "2026-09-17T12:00:00Z" })], null), "2026-09-17T12:00:00Z");
  assert.equal(nextSince([issue(1, { updated_at: "2026-09-17T09:00:00Z" })], "2026-09-17T10:00:00Z"), "2026-09-17T10:00:00Z");
  assert.equal(nextSince([], "2026-09-17T10:00:00Z"), "2026-09-17T10:00:00Z");
});

test("closesLine and the PR body close only an issue in the card's own repo", () => {
  const card = { repo: "o/r", issueNumber: 12, issueUrl: "https://github.com/o/r/issues/12" };
  assert.equal(closesLine(card), "Closes #12");
  assert.equal(closesLine({ ...card, repo: "O/R" }), "Closes #12");
  assert.equal(closesLine({ ...card, issueUrl: "https://github.com/other/repo/issues/12" }), null);
  assert.equal(closesLine({ ...card, issueNumber: null }), null);
  assert.equal(prBody(card), "Proposed by Kru. Human-approved write.\n\nCloses #12");
  assert.equal(prBody({ repo: "o/r", issueNumber: null, issueUrl: null }), "Proposed by Kru. Human-approved write.");
  assert.equal(issueRepo("https://github.com/o/r/issues/12"), "o/r");
  assert.equal(issueRepo("https://github.com/o/r/pull/12"), null);
});

test("the issue comment carries the marker, and labels are checked", () => {
  assert.equal(issueOpenedComment("https://github.com/o/r/pull/3"), `Kru opened a pull request for this: https://github.com/o/r/pull/3\n\n${KRU_MARKER}`);
  assert.equal(cleanLabel("  good first issue "), "good first issue");
  assert.equal(cleanLabel("a,b"), null);
  assert.equal(cleanLabel(""), null);
  assert.equal(cleanLabel("x".repeat(51)), null);
  assert.equal(cleanLabel(3), null);
});
