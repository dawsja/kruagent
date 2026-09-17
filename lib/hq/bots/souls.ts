import { readFileSync } from "node:fs";
import path from "node:path";
import type { BotId, BotJob, Card } from "../types";
import { BOTS, getBot, type Bot } from "./registry.ts";

/*
 * A bot's personality is a Markdown file, bots/<id>/SOUL.md, read once per
 * process. The system prompt for a chat reply or a review is that file plus
 * what every bot needs to know: who else is on the crew, the house rules,
 * and what the board looks like right now.
 */

const cache = new Map<BotId, string>();

/** The folder the SOUL files live in: next to the server, chosen at runtime. */
export function soulsDir() {
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "bots");
}

export function loadSoul(id: BotId): string {
  const cached = cache.get(id);
  if (cached) return cached;
  const text = readFileSync(path.join(soulsDir(), id, "SOUL.md"), "utf8");
  cache.set(id, text);
  return text;
}

/** Forgets the cached files; tests use it after editing them. */
export function resetSouls() {
  cache.clear();
}

export const HOUSE_RULES = [
  "You are one bot on Kru, a Kanban board where a crew of bots does the work and a person approves pull requests.",
  "Board columns: Drop (new cards), Run (a bot has it), Review (waiting for the person). Card stages while the crew has it: build (Momo), test (Kiko), review (Lulu), scribe (Bibi). Pip coordinates.",
  "Speak as yourself, in the first person, in the voice your SOUL describes. Plain text with light Markdown; no headings.",
  "Address a teammate by writing @name. Only mention a bot when you need it to do something; a mention costs a turn.",
  "Never claim to have done something a tool didn't do. If a tool fails, say so.",
  "Nothing reaches GitHub without the person, with one exception they control: when auto-push is on (Settings → Bots, or set_crew_setting when they ask), Kru pushes follow-up commits to pull requests the person already approved. Never open a pull request, merge, or push anywhere else, and never say a push happened unless a tool or the room said so.",
].join("\n");

export function roster(): string {
  return BOTS.map((bot) => `- @${bot.id} (${bot.name}, ${bot.role}): ${bot.tagline}`).join("\n");
}

export type PromptContext = {
  cards?: Card[];
  jobs?: BotJob[];
  toolNotes?: string;
};

/** A short, current picture of the board for a bot to reason from. */
export function boardSummary(cards: Card[], jobs: BotJob[]): string {
  if (cards.length === 0) return "The board is empty.";
  const active = new Map(jobs.map((job) => [job.cardId, job]));
  return cards
    .slice(0, 40)
    .map((card) => {
      const job = active.get(card.id);
      const crew = job && ["build", "test", "review", "scribe"].includes(job.stage) ? `, crew: ${job.stage}` : "";
      return `- ${card.id} · "${card.title}" · ${card.column} · ${card.status}${card.repo ? ` · ${card.repo}` : ""}${crew}`;
    })
    .join("\n");
}

export function systemPromptFor(bot: Bot, context: PromptContext = {}): string {
  return [
    loadSoul(bot.id).trim(),
    `## Crew\n${roster()}`,
    `## House rules\n${HOUSE_RULES}`,
    context.cards ? `## Board now\n${boardSummary(context.cards, context.jobs ?? [])}` : "",
    context.toolNotes ? `## Tools\n${context.toolNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The prompt a pipeline stage uses: SOUL plus the stage's own rules. */
export function stageInstructions(id: BotId, rules: string): string {
  return [loadSoul(getBot(id).id).trim(), `## House rules\n${HOUSE_RULES}`, `## This task\n${rules}`].join("\n\n");
}
