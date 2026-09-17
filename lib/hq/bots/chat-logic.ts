import { BOT_IDS, type BotId, type ChatMessage } from "../types.ts";

/*
 * The rules of the Team room, kept pure so they can be tested: who a message
 * is addressed to, whether a bot may answer it, and how fast the crew may
 * talk. These are what keep two bots from chatting with each other forever.
 */

/** `@pip` and friends; not part of an email or a longer word. */
export const MENTION = /(^|[^\w@])@(pip|momo|kiko|lulu|bibi)\b/gi;

export function parseMentions(text: string, ids: readonly BotId[] = BOT_IDS): BotId[] {
  const found: BotId[] = [];
  for (const match of text.matchAll(MENTION)) {
    const id = match[2].toLowerCase() as BotId;
    if (ids.includes(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * Bot-to-bot hops allowed from the human message that started a thread.
 * A bot's reply to you is depth 1; a bot answering that bot is depth 2.
 */
export const MAX_CHAIN = 4;

/** The bots a message is addressed to. You reach Pip by default; events reach nobody. */
export function targetsFor(message: Pick<ChatMessage, "author" | "kind" | "mentions">): BotId[] {
  if (message.kind === "event") return [];
  if (message.author === "you") return message.mentions.length ? message.mentions : ["pip"];
  return message.mentions.filter((id) => id !== message.author);
}

/** Whether a reply to this message may be generated at all. */
export function canReply(message: Pick<ChatMessage, "author" | "depth">) {
  return message.author === "you" || message.depth < MAX_CHAIN;
}

/** True when a new message should wait for a bot's answer. */
export function shouldPend(message: Pick<ChatMessage, "author" | "kind" | "mentions" | "depth">) {
  return message.kind === "message" && targetsFor(message).length > 0 && canReply(message);
}

/** A sliding window: at most `limit` events per `windowMs`. */
export class RateLimiter {
  private readonly stamps: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(now = Date.now()): boolean {
    while (this.stamps.length && now - this.stamps[0] >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
}

/** One line of transcript for a bot to read, naming any files attached. */
export function transcriptLine(message: ChatMessage, nameOf: (id: string) => string): string {
  const who = message.author === "you" ? "you" : nameOf(message.author);
  const files = message.attachments?.length ? ` [attached: ${message.attachments.map((file) => file.name).join(", ")}]` : "";
  return message.kind === "event" ? `(${who}, event) ${message.body}` : `${who}: ${message.body}${files}`;
}

/**
 * How hard Claude Code thinks per reply, when set: `KRU_BOT_EFFORT` of low,
 * medium or high. Left unset, the CLI's own default.
 */
export function botEffort(value = process.env.KRU_BOT_EFFORT): "low" | "medium" | "high" | null {
  const clean = value?.trim().toLowerCase();
  return clean === "low" || clean === "medium" || clean === "high" ? clean : null;
}
