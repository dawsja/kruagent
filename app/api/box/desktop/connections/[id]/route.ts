import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { disconnectDesktop } from "@/lib/hq/box";
import { boxErrorResponse, isTerminalId, requireBox } from "@/lib/hq/box-routes";

async function handleDelete(_request: Request, context: RouteContext<"/api/box/desktop/connections/[id]">) {
  const { id } = await context.params;
  if (!isTerminalId(id)) return NextResponse.json({ error: "Bad connection id" }, { status: 400 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  try {
    await disconnectDesktop(box, id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const DELETE = withSession(handleDelete);
