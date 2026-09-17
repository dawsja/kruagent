import type { PrFeedback, PrFeedbackKind } from "./types.ts";

/*
 * What GitHub says about a pull request, turned into feedback the crew can
 * act on: reviews, comments on the diff and the conversation, and checks
 * that failed. Nothing here talks to GitHub or the database; the sync hands
 * in the raw answers and stores what comes out.
 */

/** Marks a comment Kru wrote, so it is never read back as feedback. */
export const KRU_MARKER = "<!-- kru -->";

/** Longest revision note built from feedback. */
export const MAX_NOTE_CHARS = 6_000;
/** Longest quote of one item in a room event. */
const EVENT_QUOTE_CHARS = 140;
/** Longest quote of one item in the note. */
const NOTE_QUOTE_CHARS = 2_000;

/** Fields the sync passes on from a raw GitHub answer. */
export type FeedbackItem = Pick<
  PrFeedback,
  "id" | "kind" | "author" | "body" | "path" | "line" | "url" | "state" | "githubUpdatedAt"
>;

type RawUser = { login?: string; type?: string } | null;

export type RawReview = {
  id: number;
  user?: RawUser;
  body?: string | null;
  state?: string;
  html_url?: string;
  submitted_at?: string | null;
};

export type RawReviewComment = {
  id: number;
  user?: RawUser;
  body?: string | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  html_url?: string;
  updated_at?: string;
  created_at?: string;
};

export type RawIssueComment = {
  id: number;
  user?: RawUser;
  body?: string | null;
  html_url?: string;
  updated_at?: string;
  created_at?: string;
};

export type RawCheckRun = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  html_url?: string | null;
  details_url?: string | null;
  completed_at?: string | null;
  started_at?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
};

export type RawAnnotation = {
  path?: string;
  start_line?: number;
  annotation_level?: string;
  message?: string;
  title?: string | null;
};

/** Conclusions worth a follow-up; "skipped", "neutral" and "cancelled" are not. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);

function skipUser(user: RawUser | undefined) {
  return user?.type === "Bot";
}

function skipBody(body: string | null | undefined): body is null | undefined {
  return !body || !body.trim() || body.includes(KRU_MARKER);
}

function clean(text: string, limit: number) {
  const flat = text.trim().replace(/\r\n/g, "\n");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function oneLine(text: string, limit: number) {
  return clean(text.replace(/\s+/g, " "), limit);
}

/**
 * Reviews with something to say. An approval is returned apart, for a line in
 * the room and nothing more; a review with no body is the shell around
 * comments on the diff, which arrive on their own.
 */
export function normalizeReviews(raw: RawReview[]): { feedback: FeedbackItem[]; approvals: FeedbackItem[] } {
  const feedback: FeedbackItem[] = [];
  const approvals: FeedbackItem[] = [];
  for (const review of raw) {
    if (skipUser(review.user)) continue;
    const state = (review.state ?? "").toUpperCase();
    if (state === "PENDING" || state === "DISMISSED") continue;
    const item: FeedbackItem = {
      id: `review:${review.id}`,
      kind: "review",
      author: review.user?.login ?? null,
      body: skipBody(review.body) ? "" : review.body.trim(),
      path: null,
      line: null,
      url: review.html_url ?? null,
      state,
      githubUpdatedAt: review.submitted_at ?? new Date(0).toISOString(),
    };
    if (state === "APPROVED") {
      approvals.push(item);
      continue;
    }
    if (skipBody(review.body)) continue;
    feedback.push(item);
  }
  return { feedback, approvals };
}

export function normalizeReviewComments(raw: RawReviewComment[]): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const comment of raw) {
    if (skipUser(comment.user) || skipBody(comment.body)) continue;
    items.push({
      id: `review_comment:${comment.id}`,
      kind: "review_comment",
      author: comment.user?.login ?? null,
      body: comment.body.trim(),
      path: comment.path ?? null,
      line: comment.line ?? comment.original_line ?? null,
      url: comment.html_url ?? null,
      state: null,
      githubUpdatedAt: comment.updated_at ?? comment.created_at ?? new Date(0).toISOString(),
    });
  }
  return items;
}

export function normalizeIssueComments(raw: RawIssueComment[]): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const comment of raw) {
    if (skipUser(comment.user) || skipBody(comment.body)) continue;
    items.push({
      id: `issue_comment:${comment.id}`,
      kind: "issue_comment",
      author: comment.user?.login ?? null,
      body: comment.body.trim(),
      path: null,
      line: null,
      url: comment.html_url ?? null,
      state: null,
      githubUpdatedAt: comment.updated_at ?? comment.created_at ?? new Date(0).toISOString(),
    });
  }
  return items;
}

/** The id GitHub gave a check run, from a feedback id, for fetching its annotations. */
export function checkRunId(item: Pick<FeedbackItem, "id" | "kind">): number | null {
  if (item.kind !== "check") return null;
  const n = Number(item.id.slice("check:".length));
  return Number.isFinite(n) ? n : null;
}

/**
 * Checks that finished badly on the commit Kru pushed. A check on an older
 * commit is history; one still running has nothing to say yet.
 */
export function normalizeCheckRuns(raw: RawCheckRun[], headSha: string | null): FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (const check of raw) {
    if (check.status !== "completed") continue;
    if (!check.conclusion || !FAILED_CONCLUSIONS.has(check.conclusion)) continue;
    if (headSha && check.head_sha && check.head_sha !== headSha) continue;
    const name = check.name?.trim() || "check";
    const title = check.output?.title?.trim();
    const summary = check.output?.summary?.trim();
    const body = [title && title !== name ? title : "", summary ? clean(summary, NOTE_QUOTE_CHARS) : ""]
      .filter(Boolean)
      .join("\n");
    items.push({
      id: `check:${check.id}`,
      kind: "check",
      author: name,
      body: body || `${name} ${check.conclusion.replace(/_/g, " ")}`,
      path: null,
      line: null,
      url: check.html_url ?? check.details_url ?? null,
      state: check.conclusion,
      githubUpdatedAt: check.completed_at ?? check.started_at ?? new Date(0).toISOString(),
    });
  }
  return items;
}

/** The lines a check's annotations add to its body: where it failed. */
export function annotationLines(raw: RawAnnotation[], limit = 20): string[] {
  return raw
    .filter((a) => a.annotation_level === "failure" || a.annotation_level === "warning")
    .slice(0, limit)
    .map((a) => {
      const where = a.path ? `${a.path}${a.start_line ? `:${a.start_line}` : ""}` : "";
      const what = oneLine(a.message ?? a.title ?? "", 300);
      return [where, what].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

/** Short acknowledgements that ask for nothing. */
const ACK = /^\s*(lgtm|looks good( to me)?|nice( one)?|great|thanks?( you)?|ty|ship it|approved?|\+1|👍|🎉|:\+1:|:thumbsup:|:tada:)[\s.!]*$/i;

/** False for a comment that asks for nothing, so "LGTM" never costs a run. */
export function isActionable(item: Pick<FeedbackItem, "kind" | "body" | "state">): boolean {
  if (item.kind === "check") return true;
  if (item.kind === "review" && item.state === "CHANGES_REQUESTED") return true;
  return !ACK.test(item.body);
}

function who(item: Pick<FeedbackItem, "author">) {
  return item.author ? `@${item.author}` : "someone";
}

const KIND_ORDER: PrFeedbackKind[] = ["review", "review_comment", "issue_comment", "check"];

/**
 * The revision note a follow-up run starts from: what each reviewer and
 * check said, oldest first within its kind, checks last since their logs
 * are longest. Capped, so a long CI log can't crowd out the reviewer.
 */
export function feedbackNote(items: readonly FeedbackItem[], prNumber: number | null): string {
  const pr = prNumber ? `pull request #${prNumber}` : "the pull request";
  const parts: string[] = [`Feedback on ${pr}:`];
  const byKind = new Map<PrFeedbackKind, FeedbackItem[]>();
  for (const item of items) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item]);
  for (const kind of KIND_ORDER) {
    const list = (byKind.get(kind) ?? []).sort((a, b) => a.githubUpdatedAt.localeCompare(b.githubUpdatedAt));
    for (const item of list) {
      switch (item.kind) {
        case "review":
          parts.push(
            `Review by ${who(item)}${item.state === "CHANGES_REQUESTED" ? " (changes requested)" : ""}:\n${clean(item.body, NOTE_QUOTE_CHARS)}`,
          );
          break;
        case "review_comment":
          parts.push(
            `${who(item)} on ${item.path ?? "the diff"}${item.line ? `:${item.line}` : ""}:\n${clean(item.body, NOTE_QUOTE_CHARS)}`,
          );
          break;
        case "issue_comment":
          parts.push(`${who(item)} commented:\n${clean(item.body, NOTE_QUOTE_CHARS)}`);
          break;
        case "check":
          parts.push(`CI check \`${item.author ?? "check"}\` ${item.state?.replace(/_/g, " ") ?? "failed"}:\n${clean(item.body, NOTE_QUOTE_CHARS)}`);
          break;
      }
    }
  }
  parts.push("Address each point. Change only what the feedback needs; the rest of the pull request stands.");
  let note = parts.join("\n\n");
  if (note.length > MAX_NOTE_CHARS) note = `${note.slice(0, MAX_NOTE_CHARS - 1)}…`;
  return note;
}

/** One line for the room when an item arrives. */
export function feedbackEvent(item: FeedbackItem, prNumber: number | null): string {
  const pr = prNumber ? `PR #${prNumber}` : "the PR";
  const quote = oneLine(item.body, EVENT_QUOTE_CHARS);
  switch (item.kind) {
    case "review":
      return item.state === "CHANGES_REQUESTED"
        ? `A review on ${pr} by ${who(item)} asked for changes: ${quote}`
        : `${who(item)} reviewed ${pr}: ${quote}`;
    case "review_comment":
      return `${who(item)} commented on ${item.path ?? "the diff"}${item.line ? `:${item.line}` : ""} in ${pr}: ${quote}`;
    case "issue_comment":
      return `${who(item)} commented on ${pr}: ${quote}`;
    case "check":
      return `CI failed on ${pr}: ${item.author ?? "a check"}${item.state && item.state !== "failure" ? ` (${item.state.replace(/_/g, " ")})` : ""}`;
  }
}

/** The line for the room when someone approves. */
export function approvalEvent(item: FeedbackItem, prNumber: number | null): string {
  const pr = prNumber ? `PR #${prNumber}` : "the PR";
  return `${who(item)} approved ${pr}${item.body ? `: ${oneLine(item.body, EVENT_QUOTE_CHARS)}` : ""}`;
}

/** What Kru writes on the pull request after pushing a follow-up. */
export function followUpComment(items: Pick<FeedbackItem, "kind" | "author">[], sha: string | null): string {
  const people = [...new Set(items.filter((i) => i.kind !== "check" && i.author).map((i) => `@${i.author}`))];
  const checks = [...new Set(items.filter((i) => i.kind === "check" && i.author).map((i) => `\`${i.author}\``))];
  const reasons: string[] = [];
  if (people.length) reasons.push(`${people.join(", ")}'s comments`);
  if (checks.length) reasons.push(`the failing ${checks.join(", ")} check${checks.length === 1 ? "" : "s"}`);
  const head = sha ? `Pushed a follow-up (${sha.slice(0, 7)})` : "Pushed a follow-up";
  return `${head}${reasons.length ? ` for ${reasons.join(" and ")}` : ""}.\n\n${KRU_MARKER}`;
}

/** The stored ETags with the ones a sync just got; an undefined key is left as it was. */
export function mergeEtags<T extends Record<string, string | null | undefined>>(
  previous: T | null | undefined,
  patch: Partial<T>,
): T {
  const merged = { ...(previous ?? {}) } as Record<string, string | null | undefined>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}
