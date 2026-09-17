import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getActiveBotJobForCard, getCard, patchCard } from "@/lib/hq/data";
import { retryOf, runProblem, startRun } from "@/lib/hq/runs";

async function handlePost(
  _request: Request,
  context: RouteContext<"/api/cards/[id]/run">,
) {
  const { id } = await context.params;
  const card = getCard(id);
  if (!card) {
    return NextResponse.json({ error: "Card not found" }, { status: 400 });
  }
  if (card.status === "running") {
    return NextResponse.json({ error: "This card is already running" }, { status: 409 });
  }
  if (getActiveBotJobForCard(id)) {
    return NextResponse.json({ error: "The crew is still working on this card" }, { status: 409 });
  }
  const problem = runProblem(card);
  if (problem) {
    patchCard(id, { column: "run", status: "error" });
    return NextResponse.json({ error: problem }, { status: 400 });
  }
  // A failed follow-up is retried as one; anything else starts over.
  const run = startRun(card, retryOf(card));
  return NextResponse.json({ run }, { status: 202 });
}

export const POST = withSession(handlePost);
