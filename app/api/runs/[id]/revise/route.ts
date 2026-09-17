import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { reviseRun } from "@/lib/hq/runs";

const MAX_NOTE = 4000;

/**
 * Sends a reviewed result back to the agent with a request for changes. The
 * waiting run is closed and a new run starts from its changes plus the note,
 * so the card goes back to Run and returns to Review with the revised result.
 */
async function handlePost(request: Request, context: RouteContext<"/api/runs/[id]/revise">) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { note?: string };
  const note = (body.note ?? "").trim().slice(0, MAX_NOTE);
  if (!note) return NextResponse.json({ error: "Say what should change" }, { status: 400 });

  const result = reviseRun(id, note);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ run: result.run }, { status: 202 });
}

export const POST = withSession(handlePost);
