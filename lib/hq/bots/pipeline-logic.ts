import type { BotJob, Card, Run } from "../types";

/*
 * The pure parts of the crew's pipeline: what Kiko runs, how Lulu's verdict
 * is read, and the prompts Lulu and Bibi get. Nothing here talks to the box
 * or the database, so it is tested directly.
 */

/** How many times Lulu may send a card back to Momo before passing it on with a warning. */
export const MAX_REVIEW_ROUNDS = Math.max(0, Number(process.env.KRU_BOT_REVIEW_ROUNDS ?? 2) || 0);

export type Verdict = { verdict: "pass" | "changes"; notes: string };

/**
 * Lulu answers with `VERDICT: PASS` or `VERDICT: CHANGES` on the first line.
 * Anything else passes with a note, so a confused model never loops.
 */
export function parseVerdict(text: string | null | undefined): Verdict {
  const clean = (text ?? "").trim();
  const match = /^\s*\**\s*VERDICT\s*:\s*\**\s*(PASS|CHANGES)\b\**/im.exec(clean);
  if (!match) {
    return { verdict: "pass", notes: clean ? `Review inconclusive: ${clean.slice(0, 500)}` : "Review inconclusive." };
  }
  const notes = clean
    .replace(match[0], "")
    .replace(/^[\s.:]+/, "")
    .trim();
  return { verdict: match[1].toUpperCase() === "CHANGES" ? "changes" : "pass", notes };
}

/** How many times the crew tries a card again after it failed on the work. */
export function maxRetries() {
  const n = Number(process.env.KRU_BOT_RETRIES ?? 1);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

/** How long the crew waits before trying again: a box restart or a flaky install has time to pass. */
export const RETRY_BACKOFF_MS = 2 * 60 * 1000;

/**
 * Why a job stopped, as far as a retry cares. `setup` is something only the
 * person can fix (no repo, no model, GitHub disconnected); `work` is the run
 * or a stage failing, which may well go through next time; `handed` means
 * the change reached the person anyway, with a warning.
 */
export type FailureCause = "setup" | "work" | "handed";

/** When to try again, or null to leave the card for the person. */
export function retryPlan(
  cause: FailureCause,
  attempts: number,
  now: number,
  max = maxRetries(),
  backoff = RETRY_BACKOFF_MS,
): string | null {
  if (cause !== "work" || attempts >= max) return null;
  return new Date(now + backoff).toISOString();
}

/**
 * Whether a planned retry still makes sense: the card is still where the
 * failure left it and nothing newer happened to it.
 */
export function retryStillWanted(
  failed: Pick<BotJob, "id" | "runId">,
  card: Pick<Card, "status" | "runId"> | null,
  latestJobId: string | null,
): boolean {
  if (!card || card.status !== "error") return false;
  if (latestJobId !== failed.id) return false;
  return !failed.runId || !card.runId || card.runId === failed.runId;
}

/** Whether the next stage is another build round or the write-up. */
export function nextStageAfterReview(verdict: Verdict["verdict"], rounds: number, max = MAX_REVIEW_ROUNDS) {
  return verdict === "changes" && rounds < max ? "build" : "scribe";
}

/** The scripts Kiko runs, in order, from a package.json: lint, test, build. */
export function testPlan(packageJson: unknown, hasBunLock: boolean): string[] {
  const scripts =
    packageJson && typeof packageJson === "object" && "scripts" in packageJson
      ? ((packageJson as { scripts?: unknown }).scripts as Record<string, unknown> | undefined)
      : undefined;
  if (!scripts || typeof scripts !== "object") return [];
  const runner = hasBunLock ? "bun run" : "npm run";
  return ["lint", "test", "build"]
    .filter((name) => typeof scripts[name] === "string" && String(scripts[name]).trim())
    .map((name) => `${runner} ${name}`);
}

export type TestResult = { command: string; exitCode: number; timedOut: boolean; output: string };

/** Longest output kept per command in the report. */
const REPORT_OUTPUT_CHARS = 3_000;

export function testsPassed(results: TestResult[]) {
  return results.every((result) => !result.timedOut && result.exitCode === 0);
}

export function formatTestReport(results: TestResult[], note?: string): string {
  if (results.length === 0) return note ?? "No checks to run: the repo defines no lint, test or build script.";
  const lines = results.map((result) => {
    const status = result.timedOut ? "timed out" : result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`;
    const tail = result.output.trim().slice(-REPORT_OUTPUT_CHARS);
    return `$ ${result.command}\n${status}${tail && status !== "passed" ? `\n${tail}` : ""}`;
  });
  return [note, ...lines].filter(Boolean).join("\n\n");
}

/** One line for the room: "all 3 passed" or "1 of 3 failed (test)". */
export function testHeadline(results: TestResult[]): string {
  if (results.length === 0) return "nothing to run";
  const failed = results.filter((result) => result.timedOut || result.exitCode !== 0);
  if (failed.length === 0) return `all ${results.length} passed`;
  const names = failed.map((result) => result.command.split(" ").at(-1)).join(", ");
  return `${failed.length} of ${results.length} failed (${names})`;
}

/** Diff text quoted to Lulu and Bibi, in total. */
const MAX_DIFF_CHARS = 40_000;

export function diffDigest(run: Run): string {
  let budget = MAX_DIFF_CHARS;
  const files = run.proposedWrites.map((write) => {
    const head = `${write.deleted ? "deleted" : "changed"} ${write.path}`;
    if (!write.diff || budget <= 0) return head;
    const shown = write.diff.slice(0, budget);
    budget -= shown.length;
    return `${head}\n${shown}${shown.length < write.diff.length ? "\n[… diff truncated …]" : ""}`;
  });
  return files.length ? files.join("\n\n") : "(no files changed)";
}

export const REVIEW_RULES = [
  "Review the change below against the card's task. Decide whether it should go to the person for approval or back to the builder.",
  "Send it back only for problems that matter: it doesn't do what the task asked, it's incorrect, it breaks something, tests fail because of it, or it does something unsafe. Style, naming and nits are notes for the person, not a reason to send it back.",
  "Answer with `VERDICT: PASS` or `VERDICT: CHANGES` on the first line. Then, in a few short lines, the notes: for CHANGES, exactly what the builder must change, with file names; for PASS, anything the person should look at closely, or nothing.",
  "Plain text. No headings, no greeting, no restating the diff.",
].join("\n");

/** Whether a run continues an open pull request rather than starting a card. */
export function isFollowUp(run: Pick<Run, "prUrl" | "headBranch" | "status">) {
  return Boolean(run.prUrl && run.headBranch && run.status !== "approved" && run.status !== "merged");
}

/**
 * What Lulu may do when she has the workspace: look, and run things, but
 * never change it. Her tools don't stop an edit, so the rule says it, and
 * Kru puts the workspace back if it moved anyway.
 */
export const REVIEW_TOOL_RULES = [
  "You have the run's workspace: the repo with the change applied, and a shell in it. Use it when reading the diff isn't enough: open the files around the change, grep for other callers, run the one test that covers it.",
  "Look, don't touch. Do not edit, create, delete or format files, install packages, or run git commands that change the tree. Whatever you change is thrown away before the person sees the card.",
  "A few commands at most, then your verdict. Kiko already ran the full checks.",
].join("\n");

/** The person's standing instructions for a repo, as a prompt section. */
export function repoInstructionsSection(instructions: string | null | undefined): string {
  const text = instructions?.trim();
  return text ? `Standing instructions for this repo, from the person:\n${text}` : "";
}

export function reviewPrompt(card: Card, run: Run, testReport: string | null, repoInstructions?: string | null): string {
  return [
    `Repo: ${card.repo}`,
    `Task: ${card.title}`,
    card.body ? `Details:\n${card.body}` : "",
    repoInstructionsSection(repoInstructions),
    isFollowUp(run)
      ? `This is a follow-up on pull request${run.prNumber ? ` #${run.prNumber}` : ""}, which is already open: the change below is only what this round adds to it. Judge whether it answers what was asked.`
      : "",
    run.revisionNote ? `What this round was asked to do:\n${run.revisionNote}` : "",
    run.summary ? `The builder's summary: ${run.summary}` : "",
    run.warning ? `Warning from the run: ${run.warning}` : "",
    `Kiko's checks:\n${testReport ?? "not run"}`,
    `The change:\n${diffDigest(run)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const SCRIBE_RULES = [
  "Write the summary the person reads on the card before approving the pull request: what changed and why, in plain words, three to six short lines. Mention anything the reviewer flagged for a close look.",
  "Plain text or a short bullet list. No headings, no greeting, no commit message: that is written separately.",
].join("\n");

export function scribePrompt(card: Card, run: Run, testReport: string | null, reviewNotes: string | null): string {
  return [
    `Repo: ${card.repo}`,
    `Task: ${card.title}`,
    card.body ? `Details:\n${card.body}` : "",
    run.summary ? `The builder's summary: ${run.summary}` : "",
    `Kiko's checks:\n${testReport ?? "not run"}`,
    reviewNotes ? `Lulu's notes: ${reviewNotes}` : "",
    `The change:\n${diffDigest(run)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Lulu's notes in a run's log, newest last, for the card's history. */
export function reviewNotesIn(log: readonly string[]): { verdict: "pass" | "changes"; notes: string }[] {
  const reviews: { verdict: "pass" | "changes"; notes: string }[] = [];
  for (const line of log) {
    const match = /^Review by Lulu: (PASS|CHANGES)\n?([\s\S]*)$/.exec(line);
    if (match) reviews.push({ verdict: match[1] === "PASS" ? "pass" : "changes", notes: match[2].trim() });
  }
  return reviews;
}

/** Longest summary kept on the card. */
const MAX_SUMMARY_CHARS = 2_000;

export function cleanSummary(text: string | null | undefined): string | null {
  const clean = (text ?? "").trim();
  if (!clean) return null;
  return clean.length > MAX_SUMMARY_CHARS ? `${clean.slice(0, MAX_SUMMARY_CHARS)}…` : clean;
}
