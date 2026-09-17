import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { deleteCard, getActiveBotJobForCard, getCard, patchCard, type CardPatch } from "@/lib/hq/data";
import { COLUMNS, type ColumnId } from "@/lib/hq/types";

async function handlePatch(
  request: Request,
  context: RouteContext<"/api/cards/[id]">,
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      column?: ColumnId;
      repo?: string | null;
      model?: string | null;
    };
    const patch: CardPatch = {};
    const editsText = [body.title, body.body, body.repo, body.model].some((v) => v !== undefined);
    if (editsText && getCard(id)?.status === "running") {
      return NextResponse.json({ error: "Wait for the run to finish before editing" }, { status: 409 });
    }
    if (body.title !== undefined) patch.title = body.title.trim();
    if (body.body !== undefined) patch.body = body.body;
    if (body.column && COLUMNS.includes(body.column)) {
      // The crew moves its own cards; a drag while it works would strand them.
      if (getActiveBotJobForCard(id)) {
        return NextResponse.json({ error: "The crew is still working on this card" }, { status: 409 });
      }
      patch.column = body.column;
    }
    if (body.repo !== undefined) patch.repo = body.repo;
    if (body.model !== undefined) patch.model = body.model;

    const card = patchCard(id, patch);
    if (!card) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ card });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleDelete(
  _request: Request,
  context: RouteContext<"/api/cards/[id]">,
) {
  const { id } = await context.params;
  if (!deleteCard(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}

export const PATCH = withSession(handlePatch);
export const DELETE = withSession(handleDelete);
