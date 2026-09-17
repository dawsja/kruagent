import { reviewNotesIn } from "./bots/pipeline-logic.ts";
import { diffStats } from "./diff.ts";
import type { Run } from "./types.ts";

/*
 * The board as the browser gets it. A run's log and file contents grow with
 * every step the agent takes, and the board only ever shows a line of each,
 * so the board carries a summary; the card that is open fetches its run in
 * full from /api/runs/<id>.
 */

export type RunFileSummary = {
  path: string;
  message: string;
  deleted?: boolean;
  added: number;
  removed: number;
};

export type RunSummary = Omit<Run, "log" | "proposedWrites"> & {
  /** The newest log line, for a card's status and an error without a reason. */
  lastLog: string | null;
  logCount: number;
  files: RunFileSummary[];
  /** Lulu's verdicts on this run, oldest first, for the card's history. */
  reviews: { verdict: "pass" | "changes"; notes: string }[];
  /** "PR opened …" or "Pushed … to …", when the run reached GitHub. */
  pushedLine: string | null;
};

const PUSHED = /^(Pushed [0-9a-f]{7} to |PR opened )/;

export function summarizeRun(run: Run): RunSummary {
  const { log, proposedWrites, ...rest } = run;
  return {
    ...rest,
    lastLog: log.at(-1) ?? null,
    logCount: log.length,
    files: proposedWrites.map((write) => ({
      path: write.path,
      message: write.message,
      ...(write.deleted ? { deleted: true } : {}),
      ...(write.diff ? diffStats(write.diff) : { added: 0, removed: 0 }),
    })),
    reviews: reviewNotesIn(log),
    pushedLine: log.find((line) => PUSHED.test(line)) ?? null,
  };
}

/**
 * Whether the open card's full run is out of date: a different run, a new
 * log line, or any other change to it.
 */
export function detailStale(summary: Pick<RunSummary, "id" | "logCount" | "updatedAt">, detail: Pick<Run, "id" | "log" | "updatedAt"> | null): boolean {
  if (!detail || detail.id !== summary.id) return true;
  return detail.log.length !== summary.logCount || detail.updatedAt !== summary.updatedAt;
}

/**
 * Calls `fn` at most once per `ms`: the first call runs at once, calls
 * during the wait are folded into one more run at its end. An agent writes
 * log lines in bursts, and the board needs the last state, not every step.
 */
export function throttle(fn: () => void, ms: number, clock: { now: () => number; set: (cb: () => void, ms: number) => unknown } = {
  now: () => Date.now(),
  set: (cb, wait) => setTimeout(cb, wait),
}) {
  let last = -Infinity;
  let queued = false;
  return () => {
    if (queued) return;
    const wait = last + ms - clock.now();
    if (wait <= 0) {
      last = clock.now();
      fn();
      return;
    }
    queued = true;
    clock.set(() => {
      queued = false;
      last = clock.now();
      fn();
    }, wait);
  };
}
