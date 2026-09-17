import { NextResponse } from "next/server";
import { appUrl } from "@/lib/hq/oauth";
import { completeBrowserLogin } from "@/lib/hq/subscription";

/**
 * Where a ChatGPT sign-in returns: http://localhost:1455/auth/callback, an
 * address OpenAI fixed. It reaches Kru through Docker's port mapping or the
 * listener in lib/hq/oauth-listener.ts. No session or cookie is checked
 * (none arrive on this port); the one-time `state` of a login started from
 * a signed-in tab is what proves the callback belongs here, and the answer
 * never echoes the code.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await completeBrowserLogin({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  });
  const back = new URL(result.next, appUrl());
  if (result.ok) back.searchParams.set("connected", result.connectionId);
  else back.searchParams.set("error", result.error);
  return NextResponse.redirect(back, { headers: { "Cache-Control": "no-store" } });
}
