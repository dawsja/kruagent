import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { summarizeRun } from "@/lib/hq/board-logic";
import {
  getBotsAutoPush,
  getBotsEnabled,
  getMissingGithubPermissions,
  latestBotJobByCard,
  listBoard,
  listPrFeedback,
} from "@/lib/hq/data";
import { publicConnection } from "@/lib/hq/oauth";

/** Feedback lines the board carries; older ones stay in the database. */
const FEEDBACK_LIMIT = 200;

/**
 * The board. Pull requests are followed by the dispatcher's tick (see
 * `lib/hq/pr-sync.ts`), not here, so a merge shows up whether or not a
 * browser is open; this only reads. Runs come as summaries; the open card
 * fetches its run in full from /api/runs/<id>. The browser asks again when
 * /api/events says the board changed.
 */
async function handleGet() {
  const board = listBoard();
  return NextResponse.json({
    cards: board.cards,
    runs: board.runs.map(summarizeRun),
    connections: board.connections.map(publicConnection),
    // The crew's newest job per card, so the board can badge and gate them.
    jobs: [...latestBotJobByCard().values()],
    botsEnabled: getBotsEnabled(),
    autoPush: getBotsAutoPush(),
    prFeedback: listPrFeedback({ limit: FEEDBACK_LIMIT }),
    missingPermissions: getMissingGithubPermissions(),
  });
}

export const GET = withSession(handleGet);
