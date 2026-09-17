import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { terminalResize } from "@/lib/hq/box";
import { boxErrorResponse, isTerminalId, requireBox } from "@/lib/hq/box-routes";

async function handlePost(request: Request, context: RouteContext<"/api/box/terminals/[id]/resize">) {
  const { id } = await context.params;
  if (!isTerminalId(id)) return NextResponse.json({ error: "Bad terminal id" }, { status: 400 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as { cols?: number; rows?: number };
  try {
    await terminalResize(box, id, { cols: Number(body.cols) || 80, rows: Number(body.rows) || 24 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
