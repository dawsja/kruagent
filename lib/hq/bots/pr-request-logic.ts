/*
 * "Make the PR for the theme toggle one" in the Team room, kept pure so it
 * can be tested: whether a message asks for a pull request, which card its
 * words point at, and which number a person picked from a list. Nothing
 * here opens anything; pr-request.ts hands the card to the approve flow.
 */

export type PrRequest = {
  /** The words naming the card, e.g. "theme toggle"; empty when none were given. */
  query: string;
};

/** Greetings and "can you", "please", "go ahead and" before the request itself. */
export const LEAD = String.raw`^(?:(?:hey|hi|ok|okay|alright|great|cool|nice|perfect|looks good|lgtm)[\s,.!-]+)*(?:(?:please|pls|can you|could you|would you|will you|go ahead and|let'?s|now|then|and)\s+)*`;
const MAKE = String.raw`(?:make|open|create|raise|file|submit|send|ship|cut|put up|push|do|start)`;
const PR = String.raw`(?:pr|pull[\s-]?request)`;

const PATTERNS = [
  // "make the PR for the theme toggle one", "open a pull request: orange accent"
  new RegExp(`${LEAD}${MAKE}\\s+(?:up\\s+)?(?:the|a|an|that|this|its)?\\s*${PR}s?\\b(?:\\s*(?:for|on|of|from|with|about|:|-)\\s*|\\s+|$)([\\s\\S]*)$`, "i"),
  // "make the theme toggle PR", "open the orange accent pull request"
  new RegExp(`${LEAD}${MAKE}\\s+(?:the|a|an|that|this)\\s+([\\s\\S]+?)\\s+${PR}\\b\\W*(?:please|pls|now)?\\W*$`, "i"),
  // "approve the orange accent card", "approve theme toggle and open the PR"
  new RegExp(`${LEAD}approve\\b\\s*([\\s\\S]*)$`, "i"),
];

/** A request for a pull request, or null when the message is something else. */
export function parsePrRequest(text: string): PrRequest | null {
  const clean = text
    .replace(/(^|\s)@pip\b[,:]?/gi, " ")
    .trim()
    .replace(/[\s?!.]+$/, "");
  if (!clean || clean.length > 300 || clean.includes("\n")) return null;
  for (const pattern of PATTERNS) {
    const match = pattern.exec(clean);
    if (match) return { query: cleanQuery(match[1] ?? "") };
  }
  return null;
}

/** Words that say nothing about which card is meant. */
const FILLER = new Set(
  (
    "the a an one ones card cards task tasks change changes thing it its that this those these for of on in to " +
    "with about from and or please pls thanks thank you now pr prs pull request requests open make create " +
    "approve approved review reviewed which is was my our kru ticket go ahead can could would will just too"
  ).split(" "),
);

/** The words of a request that could name a card. */
export function cleanQuery(text: string): string {
  return words(text)
    .filter((word) => !FILLER.has(word))
    .join(" ");
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Plural and simple verb endings, so "toggles" finds "toggle". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Edits between two words, a swap of neighbours counting as one; 3 means "far". */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}

/** How alike two words are, 0 to 1: same, one starts the other, or a typo apart. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = stem(a);
  const y = stem(b);
  if (x === y) return 0.95;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.startsWith(short)) return 0.8;
  if (short.length >= 4) {
    const distance = editDistance(x, y);
    if (distance === 1) return 0.75;
    if (distance === 2 && short.length >= 7) return 0.6;
  }
  return 0;
}

export type MatchTarget = {
  id: string;
  title: string;
  body?: string | null;
  summary?: string | null;
  commitMessage?: string | null;
};

/** Title words count most; the body and what the agent said it did, less. */
const FIELD_WEIGHTS = [
  ["title", 1],
  ["commitMessage", 0.8],
  ["summary", 0.7],
  ["body", 0.7],
] as const;

/** How well the query's words describe a card, 0 to 1. */
export function scoreCard(query: string, card: MatchTarget): number {
  const wanted = words(query).filter((word) => !FILLER.has(word));
  if (wanted.length === 0) return 0;
  const fields = FIELD_WEIGHTS.map(([key, weight]) => ({ words: [...new Set(words(card[key] ?? ""))], weight }));
  let total = 0;
  for (const word of wanted) {
    let best = 0;
    for (const field of fields) {
      for (const candidate of field.words) {
        best = Math.max(best, wordSimilarity(word, candidate) * field.weight);
        if (best === 1) break;
      }
    }
    total += best;
  }
  let score = total / wanted.length;
  // The words in the same order in the title settle near ties.
  if (wanted.length > 1 && words(card.title).join(" ").includes(wanted.join(" "))) score += 0.05;
  return Math.min(1, score);
}

/** Below this, a card isn't what the person meant. */
export const MATCH_THRESHOLD = 0.55;
/** A runner-up this close to the best makes the request ambiguous. */
export const AMBIGUITY_GAP = 0.15;
const MAX_CANDIDATES = 5;

export type CardMatch<T extends MatchTarget> =
  | { status: "match"; card: T }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "none" };

/**
 * The card a request names. With no words at all, the only card waiting is
 * the one meant; with several waiting, the person is asked.
 */
export function matchCard<T extends MatchTarget>(query: string, cards: T[]): CardMatch<T> {
  if (cards.length === 0) return { status: "none" };
  if (!words(query).some((word) => !FILLER.has(word))) {
    return cards.length === 1 ? { status: "match", card: cards[0] } : { status: "ambiguous", candidates: cards.slice(0, MAX_CANDIDATES) };
  }
  const scored = cards
    .map((card) => ({ card, score: scoreCard(query, card) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return { status: "none" };
  const close = scored.filter((entry) => entry.score > scored[0].score - AMBIGUITY_GAP);
  if (close.length === 1) return { status: "match", card: close[0].card };
  return { status: "ambiguous", candidates: close.slice(0, MAX_CANDIDATES).map((entry) => entry.card) };
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/**
 * The number a person picked from a list: "2", "#2", "number 2", "the
 * second one". Null when the message is anything else.
 */
export function parsePick(text: string): number | null {
  const clean = text
    .replace(/(^|\s)@pip\b[,:]?/gi, " ")
    .trim()
    .toLowerCase()
    .replace(/[\s?!.]+$/, "");
  const digit = /^(?:(?:the\s+)?(?:#|no\.?\s*|number\s+|option\s+|card\s+))?(\d{1,2})(?:\s*(?:\)|one|please|pls))?$/.exec(clean);
  if (digit) return Number(digit[1]) || null;
  const ordinal = /^(?:the\s+)?(first|second|third|fourth|fifth)(?:\s+one)?(?:\s+please)?$/.exec(clean);
  return ordinal ? ORDINALS.indexOf(ordinal[1]) + 1 : null;
}
