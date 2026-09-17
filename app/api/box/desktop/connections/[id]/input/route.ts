import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { desktopInput } from "@/lib/hq/box";
import { boxErrorResponse, isTerminalId, requireBox } from "@/lib/hq/box-routes";

/** VNC client bytes (key, pointer and update requests), base64 in `data`. */
async function handlePost(
  request: Request,
  context: RouteContext<"/api/box/desktop/connections/[id]/input">,
) {
  const { id } = await context.params;
  if (!isTerminalId(id)) return NextResponse.json({ error: "Bad connection id" }, { status: 400 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as { data?: string };
  if (typeof body.data !== "string") return NextResponse.json({ error: "Missing data" }, { status: 400 });
  try {
    await desktopInput(box, id, body.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
