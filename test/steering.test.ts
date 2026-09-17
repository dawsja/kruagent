import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCancelledError, RunStoppedError, revisionPrompt, steerStep, taskPrompt, type AgentInput } from "../lib/hq/agent-shared.ts";
import { reviewPrompt, scribePrompt } from "../lib/hq/bots/pipeline-logic.ts";
import { considerSteering, lateSteering, queueSteering, steeringFor, workingOn, type SteerDeps } from "../lib/hq/bots/steering.ts";
import {
  claimDropCard,
  createRun,
  getActiveBotJobForCard,
  getBotJob,
  getCard,
  getRun,
  hasPendingSteering,
  insertCard,
  listSteeringNotes,
  stopCardWork,
  transitionBotJob,
  transitionRun,
} from "../lib/hq/data.ts";
import { newRun, replayNeeded, retryBase } from "../lib/hq/runs-logic.ts";
import type { BotId, Card, Run } from "../lib/hq/types";
import { useTempDataDir } from "./helpers.ts";

const at = "2026-09-17T10:00:00Z";

function card(id: string, patch: Partial<Card> = {}): Card {
  return { id, title: `Card ${id}`, body: "", column: "drop", repo: "o/r", model: "ep:m", status: "open", runId: null, createdAt: at, updatedAt: at, ...patch };
}

/** A card the crew is building: a job at build and its running run, as the pipeline leaves them. */
function building(id: string): { card: Card; run: Run } {
  insertCard(card(id));
  claimDropCard(id, "me", `job-${id}`);
  const run = newRun(`run-${id}`, getCard(id)!, undefined, { bot: "momo" }, at);
  createRun(run, { column: "run", status: "running", runId: run.id, stopped: null });
  transitionBotJob(`job-${id}`, ["build"], "build", { runId: run.id });
  return { card: getCard(id)!, run };
}

/** A model that answers what it's told to, and a room that remembers what was said. */
function deps(answer: string | null | Error) {
  const said: { bot: BotId; text: string; replyTo: string | null }[] = [];
  const asked: { bot: BotId; instructions: string; prompt: string }[] = [];
  const steer: SteerDeps = {
    ask: async (question) => {
      asked.push(question);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    say: (bot, text, options) => {
      said.push({ bot, text, replyTo: options.replyTo });
    },
  };
  return { steer, said, asked };
}

test("a message for a working bot waits on the card and reaches it at its next safe point", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c } = building("c1");
    assert.deepEqual(workingOn(c), { stage: "build", bot: "momo", runId: "run-c1" });
    assert.equal(hasPendingSteering("c1"), false);

    const note = queueSteering(c, { id: "n1", author: "you", body: "  @momo use CSS variables, not a second stylesheet ", messageId: "m1" });
    assert.equal(note?.bot, "momo");
    assert.equal(note?.stage, "build");
    assert.equal(note?.runId, "run-c1");
    assert.equal(note?.body, "@momo use CSS variables, not a second stylesheet");
    assert.equal(hasPendingSteering("c1"), true, "the runner's cheap check sees it");

    const { steer, said, asked } = deps("DECISION: ADJUST\nUnderstood: CSS variables instead of a second stylesheet. Reworking the theme file now.");
    const outcome = await considerSteering("c1", steer);
    assert.equal(outcome?.decision, "adjust");
    assert.match(outcome!.direction, /The person: @momo use CSS variables/, "the running agent is told what was said");
    assert.match(outcome!.direction, /You answered in the room: Understood/);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].bot, "momo");
    assert.match(asked[0].prompt, /Agent started/, "the bot sees its own progress");

    // It answered in the room, under the message that steered it.
    assert.deepEqual(said, [{ bot: "momo", text: "Understood: CSS variables instead of a second stylesheet. Reworking the theme file now.", replyTo: "m1" }]);
    // Read once: the next safe point finds nothing, and the run goes on.
    assert.equal(hasPendingSteering("c1"), false);
    assert.equal(await considerSteering("c1", steer), null);
    assert.equal(getRun("run-c1")?.status, "running");
    assert.equal(getActiveBotJobForCard("c1")?.stage, "build");
    const kept = listSteeringNotes("c1");
    assert.equal(kept[0].decision, "adjust");
    assert.ok(kept[0].deliveredAt);
  } finally {
    temp.cleanup();
  }
});

test("a message to a bot that isn't working is not steering", () => {
  const temp = useTempDataDir();
  try {
    insertCard(card("drop"));
    assert.equal(workingOn(getCard("drop")!), null);
    assert.equal(queueSteering(getCard("drop")!, { id: "n1", author: "you", body: "hello" }), null);
    assert.equal(hasPendingSteering("drop"), false);

    // Waiting in Review, the crew long done: nobody to steer either.
    const { run } = building("rev");
    transitionRun(run.id, ["running"], "needs_approval", {}, { status: "needs_approval", column: "review" });
    transitionBotJob("job-rev", ["build"], "done");
    assert.equal(queueSteering(getCard("rev")!, { id: "n2", author: "you", body: "hello" }), null);

    // A run started by hand has no bot; Pip speaks for it.
    insertCard(card("hand"));
    const manual = newRun("run-hand", getCard("hand")!, undefined, {}, at);
    createRun(manual, { column: "run", status: "running", runId: manual.id });
    assert.deepEqual(workingOn(getCard("hand")!), { stage: "build", bot: "pip", runId: "run-hand" });
    // An empty note is nothing to deliver.
    assert.equal(queueSteering(getCard("hand")!, { id: "n3", author: "pip", body: "   " }), null);
  } finally {
    temp.cleanup();
  }
});

test("told to stop, the run halts without a model being asked, and the card can be restarted from its work", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c } = building("c1");
    queueSteering(c, { id: "n1", author: "you", body: "@momo stop", messageId: "m1" });
    const { steer, said, asked } = deps("DECISION: CONTINUE\nI'd rather finish.");
    const outcome = await considerSteering("c1", steer);

    assert.equal(outcome?.decision, "stop");
    assert.equal(asked.length, 0, "a stop order isn't a question");
    assert.match(said[0].text, /Stopping here/);
    assert.match(said[0].text, /run the card again/);

    // The run actually halted: the runner's isCancelled and isStopped both see it.
    const run = getRun("run-c1")!;
    assert.equal(run.status, "cancelled");
    assert.equal(run.stoppedNote, "You said: @momo stop");
    assert.equal(run.log.at(-1), "Stopped, to be restarted later: You said: @momo stop");
    assert.equal(getBotJob("job-c1")?.stage, "cancelled");
    assert.equal(getBotJob("job-c1")?.claimedBy, null);
    assert.equal(getActiveBotJobForCard("c1"), null);

    // The card says so, back in Drop where run_card takes it.
    const stopped = getCard("c1")!;
    assert.equal(stopped.column, "drop");
    assert.equal(stopped.status, "open");
    assert.equal(stopped.stopped, "You said: @momo stop");

    // What the agent had changed is kept on the stopped run, as finishRun does.
    assert.equal(transitionRun("run-c1", ["cancelled"], null, { proposedWrites: [{ path: "a.ts", content: "half", message: "wip" }] }), true);

    // Restarting continues from that work instead of starting over.
    const base = retryBase(getRun("run-c1"));
    assert.equal(base?.of.id, "run-c1");
    assert.match(base!.note, /stopped part-way \(You said: @momo stop\)/);
    assert.equal(replayNeeded(base!.of), true, "its changes are put back into the new workspace");
    assert.ok(claimDropCard("c1", "me", "job-2"), "run_card can queue it again");
    const next = newRun("run-2", stopped, base, { bot: "momo" }, at);
    assert.equal(next.revisionOf, "run-c1");
    assert.match(next.log[1], /Restarting from where the work was stopped/);
    createRun(next, { column: "run", status: "running", runId: next.id, stopped: null });
    assert.equal(getCard("c1")?.stopped, null, "running again clears the mark");
    assert.equal(getCard("c1")?.status, "running");

    const prompt = revisionPrompt({ writes: base!.of.proposedWrites, summary: null, note: base!.note, resumed: true });
    assert.match(prompt, /stopped part-way/);
    assert.match(prompt, /changed a\.ts/);
    assert.doesNotMatch(prompt, /reviewer/);
  } finally {
    temp.cleanup();
  }
});

test("the bot can decide to stop on its own reading, and a discarded run is not resumed", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c } = building("c1");
    queueSteering(c, { id: "n1", author: "you", body: "@momo this whole idea is wrong, drop it for today", messageId: "m1" });
    const outcome = await considerSteering("c1", deps("DECISION: STOP\nUnderstood, leaving it here.").steer);
    assert.equal(outcome?.decision, "stop");
    assert.equal(getRun("run-c1")?.status, "cancelled");
    assert.ok(getCard("c1")?.stopped);

    // An ordinary cancel (the card's own button) discards: nothing to continue from.
    const { run } = building("c2");
    transitionRun(run.id, ["running"], "cancelled", {}, { status: "open", column: "drop" });
    assert.equal(retryBase(getRun(run.id)), undefined);
    assert.equal(getCard("c2")?.stopped, null);
  } finally {
    temp.cleanup();
  }
});

test("a model that can't be reached doesn't lose the note", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c } = building("c1");
    queueSteering(c, { id: "n1", author: "you", body: "@momo also cover the logout path" });
    const { steer, said } = deps(new Error("model down"));
    const outcome = await considerSteering("c1", steer);
    assert.equal(outcome?.decision, "adjust", "the safe reading: the note reaches the work");
    assert.match(outcome!.direction, /also cover the logout path/);
    assert.equal(said.length, 1);
    assert.equal(getRun("run-c1")?.status, "running");
  } finally {
    temp.cleanup();
  }
});

test("a change of course is carried into the rest of the run: the next build round, Lulu and Bibi", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c, run } = building("c1");
    assert.equal(steeringFor("c1"), null);
    queueSteering(c, { id: "n1", author: "you", body: "@momo make it a settings page, not a modal", messageId: "m1" });
    await considerSteering("c1", deps("DECISION: SWITCH\nSwitching: a settings page instead of the modal.").steer);
    queueSteering(getCard("c1")!, { id: "n2", author: "you", body: "@momo looking good" });
    await considerSteering("c1", deps("DECISION: CONTINUE\nThanks, carrying on.").steer);

    const steering = steeringFor("c1");
    assert.match(steering!, /make it a settings page, not a modal/);
    assert.match(steering!, /Momo switched direction: Switching: a settings page instead of the modal\./);
    assert.doesNotMatch(steering!, /looking good/, "a note that changed nothing isn't direction");

    // The card moves on; every later stage reads the same notes.
    transitionRun(run.id, ["running"], "needs_approval", { summary: "Added the page" }, { status: "needs_approval" });
    transitionBotJob("job-c1", ["build"], "test");
    const done = getRun(run.id)!;
    assert.match(reviewPrompt(getCard("c1")!, done, "all passed", null, steering), /they win:\n- The person \(while Momo was building the change\): @momo make it a settings page/);
    assert.match(scribePrompt(getCard("c1")!, done, "all passed", null, steering), /make it a settings page, not a modal/);
    assert.doesNotMatch(reviewPrompt(getCard("c1")!, done, "all passed", null, null), /direction of this card/);
    const input = { card: getCard("c1")!, steeringNotes: steering, repoInstructions: null } as AgentInput;
    assert.match(taskPrompt(input, ["go"]), /direction of this card changed[\s\S]*settings page[\s\S]*go$/);

    // Kiko has it now, so a new message is his to answer.
    const late = queueSteering(getCard("c1")!, { id: "n3", author: "you", body: "@kiko skip the e2e suite" });
    assert.equal(late?.bot, "kiko");
    assert.equal(late?.stage, "test");
    const { steer, said, asked } = deps("DECISION: ADJUST\nSkipping e2e.");
    await considerSteering("c1", steer);
    assert.equal(said[0].bot, "kiko");
    assert.match(asked[0].prompt, /You are Kiko, running the repo's checks/);
    assert.match(asked[0].prompt, /make it a settings page/, "with the earlier direction as context");
  } finally {
    temp.cleanup();
  }
});

test("notes nobody read before the crew finished are handed back, and a run that can't be halted says so", async () => {
  const temp = useTempDataDir();
  try {
    const { card: c, run } = building("c1");
    queueSteering(c, { id: "n1", author: "you", body: "@momo one more thing" });
    transitionRun(run.id, ["running"], "needs_approval", {}, { status: "needs_approval", column: "review" });
    transitionBotJob("job-c1", ["build"], "done");
    assert.equal(await considerSteering("c1", deps("DECISION: ADJUST\nok").steer), null, "nobody is working: nothing to decide");
    assert.deepEqual(lateSteering("c1").map((note) => note.body), ["@momo one more thing"]);
    assert.deepEqual(lateSteering("c1"), []);

    // Pushing to GitHub: stopping is refused, and the bot never claims it stopped.
    const { card: busy, run: pushing } = building("c2");
    transitionRun(pushing.id, ["running"], "needs_approval", {}, { status: "needs_approval" });
    transitionBotJob("job-c2", ["build"], "scribe");
    transitionRun(pushing.id, ["needs_approval"], "applying");
    assert.equal(stopCardWork("c2", "x"), null);
    queueSteering(busy, { id: "n2", author: "you", body: "@bibi stop" });
    const { steer, said } = deps(null);
    const outcome = await considerSteering("c2", steer);
    assert.equal(outcome?.decision, "continue");
    assert.match(said[0].text, /can't stop/);
    assert.equal(getRun(pushing.id)?.status, "applying");
    assert.equal(getBotJob("job-c2")?.stage, "scribe");
  } finally {
    temp.cleanup();
  }
});

test("between two steps, the builder takes the note into its conversation, or ends the run the right way", async () => {
  const logged: string[] = [];
  const base = { log: (line: string) => logged.push(line) };
  const messages = [{ role: "user", content: "the task" }];

  // Nothing waiting: the step goes on untouched, and nobody is asked.
  let asked = 0;
  const quiet = { ...base, steering: { pending: () => false, consider: async () => ((asked += 1), null) } };
  assert.equal(await steerStep(quiet, messages), undefined);
  assert.equal(asked, 0);

  // A note: the bot's answer becomes the next user turn, after everything so far.
  const outcome = { decision: "switch" as const, reply: "Switching to a page.", notes: [], direction: "The person: make it a page.\n\nYou decided to switch direction." };
  const steered = await steerStep({ ...base, steering: { pending: () => true, consider: async () => outcome } }, messages);
  assert.deepEqual(steered?.messages, [...messages, { role: "user", content: outcome.direction }]);
  assert.deepEqual(messages.length, 1, "the runner's own list is left alone");
  assert.deepEqual(logged, ["Steering from the room (switch): Switching to a page."]);

  // Cancelled by hand: thrown away. Stopped to restart: kept.
  await assert.rejects(steerStep({ ...base, isCancelled: () => true }, messages), RunCancelledError);
  await assert.rejects(steerStep({ ...base, isCancelled: () => true, isStopped: () => true }, messages), RunStoppedError);

  // The note itself stopped the run: by the time the bot has answered, the run is over.
  let halted = false;
  const stopping = {
    ...base,
    isCancelled: () => halted,
    isStopped: () => halted,
    steering: { pending: () => true, consider: async () => ((halted = true), { ...outcome, decision: "stop" as const }) },
  };
  await assert.rejects(steerStep(stopping, messages), RunStoppedError);
});
