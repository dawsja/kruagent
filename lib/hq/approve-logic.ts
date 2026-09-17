import { closesLine } from "./issue-sync-logic.ts";
import type { Card, Run } from "./types.ts";

/*
 * The decisions behind Approve, apart from GitHub and the database so they
 * can be tested: whether a run opens a pull request or pushes to the one it
 * continues, and when a push has to be refused.
 */

/**
 * A run with a head branch and a pull request before it is approved is a
 * follow-up: it was cloned from that branch and pushes back to it. Any other
 * run gets a branch of its own and a new pull request.
 */
export function approveMode(run: Pick<Run, "headBranch" | "prUrl">): "open" | "push" {
  return run.headBranch && run.prUrl ? "push" : "open";
}

/** Why a follow-up can't be pushed, given what GitHub says about its pull request. */
export function pushRefusal(state: "open" | "closed" | "merged", prNumber: number | null): string | null {
  const pr = prNumber ? `Pull request #${prNumber}` : "The pull request";
  if (state === "merged") return `${pr} was merged; there is nothing to push to. Make a new card for further changes.`;
  if (state === "closed") return `${pr} was closed without merging. Reopen it, or make a new card.`;
  return null;
}

/**
 * The body of a pull request Kru opens. A card made from an issue in its own
 * repo closes that issue when the pull request merges.
 */
export function prBody(card: Pick<Card, "repo" | "issueNumber" | "issueUrl">): string {
  const closes = closesLine(card);
  return ["Proposed by Kru. Human-approved write.", closes].filter(Boolean).join("\n\n");
}
