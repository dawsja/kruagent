import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getStoredGithubApp, setInstallationId } from "@/lib/hq/data";
import { listInstallations } from "@/lib/hq/github";
import { githubReturnPath } from "@/lib/hq/github-oauth";
import { getFreshGithubConnection } from "@/lib/hq/model-auth";
import { appUrl } from "@/lib/hq/oauth";

/**
 * GitHub sends the browser here after the app is installed. The
 * installation_id in the URL can't be trusted on its own, so it's only saved
 * when the signed-in GitHub user can actually see that installation.
 * Otherwise Kru authorizes again, and the callback picks the installation up.
 */
async function handleGet(request: Request) {
  const installationId = Number(new URL(request.url).searchParams.get("installation_id"));
  const authorize = new URL("/api/connect/github/start-browser", appUrl());

  const github = await getFreshGithubConnection().catch(() => null);
  if (!github || !installationId) return NextResponse.redirect(authorize);

  try {
    const installations = await listInstallations(github.accessToken);
    if (installations.some((item) => item.id === installationId)) {
      if (getStoredGithubApp()) setInstallationId(installationId);
      return NextResponse.redirect(new URL(githubReturnPath(), appUrl()));
    }
  } catch {
    /* authorize again below */
  }
  return NextResponse.redirect(authorize);
}

export const GET = withSession(handleGet, { navigation: true });
