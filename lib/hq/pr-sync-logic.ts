import { isActionable } from "./github-feedback-logic.ts";
import type { BotJob, Card, PrFeedback, Run } from "./types.ts";

/*
 * Which pull requests to ask GitHub about, when, and what to do with the
 * feedback that came back. Nothing here talks to GitHub or the database, so
 * it is tested directly; `pr-sync.ts` does the asking.
 */

/** How long a merge, a review or a failing check can take to show up. */
export const PR_CHECK_INTERVAL_MS = 10_000;
export const FEEDBACK_INTERVAL_MS = 30_000;
/**
 * How long to wait after the newest item before starting a follow-up, so a
 * reviewer who leaves five comments in a row gets one run, not five.
 */
export const FEEDBACK_SETTLE_MS = 90_000;
/** Pull requests asked about in one sweep, oldest-checked first. */
export const MAX_PRS_PER_SWEEP = 10;

/**
 * How many follow-ups a failing check may start on one pull request. A
 * check that keeps failing is a loop; the person breaks it. Reviews are a
 * person's own words and never capped.
 */
export function maxCheckFollowUps() {
  const n = Number(process.env.KRU_PR_CHECK_FOLLOWUPS ?? 3);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function isOpenPull(run: Run) {
  return Boolean(run.prUrl) && run.status === "approved" && run.prState !== "merged" && run.prState !== "closed";
}

/**
 * The run that owns each open pull request: the newest approved run on it.
 * After a follow-up is pushed, that run is the newest and takes over; the
 * runs before it on the same pull request are mirrored when it ends.
 */
export function prOwners(runs: readonly Run[]): Run[] {
  const byPr = new Map<string, Run>();
  for (const run of runs) {
    if (!isOpenPull(run)) continue;
    const current = byPr.get(run.prUrl!);
    if (!current || run.createdAt > current.createdAt) byPr.set(run.prUrl!, run);
  }
  return [...byPr.values()];
}

/** The other approved runs on the same pull request, to mirror an ending. */
export function runsSharingPr(runs: readonly Run[], prUrl: string, except: string): Run[] {
  return runs.filter((run) => run.prUrl === prUrl && run.id !== except && run.status === "approved");
}

/**
 * Runs whose turn it is, and claims them: the caller marks `lastChecked`
 * before the first await, so a second sweep can't ask about the same pull
 * request while the first is still waiting on GitHub.
 */
export function due<T extends { id: string }>(
  runs: readonly T[],
  lastChecked: Map<string, number>,
  now: number,
  interval: number,
  limit = MAX_PRS_PER_SWEEP,
): T[] {
  return runs
    .filter((run) => now - (lastChecked.get(run.id) ?? 0) >= interval)
    .sort((a, b) => (lastChecked.get(a.id) ?? 0) - (lastChecked.get(b.id) ?? 0))
    .slice(0, limit);
}

/** Runs no longer worth asking about, so their claims can be forgotten. */
export function staleClaims(lastChecked: Map<string, number>, live: readonly { id: string }[]): string[] {
  const ids = new Set(live.map((run) => run.id));
  return [...lastChecked.keys()].filter((id) => !ids.has(id));
}

/** How many follow-ups a failing check already started on this pull request. */
export function checkFollowUpsSoFar(runs: readonly Run[], prUrl: string): number {
  return runs.filter((run) => run.prUrl === prUrl && run.followUpReason === "check").length;
}

export type FollowUpAction =
  | { kind: "start"; items: PrFeedback[] }
  | { kind: "revise"; runId: string; items: PrFeedback[] }
  | { kind: "wait"; why: string }
  | { kind: "skip"; why: string };

/**
 * What to do about the feedback waiting on a card. Start a follow-up on the
 * pull request's owner run; fold new feedback into a follow-up already
 * waiting for the person; wait while the crew has the card or comments are
 * still arriving; or skip when nothing asks for a change.
 */
export function followUpAction(input: {
  card: Card;
  /** The run that owns the pull request. */
  ownerRun: Run;
  /** The run the card is on right now, which may be the owner. */
  cardRun: Run | null;
  activeJob: BotJob | null;
  pending: readonly PrFeedback[];
  botsEnabled: boolean;
  now: number;
  checkFollowUps: number;
}): FollowUpAction {
  const items = input.pending.filter(isActionable);
  if (items.length === 0) return { kind: "skip", why: "nothing asks for a change" };

  const newest = Math.max(...items.map((item) => Date.parse(item.seenAt) || 0));
  if (input.now - newest < FEEDBACK_SETTLE_MS) return { kind: "wait", why: "feedback still arriving" };

  if (input.activeJob) return { kind: "wait", why: "the crew has the card" };
  if (input.card.status === "running" || input.cardRun?.status === "running" || input.cardRun?.status === "applying") {
    return { kind: "wait", why: "a run is in flight" };
  }
  if (!input.botsEnabled) return { kind: "skip", why: "the crew is off" };

  const onlyChecks = items.every((item) => item.kind === "check");
  if (onlyChecks && input.checkFollowUps >= maxCheckFollowUps()) {
    return { kind: "skip", why: "the check follow-up limit was reached" };
  }

  // A follow-up already waiting for the person: the new feedback joins it.
  const waiting = input.cardRun;
  if (
    waiting &&
    waiting.id !== input.ownerRun.id &&
    waiting.status === "needs_approval" &&
    waiting.prUrl === input.ownerRun.prUrl &&
    waiting.headBranch
  ) {
    return { kind: "revise", runId: waiting.id, items };
  }

  if (isOpenPull(input.ownerRun)) return { kind: "start", items };
  return { kind: "skip", why: "the pull request is no longer open" };
}
