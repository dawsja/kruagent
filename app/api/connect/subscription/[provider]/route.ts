import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { removeSubscription } from "@/lib/hq/subscription";
import { isSubscriptionProvider } from "@/lib/hq/types";

/** Signs out of a subscription. API-key endpoints of the same format stay. */
async function handleDelete(
  _request: Request,
  context: RouteContext<"/api/connect/subscription/[provider]">,
) {
  const { provider } = await context.params;
  if (!isSubscriptionProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  removeSubscription(provider);
  return NextResponse.json({ ok: true });
}

export const DELETE = withSession(handleDelete);
