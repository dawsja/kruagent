import { getActiveBotJobForCard, getRun, listCards } from "../data.ts";
import type { Card, Run } from "../types.ts";
import { matchCard, parsePick, parsePrRequest, type MatchTarget } from "./pr-request-logic.ts";

/*
 * "Make the PR for the theme toggle one" from the person in the Team room.
 * Kru answers it itself, like /model, rather than handing it to a bot: the
 * person's own words are the approval, and a model never gets a tool that
 * opens pull requests. The matched card goes through the same approve flow
 * as the button on the card. When the words fit more than one card waiting
 * for review, Pip lists them and the person answers with a number.
 */

/** How long a numbered list stays answerable. */
const PICK_TTL_MS = 15 * 60 * 1000;

type PendingPick = { cardIds: string[]; at: number };
const holder = globalThis as typeof globalThis & { __kruPrPick?: PendingPick | null };

export type Waiting = MatchTarget & { card: Card; run: Run };

export type PrChatResult = {
  /** Pip's answer, posted as an event. */
  reply: string;
  cardId: string | null;
  /** Set when the card is found and waiting: approve this run. */
  approve: { runId: string; card: Card } | null;
};

/** Cards in Review whose run is waiting for the person, newest first. */
export function waitingCards(): Waiting[] {
  const waiting: Waiting[] = [];
  for (const card of listCards()) {
    if (card.column !== "review" || card.status !== "needs_approval" || !card.runId) continue;
    const run = getRun(card.runId);
    if (!run || run.status !== "needs_approval" || getActiveBotJobForCard(card.id)) continue;
    waiting.push({ id: card.id, title: card.title, body: card.body, summary: run.summary, commitMessage: run.commitMessage, card, run });
  }
  return waiting;
}

export function numbered(cards: { title: string; card: Card }[]): string {
  return cards.map((entry, index) => `${index + 1}. "${entry.title}"${entry.card.repo ? ` (${entry.card.repo})` : ""}`).join("\n");
}

function approving(entry: Waiting): PrChatResult {
  holder.__kruPrPick = null;
  return {
    reply: `Opening the pull request for "${entry.card.title}"…`,
    cardId: entry.card.id,
    approve: { runId: entry.run.id, card: entry.card },
  };
}

/** Why a card that isn't waiting can't get a pull request from here. */
function notWaiting(card: Card): string {
  if (getActiveBotJobForCard(card.id) || card.status === "running") {
    return `"${card.title}" is still being worked on; I'll be able to open its PR once it's in Review.`;
  }
  if (card.status === "approved" || card.status === "merged") {
    const url = card.runId ? getRun(card.runId)?.prUrl : null;
    return `"${card.title}" already has a pull request${url ? `: ${url}` : "."}`;
  }
  return `"${card.title}" has no changes waiting for review, so there's no PR to open.`;
}

/**
 * Pip's answer when the message asks for a pull request or picks from the
 * last list; null when it's neither and a bot should answer as usual.
 */
export function resolvePrChat(text: string, now = Date.now()): PrChatResult | null {
  const pending = holder.__kruPrPick;
  const pick = pending && now - pending.at < PICK_TTL_MS ? parsePick(text) : null;
  if (pending && pick !== null) {
    const cardId = pending.cardIds[pick - 1];
    if (!cardId) return { reply: `Pick a number from 1 to ${pending.cardIds.length}.`, cardId: null, approve: null };
    const entry = waitingCards().find((item) => item.card.id === cardId);
    if (entry) return approving(entry);
    holder.__kruPrPick = null;
    const card = listCards().find((item) => item.id === cardId);
    return { reply: card ? notWaiting(card) : "That card is gone.", cardId: card?.id ?? null, approve: null };
  }

  const request = parsePrRequest(text);
  if (!request) {
    holder.__kruPrPick = null;
    return null;
  }
  const waiting = waitingCards();
  // A card id, pasted as-is, needs no guessing.
  const byId = waiting.find((entry) => text.includes(entry.card.id));
  if (byId) return approving(byId);

  const match = matchCard(request.query, waiting);
  if (match.status === "match") return approving(match.card);
  if (match.status === "ambiguous") {
    holder.__kruPrPick = { cardIds: match.candidates.map((entry) => entry.card.id), at: now };
    const lead = request.query
      ? `"${request.query}" could be more than one card. Which one should get the PR?`
      : "More than one card is waiting for review. Which one should get the PR?";
    return { reply: `${lead}\n${numbered(match.candidates)}\nReply with the number.`, cardId: null, approve: null };
  }

  holder.__kruPrPick = null;
  if (waiting.length === 0) {
    const elsewhere = request.query ? matchCard(request.query, listCards()) : { status: "none" as const };
    if (elsewhere.status === "match") return { reply: notWaiting(elsewhere.card), cardId: elsewhere.card.id, approve: null };
    return { reply: "No cards are waiting for review, so there's no PR to open yet.", cardId: null, approve: null };
  }
  const others = listCards().filter((card) => !waiting.some((entry) => entry.card.id === card.id));
  const elsewhere = matchCard(request.query, others);
  if (elsewhere.status === "match") return { reply: notWaiting(elsewhere.card), cardId: elsewhere.card.id, approve: null };
  holder.__kruPrPick = { cardIds: waiting.slice(0, 5).map((entry) => entry.card.id), at: now };
  return {
    reply: `No card waiting for review matches "${request.query}". These are waiting:\n${numbered(waiting.slice(0, 5))}\nReply with a number, or say it another way.`,
    cardId: null,
    approve: null,
  };
}

/** Forgets any open numbered list; tests use it. */
export function resetPrPick() {
  holder.__kruPrPick = null;
}
