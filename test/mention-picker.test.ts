import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterMentions,
  insertMention,
  mentionTokenAt,
  moveHighlight,
  pickerKey,
  pickerOpen,
  type PickerState,
} from "../components/hq/mention-picker-logic.ts";
import { BOTS } from "../lib/hq/bots/registry.ts";

/** `|` marks the caret. */
function at(marked: string) {
  const caret = marked.indexOf("|");
  const text = marked.replace("|", "");
  return { text, caret, token: mentionTokenAt(text, caret) };
}

/** The picker's state for a marked message, against the real crew. */
function state(marked: string, highlight = 0): PickerState {
  const { token } = at(marked);
  return { token, matches: token ? filterMentions(BOTS, token.query) : [], highlight };
}

test("the picker opens on an @ that starts a word, wherever in the message", () => {
  assert.deepEqual(at("@|").token, { start: 0, end: 1, query: "" });
  assert.deepEqual(at("@mo|").token, { start: 0, end: 3, query: "mo" });
  assert.deepEqual(at("hey @ki| can you").token, { start: 4, end: 7, query: "ki" });
  assert.deepEqual(at("line one\n@lu|").token, { start: 9, end: 12, query: "lu" });
  assert.deepEqual(at("(@bi|)").token, { start: 1, end: 4, query: "bi" });
  // The caret in the middle of the word: what's before it filters, all of it is replaced.
  assert.deepEqual(at("@mo|mo hi").token, { start: 0, end: 5, query: "mo" });

  // Not the start of a word: an email address, a@b, or a second @.
  assert.equal(at("me@ex|ample.com").token, null);
  assert.equal(at("a@|").token, null);
  assert.equal(at("@@|").token, null);
});

test("it closes when the token is deleted or the caret leaves it", () => {
  assert.equal(at("|").token, null, "the @ was deleted");
  assert.equal(at("hello |").token, null);
  assert.equal(at("@momo |").token, null, "past the space after it");
  assert.equal(at("|@momo").token, null, "before the @");
  assert.equal(at("@mo mo|").token, null, "in the next word");
  assert.equal(mentionTokenAt("@mo", 99), null, "a caret the text doesn't have");
  assert.ok(at("@momo|").token, "still inside at the end of the word");
});

test("letters filter the crew's own list by name, then by job; nothing matching closes it", () => {
  const names = (query: string) => filterMentions(BOTS, query).map((bot) => bot.name);
  assert.deepEqual(names(""), BOTS.map((bot) => bot.name), "everyone, in the crew's order");
  assert.deepEqual(names("mo"), ["Momo"]);
  assert.deepEqual(names("MO"), ["Momo"]);
  assert.deepEqual(names("momo"), ["Momo"]);
  assert.deepEqual(names("rev"), ["Lulu"], "by role");
  assert.deepEqual(names("b"), ["Bibi", "Momo"], "names first, then the builder");
  assert.deepEqual(names("zz"), []);
  // The list is whatever crew it is given, not five names baked in.
  assert.deepEqual(filterMentions([{ id: "zed", name: "Zed", role: "janitor" }], "z").map((bot) => bot.id), ["zed"]);

  assert.equal(pickerOpen(state("@mo|"), null), true);
  assert.equal(pickerOpen(state("@zz|"), null), false, "nothing matches");
  assert.equal(pickerOpen(state("hello|"), null), false);
});

test("arrows move the highlight and wrap; Enter and Tab pick; Escape closes without inserting", () => {
  assert.equal(moveHighlight(0, 1, 5), 1);
  assert.equal(moveHighlight(4, 1, 5), 0);
  assert.equal(moveHighlight(0, -1, 5), 4);
  assert.equal(moveHighlight(0, 1, 0), 0);

  const open = state("@|");
  assert.deepEqual(pickerKey(open, "ArrowDown"), { kind: "move", highlight: 1 });
  assert.deepEqual(pickerKey(open, "ArrowUp"), { kind: "move", highlight: BOTS.length - 1 });
  assert.deepEqual(pickerKey({ ...open, highlight: BOTS.length - 1 }, "ArrowDown"), { kind: "move", highlight: 0 });

  // Enter picks instead of sending; Tab does the same.
  const second = { ...open, highlight: 1 };
  assert.deepEqual(pickerKey(second, "Enter"), { kind: "insert", option: BOTS[1] });
  assert.deepEqual(pickerKey(second, "Tab"), { kind: "insert", option: BOTS[1] });
  assert.deepEqual(pickerKey(state("@ki|"), "Enter"), { kind: "insert", option: BOTS.find((bot) => bot.id === "kiko") });
  // A highlight left over from a longer list still lands on something.
  assert.deepEqual(pickerKey(state("@ki|", 4), "Enter"), { kind: "insert", option: BOTS.find((bot) => bot.id === "kiko") });

  assert.deepEqual(pickerKey(open, "Escape"), { kind: "close" });
  assert.equal(pickerOpen(open, open.token!.start), false, "dismissed: closed while the caret stays in that token");
  assert.equal(pickerOpen(state("@mo|"), 0), false, "typing on in the same token keeps it closed");
  assert.equal(pickerOpen(state("@mo hi @|"), 0), true, "a new @ opens it again");

  // Everything else is the message box's: typing, Shift+Enter, shortcuts.
  assert.equal(pickerKey(open, "a"), null);
  assert.equal(pickerKey(open, "Enter", { shift: true }), null);
  assert.equal(pickerKey(open, "Tab", { shift: true }), null);
  assert.equal(pickerKey(open, "ArrowDown", { meta: true }), null);
  // Closed: Enter is the message box's, which sends.
  assert.equal(pickerKey(state("hello|"), "Enter"), null);
  assert.equal(pickerKey(state("@zz|"), "Enter"), null);
});

test("picking inserts @name and a space, and leaves the caret after it", () => {
  const pick = (marked: string, id: string) => {
    const { text, token } = at(marked);
    const next = insertMention(text, token!, id);
    return `${next.text.slice(0, next.caret)}|${next.text.slice(next.caret)}`;
  };
  assert.equal(pick("@|", "pip"), "@pip |");
  assert.equal(pick("@mo|", "momo"), "@momo |");
  // Mid-message: the rest stays, and an existing space isn't doubled.
  assert.equal(pick("hey @ki| can you run it", "kiko"), "hey @kiko |can you run it");
  assert.equal(pick("hey @ki|, can you", "kiko"), "hey @kiko |, can you");
  assert.equal(pick("@mo|mo please", "momo"), "@momo |please");
  assert.equal(pick("first line\n@lu|\nlast line", "lulu"), "first line\n@lulu |\nlast line");
  // What was picked is a mention the room understands, and the picker is closed after it.
  const { text, token } = at("ask @bi|");
  const next = insertMention(text, token!, "bibi");
  assert.equal(mentionTokenAt(next.text, next.caret), null);
});
