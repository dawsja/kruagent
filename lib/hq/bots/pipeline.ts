import { logCommand } from "../agent-shared";
import { approveRun } from "../approve";
import { boxConfig, execInWorkspace, readWorkspaceFile, BoxError } from "../box";
import { askCardModel } from "../card-model";
import { generateCommitMessage } from "../commit-message-model";
import {
  appendRunLog,
  getBotJob,
  getBotsAutoPush,
  getCard,
  getRepoInstructions,
  getRun,
  patchCard,
  transitionBotJob,
  transitionRun,
} from "../data";
import { reviewRun } from "./reviewer";
import { beginRun, claimForRevision, finishRun, retryOf, runProblem } from "../runs";
import { isActiveStage, type BotJob, type BotStage, type Card, type Run } from "../types";
import {
  MAX_REVIEW_ROUNDS,
  cleanSummary,
  formatTestReport,
  isFollowUp,
  nextStageAfterReview,
  parseVerdict,
  reviewPrompt,
  REVIEW_RULES,
  REVIEW_TOOL_RULES,
  RETRY_BACKOFF_MS,
  retryPlan,
  scribePrompt,
  type FailureCause,
  SCRIBE_RULES,
  testHeadline,
  testPlan,
  type TestResult,
} from "./pipeline-logic";
import { ensureCardModel } from "./models";
import { botForStage, getBot } from "./registry";
import { postEvent } from "./room";
import { stageInstructions } from "./souls";
import { considerCardSteering } from "./steer-card";
import { lateSteering, steeringFor } from "./steering";

/*
 * The crew's pipeline for one card: Momo builds (the ordinary agent run),
 * Kiko runs the repo's checks in the workspace, Lulu reviews the diff and
 * may send it back to Momo, Bibi writes it up, and the card lands in Review
 * for the person. Every step is a compare-and-set on the job, so a restart
 * or a cancel can't be raced.
 *
 * A message for the bot that has the card is read at that bot's next safe
 * point (see steering.ts): inside the builder's own loop for Momo, and here
 * for the others, before a stage starts, between Kiko's commands, and
 * after Lulu's and Bibi's question, before anything is made of the answer.
 */

/** Longest one of Kiko's commands may run. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** Longest Lulu or Bibi may take on one question. */
const QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

class StageError extends Error {}

/** A stage that can't start until the person fixes something; retrying won't help. */
class SetupError extends StageError {}

/** A run error that says the same: a sign-in lapsed, a connection is gone. */
const SETUP_MESSAGES = /connect github|reconnect|sign in|signed in|pick a (model|repo)|endpoint was removed|isn't configured/i;

function quote(card: Card) {
  return `"${card.title}"`;
}

function fileCount(run: Run) {
  const n = run.proposedWrites.length;
  return `${n} file${n === 1 ? "" : "s"}`;
}

function clipNote(text: string, max = 200) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A safe point for Kiko, Lulu and Bibi. Returns true when the stage must
 * not go on as it was: the card was stopped, the change went back to Momo
 * because the direction switched, or (`redo`, for a stage that has already
 * asked its question) the stage should ask again with the note in hand.
 * An adjustment before the stage has started needs nothing: the prompts
 * read the card's steering notes when they are built.
 */
async function steered(job: BotJob, card: Card, run: Run | null, options: { redo?: boolean } = {}): Promise<boolean> {
  const outcome = await considerCardSteering(card, run);
  if (!outcome) return false;
  if (run) appendRunLog(run.id, `Steering from the room (${outcome.decision}): ${outcome.reply}`);
  if (outcome.decision === "stop") return true;
  if (outcome.decision === "adjust") return Boolean(options.redo);
  if (outcome.decision !== "switch" || !run) return false;

  // A new direction is the builder's to take: the change goes back to Momo,
  // like a review that asked for changes, without using up a review round.
  const bot = botForStage(job.stage as BotStage) ?? getBot("pip");
  const said = outcome.notes.map((note) => clipNote(note.body, 1_000)).join("\n");
  const note = `The direction of this card changed while ${bot.name} was ${bot.verb}:\n${said}\nRework the change to fit.`;
  if (!claimForRevision(run, note)) return false;
  const revision = beginRun(card, { of: run, note }, { bot: "momo" });
  if (transitionBotJob(job.id, [job.stage], "build", { runId: revision.id })) {
    postEvent(bot.id, `${quote(card)} is changing direction, so it goes back to the builder. @momo over to you.`, card.id);
  }
  return true;
}

/** Notes nobody got to read before the crew was done: say so, rather than drop them silently. */
function tooLateToSteer(card: Card) {
  const late = lateSteering(card.id);
  if (late.length === 0) return;
  postEvent(
    "pip",
    `A message for the crew about ${quote(card)} came after they were done with it, so nobody acted on it: "${clipNote(late.map((note) => note.body).join(" / "))}". Ask for changes on the card to have it taken in.`,
    card.id,
  );
}

/** Drives a job from its current stage to the end. Returns when it is over. */
export async function runPipeline(initial: BotJob): Promise<void> {
  let job = initial;
  for (;;) {
    job = getBotJob(job.id) ?? job;
    if (!isActiveStage(job.stage)) return;
    const card = getCard(job.cardId);
    if (!card) {
      transitionBotJob(job.id, [job.stage], "cancelled", { error: "The card was deleted" });
      return;
    }
    const run = job.runId ? getRun(job.runId) : null;
    if (run?.status === "cancelled") {
      if (transitionBotJob(job.id, [job.stage], "cancelled")) {
        postEvent("pip", `Stopped on ${quote(card)}: the run was cancelled.`, card.id);
      }
      return;
    }
    try {
      // Momo reads her messages inside the run; the others, before they start.
      if (job.stage !== "build" && (await steered(job, card, run))) continue;
      if (job.stage === "build") await build(job, card, run);
      else if (job.stage === "test") await test(job, card, run);
      else if (job.stage === "review") await review(job, card, run);
      else if (job.stage === "scribe") await scribe(job, card, run);
    } catch (reason) {
      const message = (reason instanceof Error ? reason.message : "Something went wrong").slice(0, 500);
      failJob(job, card, message, reason instanceof SetupError || SETUP_MESSAGES.test(message));
      return;
    }
  }
}

/** Momo: the ordinary agent run, held in Run for the crew when it finishes. */
async function build(job: BotJob, initial: Card, existing: Run | null) {
  let run = existing;
  let card = initial;
  if (!run) {
    // A card made without a model gets the crew's, instead of failing on it.
    const settled = await ensureCardModel(card);
    card = settled.card;
    if (settled.assigned) postEvent("momo", `${quote(card)} had no model, so I'm using ${settled.assigned}.`, card.id);
    const problem = runProblem(card);
    if (problem) throw new SetupError(problem);
    // A failed follow-up is picked up again as one, on its pull request.
    // A card stopped part-way is continued from the work it had.
    const base = retryOf(card);
    run = beginRun(card, base, { bot: "momo" });
    if (!transitionBotJob(job.id, ["build"], "build", { runId: run.id })) return;
    postEvent(
      "momo",
      base?.of.stoppedNote
        ? `Picking ${quote(card)} back up from where it was stopped.`
        : `Picking up ${quote(card)}${job.rounds ? ` again, round ${job.rounds + 1}` : job.attempts ? `, second try` : ""}.`,
      card.id,
    );
  }
  if (run.status === "running") {
    await finishRun(card.id, run.id);
    run = getRun(run.id) ?? run;
  }
  if (run.status === "needs_approval") {
    if (transitionBotJob(job.id, ["build"], "test")) {
      postEvent("momo", `Done with ${quote(card)}: ${fileCount(run)} changed. @kiko your turn.`, card.id);
    }
    return;
  }
  if (run.status === "error") throw new StageError(run.error ?? "The agent failed");
  // Cancelled runs are caught at the top of the loop; anything else can't continue.
  if (run.status !== "cancelled") throw new StageError(`The run is ${run.status}, not waiting for the crew`);
}

/** Kiko: the repo's own lint, test and build, in the run's workspace. */
async function test(job: BotJob, card: Card, run: Run | null) {
  if (!run) throw new StageError("No run to test");
  const box = boxConfig();
  let report: string;
  const results: TestResult[] = [];
  if (!box) {
    report = "Checks skipped: the box isn't configured.";
  } else {
    let pkg: unknown = null;
    let hasBunLock = false;
    let gone = false;
    try {
      const root = await readWorkspaceFile(box, run.id, ".");
      hasBunLock = Boolean(root.directory?.includes("bun.lock") || root.directory?.includes("bun.lockb"));
      if (root.directory?.includes("package.json")) {
        const file = await readWorkspaceFile(box, run.id, "package.json");
        pkg = file.content ? JSON.parse(file.content) : null;
      }
    } catch (error) {
      if (error instanceof BoxError && error.status === 404) gone = true;
      else throw error;
    }
    if (gone) {
      report = "Checks skipped: the workspace is gone (the box restarted).";
    } else {
      const plan = testPlan(pkg, hasBunLock);
      for (const command of plan) {
        appendRunLog(run.id, logCommand(command));
        const result = await execInWorkspace(box, run.id, command, CHECK_TIMEOUT_MS);
        if (result.timedOut) appendRunLog(run.id, `  timed out after ${CHECK_TIMEOUT_MS / 60_000} minutes`);
        else appendRunLog(run.id, `  exit ${result.exitCode}`);
        results.push({ command, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output });
        if (getRun(run.id)?.status === "cancelled") return;
        // Between two commands nothing is half-done.
        if (await steered(job, card, run)) return;
      }
      report = formatTestReport(results);
    }
  }
  if (transitionBotJob(job.id, ["test"], "review", { testReport: report })) {
    const headline = results.length ? testHeadline(results) : report.replace(/^Checks skipped: /, "skipped: ");
    postEvent("kiko", `Checks on ${quote(card)}: ${headline}. @lulu over to you.`, card.id);
  }
}

/**
 * Lulu: a verdict on the change, with the workspace to look around in when
 * it's still there, and a bounded number of trips back to Momo.
 */
async function review(job: BotJob, card: Card, run: Run | null) {
  if (!run) throw new StageError("No run to review");
  const text = await reviewRun(card, run, {
    instructions: stageInstructions("lulu", REVIEW_RULES),
    prompt: reviewPrompt(card, run, job.testReport, getRepoInstructions(card.repo), steeringFor(card.id)),
    toolRules: REVIEW_TOOL_RULES,
  });
  // A message that came while she read: the verdict isn't acted on until it
  // is answered, and a review it changes is done again.
  if (await steered(job, card, run, { redo: true })) return;
  const { verdict, notes } = parseVerdict(text);
  appendRunLog(run.id, `Review by Lulu: ${verdict.toUpperCase()}${notes ? `\n${notes}` : ""}`);
  const next = nextStageAfterReview(verdict, job.rounds);

  if (next === "build") {
    if (!claimForRevision(run, notes || "Please address the review.")) {
      throw new StageError("The run was no longer waiting for review");
    }
    const revision = beginRun(card, { of: run, note: notes || "Please address the review." }, { bot: "momo" });
    if (
      transitionBotJob(job.id, ["review"], "build", {
        runId: revision.id,
        rounds: job.rounds + 1,
        reviewVerdict: "changes",
        reviewNotes: notes || null,
      })
    ) {
      postEvent("lulu", `Review of ${quote(card)}: changes needed. ${notes} @momo back to you.`, card.id);
    }
    return;
  }

  if (verdict === "changes") {
    // Out of rounds: the person decides, with Lulu's concerns on the card.
    transitionRun(run.id, ["needs_approval"], null, {
      warning: `Lulu still had concerns after ${job.rounds + 1} round${job.rounds ? "s" : ""}: ${notes} Review carefully.`,
    });
  }
  if (transitionBotJob(job.id, ["review"], "scribe", { reviewVerdict: verdict, reviewNotes: notes || null })) {
    postEvent(
      "lulu",
      verdict === "pass"
        ? `Review of ${quote(card)}: pass.${notes ? ` ${notes}` : ""} @bibi write it up.`
        : `Review of ${quote(card)}: still has concerns after ${job.rounds + 1} rounds, passing it on with a warning. @bibi write it up.`,
      card.id,
    );
  }
}

/**
 * Bibi: the summary and the commit message, then the card goes to the
 * person. A follow-up on a pull request is pushed right here when the
 * person turned auto-push on; otherwise it waits in Review like any run.
 */
async function scribe(job: BotJob, card: Card, run: Run | null) {
  if (!run) throw new StageError("No run to write up");
  let summary = run.summary ?? null;
  try {
    const text = await askCardModel(card, run, {
      instructions: stageInstructions("bibi", SCRIBE_RULES),
      prompt: scribePrompt(
        card,
        run,
        job.testReport,
        job.reviewVerdict === "changes" ? (run.warning ?? null) : null,
        steeringFor(card.id),
      ),
      timeoutMs: QUESTION_TIMEOUT_MS,
    });
    summary = cleanSummary(text) ?? summary;
  } catch {
    // The builder's own summary stands.
  }
  // Last safe point: once the card is handed over, the crew is done with it.
  if (await steered(job, card, run, { redo: true })) return;
  const commitMessage = await generateCommitMessage(card, { ...run, summary });
  if (
    !transitionRun(
      run.id,
      ["needs_approval"],
      null,
      { summary, commitMessage },
      { status: "needs_approval", column: "review" },
    )
  ) {
    throw new StageError("The run was no longer waiting for approval");
  }
  const pr = run.prNumber ? `PR #${run.prNumber}` : "the pull request";

  if (isFollowUp(run) && getBotsAutoPush()) {
    appendRunLog(run.id, `Auto-push is on: pushing to ${pr}`);
    // The job is still active, so the button can't race this; the run's own
    // claim inside approveRun settles anything else.
    const result = await approveRun(run.id, { job: job.id });
    if (transitionBotJob(job.id, ["scribe"], "done")) {
      postEvent(
        "pip",
        result.ok
          ? `Pushed a follow-up to ${pr} for ${quote(card)}: ${commitMessage}. ${run.prUrl}`
          : `Couldn't push the follow-up to ${pr} for ${quote(card)}: ${result.error}. It's waiting in Review.`,
        card.id,
      );
    }
    tooLateToSteer(card);
    return;
  }

  appendRunLog(run.id, `Waiting for approval: ${fileCount(run)} to change`);
  if (transitionBotJob(job.id, ["scribe"], "done")) {
    postEvent(
      "bibi",
      isFollowUp(run)
        ? `${quote(card)} is ready: approve to push it to ${pr}. ${commitMessage}`
        : `${quote(card)} is ready for your approval: ${commitMessage}`,
      card.id,
    );
  }
  tooLateToSteer(card);
}

/** Ends a job with an error and makes sure the card is somewhere sensible. */
function failJob(job: BotJob, card: Card, message: string, setup: boolean) {
  const stage = job.stage as BotStage;
  const run = job.runId ? getRun(job.runId) : null;
  // A change that exists goes to the person; a setup problem waits for them;
  // anything else may go through on a second try.
  const cause: FailureCause = run?.status === "needs_approval" ? "handed" : setup ? "setup" : "work";
  const retryAt = retryPlan(cause, job.attempts ?? 0, Date.now());
  if (!transitionBotJob(job.id, [stage], "failed", { error: message, retryAt })) return;
  const bot = botForStage(stage) ?? getBot("pip");
  postEvent(bot.id, `Stopped on ${quote(card)} while ${bot.verb}: ${message}`, card.id);
  if (retryAt) postEvent("pip", `I'll have the crew try ${quote(card)} again in ${Math.round(RETRY_BACKOFF_MS / 60_000)} minutes.`, card.id);
  // A note still waiting is read by the retry; without one, nobody will.
  else tooLateToSteer(card);

  if (run?.status === "needs_approval") {
    // The change exists; hand it to the person with the crew's note.
    transitionRun(
      run.id,
      ["needs_approval"],
      null,
      { warning: `The crew stopped at ${stage}: ${message} Review carefully.` },
      { status: "needs_approval", column: "review" },
    );
  } else if (run?.status !== "running" && getCard(card.id)?.status !== "error") {
    patchCard(card.id, { column: "run", status: "error" });
  }
}

export { MAX_REVIEW_ROUNDS };
