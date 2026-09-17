import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { publicConnection } from "@/lib/hq/oauth";
import { completePastedUrl } from "@/lib/hq/subscription";
import { isSubscriptionProvider } from "@/lib/hq/types";

/** Finishes a browser sign-in from the callback address the person pasted. */
async function handlePost(
  request: Request,
  context: RouteContext<"/api/connect/subscription/[provider]/complete">,
) {
  const { provider } = await context.params;
  if (!isSubscriptionProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  try {
    const body = (await request.json()) as { url?: string };
    const connection = await completePastedUrl(body.url ?? "");
    if (!connection) throw new Error("The sign-in didn't save. Try again.");
    return NextResponse.json({ connection: publicConnection(connection) });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "The sign-in failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const POST = withSession(handlePost);
