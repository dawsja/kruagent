import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { boxErrorResponse, requireBox } from "@/lib/hq/box-routes";
import { checkClaudeCached } from "@/lib/hq/claude-code";

/**
 * Whether the Claude Code CLI in the box is installed and signed in. The
 * box finds out by running it; nothing here or there reads its files. A
 * fresh answer every time, since Settings asks on purpose; the model picker
 * then sees the same answer through the cache.
 */
async function handleGet() {
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  try {
    const check = await checkClaudeCached(box, { fresh: true });
    return NextResponse.json(check, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const GET = withSession(handleGet);
