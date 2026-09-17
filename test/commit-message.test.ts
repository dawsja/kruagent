import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_PROMPT_DIFF_CHARS,
  MAX_SUBJECT_CHARS,
  cleanCommitMessage,
  commitMessagePrompt,
  fallbackCommitMessage,
} from "../lib/hq/commit-message.ts";
import type { ProposedWrite } from "../lib/hq/types";

const write = (path: string, extra: Partial<ProposedWrite> = {}): ProposedWrite => ({
  path,
  content: "",
  message: "",
  ...extra,
});

test("a plain reply is kept as is", () => {
  assert.equal(cleanCommitMessage("Add Star on GitHub link to profile menu"), "Add Star on GitHub link to profile menu");
});

test("Markdown, quotes, labels and a closing period are removed", () => {
  assert.equal(cleanCommitMessage('Commit message: "Add **Star on GitHub** to `hq-header`."'), "Add Star on GitHub to hq-header");
  assert.equal(cleanCommitMessage("```\nFix login redirect\n```"), "Fix login redirect");
  assert.equal(cleanCommitMessage("- Fix login redirect\n\nMore detail here"), "Fix login redirect");
  assert.equal(cleanCommitMessage("   \n\n"), null);
  assert.equal(cleanCommitMessage(null), null);
});

test("long lines are cut on a word boundary", () => {
  const subject = cleanCommitMessage(
    'I added a **"Star on GitHub"** item with the GitHub logo to the profile picture menu. It opens https://github.com/dawsja/kruagent in a new tab.',
  );
  assert.equal(subject, 'I added a "Star on GitHub" item with the GitHub logo to the profile');
  assert.equal(cleanCommitMessage("x".repeat(200))?.length, MAX_SUBJECT_CHARS);
});

test("the fallback prefers the summary's first sentence, then the title, then a path", () => {
  const writes = [write("components/hq/hq-header.tsx")];
  assert.equal(
    fallbackCommitMessage({ title: "Profile menu" }, { summary: "Added a GitHub link. Verified with lint.", proposedWrites: writes }),
    "Added a GitHub link",
  );
  assert.equal(fallbackCommitMessage({ title: "Profile menu" }, { summary: null, proposedWrites: writes }), "Profile menu");
  assert.equal(fallbackCommitMessage({ title: "  " }, { summary: "", proposedWrites: writes }), "Update components/hq/hq-header.tsx");
});

test("the prompt lists files and keeps the diff within budget", () => {
  const prompt = commitMessagePrompt(
    { title: "Profile menu", body: "Add a star link" },
    {
      summary: "Done.",
      proposedWrites: [
        write("a.ts", { diff: `diff --git a/a.ts b/a.ts\nnew file mode 100644\n+${"a".repeat(MAX_PROMPT_DIFF_CHARS)}` }),
        write("b.ts", { diff: "diff --git a/b.ts b/b.ts\n+b" }),
        write("c.ts", { deleted: true }),
      ],
    },
  );
  assert.match(prompt, /- a\.ts \(added\)/);
  assert.match(prompt, /- b\.ts \(changed\)/);
  assert.match(prompt, /- c\.ts \(deleted\)/);
  assert.match(prompt, /\[… trimmed\]/);
  assert.ok(!prompt.includes("+b\n"));
  assert.ok(prompt.length < MAX_PROMPT_DIFF_CHARS + 1_000);
});
