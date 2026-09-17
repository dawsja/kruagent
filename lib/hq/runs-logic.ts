import type { BotId, Card, FollowUpReason, Run } from "./types.ts";

/*
 * How a run is made and where its workspace starts from, apart from the
 * database and the box so it can be tested. A first run and its revisions
 * clone the repo's default branch; a follow-up on a pull request clones
 * the pull request's own branch, so the changes it proposes are exactly
 * what it adds to the pull request.
 */

export function cloneRefFor(run: Pick<Run, "headBranch" | "prUrl">, defaultBranch: string): string {
  return run.headBranch && run.prUrl ? run.headBranch : defaultBranch;
}

/**
 * Whether the previous run's changes have to be written into a fresh clone.
 * A revision of a run that was only reviewed: yes, they exist nowhere else.
 * A follow-up on an approved run: no, they are on the branch being cloned.
 */
export function replayNeeded(parent: Pick<Run, "status"> | null): boolean {
  if (!parent) return false;
  return parent.status !== "approved" && parent.status !== "merged";
}

/** What ties a follow-up run to the pull request it continues. */
export type FollowUp = {
  prUrl: string;
  prNumber: number | null;
  headBranch: string;
  baseBranch: string | null;
  reason: FollowUpReason;
};

/** A run on a pull request's branch passes that on to a revision of itself. */
export function inheritedFollowUp(of: Run | undefined): FollowUp | null {
  if (!of?.prUrl || !of.headBranch) return null;
  return {
    prUrl: of.prUrl,
    prNumber: of.prNumber ?? null,
    headBranch: of.headBranch,
    baseBranch: of.baseBranch ?? null,
    reason: of.followUpReason ?? "manual",
  };
}

/**
 * What a retry of the card's last run continues from. A follow-up that
 * failed is retried as the same follow-up, on the pull request's branch
 * with the same request; a fresh run instead would open a second pull
 * request. Anything else starts over.
 */
export function retryBase(last: Run | null): { of: Run; note: string } | undefined {
  if (!last || last.status !== "error" || !last.prUrl || !last.headBranch) return undefined;
  if (last.prState === "closed" || last.prState === "merged") return undefined;
  return { of: last, note: last.revisionNote ?? "Continue the follow-up on the pull request." };
}

/**
 * A new run for the card, not yet stored. For a revision, it continues the
 * given run with the note. `bot` marks a crew-owned run. `followUp` puts
 * the run on a pull request's branch; a revision of a run that was on one
 * stays there.
 */
export function newRun(
  id: string,
  card: Card,
  revision: { of: Run; note: string } | undefined,
  options: { bot?: BotId | null; followUp?: FollowUp | null },
  now: string,
): Run {
  const followUp = options.followUp ?? inheritedFollowUp(revision?.of);
  return {
    id,
    cardId: card.id,
    status: "running",
    log: revision
      ? [
          "Agent started",
          followUp && (revision.of.status === "approved" || revision.of.status === "error")
            ? `Following up on pull request${followUp.prNumber ? ` #${followUp.prNumber}` : ""}. Request: ${revision.note}`
            : `Revising the previous result. Request: ${revision.note}`,
        ]
      : ["Agent started"],
    proposedWrites: [],
    baseBranch: followUp?.baseBranch ?? null,
    headBranch: followUp?.headBranch ?? null,
    prUrl: followUp?.prUrl ?? null,
    prNumber: followUp?.prNumber ?? null,
    prState: followUp ? "open" : null,
    followUpReason: followUp?.reason ?? null,
    error: null,
    warning: null,
    summary: null,
    revisionOf: revision?.of.id ?? null,
    revisionNote: revision?.note ?? null,
    bot: options.bot ?? null,
    commitMessage: null,
    createdAt: now,
    updatedAt: now,
  };
}
