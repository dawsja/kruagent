import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROPOSED_FILES,
  ProposedWriteError,
  safeRepoPath,
  validateProposedWrites,
} from "../lib/hq/proposed-writes.ts";

test("paths are normalized inside the repo", () => {
  assert.equal(safeRepoPath("./src//app.ts"), "src/app.ts");
  assert.equal(safeRepoPath("docs\\guide.md"), "docs/guide.md");
});

test("unsafe paths are refused", () => {
  for (const bad of ["../secrets", "a/../../b", "/etc/passwd", "C:/x.txt", ".git/config", "vendor/.git/hooks/pre-commit", ".GIT/HEAD", "", "./"]) {
    assert.equal(safeRepoPath(bad), null, bad);
  }
});

test("one write per path, last one wins, with a default message", () => {
  const writes = validateProposedWrites([
    { path: "a.txt", content: "one", message: "first" },
    { path: "b.txt", content: "b", message: "  " },
    { path: "./a.txt", content: "two", message: "second" },
  ]);
  assert.deepEqual(writes.map((w) => [w.path, w.content, w.message]), [
    ["b.txt", "b", "Update b.txt"],
    ["a.txt", "two", "second"],
  ]);
});

test("empty, oversized, too many, and unsafe proposals fail", () => {
  assert.throws(() => validateProposedWrites([]), (e) => e instanceof ProposedWriteError && /no changes/.test(e.message));
  assert.throws(() => validateProposedWrites([{ path: "big.bin", content: "x".repeat(1024 * 1024 + 1), message: "m" }]), ProposedWriteError);
  const many = Array.from({ length: MAX_PROPOSED_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, content: "", message: "m" }));
  assert.throws(() => validateProposedWrites(many), ProposedWriteError);
  assert.throws(() => validateProposedWrites([{ path: "../escape.txt", content: "", message: "m" }]), ProposedWriteError);
});
