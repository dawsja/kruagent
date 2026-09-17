import assert from "node:assert/strict";
import { test } from "node:test";
import { watchEventFor } from "../box/server.mjs";
import { markdownToAnsi, parseInline, parseMarkdown, plainInline } from "../lib/hq/markdown.ts";
import { logHeadline, readRunLog } from "../lib/hq/run-log.ts";

// ---------- markdown ----------

test("markdown: inline code, bold, italics and links", () => {
  assert.deepEqual(parseInline("Run `npm **test**` then **fix `a.ts`** and *check* [docs](https://x.dev/a)"), [
    { kind: "text", text: "Run " },
    { kind: "code", text: "npm **test**" },
    { kind: "text", text: " then " },
    { kind: "bold", children: [{ kind: "text", text: "fix " }, { kind: "code", text: "a.ts" }] },
    { kind: "text", text: " and " },
    { kind: "italic", children: [{ kind: "text", text: "check" }] },
    { kind: "text", text: " " },
    { kind: "link", text: "docs", href: "https://x.dev/a" },
  ]);
  // Not emphasis: snake_case, lone stars, and non-http links.
  assert.deepEqual(parseInline("a_b_c 2 * 3 * 4 [x](javascript:alert(1))"), [
    { kind: "text", text: "a_b_c 2 * 3 * 4 [x](javascript:alert(1))" },
  ]);
  assert.equal(plainInline(parseInline("**Done** with `x`")), "Done with x");
});

test("markdown: blocks", () => {
  const blocks = parseMarkdown(
    ["## Plan", "", "First line", "second line", "", "- one", "  - nested", "2. two", "", "```ts", "const a = 1;", "", "```", "> note", "---"].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "paragraph", "list", "list", "code", "quote", "rule"],
  );
  assert.deepEqual(blocks[1], { kind: "paragraph", inlines: [{ kind: "text", text: "First line\nsecond line" }] });
  assert.deepEqual(
    blocks[2].kind === "list" && blocks[2].items.map((item) => [item.depth, item.marker]),
    [
      [0, "•"],
      [1, "•"],
    ],
  );
  assert.deepEqual(blocks[4], { kind: "code", lang: "ts", text: "const a = 1;\n" });
  // An unclosed fence runs to the end.
  assert.deepEqual(parseMarkdown("```\nls"), [{ kind: "code", lang: "", text: "ls" }]);
});

test("markdown: terminal rendering", () => {
  const out = markdownToAnsi("**Done** with `a.ts`\n\n- one");
  assert.ok(out.includes("\x1b[1mDone\x1b[22m"));
  assert.ok(out.includes("\x1b[36ma.ts\x1b[39m"));
  assert.ok(out.endsWith("one\n"));
  assert.equal(markdownToAnsi("  \n"), "");
});

// ---------- run log ----------

test("run log: lines become entries, exits attach to their command", () => {
  const entries = readRunLog([
    "Agent started",
    "Base branch main",
    "I'll look **around** first.",
    "$ npm test",
    "  exit 1",
    "read src/a.ts",
    "Grep foo",
    "Finished: Fixed it",
    "Skipped big.bin (binary)",
    "The agent stopped without saying it was done. Review carefully; the work may be unfinished.",
    "Claude Code failed: boom",
    "Waiting for approval: 1 file to change",
  ]);
  assert.deepEqual(entries, [
    { kind: "step", text: "Agent started" },
    { kind: "step", text: "Base branch main" },
    { kind: "text", text: "I'll look **around** first." },
    { kind: "command", command: "npm test", outcome: "exit 1" },
    { kind: "file", verb: "read", path: "src/a.ts" },
    { kind: "tool", name: "Grep", detail: "foo" },
    { kind: "finished", text: "Fixed it" },
    { kind: "warning", text: "Skipped big.bin (binary)" },
    {
      kind: "warning",
      text: "The agent stopped without saying it was done. Review carefully; the work may be unfinished.",
    },
    { kind: "error", text: "Claude Code failed: boom" },
    { kind: "approval", text: "Waiting for approval: 1 file to change" },
  ]);
});

test("run log: a closing message repeated as the summary is shown once", () => {
  assert.deepEqual(readRunLog(["Done. **All** good…", "Finished: Done. **All** good, tests pass"]), [
    { kind: "finished", text: "Done. **All** good, tests pass" },
  ]);
  assert.equal(readRunLog(["Checking.", "Finished: Done"]).length, 2);
});

test("run log: headlines are one plain line", () => {
  assert.equal(logHeadline("## **Plan**\n- one"), "Plan");
  assert.equal(logHeadline("$ cat <<EOF\nhi\nEOF"), "$ cat <<EOF");
  assert.equal(logHeadline(undefined), undefined);
});

// ---------- watch feed ----------

test("watch: stream-json lines become styled watch events", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: " Looking **around**\n" },
        { type: "tool_use", name: "Bash", input: { command: "cd /work/run1/src && ls" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/work/run1/src/a.ts" } },
        { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
      ],
    },
  });
  assert.deepEqual(watchEventFor(line, "/work/run1"), [
    { type: "say", text: "Looking **around**" },
    { type: "command", command: "cd ./src && ls" },
    { type: "edit", path: "src/a.ts" },
    { type: "tool", name: "Grep", detail: "foo" },
  ]);
  assert.equal(watchEventFor("nope"), null);
});
