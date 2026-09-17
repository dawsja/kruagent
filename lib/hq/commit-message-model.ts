import { askCardModel } from "./card-model";
import {
  COMMIT_MESSAGE_INSTRUCTIONS,
  cleanCommitMessage,
  commitMessagePrompt,
  fallbackCommitMessage,
} from "./commit-message";
import type { Card, Run } from "./types";

/** An approve waits on this, so the model gets a short time before the fallback. */
const COMMIT_MESSAGE_TIMEOUT_MS = 30_000;

/**
 * Asks the card's own model for a commit subject line. Never throws: when the
 * model can't be reached or says nothing usable, the summary stands in.
 */
export async function generateCommitMessage(card: Card, run: Run): Promise<string> {
  const fallback = fallbackCommitMessage(card, run);
  try {
    const text = await askCardModel(card, run, {
      instructions: COMMIT_MESSAGE_INSTRUCTIONS,
      prompt: commitMessagePrompt(card, run),
      timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
    });
    return (text && cleanCommitMessage(text)) ?? fallback;
  } catch {
    return fallback;
  }
}
