import type { Card, Run } from "./types";

/*
 * The commit message for an approved run. The agent's summary is written for
 * a reviewer, often Markdown and several sentences long, so on approve the
 * card's own model is asked for a proper subject line. These are the pure
 * parts; the model call is in `commit-message-model.ts`.
 */

export const MAX_SUBJECT_CHARS = 72;
/** Most diff text handed to the model; the paths alone are usually enough. */
export const MAX_PROMPT_DIFF_CHARS = 8_000;

export const COMMIT_MESSAGE_INSTRUCTIONS = [
  "You write git commit messages.",
  `Reply with one commit subject line: imperative mood, at most ${MAX_SUBJECT_CHARS} characters, no Markdown, no quotes, no trailing period.`,
  "Reply with the line only. Do not run tools or change files.",
].join(" ");

/** What the model sees: the task, what the agent said, and what changed. */
export function commitMessagePrompt(card: Pick<Card, "title" | "body">, run: Pick<Run, "summary" | "proposedWrites">) {
  const parts = [`Task: ${card.title}`];
  if (card.body.trim()) parts.push(`Details:\n${card.body.trim()}`);
  if (run.summary?.trim()) parts.push(`What the agent says it did:\n${run.summary.trim()}`);

  const files = run.proposedWrites.map((write) => {
    const kind = write.deleted ? "deleted" : /^new file/m.test(write.diff ?? "") ? "added" : "changed";
    return `- ${write.path} (${kind})`;
  });
  parts.push(`Files:\n${files.join("\n")}`);

  let budget = MAX_PROMPT_DIFF_CHARS;
  const diffs: string[] = [];
  for (const write of run.proposedWrites) {
    if (!write.diff || budget <= 0) continue;
    const diff = write.diff.length > budget ? `${write.diff.slice(0, budget)}\n[… trimmed]` : write.diff;
    budget -= write.diff.length;
    diffs.push(diff);
  }
  if (diffs.length > 0) parts.push(`Diff:\n${diffs.join("\n")}`);

  parts.push("Write the commit subject line.");
  return parts.join("\n\n");
}

/**
 * A model's reply, or any prose, made into a subject line: the first real
 * line, without Markdown, quotes, labels or a closing period, cut on a word
 * boundary. Null when nothing usable is left.
 */
export function cleanCommitMessage(text: string | null | undefined): string | null {
  const line = (text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part && !/^```/.test(part));
  if (!line) return null;

  let subject = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^(?:commit(?: message)?|subject(?: line)?)\s*:\s*/i, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  subject = subject.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  subject = subject.replace(/[.。]+$/, "").trim();
  if (!subject) return null;

  if (subject.length > MAX_SUBJECT_CHARS) {
    const cut = subject.slice(0, MAX_SUBJECT_CHARS + 1);
    const space = cut.lastIndexOf(" ");
    subject = (space > 20 ? cut.slice(0, space) : subject.slice(0, MAX_SUBJECT_CHARS)).replace(/[\s,;:.-]+$/, "");
  }
  return subject;
}

/** Used when the model can't be asked: the summary's first sentence, the card title, or the path. */
export function fallbackCommitMessage(card: Pick<Card, "title">, run: Pick<Run, "summary" | "proposedWrites">) {
  const firstSentence = run.summary?.trim().split("\n")[0].split(/(?<=[.!?])\s/)[0];
  return (
    cleanCommitMessage(firstSentence) ??
    cleanCommitMessage(card.title) ??
    `Update ${run.proposedWrites[0]?.path ?? "files"}`
  );
}
