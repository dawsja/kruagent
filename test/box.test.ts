import assert from "node:assert/strict";
import { test } from "node:test";
import { changesToWrites } from "../lib/hq/box.ts";
import type { Run } from "../lib/hq/types";
import { boxCwd, capOutput, desktopSize, insideHome, insideWorkspace, parseNameStatus, workspaceDir, HttpError } from "../box/server.mjs";

test("changed files become proposed writes; binary and huge files are skipped", () => {
  const { writes, skipped } = changesToWrites(
    [
      { path: "src/a.ts", status: "modified", content: "a" },
      { path: "new.md", status: "added", content: "n" },
      { path: "old.txt", status: "deleted" },
      { path: "logo.png", status: "added", binary: true, size: 10 },
      { path: "big.json", status: "modified", tooLarge: true, size: 5_000_000 },
    ],
    "Add the thing",
  );
  assert.deepEqual(writes, [
    { path: "src/a.ts", content: "a", message: "Add the thing" },
    { path: "new.md", content: "n", message: "Add the thing" },
    { path: "old.txt", content: "", message: "Add the thing", deleted: true },
  ]);
  assert.deepEqual(skipped, ["logo.png (binary)", "big.json (larger than 1 MB)"]);
});

test("box: name-status output is parsed in pairs", () => {
  assert.deepEqual(parseNameStatus("M\0src/a.ts\0A\0new file.md\0D\0gone\0"), [
    ["M", "src/a.ts"],
    ["A", "new file.md"],
    ["D", "gone"],
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("box: long output keeps its start and end", () => {
  const short = capOutput("hello", 100);
  assert.equal(short.text, "hello");
  assert.equal(short.truncated, false);
  const long = capOutput(`${"a".repeat(500)}${"z".repeat(500)}`, 200);
  assert.ok(long.truncated);
  assert.ok(long.text.startsWith("a".repeat(50)));
  assert.ok(long.text.endsWith("z".repeat(150)));
  assert.match(long.text, /characters omitted/);
});

test("box: paths stay inside the workspace and out of .git", () => {
  const root = "/work/run1";
  assert.equal(insideWorkspace(root, "src/app.ts"), "/work/run1/src/app.ts");
  assert.equal(insideWorkspace(root, "./README.md"), "/work/run1/README.md");
  assert.equal(insideWorkspace(root, "."), root);
  for (const bad of ["../other", "/etc/passwd", ".git/config", "a/.git/x", "", "   "]) {
    assert.throws(() => insideWorkspace(root, bad), (e) => e instanceof HttpError && e.status === 400, bad);
  }
});

test("box: workspace ids are plain tokens", () => {
  assert.equal(workspaceDir("abc_123-x"), "/home/agent/workspace/abc_123-x");
  for (const bad of ["../x", "a/b", "", "x".repeat(65), "a b"]) {
    assert.throws(() => workspaceDir(bad), HttpError, bad);
  }
});

test("box: a feed replays history to late joiners and stops when closed", async () => {
  const { Feed } = await import("../box/server.mjs");
  const feed = new Feed(1000);
  feed.publish({ type: "command", command: "one" });
  feed.publish({ type: "output", text: "two" });
  const late: string[] = [];
  const stop = feed.subscribe((line: string) => late.push(line));
  assert.equal(late.length, 2);
  feed.publish({ type: "exit", code: 0 });
  assert.equal(late.length, 3);
  stop();
  feed.publish({ type: "output", text: "unseen" });
  assert.equal(late.length, 3);
  feed.close();
  const after: string[] = [];
  feed.subscribe((line: string) => after.push(line));
  assert.match(after.at(-1) ?? "", /"end"/);
});

test("box: terminals start in ~/workspace or an existing run workspace", async () => {
  const { terminalCwd } = await import("../box/server.mjs");
  assert.equal(terminalCwd(undefined), "/home/agent/workspace");
  assert.equal(terminalCwd(""), "/home/agent/workspace");
  assert.throws(() => terminalCwd("../etc"), HttpError);
  assert.throws(() => terminalCwd("does-not-exist"), (e) => e instanceof HttpError && e.status === 404);
});

test("box: a feed drops its oldest lines past the byte limit but keeps the newest", async () => {
  const { Feed } = await import("../box/server.mjs");
  const feed = new Feed(80);
  for (let i = 0; i < 10; i += 1) feed.publish({ type: "output", text: `line ${i}` });
  const seen: string[] = [];
  feed.subscribe((line: string) => seen.push(line));
  assert.ok(seen.length < 10 && seen.length >= 1);
  assert.match(seen.at(-1) ?? "", /line 9/);
});

test("box: desktop sizes fall back to a default and stay within X limits", () => {
  assert.deepEqual(desktopSize({}), { width: 1280, height: 800 });
  assert.deepEqual(desktopSize({ width: "1920", height: 1080.9 }), { width: 1920, height: 1080 });
  assert.deepEqual(desktopSize({ width: 10, height: 99999 }), { width: 640, height: 4096 });
  assert.deepEqual(desktopSize({ width: "wide", height: null }), { width: 1280, height: 800 });
});

test("box: only the workspaces nothing needs are pruned", async () => {
  const { workspacesToDrop } = await import("../lib/hq/workspaces.ts");
  const now = Date.UTC(2026, 0, 10);
  const day = 24 * 60 * 60 * 1000;
  // Newest first, the order the box returns them in.
  const workspaces = [
    { id: "running", at: now - 60_000 },
    { id: "keep-me", at: now - 120_000 },
    { id: "failed", at: now - 180_000 },
    { id: "review1", at: now - 1 * day + 1000 },
    { id: "review2", at: now - 1 * day + 2000 },
    { id: "review3", at: now - 1 * day + 3000 },
    { id: "review-old", at: now - 3 * day },
    { id: "approved", at: now - 5000 },
    { id: "orphan", at: now - 5000 },
  ];
  const status = new Map<string, Run["status"]>([
    ["running", "running"],
    ["keep-me", "needs_approval"],
    ["review1", "needs_approval"],
    ["review2", "needs_approval"],
    ["review3", "needs_approval"],
    ["review-old", "needs_approval"],
    ["approved", "approved"],
    ["failed", "error"],
  ]);

  const drop = workspacesToDrop(workspaces, status, new Set(["keep-me"]), now, 2);
  // The run in flight and the one asked for by name are never touched, and
  // neither are the two newest kept for review or recovery.
  assert.deepEqual(drop.sort(), ["approved", "orphan", "review2", "review3", "review-old"].sort());

  // With no cap at all, only what nothing is waiting on goes.
  assert.deepEqual(
    workspacesToDrop(workspaces, status, new Set(), now, 99).sort(),
    ["approved", "orphan", "review-old"].sort(),
  );

  // Turned off: every workspace no run is actively using goes.
  assert.deepEqual(
    workspacesToDrop(workspaces, status, new Set(), now, 0).sort(),
    ["approved", "failed", "keep-me", "orphan", "review1", "review2", "review3", "review-old"].sort(),
  );
});

test("box: the bots' home paths stay inside home and out of the Claude login", () => {
  const home = "/home/agent";
  const claude = "/home/agent/.claude";
  assert.equal(boxCwd(undefined, home, claude), home);
  assert.equal(boxCwd("", home, claude), home);
  assert.equal(boxCwd("bots/notes", home, claude), "/home/agent/bots/notes");
  assert.equal(boxCwd("/home/agent/workspace/abc", home, claude), "/home/agent/workspace/abc");
  assert.equal(boxCwd("/home/agent", home, claude), home);
  assert.throws(() => boxCwd("../etc", home, claude), HttpError);
  assert.throws(() => boxCwd("/etc", home, claude), HttpError);
  assert.throws(() => boxCwd(".claude", home, claude), HttpError);
  assert.throws(() => boxCwd("/home/agent/.claude/projects", home, claude), HttpError);
  assert.throws(() => boxCwd(42, home, claude), HttpError);

  assert.equal(insideHome("bots/a.txt", home, claude), "/home/agent/bots/a.txt");
  assert.throws(() => insideHome("../x", home, claude), HttpError);
  assert.throws(() => insideHome(".claude/credentials.json", home, claude), HttpError);
  assert.throws(() => insideHome("repo/.git/config", home, claude), HttpError);
});
