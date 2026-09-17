import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardForIssue,
  deleteCard,
  getCard,
  getIssueLabel,
  getIssueSync,
  getIssuesEnabled,
  importedIssueIds,
  insertCardForIssue,
  listCards,
  setIssueLabel,
  setIssueSync,
  setIssuesEnabled,
  wasIssueImported,
} from "../lib/hq/data.ts";
import type { Card } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string): Card {
  return { id, title: id, body: "", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, issueNumber: 12, issueUrl: "https://github.com/o/r/issues/12", createdAt: at, updatedAt: at };
}

test("an issue becomes a card once, even after the card is deleted", () => {
  const temp = useTempDataDir();
  try {
    assert.equal(insertCardForIssue(card("c1"), { id: 555, repo: "o/r", number: 12 }), true);
    const stored = getCard("c1")!;
    assert.equal(stored.issueNumber, 12);
    assert.equal(stored.issueUrl, "https://github.com/o/r/issues/12");

    // The second import inserts nothing at all.
    assert.equal(insertCardForIssue(card("c2"), { id: 555, repo: "o/r", number: 12 }), false);
    assert.equal(getCard("c2"), null);
    assert.equal(listCards().length, 1);
    assert.equal(cardForIssue("o/r", 12)?.id, "c1");
    assert.deepEqual([...importedIssueIds("o/r")], [555]);
    assert.deepEqual([...importedIssueIds("o/other")], []);

    deleteCard("c1");
    assert.equal(cardForIssue("o/r", 12), null);
    assert.equal(wasIssueImported("o/r", 12), true);
    assert.equal(insertCardForIssue(card("c3"), { id: 555, repo: "o/r", number: 12 }), false);
    assert.equal(wasIssueImported("o/r", 13), false);
  } finally {
    temp.cleanup();
  }
});

test("issue settings default off with the kru label, and a new label resets the cursors", () => {
  const temp = useTempDataDir();
  try {
    assert.equal(getIssuesEnabled(), false);
    assert.equal(getIssueLabel(), "kru");
    setIssuesEnabled(true);
    assert.equal(getIssuesEnabled(), true);

    assert.equal(getIssueSync("o/r"), null);
    setIssueSync("o/r", { since: "2026-09-17T10:00:00Z", etag: "W/1" });
    assert.deepEqual({ ...getIssueSync("o/r"), checkedAt: "" }, { repo: "o/r", since: "2026-09-17T10:00:00Z", etag: "W/1", checkedAt: "" });
    setIssueSync("o/r", { since: "2026-09-17T11:00:00Z", etag: null });
    assert.equal(getIssueSync("o/r")?.since, "2026-09-17T11:00:00Z");
    assert.equal(getIssueSync("o/r")?.etag, null);

    setIssueLabel("bug");
    assert.equal(getIssueLabel(), "bug");
    assert.equal(getIssueSync("o/r"), null);
  } finally {
    temp.cleanup();
  }
});
