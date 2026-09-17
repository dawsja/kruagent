import { KRU_MARKER } from "./github-feedback-logic.ts";
import type { Card } from "./types.ts";

/*
 * GitHub issues as cards: which repos to watch, which issues to take, what
 * the card says, and how the pull request refers back. Nothing here talks
 * to GitHub or the database, so it is tested directly; `issue-sync.ts`
 * does the asking.
 */

/** How often each watched repo is asked for labelled issues. */
export const ISSUE_INTERVAL_MS = 60_000;
/** Repos watched at most, so a board with many repos can't spend the rate limit. */
export const MAX_REPOS = 20;
/** Issues turned into cards per repo per pass; the rest wait for the next. */
export const MAX_IMPORTS_PER_REPO = 10;

const MAX_TITLE = 200;
const MAX_BODY = 4000;

export type RawIssue = {
  id: number;
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  updated_at?: string;
  labels?: (string | { name?: string })[];
  /** Present when the "issue" is a pull request; those are never cards. */
  pull_request?: unknown;
};

/**
 * The repos worth watching: the one chosen at setup first, then every repo a
 * card names, each once.
 */
export function reposToPoll(cards: readonly Pick<Card, "repo">[], setupRepo: string | null): string[] {
  const repos: string[] = [];
  for (const repo of [setupRepo, ...cards.map((card) => card.repo)]) {
    const clean = repo?.trim();
    if (clean && /^[\w.-]+\/[\w.-]+$/.test(clean) && !repos.includes(clean)) repos.push(clean);
  }
  return repos.slice(0, MAX_REPOS);
}

function labelNames(issue: RawIssue): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label.name ?? ""))).filter(Boolean);
}

export function hasLabel(issue: RawIssue, label: string): boolean {
  const want = label.trim().toLowerCase();
  return labelNames(issue).some((name) => name.toLowerCase() === want);
}

/** Why an issue can't become a card, or null when it can. */
export function issueProblem(issue: RawIssue): string | null {
  if (issue.pull_request) return `#${issue.number} is a pull request, not an issue`;
  if (issue.state && issue.state !== "open") return `Issue #${issue.number} is closed`;
  return null;
}

/**
 * Open, labelled issues not imported before, oldest first so a backlog
 * arrives in the order it was written.
 */
export function issuesToImport(raw: readonly RawIssue[], imported: ReadonlySet<number>, label: string): RawIssue[] {
  return raw
    .filter((issue) => !issueProblem(issue) && hasLabel(issue, label) && !imported.has(issue.id))
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_IMPORTS_PER_REPO);
}

/** The card an issue becomes: its title, its body, and where it came from. */
export function cardFromIssue(issue: RawIssue, repo: string): { title: string; body: string; repo: string } {
  const title = (issue.title?.trim() || `Issue #${issue.number}`).replace(/\s+/g, " ");
  const source = `From ${issue.html_url ?? `${repo}#${issue.number}`}`;
  const room = MAX_BODY - source.length - 2;
  let body = (issue.body ?? "").replace(/\r\n/g, "\n").trim();
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return {
    title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
    body: body ? `${body}\n\n${source}` : source,
    repo,
  };
}

/**
 * The cursor for the next ask: the newest update seen. GitHub's `since` is
 * inclusive, so the newest issue comes back once more and is skipped as
 * already imported.
 */
export function nextSince(raw: readonly RawIssue[], previous: string | null): string | null {
  let newest = previous;
  for (const issue of raw) {
    if (issue.updated_at && (!newest || issue.updated_at > newest)) newest = issue.updated_at;
  }
  return newest;
}

/** The issue's repo, from its web address. */
export function issueRepo(url: string | null | undefined): string | null {
  const match = url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/);
  return match ? match[1] : null;
}

/**
 * "Closes #N" for the pull request body, so merging closes the issue. Only
 * for an issue in the card's own repo: a bare number means that repo.
 */
export function closesLine(card: Pick<Card, "repo" | "issueNumber" | "issueUrl">): string | null {
  if (!card.issueNumber || !card.repo) return null;
  const repo = issueRepo(card.issueUrl);
  if (repo && repo.toLowerCase() !== card.repo.toLowerCase()) return null;
  return `Closes #${card.issueNumber}`;
}

/** What Kru writes on the issue once the card's pull request opens. */
export function issueOpenedComment(prUrl: string): string {
  return `Kru opened a pull request for this: ${prUrl}\n\n${KRU_MARKER}`;
}

/** A label GitHub's issue filter can take: short, and no commas (they mean "and"). */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.length > 50 || label.includes(",")) return null;
  return label;
}
