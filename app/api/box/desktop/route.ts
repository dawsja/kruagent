import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { startDesktop, stopDesktop } from "@/lib/hq/box";
import { boxErrorResponse, requireBox } from "@/lib/hq/box-routes";

/**
 * The box desktop for the signed-in person: POST starts it (or reports it
 * already running), DELETE stops it and closes every viewer.
 */
async function handlePost(request: Request) {
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as { width?: number; height?: number };
  try {
    const desktop = await startDesktop(box, {
      width: Number(body.width) || 1280,
      height: Number(body.height) || 800,
    });
    return NextResponse.json({ desktop });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

async function handleDelete() {
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  try {
    await stopDesktop(box);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
export const DELETE = withSession(handleDelete);
