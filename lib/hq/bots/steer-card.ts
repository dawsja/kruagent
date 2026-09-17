import { askCardModel } from "../card-model";
import { hasPendingSteering } from "../data";
import type { Card, Run } from "../types";
import { postBotMessage } from "./room";
import { stageInstructions } from "./souls";
import { considerSteering } from "./steering";
import type { SteerOutcome } from "./steering-logic";

/*
 * Steering with the real model and the real room plugged in: the working
 * bot's decision is one question to the card's own model, and its answer is
 * a line in the Team room under the message that steered it.
 */

/** Longest a bot may take to decide what a note means. */
const DECISION_TIMEOUT_MS = 90_000;

/**
 * A safe point for the card: answers any notes waiting on it. Null when
 * there were none. `run` is where a Claude Code card's question is asked.
 */
export function considerCardSteering(card: Card, run: Run | null): Promise<SteerOutcome | null> {
  if (!hasPendingSteering(card.id)) return Promise.resolve(null);
  return considerSteering(card.id, {
    // In the working bot's own voice, like its stage.
    ask: async ({ bot, instructions, prompt }) =>
      run
        ? askCardModel(card, run, {
            instructions: stageInstructions(bot, instructions),
            prompt,
            timeoutMs: DECISION_TIMEOUT_MS,
            readOnly: true,
          })
        : null,
    say: (bot, text, options) => {
      postBotMessage(bot, text, { replyTo: options.replyTo, depth: 1, cardId: options.cardId });
    },
  });
}
