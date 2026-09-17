import { boxConfig } from "../box.ts";
import { checkClaudeCached, claudeCodeSignedIn } from "../claude-code.ts";
import { getActiveBotJobForCard, getBotsModel, getCard, getOnboarding, listConnections, patchCard, setBotsModel } from "../data.ts";
import { modelOptionsForConnections } from "../live-models.ts";
import type { Card } from "../types";
import {
  buildIndex,
  describeEntry,
  formatIndex,
  resolveModel,
  type IndexEntry,
} from "./model-index.ts";

/*
 * Which models the crew can use right now, and switching between them by
 * name from the Team chat. The list is the pickers' own: every connected
 * endpoint and subscription, plus Claude Code when the CLI in the box is
 * signed in.
 */

export async function modelIndex(): Promise<IndexEntry[]> {
  const { options } = modelOptionsForConnections(listConnections(), await claudeCodeSignedIn());
  return buildIndex(options);
}

/**
 * The model a new card gets when nobody names one: the crew's chat model,
 * else the model saved at setup, else the first one available. Null only
 * when nothing is connected at all.
 */
export async function defaultCardModel(index?: IndexEntry[]): Promise<string | null> {
  const entries = index ?? (await modelIndex());
  const usable = new Set(entries.map((entry) => entry.option.id));
  for (const ref of [getBotsModel(), getOnboarding()?.model ?? null]) {
    if (ref && usable.has(ref)) return ref;
  }
  return entries[0]?.option.id ?? null;
}

/** The numbered list, with the crew's chat model marked. */
export async function listModelsText(): Promise<string> {
  return formatIndex(await modelIndex(), getBotsModel());
}

export type SwitchResult = { ok: boolean; message: string; ref?: string };

/**
 * Resolves a model by name and checks it can run: listed means connected;
 * Claude Code is asked again, since a sign-in can lapse.
 */
export async function findModel(query: string): Promise<SwitchResult & { entry?: IndexEntry }> {
  const index = await modelIndex();
  if (index.length === 0) {
    return { ok: false, message: "No models are available. Add an endpoint or sign in under Settings." };
  }
  const result = resolveModel(query, index);
  if (result.status === "none") {
    return { ok: false, message: `No model matches "${query}". Available:\n${formatIndex(index, getBotsModel())}` };
  }
  if (result.status === "ambiguous") {
    return {
      ok: false,
      message: `"${query}" could be more than one of these; say which (a number works too):\n${result.candidates.map((entry) => describeEntry(entry)).join("\n")}`,
    };
  }
  const entry = result.entry;
  if (entry.kind === "claude-code") {
    const box = boxConfig();
    const check = box ? await checkClaudeCached(box, { fresh: true }).catch(() => null) : null;
    if (check?.status !== "ok") {
      return { ok: false, message: `${entry.option.name} runs on Claude Code, and the CLI in the box isn't signed in right now.` };
    }
  }
  return { ok: true, message: "", ref: entry.option.id, entry };
}

/** Switches what the crew chats with. */
export async function switchChatModel(query: string): Promise<SwitchResult> {
  const found = await findModel(query);
  if (!found.ok || !found.entry) return found;
  setBotsModel(found.entry.option.id);
  return {
    ok: true,
    ref: found.entry.option.id,
    message: `The crew now chats with ${found.entry.option.name} (${found.entry.option.provider}). New cards from chat use it too.`,
  };
}

/** Switches the model a card runs on. Refused while it runs or the crew has it. */
export async function switchCardModel(cardId: string, query: string): Promise<SwitchResult> {
  const card = getCard(cardId);
  if (!card) return { ok: false, message: "No such card." };
  if (card.status === "running" || getActiveBotJobForCard(card.id)) {
    return { ok: false, message: `"${card.title}" is being worked on; switch its model once it stops.` };
  }
  const found = await findModel(query);
  if (!found.ok || !found.entry) return found;
  patchCard(card.id, { model: found.entry.option.id });
  return {
    ok: true,
    ref: found.entry.option.id,
    message: `"${card.title}" now runs on ${found.entry.option.name} (${found.entry.option.provider}).`,
  };
}

/**
 * Gives a card with no model the default. A card that names one keeps it:
 * if that model can't run, the run says why. Returns the card as it now
 * stands, and the name of the model it was given, if any.
 */
export async function ensureCardModel(card: Card): Promise<{ card: Card; assigned: string | null }> {
  if (card.model) return { card, assigned: null };
  const index = await modelIndex();
  const ref = await defaultCardModel(index);
  if (!ref) return { card, assigned: null };
  const updated = patchCard(card.id, { model: ref }) ?? card;
  return { card: updated, assigned: index.find((entry) => entry.option.id === ref)?.option.name ?? ref };
}
