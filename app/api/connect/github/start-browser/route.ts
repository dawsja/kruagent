import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getKruGithubApp, githubAuthorizeUrl, githubReturnPath } from "@/lib/hq/github-oauth";
import {
  appUrl,
  pkceChallenge,
  pkceVerifier,
  randomString,
  setOAuthCookie,
} from "@/lib/hq/oauth";

async function handleGet() {
  const app = await getKruGithubApp();
  if (!app) {
    return NextResponse.redirect(new URL("/onboarding", appUrl()));
  }
  const state = randomString(16);
  const verifier = pkceVerifier();
  await setOAuthCookie({
    provider: "github",
    state,
    verifier,
    next: githubReturnPath(),
  });
  return NextResponse.redirect(
    githubAuthorizeUrl(app.clientId, state, pkceChallenge(verifier)),
  );
}

export const GET = withSession(handleGet, { navigation: true });
