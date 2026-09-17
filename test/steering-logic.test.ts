import assert from "node:assert/strict";
import { test } from "node:test";
import {
  continuationSection,
  fallbackDecision,
  isStopOrder,
  parseSteerDecision,
  progressLines,
  resumeNote,
  steerDirection,
  steerPrompt,
  steerTarget,
  steeringSection,
  stopReason,
} from "../lib/hq/bots/steering-logic.ts";
import type { BotJob, SteeringNote } from "../lib/hq/types";

const at = "2026-09-17T10:00:00Z";

function job(id: string, cardId: string, stage: BotJob["stage"], updatedAt = at): BotJob {
  return { id, cardId, stage, runId: null, rounds: 0, testReport: null, reviewVerdict: null, error: null, claimedBy: "me", createdAt: at, updatedAt };
}

function note(body: string, patch: Partial<SteeringNote> = {}): SteeringNote {
  return {
    id: "n1",
    cardId: "c1",
    runId: "r1",
    stage: "build",
    bot: "momo",
    author: "you",
    body,
    messageId: "m1",
    decision: null,
    reply: null,
    createdAt: at,
    deliveredAt: null,
    ...patch,
  };
}

test("a message steers the card its bot is working, and nothing when the bot is idle", () => {
  const cards = [
    { id: "c1", title: "Add dark mode" },
    { id: "c2", title: "Fix the login redirect" },
  ];
  assert.equal(steerTarget("momo", "also do the footer", [], cards), null, "nobody is working");
  assert.equal(steerTarget("momo", "also do the footer", [job("j1", "c1", "test")], cards), null, "Kiko has it, not Momo");
  assert.equal(steerTarget("kiko", "skip the lint", [job("j1", "c1", "test")], cards)?.id, "j1");
  assert.equal(steerTarget("momo", "hi", [job("j1", "c1", "done")], cards), null, "a finished job steers nothing");
  assert.equal(steerTarget("pip", "stop", [job("j1", "c1", "build")], cards), null, "Pip never has a stage");
  assert.equal(steerTarget("momo", "x", [job("j1", "gone", "build")], cards), null, "the card was deleted");

  // Two cards at once: the one the message names, else the one that moved last.
  const both = [job("j1", "c1", "build", "2026-09-17T10:01:00Z"), job("j2", "c2", "build", "2026-09-17T10:05:00Z")];
  assert.equal(steerTarget("momo", "on the dark mode one, use CSS variables", both, cards)?.id, "j1");
  assert.equal(steerTarget("momo", "the login fix should also cover logout", both, cards)?.id, "j2");
  assert.equal(steerTarget("momo", "use tabs", both, cards)?.id, "j2");
});

test("a bare order to stop is recognised; a change of course that starts with stop is not", () => {
  for (const text of ["stop", "@momo stop", "@momo please stop!", "Pause", "pause that for now please", "hold on", "@kiko halt the checks", "stop working", "STOP.", "cancel that", "wait", "stop what you're doing"]) {
    assert.equal(isStopOrder(text), true, text);
  }
  for (const text of ["stop using npm, use pnpm", "@momo don't stop", "pause the animation when the tab is hidden", "wait, also add a test", "also add dark mode", "", "hold the header at 64px"]) {
    assert.equal(isStopOrder(text), false, text);
  }
});

test("the bot's decision is read from its first line, with the rest as its reply", () => {
  assert.deepEqual(parseSteerDecision("DECISION: ADJUST\nGot it, I'll use pnpm from here on."), {
    decision: "adjust",
    reply: "Got it, I'll use pnpm from here on.",
  });
  assert.equal(parseSteerDecision("**DECISION: STOP**\n\nStopping now.")?.decision, "stop");
  assert.equal(parseSteerDecision("decision: switch - dropping the modal, doing a page instead")?.decision, "switch");
  assert.equal(parseSteerDecision("decision: switch - dropping the modal, doing a page instead")?.reply, "dropping the modal, doing a page instead");
  assert.equal(parseSteerDecision("Sure.\nDECISION: CONTINUE")?.decision, "continue");
  assert.match(parseSteerDecision("DECISION: CONTINUE")!.reply, /carrying on/, "a bare decision gets a plain reply");
  // No line, or a word that isn't a decision: the note still reaches the work.
  assert.deepEqual(parseSteerDecision("I'll switch to pnpm."), { decision: "adjust", reply: "I'll switch to pnpm." });
  assert.equal(parseSteerDecision("DECISION: MAYBE\nhm")?.decision, "adjust");
  assert.equal(parseSteerDecision(""), null);
  assert.equal(parseSteerDecision(null), null);
  assert.ok(parseSteerDecision(`DECISION: ADJUST\n${"x".repeat(2_000)}`)!.reply.length <= 600);
});

test("with no model to ask, a stop order stops and anything else reaches the work", () => {
  assert.equal(fallbackDecision([note("@momo stop")]).decision, "stop");
  assert.equal(fallbackDecision([note("use pnpm")]).decision, "adjust");
  assert.equal(fallbackDecision([note("use pnpm"), note("stop")]).decision, "stop");
  assert.equal(stopReason([note("@momo   stop,\nplease")]), "You said: @momo stop, please");
  assert.equal(stopReason([note("hold this one", { author: "pip" })]), "Pip said: hold this one");
});

test("the question shows the task, the bot's own progress, and who said what", () => {
  const prompt = steerPrompt({
    bot: "momo",
    stage: "build",
    card: { title: "Add dark mode", body: "Toggle in the header", repo: "o/r" },
    notes: [note("use CSS variables, not a second stylesheet"), note("the person wants it on the settings page too", { author: "pip" })],
    progress: ["$ npm test", "edit src/theme.ts"],
    earlier: [note("keep it small", { decision: "adjust", reply: "Keeping it small." })],
  });
  assert.match(prompt, /You are Momo, building the change/);
  assert.match(prompt, /Task: Add dark mode/);
  assert.match(prompt, /Toggle in the header/);
  assert.match(prompt, /edit src\/theme\.ts/);
  assert.match(prompt, /The person: use CSS variables/);
  assert.match(prompt, /Pip, passing on what the person wants: the person wants it on the settings page too/);
  assert.match(prompt, /keep it small/, "an earlier note gives the new one its context");
  assert.deepEqual(progressLines(["a\nb", "c"], 1), ["c"]);
  assert.deepEqual(progressLines(["a\n  b"]), ["a b"]);
});

test("the working agent is told the message, its own answer, and what that means", () => {
  const adjust = steerDirection([note("use pnpm")], "adjust", "Switching to pnpm.");
  assert.match(adjust, /The person: use pnpm/);
  assert.match(adjust, /You answered in the room: Switching to pnpm\./);
  assert.match(adjust, /adjust/);
  assert.match(steerDirection([note("make it a page, not a modal")], "switch", "ok"), /replaces the parts of the original task/);
  assert.match(steerDirection([note("nice work")], "continue", "thanks"), /Carry on/);

  const again = continuationSection(adjust, ["$ npm install", "edit a.ts"]);
  assert.match(again, /continuation, not a fresh start/);
  assert.match(again, /git status/);
  assert.match(again, /edit a\.ts/);
  assert.match(again, /The person: use pnpm/);
});

test("later stages get the course changes, and not the notes that changed nothing", () => {
  assert.equal(steeringSection([]), "");
  assert.equal(steeringSection([note("nice", { decision: "continue", reply: "thanks" })]), "");
  assert.equal(steeringSection([note("unread")]), "", "a note nobody read yet decided nothing");
  const section = steeringSection([
    note("nice", { decision: "continue", reply: "thanks" }),
    note("use CSS variables", { decision: "adjust", reply: "Using variables now." }),
    note("make it a settings page instead", { decision: "switch", reply: "Switching.", stage: "review", bot: "lulu" }),
  ]);
  assert.match(section, /direction of this card changed/);
  assert.match(section, /they win/);
  assert.match(section, /while Momo was building the change\): use CSS variables/);
  assert.match(section, /Momo adjusted: Using variables now\./);
  assert.match(section, /while Lulu was reviewing the change\): make it a settings page instead/);
  assert.match(section, /Lulu switched direction/);
  assert.doesNotMatch(section, /nice/);
  assert.match(resumeNote("You said: stop"), /stopped part-way \(You said: stop\) and has now been restarted/);
});
