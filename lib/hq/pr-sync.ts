import { postEvent } from "./bots/room";
import {
  appendRunLog,
  getActiveBotJobForCard,
  getBotsEnabled,
  getCard,
  getMissingGithubPermissions,
  getRun,
  insertPrFeedback,
  listPrFeedback,
  listRuns,
  markPrFeedbackHandled,
  setMissingGithubPermissions,
  transitionRun,
} from "./data";
import { beginFollowUp, foldIntoWaiting } from "./follow-up";
import {
  GithubPermissionError,
  checkPull,
  githubBackoffUntil,
  listCheckRunAnnotations,
  listCheckRuns,
  listIssueComments,
  listPullReviewComments,
  listPullReviews,
  parsePullUrl,
} from "./github";
import {
  annotationLines,
  approvalEvent,
  checkRunId,
  feedbackEvent,
  mergeEtags,
  normalizeCheckRuns,
  normalizeIssueComments,
  normalizeReviewComments,
  normalizeReviews,
  type FeedbackItem,
  type RawAnnotation,
  type RawCheckRun,
  type RawIssueComment,
  type RawReview,
  type RawReviewComment,
} from "./github-feedback-logic";
import { getFreshGithubConnection } from "./model-auth";
import {
  FEEDBACK_INTERVAL_MS,
  PR_CHECK_INTERVAL_MS,
  checkFollowUpsSoFar,
  due,
  followUpAction,
  prOwners,
  runsSharingPr,
  staleClaims,
} from "./pr-sync-logic";
import { runProblem } from "./runs";
import type { PrEtags, PrFeedback, Run } from "./types";

/*
 * Kru's side of a pull request after it opens: from the dispatcher's tick,
 * ask GitHub what happened to each open one (merged, closed, still open),
 * read what reviewers and checks said, keep it as feedback, and start a
 * follow-up when the feedback asks for a change. All of it is conditional
 * on ETags, so a quiet pull request costs nothing per tick.
 *
 * Tracking runs whether or not the crew is on: it only keeps the board
 * truthful. Starting a follow-up spends model time, so that waits for the
 * crew switch.
 */

/** How long to leave a refused permission alone before asking again. */
const PERMISSION_RETRY_MS = 10 * 60 * 1000;

type State = {
  syncing: boolean;
  /** When each owner run's pull request was last asked about. */
  pullChecked: Map<string, number>;
  feedbackChecked: Map<string, number>;
  permissionRetryAt: number;
  /** Cards told once why a follow-up can't start. */
  warned: Set<string>;
  /** The last failure logged per run, so a dead token is one line, not one per interval. */
  failed: Map<string, string>;
};

const holder = globalThis as typeof globalThis & { __kruPrSync?: State };

function state(): State {
  return (holder.__kruPrSync ??= {
    syncing: false,
    pullChecked: new Map(),
    feedbackChecked: new Map(),
    permissionRetryAt: 0,
    warned: new Set(),
    failed: new Map(),
  });
}

/**
 * A failed ask is tried again after its normal interval, not on the next
 * tick: GitHub being down or a token being dead doesn't get better in
 * three seconds, and the log says so once per change of reason.
 */
function noteFailure(what: string, run: Run, error: unknown) {
  const current = state();
  const message = error instanceof Error ? error.message : String(error);
  const key = `${what}:${run.id}`;
  if (current.failed.get(key) === message) return;
  current.failed.set(key, message);
  console.warn(`[kru] ${what} failed for run ${run.id}: ${message}`);
}

function prLabel(run: Run) {
  return run.prNumber ? `PR #${run.prNumber}` : "the pull request";
}

/** One pass. Never overlaps with itself; the dispatcher calls it each tick. */
export async function syncPullRequests(now = Date.now()) {
  const current = state();
  if (current.syncing) return;
  current.syncing = true;
  try {
    if (githubBackoffUntil() > now) return;
    // A failed refresh just skips this pass; Settings shows reconnect.
    const github = await getFreshGithubConnection().catch(() => null);
    if (!github) return;
    const token = github.accessToken;

    const owners = prOwners(listRuns());
    for (const id of staleClaims(current.pullChecked, owners)) {
      current.pullChecked.delete(id);
      current.feedbackChecked.delete(id);
      current.failed.delete(`Pull request check:${id}`);
      current.failed.delete(`Feedback sync:${id}`);
    }

    // Claimed before the first await, so the next tick can't ask about the
    // same pull requests while these answers are still on their way.
    const pulls = due(owners, current.pullChecked, now, PR_CHECK_INTERVAL_MS);
    for (const run of pulls) current.pullChecked.set(run.id, now);
    await Promise.all(
      pulls.map((run) =>
        checkOne(token, run)
          .then(() => current.failed.delete(`Pull request check:${run.id}`))
          .catch((error: unknown) => noteFailure("Pull request check", run, error)),
      ),
    );

    // Only what is still open after the check above.
    const open = prOwners(listRuns());
    const feedback = due(open, current.feedbackChecked, now, FEEDBACK_INTERVAL_MS);
    for (const run of feedback) current.feedbackChecked.set(run.id, now);
    await Promise.all(
      feedback.map((run) =>
        syncFeedback(token, run, now)
          .then(() => current.failed.delete(`Feedback sync:${run.id}`))
          .catch((error: unknown) => noteFailure("Feedback sync", run, error)),
      ),
    );

    startFollowUps(now);
  } finally {
    current.syncing = false;
  }
}

/** What happened to one pull request: merged, closed, or a new head. */
async function checkOne(token: string, run: Run) {
  const parsed = parsePullUrl(run.prUrl!);
  if (!parsed) return;
  const result = await checkPull(token, parsed.repo, parsed.number, run.prEtag);
  // 304: nothing has changed, and the stored ETag still describes it.
  if (!result.changed) return;
  const card = getCard(run.cardId);
  // The card follows the run only while it is on it; a follow-up in flight
  // finds out for itself when it tries to push.
  const onCard = card?.runId === run.id;
  const siblings = runsSharingPr(listRuns(), run.prUrl!, run.id);

  if (result.state === "merged") {
    const patch = { prState: result.state, prEtag: result.etag, prHeadSha: result.headSha, prNumber: result.number };
    if (transitionRun(run.id, [run.status], "merged", patch, onCard ? { status: "merged" } : undefined)) {
      appendRunLog(run.id, "PR merged");
      for (const other of siblings) transitionRun(other.id, [other.status], "merged", { prState: "merged" });
      if (card) postEvent("pip", `${prLabel({ ...run, ...patch })} for "${card.title}" was merged.`, card.id);
    }
    return;
  }
  if (result.state === "closed") {
    const message = `${prLabel({ ...run, prNumber: result.number })} was closed without merging`;
    const patch = { prState: result.state, prEtag: result.etag, prNumber: result.number, error: message };
    if (transitionRun(run.id, [run.status], null, patch, onCard ? { status: "error", column: "review" } : undefined)) {
      appendRunLog(run.id, message);
      for (const other of siblings) transitionRun(other.id, [other.status], null, { prState: "closed" });
      if (card) postEvent("pip", `${message} for "${card.title}". Reopen it from the card, or make a new one.`, card.id);
    }
    return;
  }
  // Still open. Keep the ETag so the next check is a free 304, and the head
  // so checks are read for the right commit (someone may push by hand).
  const patch = { prEtag: result.etag, prHeadSha: result.headSha, prNumber: result.number, prState: "open" as const };
  if (run.prHeadSha && result.headSha && run.prHeadSha !== result.headSha) {
    // New commit, new checks: forget the checks ETag so they are read again.
    transitionRun(run.id, [run.status], null, { ...patch, prEtags: mergeEtags<PrEtags>(run.prEtags, { checks: null }) });
  } else {
    transitionRun(run.id, [run.status], null, patch);
  }
}

/** Which app permission a refused read needs, from the path GitHub refused. */
function permissionFor(error: GithubPermissionError) {
  return /check-runs|check-suites/.test(error.path) ? "checks" : "pull_requests";
}

/** Reviews, comments and checks on one pull request, stored as feedback. */
async function syncFeedback(token: string, run: Run, now: number) {
  const parsed = parsePullUrl(run.prUrl!);
  if (!parsed) return;
  const { repo, number } = parsed;
  const etags: PrEtags = run.prEtags ?? {};
  const fresh: Partial<PrEtags> = {};
  const items: FeedbackItem[] = [];
  const approvals: FeedbackItem[] = [];
  const missing = getMissingGithubPermissions();
  const current = state();

  const reviews = await listPullReviews<RawReview>(token, repo, number, etags.reviews);
  if (reviews.changed) {
    const normalized = normalizeReviews(reviews.data);
    items.push(...normalized.feedback);
    approvals.push(...normalized.approvals);
    fresh.reviews = reviews.etag;
  }
  const comments = await listPullReviewComments<RawReviewComment>(token, repo, number, etags.comments);
  if (comments.changed) {
    items.push(...normalizeReviewComments(comments.data));
    fresh.comments = comments.etag;
  }
  const talk = await listIssueComments<RawIssueComment>(token, repo, number, etags.issueComments);
  if (talk.changed) {
    items.push(...normalizeIssueComments(talk.data));
    fresh.issueComments = talk.etag;
  }

  const skipChecks = missing.includes("checks") && now < current.permissionRetryAt;
  if (run.prHeadSha && !skipChecks) {
    try {
      const checks = await listCheckRuns<RawCheckRun>(token, repo, run.prHeadSha, etags.checks);
      if (checks.changed) {
        items.push(...normalizeCheckRuns(checks.data, run.prHeadSha));
        fresh.checks = checks.etag;
      }
      if (missing.includes("checks")) setMissingGithubPermissions(missing.filter((p) => p !== "checks"));
    } catch (error) {
      if (!(error instanceof GithubPermissionError)) throw error;
      const permission = permissionFor(error);
      current.permissionRetryAt = now + PERMISSION_RETRY_MS;
      if (!missing.includes(permission)) {
        setMissingGithubPermissions([...missing, permission]);
        postEvent(
          "pip",
          "I can't read CI results on the crew's pull requests yet: the GitHub App needs the Checks permission. Settings → Bots shows how to add it.",
        );
      }
    }
  }

  // Only what is new gets annotations fetched, a line in the room, and a
  // place in the queue; approvals are kept so they are announced once.
  const known = new Set(listPrFeedback({ cardId: run.cardId }).map((item) => item.id));
  const seenAt = new Date(now).toISOString();
  const stamp = (item: FeedbackItem, handledBy: string | null): PrFeedback => ({
    ...item,
    cardId: run.cardId,
    runId: run.id,
    prUrl: run.prUrl!,
    seenAt,
    handledBy,
  });
  const incoming: PrFeedback[] = [];
  for (const item of items) {
    if (known.has(item.id)) continue;
    let body = item.body;
    const checkId = checkRunId(item);
    if (checkId !== null) {
      const lines = await listCheckRunAnnotations<RawAnnotation>(token, repo, checkId).then(annotationLines).catch(() => []);
      if (lines.length) body = `${body}\n${lines.join("\n")}`;
    }
    incoming.push(stamp({ ...item, body }, null));
  }
  for (const item of approvals) if (!known.has(item.id)) incoming.push(stamp(item, run.id));

  const stored = insertPrFeedback(incoming);
  for (const item of stored) {
    const line = item.state === "APPROVED" && item.kind === "review" ? approvalEvent(item, run.prNumber ?? null) : feedbackEvent(item, run.prNumber ?? null);
    postEvent("pip", line, run.cardId);
  }
  if (Object.keys(fresh).length) {
    transitionRun(run.id, [run.status], null, { prEtags: mergeEtags<PrEtags>(run.prEtags, fresh) });
  }
}

/**
 * A follow-up for each card whose pending feedback asks for a change, when
 * the crew is on and nothing else has the card. Feedback on a pull request
 * that has since merged or closed is put away.
 */
export function startFollowUps(now = Date.now()) {
  const pending = listPrFeedback({ pending: true });
  if (pending.length === 0) return;
  const runs = listRuns();
  const owners = prOwners(runs);
  const byCard = new Map<string, PrFeedback[]>();
  for (const item of pending) byCard.set(item.cardId, [...(byCard.get(item.cardId) ?? []), item]);
  const botsEnabled = getBotsEnabled();
  const current = state();

  for (const [cardId, items] of byCard) {
    const card = getCard(cardId);
    const owner = owners.find((run) => run.prUrl === items[0].prUrl);
    if (!card || !owner) {
      markPrFeedbackHandled(
        items.map((item) => item.id),
        items[0].runId,
      );
      continue;
    }
    const action = followUpAction({
      card,
      ownerRun: owner,
      cardRun: card.runId ? getRun(card.runId) : null,
      activeJob: getActiveBotJobForCard(card.id),
      pending: items,
      botsEnabled,
      now,
      checkFollowUps: checkFollowUpsSoFar(runs, owner.prUrl!),
    });
    if (action.kind === "wait") continue;
    if (action.kind === "skip") {
      if (action.why === "the check follow-up limit was reached" && !current.warned.has(`${cardId}:cap`)) {
        current.warned.add(`${cardId}:cap`);
        postEvent("pip", `CI is still failing on ${prLabel(owner)} for "${card.title}" after ${checkFollowUpsSoFar(runs, owner.prUrl!)} follow-ups. I'll stop trying; have a look at the check yourself.`, card.id);
      }
      if (action.why === "nothing asks for a change") {
        markPrFeedbackHandled(
          items.map((item) => item.id),
          owner.id,
        );
      }
      continue;
    }
    const problem = runProblem(card);
    if (problem) {
      if (!current.warned.has(`${cardId}:${problem}`)) {
        current.warned.add(`${cardId}:${problem}`);
        postEvent("pip", `There's feedback on ${prLabel(owner)} for "${card.title}" but I can't start a follow-up: ${problem}`, card.id);
      }
      continue;
    }
    current.warned.delete(`${cardId}:cap`);
    if (action.kind === "revise") {
      const waiting = getRun(action.runId);
      if (waiting) foldIntoWaiting(card, waiting, action.items);
      continue;
    }
    const reason = action.items.every((item) => item.kind === "check") ? "check" : "review";
    beginFollowUp(card, owner, action.items, reason, { bot: "momo" });
  }
}
