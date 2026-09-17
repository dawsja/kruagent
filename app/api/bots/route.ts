import { withSession } from "@/lib/auth/guard";
import { after, NextResponse } from "next/server";
import { BOTS } from "@/lib/hq/bots/registry";
import { boxConfig, endAgent } from "@/lib/hq/box";
import {
  getBotsAutoPush,
  getBotsEnabled,
  getBotsModel,
  getIssueLabel,
  getIssuesEnabled,
  getMissingGithubPermissions,
  listBotJobs,
  setBotsAutoPush,
  setBotsEnabled,
  setBotsModel,
  setIssueLabel,
  setIssuesEnabled,
  setMissingGithubPermissions,
} from "@/lib/hq/data";
import { getKruGithubApp } from "@/lib/hq/github-oauth";
import { cleanLabel } from "@/lib/hq/issue-sync-logic";

async function settings() {
  const app = await getKruGithubApp().catch(() => null);
  return {
    enabled: getBotsEnabled(),
    model: getBotsModel(),
    autoPush: getBotsAutoPush(),
    issuesEnabled: getIssuesEnabled(),
    issueLabel: getIssueLabel(),
    // Permissions GitHub refused, and where to grant them.
    missingPermissions: getMissingGithubPermissions(),
    githubApp: app ? { slug: app.slug, installationId: app.installationId ?? null } : null,
  };
}

/** The crew: whether it's on, who is in it, what it chats with, and what it is working on. */
async function handleGet() {
  return NextResponse.json({
    ...(await settings()),
    bots: BOTS,
    jobs: listBotJobs({ active: true }),
  });
}

/**
 * The Settings controls: the switch (turning it on picks up every open card
 * in Drop), the chat model, a ref like a card's, or null for the default,
 * auto-push for follow-ups, and a recheck once app permissions were fixed.
 */
async function handlePatch(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: unknown;
    model?: unknown;
    autoPush?: unknown;
    issuesEnabled?: unknown;
    issueLabel?: unknown;
    recheckPermissions?: unknown;
  };
  for (const key of ["enabled", "autoPush", "issuesEnabled"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      return NextResponse.json({ error: `${key} must be true or false` }, { status: 400 });
    }
  }
  if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    return NextResponse.json({ error: "model must be a ref or null" }, { status: 400 });
  }
  const label = body.issueLabel === undefined ? undefined : cleanLabel(body.issueLabel);
  if (label === null) {
    return NextResponse.json({ error: "The label must be 1 to 50 characters, without commas" }, { status: 400 });
  }
  if (
    [body.enabled, body.model, body.autoPush, body.issuesEnabled, body.issueLabel].every((value) => value === undefined) &&
    !body.recheckPermissions
  ) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }
  if (typeof body.enabled === "boolean") {
    const wasOn = getBotsEnabled();
    setBotsEnabled(body.enabled);
    // Switched off: close the bots' Claude Code sessions in the box now
    // rather than after their idle timeout.
    const box = boxConfig();
    if (wasOn && !body.enabled && box) {
      after(() => Promise.allSettled(BOTS.map((bot) => endAgent(box, `bot-${bot.id}`))));
    }
  }
  if (typeof body.autoPush === "boolean") setBotsAutoPush(body.autoPush);
  if (typeof body.issuesEnabled === "boolean") setIssuesEnabled(body.issuesEnabled);
  if (label && label !== getIssueLabel()) setIssueLabel(label);
  if (body.model !== undefined) setBotsModel(typeof body.model === "string" && body.model.trim() ? body.model.trim() : null);
  // Cleared here; the next sync asks GitHub again and puts it back if need be.
  if (body.recheckPermissions) setMissingGithubPermissions([]);
  return NextResponse.json(await settings());
}

export const GET = withSession(handleGet);
export const PATCH = withSession(handlePatch);
