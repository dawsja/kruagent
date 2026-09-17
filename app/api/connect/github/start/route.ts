import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getKruGithubApp, githubAuthorizeUrl } from "@/lib/hq/github-oauth";
import {
  pkceChallenge,
  pkceVerifier,
  randomString,
  safeNext,
  setOAuthCookie,
} from "@/lib/hq/oauth";

/**
 * Starts connecting GitHub: always an authorize URL. After authorizing, the
 * callback sends the user to install the app if it isn't installed anywhere.
 */
async function handlePost(request: Request) {
  try {
    const next = safeNext(new URL(request.url).searchParams.get("next"), "/onboarding");
    const app = await getKruGithubApp();
    if (!app) {
      return NextResponse.json(
        { error: "Create your Kru GitHub App in setup first." },
        { status: 409 },
      );
    }
    const state = randomString(16);
    const verifier = pkceVerifier();
    await setOAuthCookie({ provider: "github", state, verifier, next });
    return NextResponse.json({
      url: githubAuthorizeUrl(app.clientId, state, pkceChallenge(verifier)),
    });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Could not start GitHub login";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const POST = withSession(handlePost);
