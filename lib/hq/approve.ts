import { approveMode, prBody, pushRefusal } from "./approve-logic";
import { generateCommitMessage } from "./commit-message-model";
import { appendRunLog, getActiveBotJobForCard, getCard, getRun, listPrFeedback, transitionRun } from "./data";
import { applyWrites, getPull, getRepo, parsePullUrl, postIssueComment, pushWrites } from "./github";
import { followUpComment } from "./github-feedback-logic";
import { issueOpenedComment, issueRepo } from "./issue-sync-logic";
import { getFreshGithubConnection } from "./model-auth";
import { randomString } from "./oauth";
import { createRedactor } from "./redact";
import { releaseWorkspace } from "./runs";
import type { Run } from "./types";

export type ApproveResult =
  | { ok: true; run: Run; mode: "opened" | "pushed" }
  | { ok: false; status: number; error: string };

/**
 * Applies a run's proposed changes. A first run gets a new branch, a single
 * commit holding every changed file under a message the card's model
 * writes, and a pull request. A follow-up, which continues an approved run
 * on the pull request's own branch, gets one more commit pushed to that
 * branch instead, and no new pull request. The run is claimed first, so a
 * double click, a second tab or a chat request can't open two pull
 * requests. If GitHub fails, the run goes back to waiting with the error,
 * so it can be approved again.
 *
 * The approve button, "make the PR for …" in the Team room, and the crew's
 * auto-push all land here. `job` is the crew's own job on the card, the
 * one caller allowed through while a job is active.
 */
export async function approveRun(id: string, options: { job?: string } = {}): Promise<ApproveResult> {
  const run = getRun(id);
  if (!run) return { ok: false, status: 404, error: "Run not found" };
  if (run.status !== "needs_approval") {
    return { ok: false, status: 409, error: "This run isn't waiting for approval" };
  }
  const card = getCard(run.cardId);
  if (!card?.repo) return { ok: false, status: 400, error: "Pick a repo on the card" };
  // The run waits for approval internally while Kiko, Lulu and Bibi work;
  // the person gets it once the crew is done.
  const active = getActiveBotJobForCard(card.id);
  if (active && active.id !== options.job) {
    return { ok: false, status: 409, error: "The crew is still working on this card" };
  }

  let github;
  try {
    github = await getFreshGithubConnection();
  } catch (reason) {
    return { ok: false, status: 409, error: reason instanceof Error ? reason.message : "Reconnect GitHub" };
  }
  if (!github) return { ok: false, status: 400, error: "Connect GitHub first" };
  const redact = createRedactor([github.accessToken, github.refreshToken]);
  const token = github.accessToken;

  if (approveMode(run) === "push") {
    const parsed = parsePullUrl(run.prUrl!);
    if (!parsed) return { ok: false, status: 400, error: "This run's pull request address is unreadable" };
    const head = run.headBranch!;
    if (!transitionRun(id, ["needs_approval"], "applying", { error: null })) {
      return { ok: false, status: 409, error: "This run is already being approved or was discarded" };
    }
    appendRunLog(id, `Approved. Pushing to ${head} on pull request #${parsed.number}`);
    try {
      const pull = await getPull(token, parsed.repo, parsed.number);
      const refusal = pushRefusal(pull.state, run.prNumber ?? parsed.number);
      if (refusal) throw new Error(refusal);
      const commitMessage = run.commitMessage ?? (await generateCommitMessage(card, run));
      appendRunLog(id, redact(`Commit message: ${commitMessage}`));
      const { sha } = await pushWrites({
        token,
        repo: parsed.repo,
        head,
        message: commitMessage,
        writes: run.proposedWrites,
        expectedHeadSha: run.prHeadSha ?? pull.headSha,
        warn: (line) => appendRunLog(id, redact(line)),
      });
      transitionRun(
        id,
        ["applying"],
        "approved",
        // Every list is read again for the new head; ids keep it cheap.
        { prHeadSha: sha, prState: "open", prEtag: null, prEtags: null },
        { status: "approved", column: "review" },
      );
      appendRunLog(id, `Pushed ${sha.slice(0, 7)} to ${run.prUrl}`);
      // A note on the pull request for whoever asked; not worth failing over.
      const addressed = listPrFeedback({ cardId: card.id }).filter((item) => item.handledBy === id);
      await postIssueComment(token, parsed.repo, parsed.number, followUpComment(addressed, sha)).catch((error: unknown) => {
        appendRunLog(id, redact(`Couldn't comment on the pull request: ${error instanceof Error ? error.message : "unknown error"}`));
      });
      await releaseWorkspace(id);
      return { ok: true, run: getRun(id) ?? run, mode: "pushed" };
    } catch (reason) {
      const message = redact(reason instanceof Error ? reason.message : "Push failed").slice(0, 300);
      transitionRun(id, ["applying"], "needs_approval", { error: message });
      appendRunLog(id, `Could not push to the pull request: ${message}`);
      return { ok: false, status: 502, error: message };
    }
  }

  const head = `kru/${Date.now().toString(36)}-${randomString(3).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  if (!transitionRun(id, ["needs_approval"], "applying", { headBranch: head, error: null })) {
    return { ok: false, status: 409, error: "This run is already being approved or was discarded" };
  }
  appendRunLog(id, `Approved. Opening a pull request from ${head}`);

  try {
    const branch = run.baseBranch ?? (await getRepo(token, card.repo)).default_branch;
    // The card's own model names the commit; the agent's summary is prose.
    // When the crew handled the card, Bibi already wrote it.
    const commitMessage = run.commitMessage ?? (await generateCommitMessage(card, run));
    appendRunLog(id, redact(`Commit message: ${commitMessage}`));
    const pr = await applyWrites({
      token,
      repo: card.repo,
      branch,
      head,
      title: card.title,
      body: prBody(card),
      message: commitMessage,
      writes: run.proposedWrites,
    });
    transitionRun(
      id,
      ["applying"],
      "approved",
      { prUrl: pr.url, prNumber: pr.number, prHeadSha: pr.headSha, prState: "open" },
      { status: "approved", column: "review" },
    );
    appendRunLog(id, `PR opened ${pr.url}`);
    // A card from an issue says so on the issue; not worth failing over.
    if (card.issueNumber) {
      const repo = issueRepo(card.issueUrl) ?? card.repo;
      await postIssueComment(token, repo, card.issueNumber, issueOpenedComment(pr.url)).catch((error: unknown) => {
        appendRunLog(id, redact(`Couldn't comment on issue #${card.issueNumber}: ${error instanceof Error ? error.message : "unknown error"}`));
      });
    }
    // Approved, so there is nothing left to revise in the box.
    await releaseWorkspace(id);
    return { ok: true, run: getRun(id) ?? run, mode: "opened" };
  } catch (reason) {
    const message = redact(reason instanceof Error ? reason.message : "Approve failed").slice(0, 300);
    transitionRun(id, ["applying"], "needs_approval", { error: message });
    appendRunLog(id, `Could not open the pull request: ${message}`);
    return { ok: false, status: 502, error: message };
  }
}
