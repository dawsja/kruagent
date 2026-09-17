import type { Run } from "./types";

/*
 * What the box keeps, and for how long. A run's workspace used to go as soon
 * as the agent stopped, so asking for changes cloned the repo again and
 * reinstalled everything to land back where the reviewed run already was.
 * It is kept now, for the revision to continue in and for a shell to open
 * in while the card is reviewed — but a clone plus whatever a repo installs
 * is real disk, so only a few of them, and not forever.
 *
 * None of it is load-bearing. A run's changes live in the database, so a
 * workspace that goes just means the next revision clones and replays them.
 */

/**
 * How many finished runs keep their workspace. Each one holds a clone and
 * whatever that repo installs, so this is a disk bill: `KRU_REVIEW_WORKSPACES=0`
 * turns the whole thing off and every revision clones again.
 */
export const REVIEW_WORKSPACES = Math.max(
  0,
  Number(process.env.KRU_REVIEW_WORKSPACES ?? 3) || 0,
);

/** And for how long, however few of them there are. */
export const REVIEW_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Which of the box's workspaces to drop. A workspace is worth keeping while
 * its run waits for review, because a revision can continue in it, and when
 * its run failed after the agent finished, because the work is only there
 * (other failed runs drop theirs straight away); the rest
 * are left over from runs that ended. Past the newest `limit` of the ones
 * worth keeping, and past the age limit, they go too.
 *
 * Deciding this wrongly throws away work in progress, so it is kept apart
 * from the box call and tested. `workspaces` arrives newest first.
 */
export function workspacesToDrop(
  workspaces: { id: string; at: number }[],
  status: Map<string, Run["status"]>,
  keep: Set<string>,
  now: number,
  limit: number = REVIEW_WORKSPACES,
): string[] {
  const waiting: { id: string; at: number }[] = [];
  const drop: string[] = [];

  for (const workspace of workspaces) {
    if (keep.has(workspace.id)) continue;
    const state = status.get(workspace.id);
    // A run still working is using it, whatever else is true of it.
    if (state === "running") continue;
    // Waiting for review, or failed while collecting its changes: the only
    // copy of that work is in the workspace.
    if (state === "needs_approval" || state === "error") waiting.push(workspace);
    else drop.push(workspace.id);
  }

  const stale = now - REVIEW_WORKSPACE_TTL_MS;
  for (const [index, workspace] of waiting.entries()) {
    if (index >= limit || workspace.at < stale) drop.push(workspace.id);
  }
  return drop;
}
