import { after } from "next/server";
import { RunCancelledError, runCardAgent } from "./agent";
import { boxConfig, boxUrl, deleteWorkspace, listWorkspaces } from "./box";
import { runCardClaudeCode } from "./claude-code";
import {
  appendRunLog,
  createRun,
  getActiveBotJobForCard,
  getCard,
  getConnection,
  getGithubConnection,
  getRepoInstructions,
  getRun,
  hasPendingSteering,
  listRuns,
  transitionRun,
} from "./data";
import { considerCardSteering } from "./bots/steer-card";
import { steeringFor } from "./bots/steering";
import { getRepo } from "./github";
import { ensureFreshConnection, getFreshGithubConnection } from "./model-auth";
import { PROVIDER_NAMES, isClaudeCodeRef, parseModelRef } from "./models";
import { randomString } from "./oauth";
import { createRedactor } from "./redact";
import { cloneRefFor, newRun, replayNeeded, retryBase, type FollowUp } from "./runs-logic";
import { isModelProvider, type BotId, type Card, type Run } from "./types";
import { REVIEW_WORKSPACES, workspacesToDrop } from "./workspaces";

/*
 * Starting and finishing agent runs, shared by the run and revise routes.
 * A run is created in the request, then the agent works in `after()` so the
 * response returns at once; the board polls for progress.
 */

/**
 * Drops the workspace a run no longer needs. Safe to call for a run that
 * never had one, or whose box has since forgotten it.
 */
export async function releaseWorkspace(runId: string) {
  const box = boxConfig();
  if (!box) return;
  await deleteWorkspace(box, runId).catch(() => undefined);
}

/**
 * Makes room before a run claims a workspace of its own.
 *
 * Nothing here is load-bearing: a run's changes live in the database, so a
 * workspace that goes just means the next revision clones and replays.
 */
async function pruneWorkspaces(keep: string[]) {
  const box = boxConfig();
  if (!box) return;
  const { workspaces } = await listWorkspaces(box).catch(() => ({ workspaces: [] }));
  if (workspaces.length === 0) return;

  const status = new Map(listRuns().map((run) => [run.id, run.status]));
  const drop = workspacesToDrop(workspaces, status, new Set(keep), Date.now());
  for (const id of drop) await deleteWorkspace(box, id).catch(() => undefined);
}

/** Why a card can't run right now, or null when it can. */
export function runProblem(card: Card): string | null {
  const github = getGithubConnection();
  const { connectionId } = parseModelRef(card.model);
  const model = connectionId ? getConnection(connectionId) : null;
  if (!boxUrl()) return "Kru's box isn't configured. Set KRU_BOX_URL and start the box container.";
  if (!github) return "Connect GitHub first";
  if (!card.repo) return "Pick a repo on the card";
  // Claude Code has no connection row: the CLI in the box signs in on its
  // own, and whether it has is checked when the run starts.
  if (isClaudeCodeRef(card.model)) return null;
  if (!card.model) return "Pick a model on the card";
  if (!model) {
    if (connectionId.startsWith("sub_")) {
      return "This card's subscription sign-in was removed. Sign in again in Settings or pick another model.";
    }
    return isModelProvider(connectionId)
      ? `Connect ${PROVIDER_NAMES[connectionId]} first`
      : "This card's API endpoint was removed. Pick another model.";
  }
  return null;
}

/**
 * Closes a waiting run so a revision can continue from it. Returns false
 * when it was already approved, discarded, or claimed by another revision.
 */
export function claimForRevision(run: Run, note: string): boolean {
  appendRunLog(run.id, `Sent back with a request for changes: ${note}`);
  return transitionRun(run.id, ["needs_approval"], "cancelled", {});
}

export type { FollowUp };

/** What running the card again continues from, if its last run was a failed follow-up. */
export function retryOf(card: Card): { of: Run; note: string } | undefined {
  return retryBase(card.runId ? getRun(card.runId) : null);
}

/**
 * Creates a run for the card and moves the card to Run, without starting
 * the agent: the caller does that with `finishRun`, in `after()` from a
 * route or awaited from the bot dispatcher. For a revision, the new run
 * continues the reviewed one with the note. `bot` marks a crew-owned run,
 * which stops in Run for the crew instead of in Review for the person.
 * `followUp` puts the run on a pull request's branch; a revision of a run
 * that was on one stays there.
 */
export function beginRun(
  card: Card,
  revision?: { of: Run; note: string },
  options: { bot?: BotId | null; followUp?: FollowUp | null } = {},
): Run {
  const run = newRun(randomString(12), card, revision, options, new Date().toISOString());
  // Running again is what clears a card that was stopped part-way.
  createRun(run, { column: "run", status: "running", runId: run.id, stopped: null });
  return run;
}

/**
 * Creates a run for the card, moves the card to Run, and schedules the agent
 * once the response has gone out. For routes; the dispatcher uses `beginRun`.
 */
export function startRun(card: Card, revision?: { of: Run; note: string }): Run {
  const run = beginRun(card, revision);
  after(() => finishRun(card.id, run.id));
  return run;
}

export type ReviseResult =
  | { ok: true; run: Run; card: Card }
  | { ok: false; status: number; error: string };

/**
 * Sends a reviewed result back to the agent with a request for changes. The
 * waiting run is closed and a new run starts from its changes plus the note,
 * in the same workspace, so the card goes back to Run and returns to Review
 * with the revised result.
 *
 * The "Ask for changes" box on the card and "revise the blur fix, …" in the
 * Team room both land here.
 */
export function reviseRun(id: string, note: string): ReviseResult {
  const run = getRun(id);
  if (!run) return { ok: false, status: 404, error: "Run not found" };
  if (run.status !== "needs_approval") {
    return { ok: false, status: 409, error: "This run isn't waiting for review" };
  }
  const card = getCard(run.cardId);
  if (!card) return { ok: false, status: 404, error: "Card not found" };
  if (getActiveBotJobForCard(card.id)) {
    return { ok: false, status: 409, error: "The crew is still working on this card" };
  }
  const problem = runProblem(card);
  if (problem) return { ok: false, status: 400, error: problem };

  // Claim the waiting run first, so two requests can't start two revisions.
  if (!claimForRevision(run, note)) {
    return { ok: false, status: 409, error: "This run was already approved or discarded" };
  }
  return { ok: true, run: startRun(card, { of: run, note }), card };
}

/**
 * Runs the agent for a run that `beginRun` created and settles the run:
 * `needs_approval` with the changes, or `error`. A run the crew owns stays
 * in the Run column when it finishes; the pipeline moves the card on.
 */
export async function finishRun(cardId: string, runId: string) {
  const card = getCard(cardId);
  const run = getRun(runId);
  const claudeCode = isClaudeCodeRef(card?.model);
  const { connectionId } = parseModelRef(card?.model);
  const stored = !claudeCode && connectionId ? getConnection(connectionId) : null;
  if (!card?.repo || !run || (!stored && !claudeCode) || run.status !== "running") return;

  // Logs and errors are shown on the board and kept in the database, so mask
  // the tokens this run uses. A Claude Code card has none of its own.
  let redact = createRedactor([stored?.accessToken]);
  try {
    const github = await getFreshGithubConnection();
    if (!github) throw new Error("Connect GitHub first");
    // On a Claude Code card the CLI signs in for itself, so the card's
    // "model" is the GitHub connection standing in: nothing reads its token.
    const model = stored ? await ensureFreshConnection(stored) : github;
    redact = createRedactor([github.accessToken, github.refreshToken, model.accessToken, model.refreshToken]);
    const { default_branch } = await getRepo(github.accessToken, card.repo);
    const branch = run.baseBranch ?? default_branch;
    // A follow-up works on the pull request's own branch; everything else
    // starts from the base branch.
    const ref = cloneRefFor(run, branch);
    appendRunLog(runId, ref === branch ? `Base branch ${branch}` : `Branch ${ref} (pull request${run.prNumber ? ` #${run.prNumber}` : ""} on ${branch})`);

    const parent = run.revisionOf ? getRun(run.revisionOf) : null;
    // An approved parent's changes are on the branch being cloned; a
    // reviewed parent's exist only in the database and are put back.
    const replay = replayNeeded(parent);
    const previous =
      parent && run.revisionNote
        ? {
            writes: parent.proposedWrites,
            summary: parent.summary ?? null,
            note: run.revisionNote,
            applied: !replay,
            resumed: Boolean(parent.stoppedNote),
          }
        : undefined;

    // Room for this run's workspace, keeping the one it means to continue in.
    await pruneWorkspaces([runId, ...(parent && replay ? [parent.id] : [])]).catch(() => undefined);

    const runner = claudeCode ? runCardClaudeCode : runCardAgent;
    const { writes, warning, summary, stopped } = await runner({
      card,
      github,
      model,
      branch: ref,
      runId,
      previous,
      repoInstructions: getRepoInstructions(card.repo),
      // Only a reviewed parent's workspace is worth continuing in: an
      // approved one was cloned from the base branch, so its working tree
      // would show the whole pull request as this run's change.
      adopt: previous && replay && REVIEW_WORKSPACES > 0 ? (parent?.id ?? null) : null,
      log: (line) => {
        appendRunLog(runId, redact(line));
      },
      isCancelled: () => getRun(runId)?.status !== "running",
      // Cancelled with a reason to continue later, not discarded.
      isStopped: () => Boolean(getRun(runId)?.stoppedNote),
      steeringNotes: steeringFor(card.id),
      steering: {
        pending: () => hasPendingSteering(card.id),
        consider: () => considerCardSteering(card, getRun(runId)),
      },
    });

    // Stopped to be restarted later: what the agent had changed stays with
    // the run, for the card's next run to continue from, and the workspace
    // stays until newer runs need the room.
    if (stopped) {
      transitionRun(runId, ["cancelled"], null, { proposedWrites: writes, summary });
      return;
    }

    // Stop for a person: nothing reaches GitHub until Approve. This does
    // nothing if the run was cancelled while the agent worked. A crew run
    // stops for the crew instead: the card stays in Run until Bibi is done.
    const files = `${writes.length} file${writes.length === 1 ? "" : "s"}`;
    if (
      transitionRun(
        runId,
        ["running"],
        "needs_approval",
        { proposedWrites: writes, baseBranch: branch, warning, summary },
        run.bot ? { status: "needs_approval" } : { status: "needs_approval", column: "review" },
      )
    ) {
      appendRunLog(
        runId,
        run.bot ? `Built: ${files} to change. Handing off to Kiko.` : `Waiting for approval: ${files} to change`,
      );
      // Kept for a revision to continue in, and for a shell during review.
      if (REVIEW_WORKSPACES === 0) await releaseWorkspace(runId);
    } else {
      // Cancelled while the agent worked: nobody is going to review this.
      await releaseWorkspace(runId);
    }
  } catch (reason) {
    // The person already moved the card back to Drop.
    if (reason instanceof RunCancelledError) return;
    const message = redact(reason instanceof Error ? reason.message : "Agent failed");
    if (
      transitionRun(runId, ["running"], "error", { error: message }, { status: "error", column: "run" })
    ) {
      appendRunLog(runId, message);
    }
  }
}
