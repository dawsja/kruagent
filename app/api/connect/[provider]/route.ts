import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { appUrl, safeNext } from "@/lib/hq/oauth";
import { deleteConnectionsByProvider } from "@/lib/hq/data";
import { isByokProvider, isConnectionProvider } from "@/lib/hq/types";

async function handleGet(
  request: Request,
  context: RouteContext<"/api/connect/[provider]">,
) {
  const { provider } = await context.params;
  const next = safeNext(new URL(request.url).searchParams.get("next"), "/app");

  if (provider === "github") {
    const url = new URL("/onboarding", appUrl());
    url.searchParams.set("connect", "github");
    return NextResponse.redirect(url);
  }

  if (isByokProvider(provider)) {
    const url = new URL("/connect/byok", appUrl());
    url.searchParams.set("provider", provider);
    url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }

  return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
}

async function handleDelete(
  _request: Request,
  context: RouteContext<"/api/connect/[provider]">,
) {
  const { provider } = await context.params;
  if (!isConnectionProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  if (isByokProvider(provider)) {
    // Several endpoints can share a format, so they are removed by id.
    return NextResponse.json(
      { error: "Remove API endpoints with DELETE /api/connect/byok/[id]" },
      { status: 400 },
    );
  }
  deleteConnectionsByProvider(provider);
  return NextResponse.json({ ok: true });
}

export const GET = withSession(handleGet, { navigation: true });
export const DELETE = withSession(handleDelete);
