import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { listRepos } from "@/lib/hq/github";
import { getFreshGithubConnection, GithubReconnectError } from "@/lib/hq/model-auth";

async function handleGet() {
  try {
    const github = await getFreshGithubConnection();
    if (!github) return NextResponse.json({ repos: [] });
    return NextResponse.json({ repos: await listRepos(github.accessToken) });
  } catch (reason) {
    if (reason instanceof GithubReconnectError) {
      return NextResponse.json({ repos: [], error: reason.message }, { status: 409 });
    }
    const message = reason instanceof Error ? reason.message : "GitHub error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export const GET = withSession(handleGet);
