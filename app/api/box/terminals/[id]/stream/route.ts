import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { isTerminalId, proxyBoxStream, requireBox } from "@/lib/hq/box-routes";

/** Terminal output as server-sent events; each event carries base64 bytes. */
async function handleGet(request: Request, context: RouteContext<"/api/box/terminals/[id]/stream">) {
  const { id } = await context.params;
  if (!isTerminalId(id)) return NextResponse.json({ error: "Bad terminal id" }, { status: 400 });
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  return proxyBoxStream(box, `/terminals/${id}/stream`, request);
}

export const GET = withSession(handleGet);
