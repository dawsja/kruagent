import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { postEvent } from "@/lib/hq/bots/room";
import { appendRunLog, getCard, getRun, transitionRun } from "@/lib/hq/data";
import { parsePullUrl, reopenPull } from "@/lib/hq/github";
import { getFreshGithubConnection } from "@/lib/hq/model-auth";

/**
 * Reopens a pull request that was closed without merging, so the branch
 * and its follow-ups carry on instead of starting over.
 */
async function handlePost(_request: Request, context: RouteContext<"/api/runs/[id]/reopen">) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run?.prUrl) return NextResponse.json({ error: "This run has no pull request" }, { status: 404 });
  if (run.prState !== "closed") return NextResponse.json({ error: "The pull request isn't closed" }, { status: 409 });
  const parsed = parsePullUrl(run.prUrl);
  if (!parsed) return NextResponse.json({ error: "This run's pull request address is unreadable" }, { status: 400 });

  const github = await getFreshGithubConnection().catch(() => null);
  if (!github) return NextResponse.json({ error: "Connect GitHub first" }, { status: 400 });
  try {
    await reopenPull(github.accessToken, parsed.repo, parsed.number);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Reopen failed";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
  const card = getCard(run.cardId);
  // The ETag is dropped so the next check reads the reopened state.
  transitionRun(id, [run.status], null, { prState: "open", prEtag: null, error: null }, card?.runId === id ? { status: "approved", column: "review" } : undefined);
  appendRunLog(id, `PR #${parsed.number} reopened`);
  if (card) postEvent("pip", `Reopened PR #${parsed.number} for "${card.title}".`, card.id);
  return NextResponse.json({ run: getRun(id) });
}

export const POST = withSession(handlePost);
