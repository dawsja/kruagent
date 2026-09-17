import { getActiveBotJobForCard, getRun, listCards } from "../data.ts";
import type { Card } from "../types.ts";
import { matchCard, parsePick } from "./pr-request-logic.ts";
import { numbered, waitingCards, type Waiting } from "./pr-request.ts";
import { parseReviseRequest } from "./revise-request-logic.ts";

/*
 * "On the landing page one, make the hero smaller" from the person in the
 * Team room. Like "make the PR for …", Kru answers it itself rather than
 * handing it to a bot: the words are matched loosely against the cards
 * waiting in Review, and the matched card goes through the same revise flow
 * as the "Ask for changes" box on the card, with the rest of the message as
 * the note. When the words fit more than one card, Pip lists them and the
 * person answers with a number; the note is kept for the pick.
 */

/** How long a numbered list stays answerable. */
const PICK_TTL_MS = 15 * 60 * 1000;

type PendingPick = { cardIds: string[]; note: string; at: number };
const holder = globalThis as typeof globalThis & { __kruRevisePick?: PendingPick | null };

export type ReviseChatResult = {
  /** Pip's answer, posted as an event; unused when `revise` is set. */
  reply: string;
  cardId: string | null;
  /** Set when the card is found and waiting: send this run back with the note. */
  revise: { runId: string; card: Card; note: string } | null;
};

function revising(entry: Waiting, note: string): ReviseChatResult {
  holder.__kruRevisePick = null;
  return { reply: "", cardId: entry.card.id, revise: { runId: entry.run.id, card: entry.card, note } };
}

/** Why a card that isn't waiting in Review can't be sent back from here. */
function notWaiting(card: Card): string {
  if (getActiveBotJobForCard(card.id) || card.status === "running") {
    return `"${card.title}" is still being worked on; @mention the bot that has it to steer it now, or tell me what to change once it's in Review.`;
  }
  if (card.status === "approved" || card.status === "merged") {
    const url = card.runId ? getRun(card.runId)?.prUrl : null;
    return `"${card.title}" already has a pull request${url ? ` (${url})` : ""}, so it can't be sent back. Make a new card for the follow-up.`;
  }
  if (card.status === "error") {
    return `"${card.title}" stopped with an error, so there's no result to revise. Run it again from the card.`;
  }
  if (card.column === "drop") {
    return `"${card.title}" is still in Drop and hasn't been built, so there's nothing to revise yet. Edit the card instead.`;
  }
  return `"${card.title}" has no changes waiting in Review, so there's nothing to send back.`;
}

/**
 * What to do when the message asks for changes to a reviewed card or picks
 * from the last list; null when it's neither and a bot should answer as usual.
 */
export function resolveReviseChat(text: string, now = Date.now()): ReviseChatResult | null {
  const pending = holder.__kruRevisePick;
  const pick = pending && now - pending.at < PICK_TTL_MS ? parsePick(text) : null;
  if (pending && pick !== null) {
    const cardId = pending.cardIds[pick - 1];
    if (!cardId) return { reply: `Pick a number from 1 to ${pending.cardIds.length}.`, cardId: null, revise: null };
    const entry = waitingCards().find((item) => item.card.id === cardId);
    if (entry) return revising(entry, pending.note);
    holder.__kruRevisePick = null;
    const card = listCards().find((item) => item.id === cardId);
    return { reply: card ? notWaiting(card) : "That card is gone.", cardId: card?.id ?? null, revise: null };
  }

  holder.__kruRevisePick = null;
  const request = parseReviseRequest(text);
  if (!request) return null;
  const waiting = waitingCards();
  // A card id, pasted as-is, needs no guessing.
  const byId = waiting.find((entry) => text.includes(entry.card.id));
  const match = byId ? { status: "match" as const, card: byId } : matchCard(request.query, waiting);
  // "On the landing page, …" is only about a card when one in Review fits.
  if (!request.explicit && match.status === "none") return null;

  if (!request.note) {
    const named = match.status === "match" ? `"${match.card.card.title}"` : "the card";
    return {
      reply: `What should change on ${named}? Say it in one message, like "revise the blur fix, it's too dark now".`,
      cardId: match.status === "match" ? match.card.card.id : null,
      revise: null,
    };
  }
  if (match.status === "match") return revising(match.card, request.note);
  if (match.status === "ambiguous") {
    holder.__kruRevisePick = { cardIds: match.candidates.map((entry) => entry.card.id), note: request.note, at: now };
    const lead = request.query
      ? `"${request.query}" could be more than one card. Which one should get your note?`
      : "More than one card is waiting for review. Which one should get your note?";
    return { reply: `${lead}\n${numbered(match.candidates)}\nReply with the number.`, cardId: null, revise: null };
  }

  const others = listCards().filter((card) => !waiting.some((entry) => entry.card.id === card.id));
  const elsewhere = request.query ? matchCard(request.query, others) : { status: "none" as const };
  if (elsewhere.status === "match") return { reply: notWaiting(elsewhere.card), cardId: elsewhere.card.id, revise: null };
  if (waiting.length === 0) {
    return { reply: "No cards are waiting in Review, so there's nothing to send back yet.", cardId: null, revise: null };
  }
  holder.__kruRevisePick = { cardIds: waiting.slice(0, 5).map((entry) => entry.card.id), note: request.note, at: now };
  return {
    reply: `No card waiting in Review matches "${request.query}". These are waiting:\n${numbered(waiting.slice(0, 5))}\nReply with a number, or say it another way.`,
    cardId: null,
    revise: null,
  };
}

/** Forgets any open numbered list; the PR flow and tests use it. */
export function resetRevisePick() {
  holder.__kruRevisePick = null;
}
