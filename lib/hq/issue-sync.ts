import { postEvent } from "./bots/room";
import { defaultCardModel } from "./bots/models";
import { createCardFromIssue } from "./cards";
import {
  cardForIssue,
  getBotsEnabled,
  getIssueLabel,
  getIssueSync,
  getIssuesEnabled,
  getMissingGithubPermissions,
  getOnboarding,
  importedIssueIds,
  listCards,
  setIssueSync,
  setMissingGithubPermissions,
  wasIssueImported,
} from "./data";
import { GithubPermissionError, getIssue, githubBackoffUntil, listLabelledIssues } from "./github";
import {
  ISSUE_INTERVAL_MS,
  cardFromIssue,
  issueProblem,
  issuesToImport,
  nextSince,
  reposToPoll,
  type RawIssue,
} from "./issue-sync-logic";
import { getFreshGithubConnection } from "./model-auth";
import type { Card } from "./types";

/*
 * GitHub issues as work: from the dispatcher's tick, while the crew is on
 * and issue pickup is turned on, ask each watched repo for open issues
 * carrying the label and turn the new ones into cards in Drop, where the
 * crew picks them up like any other. Each repo keeps a cursor, and every
 * ask is conditional, so a quiet repo costs nothing.
 */

/** How long to leave a refused permission alone before asking again. */
const PERMISSION_RETRY_MS = 10 * 60 * 1000;

type State = {
  syncing: boolean;
  lastPass: number;
  permissionRetryAt: number;
  /** The last failure logged per repo, so a dead token is one line. */
  failed: Map<string, string>;
};

const holder = globalThis as typeof globalThis & { __kruIssueSync?: State };

function state(): State {
  return (holder.__kruIssueSync ??= { syncing: false, lastPass: 0, permissionRetryAt: 0, failed: new Map() });
}

function refused(now: number) {
  const current = state();
  current.permissionRetryAt = now + PERMISSION_RETRY_MS;
  const missing = getMissingGithubPermissions();
  if (missing.includes("issues")) return;
  setMissingGithubPermissions([...missing, "issues"]);
  postEvent(
    "pip",
    "I can't read issues yet: the GitHub App needs the Issues permission. Settings → Bots shows how to add it.",
  );
}

async function cardFor(issue: RawIssue, repo: string): Promise<Card | null> {
  const model = await defaultCardModel().catch(() => null);
  return createCardFromIssue(
    { ...cardFromIssue(issue, repo), model },
    { id: issue.id, number: issue.number, url: issue.html_url ?? null },
  );
}

/** One pass over the watched repos. Never overlaps with itself. */
export async function syncIssues(now = Date.now()) {
  const current = state();
  if (current.syncing || now - current.lastPass < ISSUE_INTERVAL_MS) return;
  if (!getBotsEnabled() || !getIssuesEnabled()) return;
  if (githubBackoffUntil() > now || current.permissionRetryAt > now) return;
  current.syncing = true;
  current.lastPass = now;
  try {
    const github = await getFreshGithubConnection().catch(() => null);
    if (!github) return;
    const label = getIssueLabel();
    const missing = getMissingGithubPermissions();

    for (const repo of reposToPoll(listCards(), getOnboarding()?.repo ?? null)) {
      try {
        const cursor = getIssueSync(repo);
        const result = await listLabelledIssues<RawIssue>(github.accessToken, repo, label, cursor?.since ?? null, cursor?.etag);
        current.failed.delete(repo);
        if (missing.includes("issues")) setMissingGithubPermissions(getMissingGithubPermissions().filter((p) => p !== "issues"));
        if (!result.changed) continue;

        for (const issue of issuesToImport(result.data, importedIssueIds(repo), label)) {
          const card = await cardFor(issue, repo);
          if (!card) continue;
          postEvent(
            "pip",
            `Picked up issue #${issue.number} from ${repo} as "${card.title}"${card.model ? "; the crew starts on it next." : ", but no model is available to run it."}`,
            card.id,
          );
        }
        // The etag belongs to this exact ask; a new cursor means a new ask.
        const since = nextSince(result.data, cursor?.since ?? null);
        setIssueSync(repo, { since, etag: since === (cursor?.since ?? null) ? result.etag : null });
      } catch (error) {
        if (error instanceof GithubPermissionError) {
          refused(now);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (current.failed.get(repo) !== message) {
          current.failed.set(repo, message);
          console.warn(`[kru] Issue sync failed for ${repo}: ${message}`);
        }
      }
    }
  } finally {
    current.syncing = false;
  }
}

export type ImportResult = { ok: true; card: Card } | { ok: false; error: string; card?: Card };

/**
 * One issue by number, on request (Pip's import_issue). Works whether or not
 * issue pickup is on, and needs no label.
 */
export async function importIssue(repo: string, number: number): Promise<ImportResult> {
  const existing = cardForIssue(repo, number);
  if (existing) return { ok: false, error: `Issue #${number} is already card "${existing.title}" (${existing.id}).`, card: existing };
  if (wasIssueImported(repo, number)) return { ok: false, error: `Issue #${number} was imported before and its card was deleted.` };

  const github = await getFreshGithubConnection().catch(() => null);
  if (!github) return { ok: false, error: "Connect GitHub first." };
  let issue: RawIssue;
  try {
    issue = await getIssue<RawIssue>(github.accessToken, repo, number);
  } catch (error) {
    if (error instanceof GithubPermissionError) {
      refused(Date.now());
      return { ok: false, error: "The GitHub App can't read issues yet; Settings → Bots shows how to allow it." };
    }
    return { ok: false, error: error instanceof Error ? error.message : "GitHub refused" };
  }
  const problem = issueProblem(issue);
  if (problem) return { ok: false, error: `${problem}.` };
  const card = await cardFor(issue, repo);
  if (!card) return { ok: false, error: `Issue #${number} was just imported.` };
  return { ok: true, card };
}
