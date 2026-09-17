import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { approveRun } from "@/lib/hq/approve";

/** Opens the pull request for a run waiting for approval. */
async function handlePost(
  _request: Request,
  context: RouteContext<"/api/runs/[id]/approve">,
) {
  const { id } = await context.params;
  const result = await approveRun(id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ run: result.run });
}

export const POST = withSession(handlePost);
