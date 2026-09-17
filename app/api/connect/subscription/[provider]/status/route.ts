import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { loginStatus } from "@/lib/hq/subscription";
import { isSubscriptionProvider } from "@/lib/hq/types";

/** Where a sign-in stands. Polling this is what drives a device-code login. */
async function handleGet(
  request: Request,
  context: RouteContext<"/api/connect/subscription/[provider]/status">,
) {
  const { provider } = await context.params;
  if (!isSubscriptionProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  const loginId = new URL(request.url).searchParams.get("login") ?? "";
  const status = await loginStatus(loginId);
  if (status.provider && status.provider !== provider) {
    return NextResponse.json({ error: "That sign-in belongs to another provider" }, { status: 400 });
  }
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withSession(handleGet);
