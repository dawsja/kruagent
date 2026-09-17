import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getActiveBotJobForCard, getBotsEnabled, getCard, getRun, listPrFeedback } from "@/lib/hq/data";
import { followUpByHand } from "@/lib/hq/follow-up";
import { runProblem } from "@/lib/hq/runs";

const MAX_NOTE = 4000;

/**
 * Starts a follow-up on an approved run's pull request from the card: with
 * the person's note, the feedback waiting on the card, or both. The crew
 * drives it when on; otherwise the agent runs like a card started by hand.
 */
async function handlePost(request: Request, context: RouteContext<"/api/runs/[id]/follow-up">) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { note?: string };
  const note = (body.note ?? "").trim().slice(0, MAX_NOTE);

  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status !== "approved" || !run.prUrl || !run.headBranch) {
    return NextResponse.json({ error: "This run has no open pull request to follow up on" }, { status: 409 });
  }
  if (run.prState === "merged" || run.prState === "closed") {
    return NextResponse.json({ error: `The pull request was ${run.prState}` }, { status: 409 });
  }
  const card = getCard(run.cardId);
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });
  if (getActiveBotJobForCard(card.id)) {
    return NextResponse.json({ error: "The crew is still working on this card" }, { status: 409 });
  }
  if (card.status === "running") return NextResponse.json({ error: "A run is already in flight" }, { status: 409 });
  const problem = runProblem(card);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const pending = listPrFeedback({ cardId: card.id, pending: true }).filter((item) => item.prUrl === run.prUrl);
  if (!note && pending.length === 0) {
    return NextResponse.json({ error: "Say what should change, or wait for feedback on the pull request" }, { status: 400 });
  }
  const started = followUpByHand(card, run, note || "Address the feedback on the pull request.", {
    crew: getBotsEnabled(),
    pending,
  });
  return NextResponse.json({ run: started }, { status: 202 });
}

export const POST = withSession(handlePost);
