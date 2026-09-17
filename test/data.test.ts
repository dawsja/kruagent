import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendRunLog,
  createRun,
  deleteCard,
  getCard,
  getRun,
  insertCard,
  listConnections,
  listRuns,
  transitionRun,
  upsertConnection,
} from "../lib/hq/data.ts";
import type { Card, Connection, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

function seed() {
  const at = new Date().toISOString();
  const card: Card = { id: "card1", title: "Task", body: "", column: "drop", repo: "o/r", model: "ep_x:m", status: "open", runId: null, createdAt: at, updatedAt: at };
  insertCard(card);
  const run: Run = { id: "run1", cardId: "card1", status: "running", log: ["Agent started"], proposedWrites: [], prUrl: null, error: null, createdAt: at, updatedAt: at };
  createRun(run, { column: "run", status: "running", runId: "run1" });
}

test("transitionRun only moves from an expected status", () => {
  const temp = useTempDataDir();
  try {
    seed();
    assert.equal(getCard("card1")?.status, "running");
    assert.equal(transitionRun("run1", ["needs_approval"], "approved"), false);
    assert.equal(getRun("run1")?.status, "running");

    const writes = [{ path: "a.txt", content: "hi", message: "add a" }];
    assert.equal(
      transitionRun("run1", ["running"], "needs_approval", { proposedWrites: writes, baseBranch: "main" }, { status: "needs_approval", column: "review" }),
      true,
    );
    const run = getRun("run1");
    assert.equal(run?.status, "needs_approval");
    assert.deepEqual(run?.proposedWrites, writes);
    assert.equal(run?.baseBranch, "main");
    assert.equal(getCard("card1")?.column, "review");

    assert.equal(transitionRun("run1", ["running"], "needs_approval"), false, "second transition must fail");
  } finally {
    temp.cleanup();
  }
});

test("logs keep order and stop after cancellation", () => {
  const temp = useTempDataDir();
  try {
    seed();
    assert.equal(appendRunLog("run1", "read a.txt"), true);
    assert.equal(appendRunLog("run1", "propose a.txt"), true);
    assert.deepEqual(getRun("run1")?.log, ["Agent started", "read a.txt", "propose a.txt"]);
    assert.equal(transitionRun("run1", ["running"], "cancelled"), true);
    assert.equal(appendRunLog("run1", "late line"), false);
    assert.equal(getRun("run1")?.log.length, 3);
  } finally {
    temp.cleanup();
  }
});

test("deleting a card removes its runs and logs", () => {
  const temp = useTempDataDir();
  try {
    seed();
    appendRunLog("run1", "line");
    assert.equal(deleteCard("card1"), true);
    assert.equal(getRun("run1"), null);
    assert.equal(listRuns().length, 0);
    assert.equal(deleteCard("card1"), false);
  } finally {
    temp.cleanup();
  }
});

test("approval claims a waiting run once and can hand it back on failure", () => {
  const temp = useTempDataDir();
  try {
    seed();
    const writes = [{ path: "a.txt", content: "hi", message: "add a" }];
    transitionRun("run1", ["running"], "needs_approval", { proposedWrites: writes, baseBranch: "main" }, { status: "needs_approval", column: "review" });

    assert.equal(transitionRun("run1", ["needs_approval"], "applying", { headBranch: "kru/one", error: null }), true);
    assert.equal(transitionRun("run1", ["needs_approval"], "applying", { headBranch: "kru/two" }), false, "a second approve can't claim it");
    assert.equal(transitionRun("run1", ["running", "needs_approval"], "cancelled"), false, "an applying run can't be discarded");

    assert.equal(transitionRun("run1", ["applying"], "needs_approval", { error: "GitHub said no" }), true);
    let run = getRun("run1");
    assert.equal(run?.status, "needs_approval");
    assert.equal(run?.error, "GitHub said no");
    assert.equal(run?.headBranch, "kru/one");
    assert.deepEqual(run?.proposedWrites, writes);

    assert.equal(transitionRun("run1", ["needs_approval"], "applying", { headBranch: "kru/three", error: null }), true);
    assert.equal(
      transitionRun("run1", ["applying"], "approved", { prUrl: "https://github.com/o/r/pull/7" }, { status: "approved", column: "review" }),
      true,
    );
    run = getRun("run1");
    assert.equal(run?.status, "approved");
    assert.equal(run?.error, null);
    assert.equal(run?.headBranch, "kru/three");
    assert.equal(getCard("card1")?.status, "approved");
  } finally {
    temp.cleanup();
  }
});

test("a waiting run can be discarded and its card returns to Drop", () => {
  const temp = useTempDataDir();
  try {
    seed();
    transitionRun("run1", ["running"], "needs_approval", { proposedWrites: [{ path: "a.txt", content: "", message: "m" }] }, { status: "needs_approval", column: "review" });
    assert.equal(appendRunLog("run1", "Proposed changes discarded"), true);
    assert.equal(transitionRun("run1", ["needs_approval"], "cancelled", {}, { status: "open", column: "drop" }), true);
    assert.equal(getRun("run1")?.status, "cancelled");
    assert.equal(getCard("card1")?.column, "drop");
    assert.equal(getCard("card1")?.status, "open");
  } finally {
    temp.cleanup();
  }
});

test("a subscription sign-in and an API-key endpoint of the same format coexist", () => {
  const temp = useTempDataDir();
  try {
    const base: Omit<Connection, "id" | "meta" | "label"> = { provider: "openai", accessToken: "k", refreshToken: null, expiresAt: null };
    upsertConnection({ ...base, id: "ep_x", label: "api.openai.com", meta: { name: "OpenAI", baseUrl: "https://api.openai.com/v1" } });
    upsertConnection({ ...base, id: "sub_openai", label: "ChatGPT", accessToken: "eyJ.tok.en", refreshToken: "rt", expiresAt: 1, meta: { auth: "oauth", name: "ChatGPT" } });
    assert.deepEqual(listConnections().map((item) => item.id), ["ep_x", "sub_openai"]);
    // Signing in again replaces the subscription only.
    upsertConnection({ ...base, id: "sub_openai", label: "ChatGPT 2", accessToken: "tok2", refreshToken: "rt2", expiresAt: 2, meta: { auth: "oauth", name: "ChatGPT" } });
    assert.deepEqual(listConnections().map((item) => [item.id, item.label]), [["ep_x", "api.openai.com"], ["sub_openai", "ChatGPT 2"]]);
  } finally {
    temp.cleanup();
  }
});

test("a run carries what GitHub last said about its pull request", () => {
  const temp = useTempDataDir();
  try {
    seed();
    transitionRun("run1", ["running"], "approved", { prUrl: "https://github.com/o/r/pull/7" });
    assert.equal(getRun("run1")?.prState, null, "nothing has been asked yet");
    assert.equal(getRun("run1")?.prEtag, null);

    // Still open: only the ETag is kept, so the next check can be a 304.
    transitionRun("run1", ["approved"], null, { prEtag: 'W/"abc"' });
    let run = getRun("run1");
    assert.equal(run?.status, "approved", "an ETag alone must not move the run");
    assert.equal(run?.prEtag, 'W/"abc"');

    transitionRun("run1", ["approved"], null, { prState: "closed", prEtag: 'W/"def"' });
    run = getRun("run1");
    assert.equal(run?.prState, "closed");
    assert.equal(run?.prEtag, 'W/"def"');
    assert.equal(listRuns().find((item) => item.id === "run1")?.prState, "closed");
  } finally {
    temp.cleanup();
  }
});
