import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { appendRunLog, getRun, transitionRun } from "@/lib/hq/data";
import { releaseWorkspace } from "@/lib/hq/runs";

/**
 * Stops a running run, or discards changes that are waiting for approval.
 * The card goes back to Drop. A run that is opening its pull request can't be
 * cancelled.
 */
async function handlePost(
  _request: Request,
  context: RouteContext<"/api/runs/[id]/cancel">,
) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (run.status === "running" || run.status === "needs_approval") {
    appendRunLog(id, run.status === "running" ? "Run cancelled" : "Proposed changes discarded");
    transitionRun(id, [run.status], "cancelled", {}, { status: "open", column: "drop" });
    // A running agent's own workspace goes when its run unwinds; a discarded
    // one is waiting in the box for a revision that is not coming.
    if (run.status === "needs_approval") await releaseWorkspace(id);
  }
  return NextResponse.json({ run: getRun(id) });
}

export const POST = withSession(handlePost);
