import assert from "node:assert/strict";
import { test } from "node:test";
import { approveMode, prBody, pushRefusal } from "../lib/hq/approve-logic.ts";

test("approveMode pushes only when the run continues a pull request", () => {
  assert.equal(approveMode({ headBranch: null, prUrl: null }), "open");
  assert.equal(approveMode({ headBranch: "kru/abc", prUrl: null }), "open");
  assert.equal(approveMode({ headBranch: "kru/abc", prUrl: "https://github.com/o/r/pull/1" }), "push");
});

test("pushRefusal explains a merged or closed pull request", () => {
  assert.equal(pushRefusal("open", 3), null);
  assert.match(pushRefusal("merged", 3)!, /^Pull request #3 was merged/);
  assert.match(pushRefusal("closed", null)!, /^The pull request was closed without merging/);
});

test("prBody is the standing line", () => {
  assert.equal(prBody({ repo: "o/r" }), "Proposed by Kru. Human-approved write.");
});
