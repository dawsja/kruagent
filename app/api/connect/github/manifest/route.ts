import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { saveGithubApp } from "@/lib/hq/data";
import { appUrl, takeManifestState } from "@/lib/hq/oauth";

/** GitHub sends the browser here after the app is created, with a one-hour code. */
async function handleGet(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = await takeManifestState();
  const fail = new URL("/connect/github/created", appUrl());

  if (!code) {
    fail.searchParams.set("error", "GitHub app setup was cancelled");
    return NextResponse.redirect(fail);
  }
  if (!state || !expected || state !== expected) {
    fail.searchParams.set(
      "error",
      "This GitHub App setup could not be verified. Start again from setup in this browser.",
    );
    return NextResponse.redirect(fail);
  }

  try {
    const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "kru-agent-hq",
      },
    });
    const data = (await res.json()) as {
      id?: number;
      slug?: string;
      client_id?: string;
      client_secret?: string;
      pem?: string;
      message?: string;
    };
    if (!res.ok || !data.client_id || !data.client_secret || !data.slug) {
      throw new Error(data.message ?? "GitHub app conversion failed");
    }
    saveGithubApp({
      clientId: data.client_id,
      clientSecret: data.client_secret,
      slug: data.slug,
      appId: data.id ?? 0,
      pem: data.pem,
    });
    // The app exists but is not authorized or installed on anything yet, and
    // that is the same trip. Going straight on saves the reader a dead-end
    // page and a second button that only said "now do the other half".
    return NextResponse.redirect(new URL("/api/connect/github/start-browser", appUrl()));
  } catch (reason) {
    fail.searchParams.set(
      "error",
      reason instanceof Error ? reason.message.slice(0, 200) : "GitHub app setup failed",
    );
    return NextResponse.redirect(fail);
  }
}

export const GET = withSession(handleGet, { navigation: true });
