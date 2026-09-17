import { STEER_DECISIONS, type BotId, type BotJob, type BotStage, type Card, type SteerDecision, type SteeringNote } from "../types.ts";

/*
 * The pure parts of steering: which card a message to a working bot is
 * about, when a note is a plain order to stop, the question a bot answers
 * at its safe point and how its answer is read, and what the rest of the
 * run is told afterwards. Nothing here talks to the database, the box or a
 * model, so it is tested directly.
 */

/** Which bot works each stage; the registry has the same map, with faces. */
const STAGE_BOTS: Partial<Record<BotStage, BotId>> = { build: "momo", test: "kiko", review: "lulu", scribe: "bibi" };

export function stageBot(stage: BotStage): BotId | null {
  return STAGE_BOTS[stage] ?? null;
}

const NAMES: Record<BotId, string> = { pip: "Pip", momo: "Momo", kiko: "Kiko", lulu: "Lulu", bibi: "Bibi" };
const VERBS: Partial<Record<BotStage, string>> = {
  build: "building the change",
  test: "running the repo's checks",
  review: "reviewing the change",
  scribe: "writing the summary",
};

/** What the bot's decision means for the run. */
export type SteerOutcome = {
  decision: SteerDecision;
  /** What the bot said back in the room. */
  reply: string;
  notes: SteeringNote[];
  /** The note as the working agent is told it, decision and all. */
  direction: string;
};

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

/**
 * The job a message to `bot` is steering: the one at that bot's stage. With
 * the crew on several cards at once, the one whose title the message
 * names best, else the one that moved last. Null when the bot isn't working.
 */
export function steerTarget(
  bot: BotId,
  text: string,
  jobs: readonly BotJob[],
  cards: readonly Pick<Card, "id" | "title">[],
): BotJob | null {
  const mine = jobs.filter((job) => stageBot(job.stage) === bot && cards.some((card) => card.id === job.cardId));
  if (mine.length <= 1) return mine[0] ?? null;
  const said = new Set(words(text));
  const score = (job: BotJob) => words(cards.find((card) => card.id === job.cardId)?.title ?? "").filter((word) => said.has(word)).length;
  return [...mine].sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** A note without its mentions and pleasantries, lowercased. */
function bare(text: string) {
  return text
    .toLowerCase()
    .replace(/@\w+/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\b(please|pls|hey|hi|ok|okay|for now|right now|now|right|just|can you|could you|would you|thanks|thank you)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_ORDER =
  /^(stop|pause|halt|abort|hold on|hold it|hold up|hold|wait|cancel( that| this| it)?)( (it|that|this|here|there|working|work|everything|all work|for a bit|for a moment|for (a )?while|for later|until i say( so)?|what you('re| are) doing|the (run|card|build|work|task|job|checks|tests|review)))*$/;

/**
 * True when the note is nothing but an order to stop ("@momo stop", "pause
 * that for now please"). Those halt the run without asking a model, so a
 * stop is never talked out of. "Stop using npm" is a change of course, not
 * this, and goes to the bot to decide.
 */
export function isStopOrder(text: string): boolean {
  return STOP_ORDER.test(bare(text));
}

export const STEER_RULES = [
  "A message arrived for you while you are in the middle of working on a card. You have paused at a safe point to read it. Decide what it means for the work, honestly: don't agree to something you won't do.",
  "Answer with one of these on the first line:",
  "`DECISION: CONTINUE` when it changes nothing (a question, encouragement, something you are already doing).",
  "`DECISION: ADJUST` when you keep the same goal but change how you get there, or add something to it.",
  "`DECISION: SWITCH` when the goal itself changes: what you were doing is set aside for what the message asks.",
  "`DECISION: STOP` when you are asked to stop, pause or drop the work. The run halts and the card can be restarted later.",
  "Then, in one to three short sentences, your reply for the room: what you understood, and what you are doing now (carrying on, changing course, or stopping). Answer a question if one was asked. Plain text, no headings, no greeting.",
].join("\n");

function who(note: Pick<SteeringNote, "author">) {
  return note.author === "you" ? "The person" : `${NAMES[note.author]}, passing on what the person wants`;
}

/** The question a working bot answers about the notes it just read. */
export function steerPrompt(input: {
  bot: BotId;
  stage: BotStage;
  card: Pick<Card, "title" | "body" | "repo">;
  notes: readonly SteeringNote[];
  /** The newest lines of the run's log: what the bot was doing. */
  progress: readonly string[];
  /** Notes answered earlier on this card, so a second message reads in context. */
  earlier?: readonly SteeringNote[];
}): string {
  const earlier = steeringSection(input.earlier ?? []);
  return [
    `You are ${NAMES[input.bot]}, ${VERBS[input.stage] ?? "working"} for this card.`,
    `Repo: ${input.card.repo ?? "none"}`,
    `Task: ${input.card.title}`,
    input.card.body ? `Details:\n${input.card.body}` : "",
    earlier,
    input.progress.length ? `What you have done so far, from the run's log (newest last):\n${input.progress.join("\n")}` : "",
    `The message${input.notes.length === 1 ? "" : "s"} that arrived:\n${input.notes.map((note) => `${who(note)}: ${note.body}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Longest reply a bot posts about a steering note. */
const MAX_REPLY_CHARS = 600;

function clipReply(text: string) {
  const clean = text.replace(/\s*\n\s*/g, " ").trim();
  return clean.length > MAX_REPLY_CHARS ? `${clean.slice(0, MAX_REPLY_CHARS - 1)}…` : clean;
}

const DEFAULT_REPLY: Record<SteerDecision, string> = {
  continue: "Read that; it doesn't change what I'm doing, so I'm carrying on.",
  adjust: "Got it. I'm adjusting what I'm doing to take that in, and carrying on.",
  switch: "Got it. I'm setting aside what I was doing and switching to that.",
  stop: "Stopping here. The card keeps what I've done so far and can be restarted later.",
};

/**
 * Reads `DECISION: …` and the reply after it. A model that answers without
 * the line is taken to have adjusted, with its words as the reply: the note
 * still reaches the work, which is the safe reading of an unclear answer.
 */
export function parseSteerDecision(text: string | null | undefined): { decision: SteerDecision; reply: string } | null {
  const clean = (text ?? "").trim();
  if (!clean) return null;
  const match = /^\s*\**\s*DECISION\s*:\s*\**\s*([A-Za-z]+)\b\**/im.exec(clean);
  const named = match?.[1].toLowerCase();
  const decision = STEER_DECISIONS.find((item) => item === named);
  if (!match || !decision) return { decision: "adjust", reply: clipReply(clean) };
  const reply = clipReply(clean.replace(match[0], "").replace(/^[\s.:—-]+/, ""));
  return { decision, reply: reply || DEFAULT_REPLY[decision] };
}

/** The decision when no model can be asked: a stop order stops, anything else reaches the work. */
export function fallbackDecision(notes: readonly Pick<SteeringNote, "body">[]): { decision: SteerDecision; reply: string } {
  const decision: SteerDecision = notes.some((note) => isStopOrder(note.body)) ? "stop" : "adjust";
  return { decision, reply: DEFAULT_REPLY[decision] };
}

/** The reason kept on a stopped card and run, from the notes that stopped it. */
export function stopReason(notes: readonly Pick<SteeringNote, "author" | "body">[]): string {
  const said = notes.map((note) => note.body.replace(/\s+/g, " ").trim()).filter(Boolean).join(" / ");
  const by = notes.some((note) => note.author === "you") ? "you" : NAMES[notes[0]?.author as BotId] ?? "you";
  const text = `${by === "you" ? "You" : by} said: ${said || "stop"}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * What the working agent is told after the bot answered: the message, the
 * decision, and what to do with it. For Kru's own runner this goes into the
 * conversation as the next user turn.
 */
export function steerDirection(notes: readonly SteeringNote[], decision: SteerDecision, reply: string): string {
  const said = notes.map((note) => `${who(note)}: ${note.body}`).join("\n");
  const what =
    decision === "continue"
      ? "You decided it changes nothing. Carry on with the task as you were."
      : decision === "adjust"
        ? "You decided to adjust: keep the task's goal, and change your approach to take this in. Rework anything you already did that no longer fits."
        : decision === "switch"
          ? "You decided to switch direction: what the message asks now comes first, and replaces the parts of the original task it contradicts. Undo work that no longer belongs in the change."
          : "You decided to stop. Do nothing more.";
  return [
    "A steering message arrived from the Team room while you were working, and you paused to read it:",
    said,
    `You answered in the room: ${reply}`,
    what,
  ].join("\n\n");
}

/**
 * The direction given on a card so far, as a prompt section for whoever
 * works it next: a later round of the builder, the reviewer, the scribe.
 * Notes a bot decided changed nothing are left out.
 */
export function steeringSection(notes: readonly SteeringNote[]): string {
  const moved = notes.filter((note) => note.decision && note.decision !== "continue");
  if (moved.length === 0) return "";
  const lines = moved.map((note) => {
    const heard = note.decision === "stop" ? "stopped" : note.decision === "switch" ? "switched direction" : "adjusted";
    return `- ${who(note)} (while ${NAMES[note.bot]} was ${VERBS[note.stage] ?? "working"}): ${note.body.replace(/\s+/g, " ").trim()}\n  ${NAMES[note.bot]} ${heard}${note.reply ? `: ${note.reply}` : "."}`;
  });
  return `The direction of this card changed while it was being worked on. These messages are part of the task now; where they differ from the task as written, they win:\n${lines.join("\n")}`;
}

/** How many of the run's newest log lines a bot is shown of its own progress. */
export const PROGRESS_LINES = 25;
const PROGRESS_LINE_CHARS = 400;

export function progressLines(log: readonly string[], limit = PROGRESS_LINES): string[] {
  return log.slice(-limit).map((line) => {
    const flat = line.replace(/\s*\n\s*/g, " ");
    return flat.length > PROGRESS_LINE_CHARS ? `${flat.slice(0, PROGRESS_LINE_CHARS)}…` : flat;
  });
}

/**
 * For Claude Code, whose CLI takes one prompt per process: the builder is
 * interrupted between two tool calls and started again in the same
 * workspace with this after the task, since the new process remembers
 * nothing of the old one.
 */
export function continuationSection(direction: string, progress: readonly string[]): string {
  return [
    "You were already part-way through this task when you were interrupted, so this is a continuation, not a fresh start. Everything you changed so far is still in your working directory: look at `git status` and `git diff` before anything else, and don't redo what is already done.",
    progress.length ? `What you had done, from the run's log (newest last):\n${progress.join("\n")}` : "",
    direction,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The note a restarted card's run gets, in place of a reviewer's request. */
export function resumeNote(stoppedNote: string): string {
  return `The work on this card was stopped part-way (${stoppedNote}) and has now been restarted. Pick the task up from the current state of the files and finish it.`;
}
