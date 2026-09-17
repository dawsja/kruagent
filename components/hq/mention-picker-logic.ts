/*
 * The @ mention picker's rules, apart from React so they can be tested:
 * where the @ token under the caret is, which bots it matches, what a key
 * does while the list is open, and what the message looks like after a
 * pick. The component in team-chat.tsx only draws the result.
 */

/** What the picker needs to know about a bot; the crew's registry has more. */
export type MentionOption = { id: string; name: string; role: string };

/** The `@word` the caret is in: where the @ is, where the word ends, and the letters typed so far. */
export type MentionToken = { start: number; end: number; query: string };

const WORD = /\w/;

/**
 * The @ token the caret sits in, or null. The @ has to start a word: at the
 * start of the message or after a space or punctuation, so an email address
 * or `a@b` opens nothing. The caret has to be after the @ and inside the
 * letters that follow it; moving it out closes the picker.
 */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  if (caret < 1 || caret > text.length) return null;
  let at = caret;
  while (at > 0 && WORD.test(text[at - 1])) at -= 1;
  if (at === 0 || text[at - 1] !== "@") return null;
  const start = at - 1;
  if (start > 0 && (WORD.test(text[start - 1]) || text[start - 1] === "@")) return null;
  let end = caret;
  while (end < text.length && WORD.test(text[end])) end += 1;
  return { start, end, query: text.slice(at, caret) };
}

/**
 * The bots a query matches, in the crew's own order: those whose name or id
 * starts with it first, then those whose role does ("@rev" finds the
 * reviewer). No letters yet matches everyone.
 */
export function filterMentions<T extends MentionOption>(options: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return [...options];
  const byName = options.filter((bot) => bot.id.toLowerCase().startsWith(q) || bot.name.toLowerCase().startsWith(q));
  const byRole = options.filter((bot) => !byName.includes(bot) && bot.role.toLowerCase().startsWith(q));
  return [...byName, ...byRole];
}

/**
 * The message after picking a bot: the token becomes `@id` and one space,
 * and the caret lands after that space. A space already there is reused
 * rather than doubled, so picking mid-message leaves the rest as it was.
 */
export function insertMention(text: string, token: MentionToken, id: string): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const mention = `@${id}`;
  const next = `${before}${mention}${after.startsWith(" ") ? "" : " "}${after}`;
  return { text: next, caret: before.length + mention.length + 1 };
}

/** The highlight after an arrow key: it wraps at both ends. */
export function moveHighlight(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

export type PickerState = {
  /** The token being completed; null when the picker is closed. */
  token: MentionToken | null;
  matches: readonly MentionOption[];
  highlight: number;
};

/**
 * Whether the picker shows: there is a token, something matches it, and it
 * wasn't dismissed with Escape. A dismissal lasts while the caret stays in
 * that same token; a new @ opens the picker again.
 */
export function pickerOpen(state: Pick<PickerState, "token" | "matches">, dismissedStart: number | null): boolean {
  return Boolean(state.token) && state.matches.length > 0 && state.token?.start !== dismissedStart;
}

export type PickerAction =
  | { kind: "move"; highlight: number }
  | { kind: "insert"; option: MentionOption }
  | { kind: "close" };

/**
 * What a key does while the picker is open, or null when the key isn't the
 * picker's and the message box handles it as usual. Enter and Tab pick the
 * highlighted bot, which is why Enter doesn't send while the list is up.
 */
export function pickerKey(state: PickerState, key: string, modifiers: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}): PickerAction | null {
  if (!state.token || state.matches.length === 0) return null;
  if (modifiers.alt || modifiers.ctrl || modifiers.meta) return null;
  const highlight = Math.min(state.highlight, state.matches.length - 1);
  switch (key) {
    case "ArrowDown":
      return { kind: "move", highlight: moveHighlight(highlight, 1, state.matches.length) };
    case "ArrowUp":
      return { kind: "move", highlight: moveHighlight(highlight, -1, state.matches.length) };
    case "Enter":
      // Shift+Enter is still a new line.
      return modifiers.shift ? null : { kind: "insert", option: state.matches[highlight] };
    case "Tab":
      return modifiers.shift ? null : { kind: "insert", option: state.matches[highlight] };
    case "Escape":
      return { kind: "close" };
    default:
      return null;
  }
}
