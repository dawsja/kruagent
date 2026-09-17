import assert from "node:assert/strict";
import { test } from "node:test";
import { agentNotesSection, taskPrompt, type AgentInput } from "../lib/hq/agent-shared.ts";
import { botEffort } from "../lib/hq/bots/chat-logic.ts";
import {
  cancelBotRetry,
  claimDropCard,
  getBotJob,
  getRepoInstructions,
  insertCard,
  listBotJobs,
  listBotJobsForCard,
  listRepoInstructions,
  retryBotJob,
  setRepoInstructions,
  transitionBotJob,
} from "../lib/hq/data.ts";
import type { Card } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string): Card {
  return { id, title: id, body: "", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, createdAt: at, updatedAt: at };
}

test("a failed job retries once as a new job with one more attempt", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("c1"));
    claimDropCard("c1", "me", "j1");
    assert.equal(transitionBotJob("j1", ["build"], "failed", { error: "box dropped", retryAt: "2026-09-17T10:02:00Z" }), true);

    assert.deepEqual(listBotJobs({ retryDue: "2026-09-17T10:01:00Z" }), [], "not due yet");
    assert.deepEqual(listBotJobs({ retryDue: "2026-09-17T10:03:00Z" }).map((j) => j.id), ["j1"]);

    const retry = retryBotJob("j1", "j2", "me");
    assert.equal(retry?.stage, "build");
    assert.equal(retry?.attempts, 1);
    assert.equal(getBotJob("j2")?.attempts, 1);
    assert.equal(getBotJob("j2")?.runId, null);
    assert.equal(getBotJob("j1")?.retryAt, null, "the old job's retry is used up");
    assert.equal(retryBotJob("j1", "j3", "me"), null, "never twice");
    assert.deepEqual(listBotJobsForCard("c1").map((j) => j.id), ["j1", "j2"]);

    // A second failure of the retry, and a card that already has a job.
    transitionBotJob("j2", ["build"], "failed", { error: "again", retryAt: "2026-09-17T10:05:00Z" });
    insertCard(card("c2"));
    claimDropCard("c2", "me", "k1");
    transitionBotJob("k1", ["build"], "failed", { retryAt: "2026-09-17T10:05:00Z" });
    claimDropCard("c2", "me", "k2");
    assert.equal(retryBotJob("k1", "k3", "me"), null, "the card has an active job");

    cancelBotRetry("j2");
    assert.equal(getBotJob("j2")?.retryAt, null);
    assert.equal(retryBotJob("j2", "j4", "me"), null);

    transitionBotJob("k2", ["build"], "review", { reviewNotes: "- a.ts: off by one" });
    assert.equal(getBotJob("k2")?.reviewNotes, "- a.ts: off by one");
  } finally {
    temp.cleanup();
  }
});

test("repo instructions round-trip, clear when empty, and are capped", () => {
  const temp = useTempDataDir();
  try {
    assert.equal(getRepoInstructions("o/r"), null);
    assert.equal(getRepoInstructions(null), null);
    setRepoInstructions("o/r", "  Use pnpm.  ");
    setRepoInstructions("o/a", "Never touch migrations/");
    assert.equal(getRepoInstructions("o/r"), "Use pnpm.");
    assert.deepEqual(listRepoInstructions().map((r) => r.repo), ["o/a", "o/r"]);
    setRepoInstructions("o/r", "   ");
    assert.equal(getRepoInstructions("o/r"), null);
    setRepoInstructions("o/r", "x".repeat(9000));
    assert.equal(getRepoInstructions("o/r")?.length, 8000);
  } finally {
    temp.cleanup();
  }
});

test("the builder's prompt carries repo instructions and the repo's agent notes", () => {
  const input = { card: { ...card("c1"), title: "Add dark mode" }, repoInstructions: "Use pnpm" } as unknown as AgentInput;
  const prompt = taskPrompt(input, [agentNotesSection({ name: "AGENTS.md", content: "Run bun test before finishing." })]);
  assert.match(prompt, /Task: Add dark mode\n\nStanding instructions for this repo, from the person:\nUse pnpm/);
  assert.match(prompt, /The repo's AGENTS\.md, notes for agents working in it:\nRun bun test before finishing\./);
  assert.equal(agentNotesSection(null), "");
  assert.equal(agentNotesSection({ name: "CLAUDE.md", content: "  " }), "");
  assert.match(agentNotesSection({ name: "CLAUDE.md", content: "y".repeat(9000) }), /\[… truncated …\]$/);
  assert.doesNotMatch(taskPrompt({ ...input, repoInstructions: null }, []), /Standing/);
});

test("botEffort accepts only the CLI's levels", () => {
  assert.equal(botEffort("High"), "high");
  assert.equal(botEffort(" low "), "low");
  assert.equal(botEffort("max"), null);
  assert.equal(botEffort(undefined), null);
});
