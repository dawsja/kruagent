import {
  answerSteeringNotes,
  getActiveBotJobForCard,
  getCard,
  getRun,
  insertSteeringNote,
  listSteeringNotes,
  stopCardWork,
  takeSteeringNotes,
} from "../data.ts";
import type { BotId, BotStage, Card, SteeringNote } from "../types.ts";
import {
  STEER_RULES,
  fallbackDecision,
  isStopOrder,
  parseSteerDecision,
  progressLines,
  stageBot,
  steerDirection,
  steerPrompt,
  steeringSection,
  stopReason,
  type SteerOutcome,
} from "./steering-logic.ts";

/*
 * Steering a bot while it has a card. A message for a working bot is kept
 * as a note on the card instead of waiting for the run to end; the stage
 * that has the card reads it at its next safe point (between two steps of
 * the builder, between two of Kiko's commands, around Lulu's and Bibi's
 * question), decides what it means, says so in the room, and the run goes
 * on from that decision. The model call and the room are handed in, so
 * this is tested with neither.
 */

export type SteerDeps = {
  /** One question to the card's model; null or a throw when it can't be reached. */
  ask: (question: { bot: BotId; instructions: string; prompt: string }) => Promise<string | null>;
  /** The bot's answer, posted in the room. */
  say: (bot: BotId, text: string, options: { replyTo: string | null; cardId: string }) => void;
};

/** Who is working a card right now: the crew's stage, or a run started by hand. */
export function workingOn(card: Card): { stage: BotStage; bot: BotId; runId: string | null } | null {
  const job = getActiveBotJobForCard(card.id);
  if (job) {
    const bot = stageBot(job.stage);
    return bot ? { stage: job.stage, bot, runId: job.runId } : null;
  }
  // A run the person started from the card has no bot; Pip speaks for it.
  if (card.status === "running" && card.runId && getRun(card.runId)?.status === "running") {
    return { stage: "build", bot: "pip", runId: card.runId };
  }
  return null;
}

/**
 * Leaves a note for whoever is working the card. Null when nobody is: the
 * caller then does what it did before steering existed.
 */
export function queueSteering(
  card: Card,
  note: { id: string; author: SteeringNote["author"]; body: string; messageId?: string | null },
): SteeringNote | null {
  const body = note.body.trim();
  const working = workingOn(card);
  if (!working || !body) return null;
  const queued: SteeringNote = {
    id: note.id,
    cardId: card.id,
    runId: working.runId,
    stage: working.stage,
    bot: working.bot,
    author: note.author,
    body,
    messageId: note.messageId ?? null,
    decision: null,
    reply: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  };
  insertSteeringNote(queued);
  return queued;
}

/** The direction given on a card so far, for the prompts of whoever works it next. */
export function steeringFor(cardId: string): string | null {
  return steeringSection(listSteeringNotes(cardId, { read: true })) || null;
}

/**
 * A safe point. Reads the notes waiting on the card, has the working bot
 * decide, posts its answer in the room and keeps both with the card. A
 * decision to stop halts the work here, before this returns. Null when no
 * note was waiting, or the card stopped being worked on in the meantime.
 */
export async function considerSteering(cardId: string, deps: SteerDeps): Promise<SteerOutcome | null> {
  const card = getCard(cardId);
  const working = card ? workingOn(card) : null;
  if (!card || !working) return null;
  const earlier = listSteeringNotes(cardId, { read: true });
  const notes = takeSteeringNotes(cardId);
  if (notes.length === 0) return null;

  // A plain "stop" is an order, not a question for a model.
  let answer = notes.some((note) => isStopOrder(note.body)) ? fallbackDecision(notes) : null;
  if (!answer) {
    const run = working.runId ? getRun(working.runId) : null;
    const text = await deps
      .ask({
        bot: working.bot,
        instructions: STEER_RULES,
        prompt: steerPrompt({ bot: working.bot, stage: working.stage, card, notes, progress: progressLines(run?.log ?? []), earlier }),
      })
      .catch(() => null);
    answer = parseSteerDecision(text) ?? fallbackDecision(notes);
  }

  // A run that is pushing to GitHub can't be halted; never say it was.
  if (answer.decision === "stop" && !stopCardWork(cardId, stopReason(notes))) {
    answer = { decision: "continue", reply: "I can't stop this one right now: it's past the point where it can be halted. It finishes in a moment." };
  }
  const { decision, reply } = answer;
  answerSteeringNotes(notes.map((note) => note.id), decision, reply);
  const from = notes.findLast((note) => note.messageId)?.messageId ?? null;
  deps.say(working.bot, decision === "stop" ? `${reply} Ask Pip to run the card again to pick it up from here.` : reply, {
    replyTo: from,
    cardId,
  });
  return { decision, reply, notes, direction: steerDirection(notes, decision, reply) };
}

/**
 * Notes nobody read before the crew was done with the card: marked read,
 * and returned so the room can be told they came too late.
 */
export function lateSteering(cardId: string): SteeringNote[] {
  return takeSteeringNotes(cardId);
}
