import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { startBrowserLogin } from "@/lib/hq/subscription";
import { isSubscriptionProvider } from "@/lib/hq/types";

/** Starts a browser sign-in with a subscription; the client opens `url` and polls `status`. */
async function handlePost(
  request: Request,
  context: RouteContext<"/api/connect/subscription/[provider]/start">,
) {
  const { provider } = await context.params;
  if (!isSubscriptionProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  try {
    const next = new URL(request.url).searchParams.get("next");
    return NextResponse.json(startBrowserLogin(provider, next));
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Could not start the sign-in";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const POST = withSession(handlePost);
