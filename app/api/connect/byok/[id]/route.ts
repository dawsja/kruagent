import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { deleteConnection, getConnection } from "@/lib/hq/data";
import { isByokProvider } from "@/lib/hq/types";

/** Remove one API-key endpoint. Other endpoints on the same format stay. */
async function handleDelete(
  _request: Request,
  context: RouteContext<"/api/connect/byok/[id]">,
) {
  const { id } = await context.params;
  const existing = getConnection(id);
  if (!existing || !isByokProvider(existing.provider) || !deleteConnection(id)) {
    return NextResponse.json(
      { error: "That endpoint no longer exists" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}

export const DELETE = withSession(handleDelete);
