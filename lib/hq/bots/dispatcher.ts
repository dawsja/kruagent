import {
  cancelBotRetry,
  claimBotJob,
  claimDropCard,
  claimPendingMessages,
  getBotsEnabled,
  getCard,
  latestBotJobByCard,
  listBotJobs,
  listCards,
  markChatAnswered,
  releaseBotClaims,
  retryBotJob,
} from "../data";
import { randomString } from "../oauth";
import { syncIssues } from "../issue-sync";
import { syncPullRequests } from "../pr-sync";
import type { BotId, BotJob, ChatMessage } from "../types";
import { targetsFor } from "./chat-logic";
import { runPipeline } from "./pipeline";
import { retryStillWanted } from "./pipeline-logic";
import { getBot } from "./registry";
import { answerMention } from "./responder";
import { postEvent } from "./room";
import { queueSteering } from "./steering";
import { steerTarget } from "./steering-logic";

/*
 * The crew's heartbeat: one interval per server process, started from
 * instrumentation.ts. Each tick follows the open pull requests, resumes
 * jobs nobody is driving, picks up cards dropped since the last tick, and
 * answers messages addressed to a bot. Everything long-running is started
 * here and awaited elsewhere, so a tick itself is quick.
 */

type State = {
  timer: ReturnType<typeof setInterval> | null;
  /** This process's name on the claims it holds. */
  owner: string;
  /** Jobs being driven right now. */
  active: Set<string>;
  ticking: boolean;
};

const holder = globalThis as typeof globalThis & { __kruBots?: State };

function state(): State {
  return (holder.__kruBots ??= { timer: null, owner: randomString(8), active: new Set(), ticking: false });
}

/** How many cards the crew works at once. */
export function concurrency() {
  return Math.max(1, Number(process.env.KRU_BOT_CONCURRENCY ?? 1) || 1);
}

export const TICK_MS = 3_000;

/** Starts the loop once; later calls are no-ops. */
export function startBotDispatcher(options: { intervalMs?: number } = {}) {
  const current = state();
  if (current.timer) return;
  // Claims from a previous process mean nothing now.
  releaseBotClaims();
  current.timer = setInterval(() => void tick(), options.intervalMs ?? TICK_MS);
  current.timer.unref?.();
  console.info("[kru] Bot dispatcher started");
}

function drive(job: BotJob) {
  const current = state();
  current.active.add(job.id);
  void runPipeline(job)
    .catch((error: unknown) => {
      console.error(`[kru] Bot job ${job.id} crashed:`, error);
    })
    .finally(() => current.active.delete(job.id));
}

/**
 * What you say to a bot that has a card right now steers that work: the
 * message waits on the card as a note, and the bot answers from inside the
 * run at its next safe point instead of chatting beside it. False when the
 * bot isn't working a card, and the message is answered as it always was.
 */
function steer(message: ChatMessage, bot: BotId): boolean {
  if (message.author !== "you" || !message.body.trim()) return false;
  const job = steerTarget(bot, message.body, listBotJobs({ active: true }), listCards());
  const card = job ? getCard(job.cardId) : null;
  if (!card) return false;
  const note = queueSteering(card, { id: randomString(9), author: "you", body: message.body, messageId: message.id });
  if (!note) return false;
  // The card may have moved on a stage between the look and the note; whoever has it answers.
  const holder = getBot(note.bot);
  postEvent(holder.id, `Heard you. I'm in the middle of ${holder.verb} "${card.title}"; I'll read this at my next safe point and answer here.`, card.id);
  return true;
}

function answer(message: ChatMessage) {
  const bots = targetsFor(message).filter((bot) => !steer(message, bot));
  void Promise.all(
    bots.map((bot) =>
      answerMention(message, bot).catch((error: unknown) => {
        console.error(`[kru] ${bot} could not answer:`, error);
      }),
    ),
  ).finally(() => markChatAnswered(message.id));
}

/** One pass. Exported for tests; never overlaps with itself. */
export async function tick() {
  const current = state();
  if (current.ticking) return;
  current.ticking = true;
  try {
    // Pull requests are followed with or without the crew: merges and
    // feedback are facts about the board. It paces itself and never overlaps.
    void syncPullRequests().catch((error: unknown) => {
      console.error("[kru] Pull request sync crashed:", error);
    });
    if (!getBotsEnabled()) return;
    // Labelled issues become cards, which the pickup below then takes.
    void syncIssues().catch((error: unknown) => {
      console.error("[kru] Issue sync crashed:", error);
    });
    const cap = concurrency();

    // Jobs a previous process, or a tick before, left unowned.
    for (const job of listBotJobs({ active: true })) {
      if (current.active.size >= cap) break;
      if (job.claimedBy || current.active.has(job.id)) continue;
      if (claimBotJob(job.id, current.owner)) drive({ ...job, claimedBy: current.owner });
    }

    // Failed work whose retry is due, unless the person moved the card on
    // since (a manual retry, an edit back to Drop, a delete).
    let had = latestBotJobByCard();
    for (const failed of listBotJobs({ retryDue: new Date().toISOString() })) {
      if (current.active.size >= cap) break;
      if (!retryStillWanted(failed, getCard(failed.cardId), had.get(failed.cardId)?.id ?? null)) {
        cancelBotRetry(failed.id);
        continue;
      }
      const job = retryBotJob(failed.id, randomString(9), current.owner);
      if (job) drive(job);
    }
    had = latestBotJobByCard();

    // Cards dropped since: open, in Drop, never picked up before. A card
    // sent back to Drop by hand is left alone; ask a bot to run it.
    const fresh = listCards()
      .filter((card) => card.status === "open" && card.column === "drop" && !had.has(card.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const card of fresh) {
      if (current.active.size >= cap) break;
      const job = claimDropCard(card.id, current.owner, randomString(9));
      if (job) drive(job);
    }

    for (const message of claimPendingMessages(current.owner, 2)) answer(message);
  } finally {
    current.ticking = false;
  }
}
