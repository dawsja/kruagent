import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { defaultCardModel } from "@/lib/hq/bots/models";
import { createCardFrom } from "@/lib/hq/cards";

async function handlePost(request: Request) {
  try {
    const body = (await request.json()) as {
      title?: string;
      body?: string;
      repo?: string | null;
      model?: string | null;
    };
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "Title required" }, { status: 400 });
    }
    // The card's own pick, else the crew's model, the saved default, or the
    // first model available, Claude Code included when it is signed in.
    const model = body.model?.trim() || (await defaultCardModel());
    const card = createCardFrom({ title: body.title, body: body.body, repo: body.repo, model });
    return NextResponse.json({ card });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withSession(handlePost);
