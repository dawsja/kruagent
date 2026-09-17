import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getRun } from "@/lib/hq/data";

/** One run in full, its log and proposed changes included, for the open card. */
async function handleGet(_request: Request, context: RouteContext<"/api/runs/[id]">) {
  const { id } = await context.params;
  const run = getRun(id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  return NextResponse.json({ run });
}

export const GET = withSession(handleGet);
