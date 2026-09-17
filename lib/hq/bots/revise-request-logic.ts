import { LEAD, cleanQuery, parsePrRequest } from "./pr-request-logic.ts";

/*
 * "On the landing page one, make the hero smaller" in the Team room, kept
 * pure so it can be tested: whether a message sends a reviewed card back
 * with a note, which words name the card, and what the note is. Matching
 * the words to a card is pr-request-logic's matchCard; nothing here starts
 * anything, revise-request.ts hands the card to the revise flow.
 */

export type ReviseRequest = {
  /** The words naming the card, e.g. "blur fix"; empty when none were given. */
  query: string;
  /** What should change, as the person wrote it; empty when they didn't say. */
  note: string;
  /**
   * True when the message plainly talks about a card: "revise …", "send …
   * back", or "the … one". False for "on the landing page, …", which is only
   * a request for changes when a card in Review fits the words.
   */
  explicit: boolean;
};

const ARTICLE = String.raw`(?:(?:the|that|this|my|our)\s+)?`;
/** The words naming the card: one line, no punctuation, as few as will do. */
const NAME = String.raw`([^\n,:;]{1,80}?)`;
/** "the landing page one": the word that says a card is meant. */
const MARK = String.raw`\s+(?:one|card|task|ticket)\b`;
/** What sits between the card's name and the note. */
const PUNCT = String.raw`(?:\s*[,:;—]\s*|\s+[-–]+\s+|\.\s+)`;
/** "revise the blur fix so it's lighter": the note starts at the joining word. */
const JOIN = String.raw`\s+(?=(?:so|because|since|but|to|and|it|it'?s|its)\b)`;
const NOTE = String.raw`([\s\S]+)`;

/** Openers that only make sense for a card that was already built. */
const REVISE_HEADS = [
  String.raw`(?:revise|rework|redo|revisit)\s+`,
  String.raw`(?:send|kick|bounce|hand)\s+back\s+`,
  String.raw`(?:(?:i\s*)?(?:want|need|have|would\s+like|'?d\s+like)\s+(?:to\s+)?)?(?:make|request|ask\s+for|see|get)?\s*(?:a\s+|an\s+|some\s+|a\s+few\s+|one\s+more\s+)?(?:changes?|tweaks?|edits?|revisions?)\s+(?:to|on|for|in)\s+`,
];
/** Openers that could be about anything; the card has to be marked or found. */
const LOOSE_HEADS = [
  String.raw`(?:on|for|in|about|regarding|with|re:?)\s+`,
  String.raw`(?:change|update|tweak|adjust|fix|edit|amend|modify|improve|polish)\s+`,
];
const BACK = String.raw`\s+back(?:\s+to\s+(?:momo|run|the\s+(?:agent|crew|run\s+column)))?`;

type Form = { pattern: RegExp; explicit: boolean; query: number; note: number | null; trailing?: boolean };

function form(source: string, explicit: boolean, note: number | null = 2, query = 1): Form {
  return { pattern: new RegExp(`${LEAD}${source}$`, "i"), explicit, query, note };
}

const FORMS: Form[] = [
  // "send the blur fix back: it's too dark", "send it back to momo"
  form(String.raw`(?:send|kick|bounce|hand)\s+${ARTICLE}${NAME}(?:${MARK})?${BACK}(?:${PUNCT}|\s+)${NOTE}`, true),
  form(String.raw`(?:send|kick|bounce|hand)\s+${ARTICLE}${NAME}(?:${MARK})?${BACK}\W*`, true, null),
  // "revise the blur fix one, …" and "on the landing page one, …": marked as a card
  ...[...REVISE_HEADS, ...LOOSE_HEADS].map((head) => form(String.raw`${head}${ARTICLE}${NAME}${MARK}(?:${PUNCT}|\s+)${NOTE}`, true)),
  // "revise the blur fix, it's too dark now"
  ...REVISE_HEADS.map((head) => form(String.raw`${head}${ARTICLE}${NAME}${PUNCT}${NOTE}`, true)),
  ...REVISE_HEADS.map((head) => form(String.raw`${head}${ARTICLE}${NAME}${JOIN}${NOTE}`, true)),
  // "revise the blur fix": which card, but not what should change
  ...REVISE_HEADS.map((head) => form(String.raw`${head}${ARTICLE}${NAME}(?:${MARK})?\W*`, true, null)),
  // "on the landing page, make the hero smaller": a card only if one fits
  ...LOOSE_HEADS.map((head) => form(String.raw`${head}${ARTICLE}${NAME}${PUNCT}${NOTE}`, false)),
  // "make the hero smaller on the landing page one"
  { ...form(String.raw`${NOTE}\s+(?:on|for|in|to)\s+(?:the|that|this|my|our)\s+${NAME}${MARK}(?:\W+(?:please|pls|thanks))?\W*`, true, 1, 2), trailing: true },
];

const QUESTION = /^(?:what|why|how|when|where|who|which|is|are|was|were|does|did|do|has|have|any|anyone)\b/i;
const POLITE = /\b(?:can|could|would|will)\s+you\b|\bplease\b|\bpls\b/i;
const PRAISE = /^(?:(?:i|we)\s+)?(?:really\s+|just\s+)?(?:thanks|thank|thx|great|nice|good|love|loved|like|liked|awesome|amazing|cool|perfect|well\s+done|kudos|lgtm|looks\s+(?:good|great))\b/i;
const NEW_CARD = /^(?:make|create|add|open|start|file|write)\s+(?:me\s+)?(?:a|an|another|one)\s+(?:new\s+)?(?:card|task|ticket)\b/i;
const MAX_QUERY_WORDS = 8;

/** The note as the agent should read it: no "please" in front, no stray dashes. */
function cleanNote(text: string): string {
  return text
    .replace(new RegExp(LEAD, "i"), "")
    .replace(/^[\s,:;.–—-]+/, "")
    .trim();
}

/**
 * A request to send a reviewed card back with changes, or null when the
 * message is something else: a question, thanks, a request for a new card.
 */
export function parseReviseRequest(text: string): ReviseRequest | null {
  // Anything said to Kiko, Lulu or Bibi is theirs to answer.
  if (/(^|\s)@(?:kiko|lulu|bibi)\b/i.test(text)) return null;
  const clean = text.replace(/(^|\s)@(?:pip|momo)\b[,:]?/gi, " ").trim();
  if (!clean || QUESTION.test(clean)) return null;
  if (/\?\W*$/.test(clean) && !POLITE.test(clean)) return null;

  for (const entry of FORMS) {
    const match = entry.pattern.exec(clean);
    if (!match) continue;
    const name = match[entry.query] ?? "";
    if ((name.match(/[a-z0-9]+/gi) ?? []).length > MAX_QUERY_WORDS) continue;
    const said = entry.note === null ? "" : (match[entry.note] ?? "").trim();
    const note = cleanNote(said);
    if (entry.note !== null && !note) continue;
    // "great work on the landing page one" is thanks, not a change.
    if (PRAISE.test(said) || (entry.trailing && (PRAISE.test(clean) || !/\s/.test(note)))) return null;
    if (note && (QUESTION.test(note) || NEW_CARD.test(note) || parsePrRequest(note))) return null;
    const query = cleanQuery(name);
    // "on it, …" names nothing, and without "revise" says nothing about a card.
    if (!entry.explicit && !query) continue;
    return { query, note, explicit: entry.explicit };
  }
  return null;
}
