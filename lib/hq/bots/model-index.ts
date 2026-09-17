/*
 * An index of the models this Kru can use, for picking one by name in the
 * Team chat: "grok sub", "claude opus 5", "gpt 5.4 api", "3". Names can be
 * slightly misspelled ("opsu", "grk"). Pure, so it is tested directly; the
 * options come from the same live list the model pickers show.
 */

export type IndexedOption = {
  /** `connectionId:modelId`, as a card or the chat model stores it. */
  id: string;
  name: string;
  /** The picker's group: the endpoint's name, "ChatGPT", "Claude Code". */
  provider: string;
  description?: string;
  badge?: string;
};

export type ModelKind = "api" | "subscription" | "claude-code";

export type IndexEntry = {
  index: number;
  option: IndexedOption;
  kind: ModelKind;
  connectionId: string;
  modelId: string;
  tokens: string[];
};

export type Resolution =
  | { status: "match"; entry: IndexEntry; score: number }
  | { status: "ambiguous"; candidates: IndexEntry[] }
  | { status: "none"; candidates: IndexEntry[] };

/** Words people use for each way of reaching a model. */
const KIND_WORDS: Record<ModelKind, string[]> = {
  api: ["api", "key", "apikey", "byok", "endpoint"],
  subscription: ["sub", "subscription", "plan", "signin", "oauth"],
  "claude-code": ["claudecode", "cc", "cli", "code", "plan", "sub", "subscription"],
};

/** Brand words that imply a family, so "supergrok" finds grok on the X sign-in. */
const ALIASES: Record<string, string[]> = {
  supergrok: ["grok", "xai", "sub"],
  chatgpt: ["gpt", "openai", "sub"],
  xai: ["grok"],
  openai: ["gpt"],
  anthropic: ["claude"],
};

/** Words that say nothing about which model; dropped from queries. */
const FILLER = new Set(["use", "switch", "to", "the", "model", "please", "with", "on", "via", "a", "an", "for", "and", "now"]);

export function kindOf(connectionId: string): ModelKind {
  if (connectionId === "claude-code") return "claude-code";
  if (connectionId.startsWith("sub_")) return "subscription";
  return "api";
}

/** Lowercase words and numbers, with letters and digits split: "opus5" → opus, 5. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1_$2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9_]+/)
    .map((token) => token.replace(/_/g, "."))
    .filter(Boolean);
}

/** Every token an option can be found by. */
export function tokensFor(option: IndexedOption): string[] {
  const colon = option.id.indexOf(":");
  const connectionId = colon > 0 ? option.id.slice(0, colon) : "";
  const modelId = colon > 0 ? option.id.slice(colon + 1) : option.id;
  const kind = kindOf(connectionId);
  const words = [
    ...tokenize(option.name),
    // claude-opus-4-5 is version 4.5, not a 4 and a 5: "opus 5" must not find it.
    ...tokenize(modelId.replace(/(\d+)-(\d{1,2})(?=-|$)/g, "$1.$2")),
    ...tokenize(option.provider),
    ...KIND_WORDS[kind],
  ];
  const provider = option.provider.toLowerCase().replace(/[^a-z]/g, "");
  if (provider) words.push(provider);
  for (const word of [...words]) words.push(...(ALIASES[word] ?? []));
  return [...new Set(words)];
}

export function buildIndex(options: readonly IndexedOption[]): IndexEntry[] {
  return options.map((option, index) => {
    const colon = option.id.indexOf(":");
    const connectionId = colon > 0 ? option.id.slice(0, colon) : "";
    return {
      index: index + 1,
      option,
      kind: kindOf(connectionId),
      connectionId,
      modelId: colon > 0 ? option.id.slice(colon + 1) : option.id,
      tokens: tokensFor(option),
    };
  });
}

/** Damerau-Levenshtein distance (adjacent swaps count once). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) d[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

const isNumber = (token: string) => /^\d+(\.\d+)*$/.test(token);

/** How well one query word matches one option word, 0 to 1. Numbers must match exactly. */
export function tokenScore(query: string, token: string): number {
  if (query === token) return 1;
  if (isNumber(query) || isNumber(token)) return 0;
  if (query.length >= 3 && token.startsWith(query)) return 0.9;
  const allowed = query.length <= 3 ? 0 : query.length <= 5 ? 1 : 2;
  const distance = editDistance(query, token);
  return distance <= allowed ? 1 - distance / Math.max(query.length, token.length) : 0;
}

/**
 * How well a query describes an option. Every query word must find a
 * match, so "grok api" never lands on a subscription; version numbers must
 * match exactly, so "opus 5" never lands on Opus 4.5.
 */
export function scoreEntry(queryTokens: string[], entry: IndexEntry): number {
  if (queryTokens.length === 0) return 0;
  let total = 0;
  for (const query of queryTokens) {
    let best = 0;
    for (const token of entry.tokens) best = Math.max(best, tokenScore(query, token));
    if (best < 0.6) return 0;
    total += best;
  }
  // A version the option has but the query didn't ask for is fine; one the
  // query names that the model id lacks has already scored zero above.
  return total / queryTokens.length;
}

/** Scores within this of the best are treated as a tie. */
const TIE = 0.02;

/**
 * Finds the model a query means. A bare number is a position in the
 * indexed list. A tie between two ways of reaching models (an API key and a
 * subscription, say) is ambiguous; a tie inside one connection goes to its
 * first model, which is the picker's default.
 */
export function resolveModel(query: string, index: readonly IndexEntry[]): Resolution {
  const trimmed = query.trim();
  if (/^#?\d+$/.test(trimmed)) {
    const entry = index.find((item) => item.index === Number(trimmed.replace("#", "")));
    return entry ? { status: "match", entry, score: 1 } : { status: "none", candidates: [] };
  }
  const exact = index.find((item) => item.option.id === trimmed || item.modelId === trimmed);
  if (exact) return { status: "match", entry: exact, score: 1 };

  const tokens = tokenize(trimmed).filter((token) => !FILLER.has(token));
  const scored = index
    .map((entry) => ({ entry, score: scoreEntry(tokens, entry) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.index - b.entry.index);
  if (scored.length === 0) return { status: "none", candidates: [] };

  const best = scored[0];
  const tied = scored.filter((item) => best.score - item.score <= TIE);
  const connections = new Set(tied.map((item) => item.entry.connectionId));
  if (connections.size > 1) {
    return { status: "ambiguous", candidates: firstPerConnection(tied.map((item) => item.entry)) };
  }
  return { status: "match", entry: best.entry, score: best.score };
}

function firstPerConnection(entries: IndexEntry[]): IndexEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.connectionId)) return false;
    seen.add(entry.connectionId);
    return true;
  });
}

const KIND_LABEL: Record<ModelKind, string> = {
  api: "API key",
  subscription: "subscription",
  "claude-code": "Claude Code",
};

/** One line per model, numbered, for a bot or the /models command to show. */
export function describeEntry(entry: IndexEntry, current?: string | null): string {
  const mark = entry.option.id === current ? " (current)" : "";
  return `${entry.index}. ${entry.option.name} · ${entry.option.provider} · ${KIND_LABEL[entry.kind]} · ${entry.modelId}${mark}`;
}

export function formatIndex(index: readonly IndexEntry[], current?: string | null): string {
  return index.length ? index.map((entry) => describeEntry(entry, current)).join("\n") : "No models are available.";
}
