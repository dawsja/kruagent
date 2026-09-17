import assert from "node:assert/strict";
import { test } from "node:test";
import { editCard, openPullFor, removeCard, steerCard, stopCard, type CardOpsDeps } from "../lib/hq/bots/card-ops.ts";
import {
  claimDropCard,
  createRun,
  getActiveBotJobForCard,
  getBotJob,
  getCard,
  getRun,
  insertCard,
  listRuns,
  listSteeringNotes,
  transitionBotJob,
  transitionRun,
} from "../lib/hq/data.ts";
import { newRun, retryBase } from "../lib/hq/runs-logic.ts";
import type { Card } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string, patch: Partial<Card> = {}): Card {
  return { id, title: `Card ${id}`, body: "old details", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, createdAt: at, updatedAt: at, ...patch };
}

/** In Drop, untouched. */
function inDrop(id: string) {
  insertCard(card(id));
}

/** The crew has it: a job at `stage` and the run it is on. */
function running(id: string, stage: "build" | "test" | "review" | "scribe" = "build") {
  insertCard(card(id));
  claimDropCard(id, "me", `job-${id}`);
  const run = newRun(`run-${id}`, getCard(id)!, undefined, { bot: "momo" }, at);
  createRun(run, { column: "run", status: "running", runId: run.id });
  transitionBotJob(`job-${id}`, ["build"], "build", { runId: run.id });
  if (stage !== "build") {
    transitionRun(run.id, ["running"], "needs_approval", {}, { status: "needs_approval" });
    transitionBotJob(`job-${id}`, ["build"], stage);
  }
}

/** Waiting in Review for the person, the crew done. */
function inReview(id: string) {
  running(id);
  transitionRun(`run-${id}`, ["running"], "needs_approval", { summary: "done" }, { status: "needs_approval", column: "review" });
  transitionBotJob(`job-${id}`, ["build"], "done");
}

/** Approved, with its pull request open on GitHub. */
function withOpenPull(id: string) {
  inReview(id);
  transitionRun(`run-${id}`, ["needs_approval"], "approved", { prUrl: `https://github.com/o/r/pull/7`, prNumber: 7, prState: "open", headBranch: "kru/x" }, { status: "approved" });
}

function deps() {
  const said: { text: string; cardId: string | null }[] = [];
  const released: string[] = [];
  let n = 0;
  const ops: CardOpsDeps = {
    newId: () => `id${(n += 1)}`,
    say: (text, cardId) => {
      said.push({ text, cardId });
    },
    releaseWorkspace: async (runId) => {
      released.push(runId);
    },
  };
  return { ops, said, released };
}

test("steer_card delivers to whoever has the card, and says plainly when nobody does", () => {
  const temp = useTempDataDir();
  try {
    const { ops } = deps();
    inDrop("drop");
    running("run");
    running("kiko", "test");
    inReview("rev");
    withOpenPull("pr");

    const delivered = steerCard({ cardId: "run", note: "also add a test for logout", author: "pip", messageId: "m1" }, ops);
    assert.match(delivered, /^Steering delivered to "Card run": Momo is building/);
    assert.match(delivered, /Nothing has changed yet/);
    const [note] = listSteeringNotes("run");
    assert.equal(note.author, "pip");
    assert.equal(note.bot, "momo");
    assert.equal(note.body, "also add a test for logout");
    assert.equal(note.messageId, "m1");
    assert.equal(note.deliveredAt, null, "waiting for Momo's next safe point");

    assert.match(steerCard({ cardId: "kiko", note: "skip e2e", author: "pip" }, ops), /Kiko is running checks/);
    assert.equal(listSteeringNotes("kiko")[0].bot, "kiko");

    assert.match(steerCard({ cardId: "drop", note: "x", author: "pip" }, ops), /^Steering NOT delivered: nothing is running on "Card drop" \(it is waiting in Drop\).*edit_card/);
    assert.match(steerCard({ cardId: "rev", note: "x", author: "pip" }, ops), /^Steering NOT delivered.*waiting in Review.*revise_run/);
    assert.match(steerCard({ cardId: "pr", note: "x", author: "pip" }, ops), /^Steering NOT delivered.*follow_up_pr/);
    assert.match(steerCard({ cardId: "nope", note: "x", author: "pip" }, ops), /^No such card/);
    assert.deepEqual(listSteeringNotes("drop"), []);
    assert.deepEqual(listSteeringNotes("rev"), []);
  } finally {
    temp.cleanup();
  }
});

test("stop_card halts a running card and leaves it restartable; elsewhere it stops nothing and says so", () => {
  const temp = useTempDataDir();
  try {
    const { ops, said } = deps();
    inDrop("drop");
    running("run");
    running("lulu", "review");
    inReview("rev");

    const result = stopCard({ cardId: "run", reason: "the person wants to rethink it", by: "pip" }, ops);
    assert.match(result, /^Stopped "Card run": Momo was building, and that work has been halted/);
    assert.match(result, /not deleted/);
    assert.match(result, /run_card restarts it/);
    assert.equal(getRun("run-run")?.status, "cancelled");
    assert.equal(getRun("run-run")?.stoppedNote, "Pip stopped it: the person wants to rethink it");
    assert.equal(getBotJob("job-run")?.stage, "cancelled");
    assert.deepEqual([getCard("run")?.column, getCard("run")?.status], ["drop", "open"]);
    assert.equal(getCard("run")?.stopped, "Pip stopped it: the person wants to rethink it");
    assert.equal(said.length, 1);
    assert.match(said[0].text, /^Stopped "Card run" while Momo was building/);
    assert.equal(said[0].cardId, "run");
    // Twice is once: the second call finds nothing running.
    assert.match(stopCard({ cardId: "run", by: "pip" }, ops), /^NOT stopped: nothing is running on "Card run" \(it is stopped, waiting in Drop to be run again\)/);
    // Restartable: run_card's claim works, and the next run continues the stopped one.
    assert.ok(retryBase(getRun("run-run")));
    assert.ok(claimDropCard("run", null, "again"));

    // While Lulu reviews, the change exists; stopping keeps it for the restart.
    assert.match(stopCard({ cardId: "lulu", by: "pip" }, ops), /^Stopped "Card lulu": Lulu was reviewing/);
    assert.equal(getRun("run-lulu")?.status, "cancelled");
    assert.equal(getRun("run-lulu")?.stoppedNote, "Pip stopped it when asked to");
    assert.equal(getActiveBotJobForCard("lulu"), null);

    assert.match(stopCard({ cardId: "drop", by: "pip" }, ops), /^NOT stopped: nothing is running on "Card drop" \(it is waiting in Drop\)/);
    assert.match(stopCard({ cardId: "rev", by: "pip" }, ops), /^NOT stopped: nothing is running on "Card rev" \(it is waiting in Review for the person\)/);
    assert.equal(getRun("run-rev")?.status, "needs_approval", "a card in Review is the person's; stop leaves it alone");
    assert.equal(getCard("rev")?.column, "review");
    assert.match(stopCard({ cardId: "nope", by: "pip" }, ops), /^No such card/);
    assert.equal(said.length, 2, "the room only hears about real stops");
  } finally {
    temp.cleanup();
  }
});

test("edit_card changes a card in Drop, reaches the working bot on a running one, and says what a card in Review keeps", () => {
  const temp = useTempDataDir();
  try {
    const { ops, said } = deps();
    inDrop("drop");
    running("run");
    inReview("rev");

    // In Drop everything can move.
    const dropped = editCard({ cardId: "drop", title: " Add dark mode ", body: "With a toggle", repo: "o/other", model: "ep:big", by: "pip" }, ops);
    assert.match(dropped, /^Edited "Add dark mode" \(drop\): title is now "Add dark mode", details replaced, repo is now o\/other, model is now ep:big\./);
    assert.match(dropped, /It is in Drop/);
    assert.deepEqual(
      [getCard("drop")?.title, getCard("drop")?.body, getCard("drop")?.repo, getCard("drop")?.model],
      ["Add dark mode", "With a toggle", "o/other", "ep:big"],
    );
    assert.deepEqual(listSteeringNotes("drop"), [], "nobody to tell");

    // Running: the text changes and the edit reaches Momo as a steering note.
    const live = editCard({ cardId: "run", title: "Add dark mode, header and footer", body: "Footer too", model: "ep:big", repo: "o/other", by: "pip", messageId: "m9" }, ops);
    assert.match(live, /^Edited "Add dark mode, header and footer"/);
    assert.match(live, /delivered as a steering note/);
    assert.match(live, /The run has not changed yet/);
    assert.match(live, /NOT changed: the repo can't change while the card is being worked on.*; the model can't change while the card is being worked on/);
    assert.equal(getCard("run")?.title, "Add dark mode, header and footer");
    assert.equal(getCard("run")?.model, "ep:m");
    assert.equal(getCard("run")?.repo, "o/r");
    const [note] = listSteeringNotes("run");
    assert.equal(note.bot, "momo");
    assert.equal(note.author, "pip");
    assert.equal(note.messageId, "m9");
    assert.match(note.body, /Task: Add dark mode, header and footer\nDetails:\nFooter too/);
    assert.match(said.at(-1)!.text, /Edited "Add dark mode, header and footer" while Momo is building/);

    // Only a refused field: nothing edited, nothing delivered.
    assert.match(editCard({ cardId: "run", model: "ep:big", by: "pip" }, ops), /^Nothing was edited on .* NOT changed: the model can't change/);
    assert.equal(listSteeringNotes("run").length, 1);

    // Review: the text changes, and the result waiting there doesn't.
    const reviewed = editCard({ cardId: "rev", body: "New details", repo: "o/other", by: "pip" }, ops);
    assert.match(reviewed, /^Edited "Card rev"/);
    assert.match(reviewed, /built from the old text and is NOT changed; use revise_run/);
    assert.match(reviewed, /NOT changed: the repo can't change on a card that is waiting in Review/);
    assert.equal(getCard("rev")?.body, "New details");
    assert.equal(getCard("rev")?.repo, "o/r");
    assert.equal(getRun("run-rev")?.status, "needs_approval");

    assert.match(editCard({ cardId: "drop", title: "Add dark mode", by: "pip" }, ops), /^Nothing was edited/);
    assert.match(editCard({ cardId: "drop", title: "  ", by: "pip" }, ops), /the title can't be empty/);
    assert.match(editCard({ cardId: "drop", repo: "not a repo", by: "pip" }, ops), /isn't a repo as owner\/name/);
    assert.match(editCard({ cardId: "nope", title: "x", by: "pip" }, ops), /^No such card/);
  } finally {
    temp.cleanup();
  }
});

test("delete_card removes a card from Drop, from Review, and in flight after stopping it and cleaning up", async () => {
  const temp = useTempDataDir();
  try {
    const { ops, said, released } = deps();
    inDrop("drop");
    running("run");
    inReview("rev");

    const dropped = await removeCard({ cardId: "drop", askedByPerson: true }, ops);
    assert.match(dropped, /^Deleted "Card drop" \(drop\) with its runs and history\. Nothing on GitHub was touched\.$/);
    assert.equal(getCard("drop"), null);
    assert.deepEqual(released, []);

    const live = await removeCard({ cardId: "run", askedByPerson: true }, ops);
    assert.match(live, /^Deleted "Card run"/);
    assert.match(live, /It was being worked on \(Momo was building\): that was stopped first\./);
    assert.match(live, /Its workspace in the box was cleaned up\./);
    assert.match(live, /Nothing on GitHub was touched/);
    assert.equal(getCard("run"), null);
    assert.equal(getRun("run-run"), null, "a runner that looks now finds no run, and unwinds as cancelled");
    assert.equal(getBotJob("job-run"), null);
    assert.deepEqual(released, ["run-run"]);
    assert.match(said.at(-1)!.text, /^Deleted "Card run"\. It was being worked on/);

    const reviewed = await removeCard({ cardId: "rev", askedByPerson: false }, ops);
    assert.match(reviewed, /^Deleted "Card rev"/);
    assert.doesNotMatch(reviewed, /stopped first/);
    assert.deepEqual(released, ["run-run", "run-rev"], "the workspace kept for review goes too");
    assert.equal(listRuns().length, 0);

    assert.match(await removeCard({ cardId: "rev", askedByPerson: true }, ops), /^No such card\. Nothing was deleted\./);
    assert.equal(said.length, 3);
  } finally {
    temp.cleanup();
  }
});

test("delete_card won't orphan an open pull request without the person saying so", async () => {
  const temp = useTempDataDir();
  try {
    const { ops, said, released } = deps();
    withOpenPull("pr");
    assert.equal(openPullFor("pr")?.prNumber, 7);

    const refused = await removeCard({ cardId: "pr", askedByPerson: true }, ops);
    assert.match(refused, /^NOT deleted: "Card pr" has an open pull request #7 \(https:\/\/github\.com\/o\/r\/pull\/7\)\./);
    assert.match(refused, /orphan/);
    assert.match(refused, /confirmOpenPullRequest: true/);
    assert.ok(getCard("pr"), "still there");

    // A bot can't confirm on the person's behalf in a bot-to-bot thread.
    const sneaky = await removeCard({ cardId: "pr", confirmOpenPullRequest: true, askedByPerson: false }, ops);
    assert.match(sneaky, /^NOT deleted/);
    assert.match(sneaky, /Only the person can confirm/);
    assert.ok(getCard("pr"));
    assert.deepEqual(said, []);
    assert.deepEqual(released, []);

    // A follow-up in flight on that pull request is guarded the same way.
    claimDropCard("pr", "me", "job-follow");
    const followUp = newRun("run-follow", getCard("pr")!, { of: getRun("run-pr")!, note: "rename the flag" }, { bot: "momo" }, at);
    createRun(followUp, { column: "run", status: "running", runId: followUp.id });
    assert.match(await removeCard({ cardId: "pr", askedByPerson: true }, ops), /^NOT deleted/);
    assert.equal(getRun("run-follow")?.status, "running", "refusing stops nothing");

    const confirmed = await removeCard({ cardId: "pr", confirmOpenPullRequest: true, askedByPerson: true }, ops);
    assert.match(confirmed, /^Deleted "Card pr"/);
    assert.match(confirmed, /pull request #7 \(https:\/\/github\.com\/o\/r\/pull\/7\) is still open on GitHub and is no longer followed/);
    assert.doesNotMatch(confirmed, /Nothing on GitHub was touched/);
    assert.equal(getCard("pr"), null);
    assert.deepEqual(released.sort(), ["run-follow", "run-pr"]);

    // Merged or closed: nothing left to orphan.
    withOpenPull("merged");
    transitionRun("run-merged", ["approved"], "merged", { prState: "merged" }, { status: "merged" });
    assert.equal(openPullFor("merged"), null);
    assert.match(await removeCard({ cardId: "merged", askedByPerson: true }, ops), /^Deleted "Card merged"/);

    // Mid-push, neither delete nor stop cuts in.
    inReview("pushing");
    transitionRun("run-pushing", ["needs_approval"], "applying");
    assert.match(await removeCard({ cardId: "pushing", askedByPerson: true }, ops), /^NOT deleted: "Card pushing" is pushing to GitHub right now/);
    assert.match(stopCard({ cardId: "pushing", by: "pip" }, ops), /^NOT stopped: "Card pushing" is pushing to GitHub right now/);
    assert.ok(getCard("pushing"));
  } finally {
    temp.cleanup();
  }
});
