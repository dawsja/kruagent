import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLineKind, diffRows, diffStats } from "../lib/hq/diff.ts";

const SAMPLE = [
  "diff --git a/a.ts b/a.ts",
  "index 1111..2222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  "--x", // a removed line whose own text starts with "-"
].join("\n");

test("diff lines are classified for display", () => {
  assert.deepEqual(SAMPLE.split("\n").map(diffLineKind), [
    "meta", "meta", "meta", "meta", "hunk", "context", "del", "add", "add", "del",
  ]);
});

test("diff stats count added and removed lines only", () => {
  assert.deepEqual(diffStats(SAMPLE), { added: 2, removed: 2 });
  assert.deepEqual(diffStats(""), { added: 0, removed: 0 });
});

test("diff rows carry old and new line numbers", () => {
  const diff = [
    ...SAMPLE.split("\n").slice(0, -1),
    "@@ -10,2 +11,2 @@ function f() {",
    " keep",
    "-old",
    "+new",
    "\\ No newline at end of file",
    "[… diff truncated …]",
    "",
  ].join("\n");
  assert.deepEqual(diffRows(diff), [
    { kind: "hunk", text: "@@ -1,3 +1,4 @@" },
    { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
    { kind: "del", oldLine: 2, text: "const b = 2;" },
    { kind: "add", newLine: 2, text: "const b = 3;" },
    { kind: "add", newLine: 3, text: "const c = 4;" },
    { kind: "hunk", text: "@@ -10,2 +11,2 @@ function f() {" },
    { kind: "context", oldLine: 10, newLine: 11, text: "keep" },
    { kind: "del", oldLine: 11, text: "old" },
    { kind: "add", newLine: 12, text: "new" },
    { kind: "note", text: "\\ No newline at end of file" },
    { kind: "note", text: "[… diff truncated …]" },
  ]);
});

test("diff rows keep non-hunk notes like binary changes", () => {
  assert.deepEqual(diffRows("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n"), [
    { kind: "note", text: "Binary files a/x.png and b/x.png differ" },
  ]);
});
