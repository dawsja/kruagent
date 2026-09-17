import { after } from "next/server";
import { postEvent } from "./bots/room";
import { appendRunLog, createBotJobForRun, markPrFeedbackHandled } from "./data";
import { feedbackNote } from "./github-feedback-logic";
import { randomString } from "./oauth";
import { beginRun, claimForRevision, finishRun } from "./runs";
import type { BotId, Card, FollowUpReason, PrFeedback, Run } from "./types";

/*
 * A follow-up: a run that continues an approved run on its pull request's
 * own branch, because a review, a failing check or a person asked for more.
 * The branch already holds the approved changes, so the run clones it and
 * proposes only what it adds; approving pushes that as one more commit.
 */

function prLabel(run: Pick<Run, "prNumber">) {
  return run.prNumber ? `PR #${run.prNumber}` : "the pull request";
}

function firstLine(text: string) {
  const line = text.split("\n").find((l) => l.trim() && !/^Feedback on/.test(l)) ?? text;
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

/**
 * Starts a follow-up on `parent`, the run that owns the pull request. With
 * `bot`, the crew drives it (a job at build for the dispatcher); without,
 * the caller runs it. The feedback it takes is marked with the new run.
 */
export function beginFollowUp(
  card: Card,
  parent: Run,
  items: readonly PrFeedback[],
  reason: FollowUpReason,
  options: { bot?: BotId | null; note?: string } = {},
): Run {
  if (!parent.prUrl || !parent.headBranch) throw new Error("That run has no pull request to follow up on");
  const note = options.note ?? feedbackNote(items, parent.prNumber ?? null);
  const run = beginRun(
    card,
    { of: parent, note },
    {
      bot: options.bot ?? null,
      followUp: {
        prUrl: parent.prUrl,
        prNumber: parent.prNumber ?? null,
        headBranch: parent.headBranch,
        baseBranch: parent.baseBranch ?? null,
        reason,
      },
    },
  );
  if (options.bot) createBotJobForRun(randomString(9), card.id, run.id);
  markPrFeedbackHandled(
    items.map((item) => item.id),
    run.id,
  );
  appendRunLog(run.id, `Follow-up on ${prLabel(run)}, branch ${parent.headBranch}`);
  postEvent(
    "pip",
    reason === "manual"
      ? `Starting a follow-up on ${prLabel(run)} for "${card.title}": ${firstLine(note)}`
      : `Starting a follow-up on ${prLabel(run)} for "${card.title}" (${reason === "check" ? "CI failed" : "review feedback"}): ${firstLine(note)}`,
    card.id,
  );
  return run;
}

/**
 * New feedback for a follow-up already waiting in Review: the waiting run is
 * closed and a new one continues from its changes with the new note, the
 * same as "ask for changes" would, so one push covers everything. Returns
 * null when the waiting run was approved or discarded in the meantime.
 */
export function foldIntoWaiting(card: Card, waiting: Run, items: readonly PrFeedback[]): Run | null {
  const note = feedbackNote(items, waiting.prNumber ?? null);
  if (!claimForRevision(waiting, note)) return null;
  const run = beginRun(card, { of: waiting, note }, { bot: "momo" });
  createBotJobForRun(randomString(9), card.id, run.id);
  markPrFeedbackHandled(
    items.map((item) => item.id),
    run.id,
  );
  postEvent("pip", `More feedback on ${prLabel(run)} for "${card.title}"; folding it into the follow-up: ${firstLine(note)}`, card.id);
  return run;
}

/**
 * A follow-up the person asked for from the card. With the crew on, the
 * crew drives it; otherwise the agent runs after the response has gone
 * out, like `startRun`. Pending feedback on the card comes along.
 */
export function followUpByHand(card: Card, parent: Run, note: string, options: { crew: boolean; pending: readonly PrFeedback[] }): Run {
  const run = beginFollowUp(card, parent, options.pending, "manual", { bot: options.crew ? "momo" : null, note });
  if (!options.crew) after(() => finishRun(card.id, run.id));
  return run;
}
