import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { proxyBoxStream, requireBox } from "@/lib/hq/box-routes";
import { getRun } from "@/lib/hq/data";

/**
 * What the agent is doing in a run's box workspace, live: the commands it
 * runs with their output, and the files it reads and writes. Available
 * while the run is working; the run log keeps the summary afterwards.
 */
async function handleGet(request: Request, context: RouteContext<"/api/runs/[id]/watch">) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  return proxyBoxStream(box, `/workspaces/${run.id}/watch`, request);
}

export const GET = withSession(handleGet);
