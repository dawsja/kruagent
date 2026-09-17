import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import {
  getKruGithubApp,
  githubAppManifest,
  githubManifestAction,
} from "@/lib/hq/github-oauth";
import { randomString, setManifestState } from "@/lib/hq/oauth";

/**
 * Starts creating this server's GitHub App. The client posts the manifest to
 * GitHub; GitHub returns the `state` we set here, which the manifest route
 * checks before accepting the app's credentials.
 */
async function handlePost() {
  const app = await getKruGithubApp();
  if (app) {
    return NextResponse.json({ registered: true, slug: app.slug });
  }
  const state = randomString(16);
  await setManifestState(state);
  return NextResponse.json({
    registered: false,
    action: githubManifestAction(state),
    manifest: JSON.stringify(githubAppManifest()),
  });
}

export const POST = withSession(handlePost);
