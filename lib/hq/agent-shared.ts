import type { Card, Connection, ProposedWrite } from "./types";

/*
 * What every card runner shares: the input and result shapes, the prompts
 * built from a card, and the limits. Kept apart from `agent.ts` so the
 * Claude Code runner (and the tests) can load it without the AI SDK.
 */

/** Longest a run may take before it is stopped and what it did is reviewed. */
export const BOX_RUN_TIMEOUT_MS = 45 * 60 * 1000;
/** Longest command echoed into the run log. */
export const LOG_COMMAND_CHARS = 1_000;

/** Longest piece of the agent's own words echoed into the run log. */
export const LOG_TEXT_CHARS = 4_000;

/** The agent's words as the run log keeps them: Markdown, capped in length. */
export function logText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > LOG_TEXT_CHARS ? `${trimmed.slice(0, LOG_TEXT_CHARS)}…` : trimmed;
}

/** A command as the run log keeps it: its own line breaks, capped in length. */
export function logCommand(command: string): string {
  const trimmed = command.trim();
  return `$ ${trimmed.length > LOG_COMMAND_CHARS ? `${trimmed.slice(0, LOG_COMMAND_CHARS)}…` : trimmed}`;
}

export const REVIEW_CAREFULLY = "Review carefully; the work may be unfinished.";

/**
 * The agent finished but its changes couldn't be collected for review (too
 * many files, say). The workspace is left standing so the work isn't lost;
 * the error says where it is.
 */
export class CollectFailedError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : "Collecting the changes failed";
    super(
      `${detail.replace(/\.?$/, ".")} The agent's work is still in the box: open a shell in the workspace from this card to recover it. It's kept for up to a day, or until newer runs need the room.`,
    );
    this.name = "CollectFailedError";
  }
}

/** The first task line when there is no previous run to continue from. */
export const FRESH_START = "Start by looking at the repo layout and any contributor docs.";

export type AgentInput = {
  card: Card;
  github: Connection;
  model: Connection;
  /** The repo's default branch, looked up before the run starts. */
  branch: string;
  /**
   * A finished run's workspace to continue in, when the box still has it.
   * Falls back to a fresh clone plus `previous`, which is the record that
   * always survives.
   */
  adopt?: string | null;
  /** Names the box workspace, so a cancelled run can be cleaned up. */
  runId: string;
  log: (line: string) => void;
  /** True once the person cancelled the run; the agent stops at its next step. */
  isCancelled?: () => boolean;
  /**
   * For a revision: the previous run's changes are applied to the clone
   * first, and the reviewer's note becomes the task. `applied` says they
   * are already on the branch being cloned (a follow-up on a pull request),
   * so nothing is written before the agent starts.
   */
  previous?: { writes: ProposedWrite[]; summary: string | null; note: string; applied?: boolean };
  /** The person's standing instructions for the card's repo. */
  repoInstructions?: string | null;
};

/** Longest repo agent notes (AGENTS.md, CLAUDE.md) quoted into a prompt. */
export const MAX_AGENT_NOTES_CHARS = 8_000;

/**
 * The repo's own notes for agents, as a prompt section: the first of
 * AGENTS.md or CLAUDE.md that exists, capped. Claude Code reads these by
 * itself; Kru's own runner quotes them.
 */
export function agentNotesSection(file: { name: string; content: string } | null): string {
  if (!file?.content.trim()) return "";
  const text = file.content.trim();
  const shown = text.length > MAX_AGENT_NOTES_CHARS ? `${text.slice(0, MAX_AGENT_NOTES_CHARS)}\n[… truncated …]` : text;
  return `The repo's ${file.name}, notes for agents working in it:\n${shown}`;
}

export type AgentResult = { writes: ProposedWrite[]; warning: string | null; summary: string | null };

/** Cancelled runs end with this error; the run route ignores it. */
export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export function taskPrompt(input: AgentInput, extra: string[]) {
  const standing = input.repoInstructions?.trim();
  return [
    `Repo: ${input.card.repo}`,
    `Task: ${input.card.title}`,
    input.card.body ? `Details:\n${input.card.body}` : "",
    standing ? `Standing instructions for this repo, from the person:\n${standing}` : "",
    ...extra,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** True for the abort our own run timeout raises. */
export function isTimeout(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /abort|timeout/i.test(error.message);
}

/** Diff text quoted back to the model in a revision prompt, in total. */
const MAX_REVISION_DIFF_CHARS = 40_000;

export function revisionPrompt(previous: NonNullable<AgentInput["previous"]>) {
  let budget = MAX_REVISION_DIFF_CHARS;
  const files = previous.writes.map((write) => {
    const head = `${write.deleted ? "deleted" : "changed"} ${write.path}`;
    if (!write.diff || budget <= 0) return head;
    const shown = write.diff.slice(0, budget);
    budget -= shown.length;
    return `${head}\n${shown}${shown.length < write.diff.length ? "\n[… diff truncated …]" : ""}`;
  });
  if (previous.applied) {
    return [
      "This is a follow-up on an open pull request. Your working directory is a clone of the pull request's branch, which already holds the changes below; what you change now is pushed to that pull request as one more commit.",
      previous.summary ? `What the pull request does: ${previous.summary}` : "",
      files.join("\n\n"),
      `Feedback arrived on the pull request:\n${previous.note}`,
      "Address the feedback. Change only what it needs; the rest of the pull request stands.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    "This is a revision. A previous run already made these changes, and they are applied in your working directory:",
    previous.summary ? `Previous summary: ${previous.summary}` : "",
    files.join("\n\n"),
    `The reviewer looked at that and asked for changes:\n${previous.note}`,
    "Continue from the current state of the files. Keep what the reviewer didn't object to.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
