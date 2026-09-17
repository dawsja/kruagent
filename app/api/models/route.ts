import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import { claudeCodeSignedIn } from "@/lib/hq/claude-code";
import { listConnections } from "@/lib/hq/data";
import { modelOptionsForConnections } from "@/lib/hq/live-models";

/**
 * Model picker options for every connected API endpoint, and for Claude
 * Code when the box says it's signed in (a cached answer; Settings and each
 * run refresh it).
 */
async function handleGet() {
  return NextResponse.json(modelOptionsForConnections(listConnections(), await claudeCodeSignedIn()));
}

export const GET = withSession(handleGet);
