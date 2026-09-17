import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { createTerminal } from "@/lib/hq/box";
import { boxErrorResponse, requireBox } from "@/lib/hq/box-routes";
import { getRun } from "@/lib/hq/data";

/**
 * Opens a shell in the box for the signed-in person: in a running run's
 * workspace (or one kept for review or recovery) when `runId` is given, otherwise in the agent's ~/workspace.
 */
async function handlePost(request: Request) {
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as {
    runId?: string;
    cols?: number;
    rows?: number;
  };
  let workspace: string | null = null;
  if (body.runId) {
    const run = getRun(body.runId);
    // Working, waiting for review, or failed with its work kept; the box
    // says plainly when the workspace has already gone.
    if (!run || !["running", "needs_approval", "error"].includes(run.status)) {
      return NextResponse.json({ error: "That run has no workspace in the box" }, { status: 409 });
    }
    workspace = run.id;
  }
  try {
    const terminal = await createTerminal(box, {
      workspace,
      cols: Number(body.cols) || 80,
      rows: Number(body.rows) || 24,
    });
    return NextResponse.json({ terminal });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
