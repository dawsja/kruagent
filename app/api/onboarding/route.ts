import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { getBotsEnabled, getOnboarding, listConnections, saveOnboarding, setBotsEnabled } from "@/lib/hq/data";
import { listRepos } from "@/lib/hq/github";
import { getKruGithubApp } from "@/lib/hq/github-oauth";
import { getFreshGithubConnection } from "@/lib/hq/model-auth";
import { publicConnection } from "@/lib/hq/oauth";
import { isModelProvider, type Onboarding } from "@/lib/hq/types";

async function handleGet() {
  return NextResponse.json({
    onboarding: getOnboarding(),
    connections: listConnections().map(publicConnection),
    githubApp: Boolean(await getKruGithubApp()),
    bots: getBotsEnabled(),
  });
}

/** The most recently pushed repo the GitHub App can reach, if any. */
async function mostRecentRepo() {
  try {
    const github = await getFreshGithubConnection();
    if (!github) return null;
    return (await listRepos(github.accessToken))[0]?.full_name ?? null;
  } catch {
    return null;
  }
}

async function handlePost(request: Request) {
  try {
    const body = (await request.json()) as Partial<Onboarding> & { bots?: boolean };
    const model = body.model?.trim() || null;
    // The bots step of setup; Settings changes it later through /api/bots.
    if (typeof body.bots === "boolean") setBotsEnabled(body.bots);

    const connections = listConnections();
    const github = connections.some((item) => item.provider === "github");
    const hasModel = connections.some((item) => isModelProvider(item.provider));
    // No repo is picked during setup; the board can change it per card.
    const repo = body.repo?.trim() || (github ? await mostRecentRepo() : null);
    const onboarding: Onboarding = {
      complete: Boolean(github && hasModel),
      model,
      repo,
    };
    saveOnboarding(onboarding);
    return NextResponse.json({ onboarding, bots: getBotsEnabled() });
  } catch (reason) {
    const message =
      reason instanceof Error ? reason.message : "Could not save onboarding";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withSession(handleGet);
export const POST = withSession(handlePost);
