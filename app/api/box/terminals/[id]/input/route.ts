import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { terminalInput } from "@/lib/hq/box";
import { boxErrorResponse, isTerminalId, requireBox } from "@/lib/hq/box-routes";

/** Keystrokes for a terminal, base64-encoded in `data`. */
async function handlePost(request: Request, context: RouteContext<"/api/box/terminals/[id]/input">) {
  const { id } = await context.params;
  if (!isTerminalId(id)) return NextResponse.json({ error: "Bad terminal id" }, { status: 400 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as { data?: string };
  if (typeof body.data !== "string") return NextResponse.json({ error: "Missing data" }, { status: 400 });
  try {
    await terminalInput(box, id, body.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
