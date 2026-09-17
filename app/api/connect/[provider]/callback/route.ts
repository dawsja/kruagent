import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getStoredGithubApp, replaceProviderConnection, setInstallationId } from "@/lib/hq/data";
import { githubGet, listInstallations } from "@/lib/hq/github";
import { getKruGithubApp, githubInstallUrl } from "@/lib/hq/github-oauth";
import { appUrl, safeNext, takeOAuthCookie } from "@/lib/hq/oauth";
import type { Connection } from "@/lib/hq/types";

async function exchangeGithub(code: string, verifier?: string): Promise<Connection> {
  const app = await getKruGithubApp();
  if (!app) throw new Error("Create your Kru GitHub App in setup first");
  const body = new URLSearchParams({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code,
    redirect_uri: `${appUrl()}/api/connect/github/callback`,
  });
  if (verifier) body.set("code_verifier", verifier);
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "GitHub token exchange failed");
  }
  const user = await githubGet<{ login: string; avatar_url?: string }>(data.access_token, "/user");
  return {
    id: "github",
    provider: "github",
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
    label: user.login,
    meta: {
      login: user.login,
      ...(user.avatar_url ? { avatar: user.avatar_url } : {}),
    },
  };
}

async function handleGet(
  request: Request,
  context: RouteContext<"/api/connect/[provider]/callback">,
) {
  const { provider } = await context.params;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = await takeOAuthCookie();
  const back = new URL(safeNext(cookie?.next, "/app"), appUrl());

  // An older app with install-time authorization returns here from the
  // install page without Kru's state. Never trust that code; authorize again.
  if (provider === "github" && !state && url.searchParams.get("setup_action")) {
    return NextResponse.redirect(new URL("/api/connect/github/start-browser", appUrl()));
  }

  try {
    if (!code || !state || !cookie || cookie.provider !== provider || cookie.state !== state) {
      throw new Error("OAuth state mismatch");
    }
    if (provider !== "github") throw new Error("Unknown provider");

    const connection = await exchangeGithub(code, cookie.verifier);
    const installations = await listInstallations(connection.accessToken).catch(() => []);
    if (installations[0]) {
      connection.meta = { ...connection.meta, installationId: String(installations[0].id) };
    }
    replaceProviderConnection(connection);
    if (installations[0] && getStoredGithubApp()) setInstallationId(installations[0].id);

    // Authorized but not installed anywhere yet: install next, then setup returns.
    const app = await getKruGithubApp();
    if (installations.length === 0 && app?.slug) {
      return NextResponse.redirect(githubInstallUrl(app.slug));
    }
    // Back where the trip started — setup, or Settings — rather than a page
    // whose only content is "now return to the other tab".
    return NextResponse.redirect(back);
  } catch (reason) {
    back.searchParams.set("error", reason instanceof Error ? reason.message : "OAuth failed");
  }
  return NextResponse.redirect(back);
}

export const GET = withSession(handleGet, { navigation: true });
