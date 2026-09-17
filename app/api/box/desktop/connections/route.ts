import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { connectDesktop } from "@/lib/hq/box";
import { boxErrorResponse, requireBox } from "@/lib/hq/box-routes";

/**
 * Opens a VNC connection to the box desktop for this viewer, starting the
 * desktop first when it isn't running. The connection's bytes arrive on its
 * stream route and input goes back through its input route.
 */
async function handlePost(request: Request) {
  const box = requireBox();
  if (box instanceof NextResponse) return box;
  const body = (await request.json().catch(() => ({}))) as { width?: number; height?: number };
  try {
    const connection = await connectDesktop(box, {
      width: Number(body.width) || 1280,
      height: Number(body.height) || 800,
    });
    return NextResponse.json({ connection });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

export const POST = withSession(handlePost);
