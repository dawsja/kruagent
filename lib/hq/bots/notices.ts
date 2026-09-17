import type { BotId, BotJob, ChatMessage } from "../types.ts";

/*
 * What the browser shows about the crew, kept pure so it can be tested.
 * Notifications come from Pip and are fixed sentences about a job changing
 * stage; nothing a model wrote ever goes into one. The unread dot is the
 * newest line a bot posted after you last had the room open.
 */

/** Longest card title quoted in a notification. */
const MAX_TITLE = 60;

function quote(title: string) {
  const clean = title.trim().replace(/\s+/g, " ");
  return `"${clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean}"`;
}

const STOPPED_WHILE: Partial<Record<BotJob["stage"], string>> = {
  build: "building",
  test: "testing",
  review: "reviewing",
  scribe: "writing up",
};

/**
 * Pip's one line for a job that moved, or null when nothing worth a
 * notification happened. `previous` is the same job as last seen, if it was.
 * `followUp` names the pull request when the job is a follow-up on one, and
 * `pushed` says the crew pushed it itself.
 */
export function crewNotice(
  previous: BotJob | undefined,
  job: BotJob,
  cardTitle: string,
  options: { followUp?: number | null; pushed?: boolean } = {},
): string | null {
  if (previous && previous.stage === job.stage && previous.rounds === job.rounds) return null;
  const card = quote(cardTitle);
  const pr = options.followUp ? `PR #${options.followUp}` : null;
  switch (job.stage) {
    case "build":
      if (pr && !previous) return `Momo is following up on ${pr} for ${card}`;
      if (!previous && job.attempts) return `Momo is trying ${card} again`;
      return job.rounds > 0 ? `Momo picked up ${card} again` : `Momo picked up ${card}`;
    case "test":
      return `Kiko is running checks on ${card}`;
    case "review":
      return `Lulu is starting review of ${card}`;
    case "scribe":
      return `Bibi is writing up ${card}`;
    case "done":
      if (pr && options.pushed) return `Pushed a follow-up to ${pr} for ${card}`;
      if (pr) return `${card} is ready to push to ${pr}`;
      return `${card} is ready for review`;
    case "failed": {
      const verb = previous ? STOPPED_WHILE[previous.stage] : undefined;
      const stopped = verb ? `${card} stopped while ${verb}` : `${card} stopped`;
      return job.retryAt ? `${stopped}; the crew will try again shortly` : stopped;
    }
    default:
      // Cancelled: you did that yourself.
      return null;
  }
}

/**
 * The bot that posted last, when that line is newer than `readAt`; null when
 * you're caught up or nothing has been marked read yet.
 */
export function unreadBot(messages: readonly ChatMessage[], readAt: string | null): BotId | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.author === "you") continue;
    return readAt !== null && message.createdAt > readAt ? message.author : null;
  }
  return null;
}
