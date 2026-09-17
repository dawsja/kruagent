import { insertChatMessage, type NewChatAttachment } from "../data";
import { randomString } from "../oauth";
import type { BotId, ChatMessage } from "../types";
import { parseMentions, shouldPend } from "./chat-logic";

/*
 * Writing to the Team room. Events are the crew's own progress lines and
 * never get an answer; messages from a bot may, when they mention another.
 */

const MAX_BODY = 4000;

function trim(text: string) {
  const clean = text.trim();
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}…` : clean;
}

/** A progress line from a bot about a card, e.g. "Picking up …". */
export function postEvent(bot: BotId, text: string, cardId: string | null = null): ChatMessage {
  const message: ChatMessage = {
    id: randomString(9),
    author: bot,
    kind: "event",
    body: trim(text),
    mentions: parseMentions(text),
    cardId,
    replyTo: null,
    depth: 0,
    createdAt: new Date().toISOString(),
  };
  insertChatMessage(message);
  return message;
}

/** What a bot says in the room. Mentions in it may draw another bot in. */
export function postBotMessage(
  bot: BotId,
  text: string,
  options: { replyTo?: string | null; depth?: number; cardId?: string | null } = {},
): ChatMessage {
  const message: ChatMessage = {
    id: randomString(9),
    author: bot,
    kind: "message",
    body: trim(text),
    mentions: parseMentions(text),
    cardId: options.cardId ?? null,
    replyTo: options.replyTo ?? null,
    depth: options.depth ?? 1,
    createdAt: new Date().toISOString(),
  };
  insertChatMessage(message, { pending: shouldPend(message) });
  return message;
}

/** What you say in the room, with any files attached; pending when the crew is on. */
export function postHumanMessage(
  text: string,
  options: { pending: boolean; files?: Omit<NewChatAttachment, "id">[] },
): ChatMessage {
  const files = (options.files ?? []).map((file) => ({ ...file, id: randomString(12) }));
  const message: ChatMessage = {
    id: randomString(9),
    author: "you",
    kind: "message",
    body: trim(text),
    mentions: parseMentions(text),
    cardId: null,
    replyTo: null,
    depth: 0,
    createdAt: new Date().toISOString(),
    ...(files.length
      ? { attachments: files.map(({ id, name, mediaType, data }) => ({ id, name, mediaType, size: data.byteLength })) }
      : {}),
  };
  insertChatMessage(message, { pending: options.pending && shouldPend(message), files });
  return message;
}
