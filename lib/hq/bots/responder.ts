import { generateText, stepCountIs, type FilePart, type LanguageModel, type TextPart } from "ai";
import { modelFor } from "../agent";
import { boxConfig } from "../box";
import { checkClaudeCached } from "../claude-code";
import {
  getBotsModel,
  getChatAttachment,
  getConnection,
  listBotJobs,
  listCards,
  listConnections,
  recentChatMessages,
} from "../data";
import { ensureFreshConnection } from "../model-auth";
import { CLAUDE_CODE_MODELS, isClaudeCodeRef, modelOptionsFor, parseModelRef } from "../models";
import type { BotId, ChatMessage } from "../types";
import { contextAttachments, kindOf } from "./attachments";
import { RateLimiter, botEffort, transcriptLine } from "./chat-logic";
import { claudeCodeTurn } from "./claude-driver";
import { botName, getBot } from "./registry";
import { postBotMessage, postEvent } from "./room";
import { systemPromptFor } from "./souls";
import { botTools, TOOL_NOTES } from "./tools";

/*
 * A bot's turn in the Team room: the SOUL as the system prompt, the last
 * few dozen lines as context, the board's tools in hand, and one reply
 * posted at the end. The room talks with the model picked under Settings →
 * Bots: an API endpoint through the AI SDK, or Claude Code through a
 * persistent session in the box that reaches the same tools over the `kru`
 * MCP bridge. Card work still runs on each card's own model.
 */

/** Lines of the room a bot reads before answering. */
const CONTEXT_LINES = 30;
/** Tool steps a single reply may take. */
const MAX_STEPS = 12;
const REPLY_TIMEOUT_MS = 120_000;
/** Claude Code runs real tools in the box, so it gets longer. */
const CLAUDE_REPLY_TIMEOUT_MS = 10 * 60 * 1000;
/** Bot messages per minute across the crew, before it cools off. */
const limiter = new RateLimiter(20, 60_000);
let warnedNoModel = false;

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

export type ChatEngine =
  | { kind: "api"; model: LanguageModel; providerOptions?: ProviderOptions }
  | { kind: "claude-code"; modelId: string };

/**
 * The engine the room talks with: the saved pick, else the first API
 * endpoint, else Claude Code when the CLI in the box is signed in. Null
 * when there is nothing to talk with.
 */
export async function chatEngine(): Promise<ChatEngine | null> {
  const saved = getBotsModel();
  if (isClaudeCodeRef(saved)) return { kind: "claude-code", modelId: parseModelRef(saved).modelId };
  let ref = saved;
  let stored = ref && parseModelRef(ref).connectionId ? getConnection(parseModelRef(ref).connectionId) : null;
  if (!stored) {
    const option = modelOptionsFor(listConnections())[0];
    if (option) {
      ref = option.id;
      stored = getConnection(parseModelRef(option.id).connectionId);
    }
  }
  if (stored && ref) {
    const fresh = await ensureFreshConnection(stored);
    return { kind: "api", ...modelFor(fresh, ref) };
  }
  const box = boxConfig();
  if (box && (await checkClaudeCached(box).catch(() => null))?.status === "ok") {
    return { kind: "claude-code", modelId: CLAUDE_CODE_MODELS[0] };
  }
  return null;
}

/**
 * The files a reply reads: the message's own and the newest earlier ones in
 * the lines the bot reads. Text goes into the prompt; images and PDFs go
 * with it as files. A file deleted since (the room cleared) is skipped.
 */
function readAttachments(message: ChatMessage, lines: ChatMessage[]) {
  const texts: { name: string; text: string }[] = [];
  const binary: { name: string; mediaType: string; data: Uint8Array }[] = [];
  for (const picked of contextAttachments(message, lines)) {
    const file = getChatAttachment(picked.id);
    if (!file) continue;
    if (kindOf(file.mediaType) === "text") texts.push({ name: file.name, text: new TextDecoder().decode(file.data) });
    else binary.push({ name: file.name, mediaType: file.mediaType, data: new Uint8Array(file.data) });
  }
  return { texts, binary, names: binary.map((file) => file.name) };
}

/** One bot answers one message. Never throws for the dispatcher's sake. */
export async function answerMention(message: ChatMessage, botId: BotId): Promise<void> {
  const bot = getBot(botId);
  if (!limiter.allow()) {
    postEvent(botId, "Cooling off for a minute; the room is busy.", message.cardId);
    return;
  }
  const engine = await chatEngine().catch(() => null);
  if (!engine) {
    if (!warnedNoModel) {
      postEvent("pip", "I need a model to chat with. Add an endpoint, or sign in to Claude Code in the box, under Settings.", null);
      warnedNoModel = true;
    }
    return;
  }
  warnedNoModel = false;

  const instructions = systemPromptFor(bot, {
    cards: listCards(),
    jobs: listBotJobs({ active: true }),
    toolNotes: TOOL_NOTES,
  });
  const lines = recentChatMessages(CONTEXT_LINES);
  const transcript = lines.map((line) => transcriptLine(line, botName)).join("\n");
  const files = readAttachments(message, lines);
  const prompt = [
    `The room so far (oldest first):\n${transcript}`,
    ...files.texts.map((file) => `Attached file ${file.name}:\n\`\`\`\n${file.text}\n\`\`\``),
    files.names.length
      ? `Reference files attached in the room are included with this message: ${files.names.join(", ")}. Read them as context for your reply.`
      : null,
    `Reply as ${bot.name} to ${message.author === "you" ? "the person" : botName(message.author)}'s last message. Use tools when the message asks for something to happen. Answer in a few lines.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const tools = botTools({ bot, message });

  let text: string;
  try {
    if (engine.kind === "claude-code") {
      const box = boxConfig();
      if (!box) throw new Error("The box isn't configured");
      const result = await claudeCodeTurn({
        box,
        agentId: `bot-${bot.id}`,
        modelId: engine.modelId,
        effort: botEffort(),
        maxTurns: MAX_STEPS,
        instructions,
        prompt,
        attachments: files.binary.map((file) => ({ name: file.name, mediaType: file.mediaType, data: Buffer.from(file.data).toString("base64") })),
        tools,
        timeoutMs: CLAUDE_REPLY_TIMEOUT_MS,
        signal: AbortSignal.timeout(CLAUDE_REPLY_TIMEOUT_MS + 10_000),
      });
      if (!result.ok && !result.text) throw new Error(result.error ?? `Claude Code stopped (${result.stopReason ?? "unknown"})`);
      text = result.text.trim();
    } else {
      // A ChatGPT sign-in carries the box instructions here; swap in the SOUL.
      const providerOptions = engine.providerOptions?.openai
        ? { ...engine.providerOptions, openai: { ...engine.providerOptions.openai, instructions } }
        : engine.providerOptions;
      const result = await generateText({
        model: engine.model,
        providerOptions,
        instructions,
        ...(files.binary.length
          ? {
              messages: [
                {
                  role: "user" as const,
                  content: [
                    { type: "text", text: prompt } satisfies TextPart,
                    ...files.binary.map(
                      (file) =>
                        ({ type: "file", mediaType: file.mediaType, filename: file.name, data: { type: "data", data: file.data } }) satisfies FilePart,
                    ),
                  ],
                },
              ],
            }
          : { prompt }),
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        abortSignal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      });
      text = result.text.trim();
    }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : "unknown error").slice(0, 200);
    postEvent(botId, `Couldn't answer: ${detail}`, message.cardId);
    return;
  }
  if (!text) return;
  postBotMessage(botId, text, { replyTo: message.id, depth: message.depth + 1, cardId: message.cardId });
}
