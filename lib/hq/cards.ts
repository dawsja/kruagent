import { getOnboarding, insertCard, insertCardForIssue } from "./data";
import { randomString } from "./oauth";
import type { Card } from "./types";

/*
 * Making a card, shared by the API route and the bots' create_card tool, so
 * both fill in the repo the same way. The caller settles the model first
 * (lib/hq/bots/models.ts has the default), since that needs to ask the box
 * whether Claude Code is signed in.
 */

export type NewCard = {
  title: string;
  body?: string | null;
  repo?: string | null;
  model?: string | null;
};

function buildCard(input: NewCard): Card {
  const title = input.title.trim();
  if (!title) throw new Error("Title required");
  const now = new Date().toISOString();
  return {
    id: randomString(12),
    title,
    body: input.body?.trim() ?? "",
    column: "drop",
    repo: input.repo?.trim() || getOnboarding()?.repo || null,
    // No model is allowed; running the card asks for one.
    model: input.model?.trim() || null,
    status: "open",
    runId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Creates a card in Drop. Throws when the title is empty. */
export function createCardFrom(input: NewCard): Card {
  const card = buildCard(input);
  insertCard(card);
  return card;
}

/**
 * Creates a card in Drop from a GitHub issue in `repo`. Null when that issue
 * was imported before; an issue becomes a card once, even if the card is
 * deleted later.
 */
export function createCardFromIssue(
  input: NewCard & { repo: string },
  issue: { id: number; number: number; url: string | null },
): Card | null {
  const card: Card = { ...buildCard(input), repo: input.repo, issueNumber: issue.number, issueUrl: issue.url };
  return insertCardForIssue(card, { id: issue.id, repo: input.repo, number: issue.number }) ? card : null;
}
