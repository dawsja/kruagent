import { withSession } from "@/lib/auth/guard";
import { after, NextResponse } from "next/server";
import { approveRun } from "@/lib/hq/approve";
import { checkFiles, cleanName, verifyFile } from "@/lib/hq/bots/attachments";
import { parseCommand, runCommand } from "@/lib/hq/bots/commands";
import { resolvePrChat } from "@/lib/hq/bots/pr-request";
import { resetRevisePick, resolveReviseChat } from "@/lib/hq/bots/revise-request";
import { postEvent, postHumanMessage } from "@/lib/hq/bots/room";
import { clearChatMessages, getBotsEnabled, listChatMessages } from "@/lib/hq/data";
import { reviseRun } from "@/lib/hq/runs";

const MAX_BODY = 4000;

/** A note, short enough to repeat back in the room. */
function clip(text: string, max = 160) {
  const line = text.replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The room, or only what came after `after` (a message's createdAt). */
async function handleGet(request: Request) {
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const limit = Number(url.searchParams.get("limit") ?? 200) || 200;
  return NextResponse.json({
    messages: listChatMessages({ after: after || null, limit }),
    enabled: getBotsEnabled(),
  });
}

type Upload = { name: string; mediaType: string; data: Uint8Array };

/**
 * The message's text and files: JSON for text alone, multipart form data
 * (`body` and any number of `files`) when files are attached.
 */
async function readMessage(request: Request): Promise<{ text: string; files: Upload[] } | { error: string }> {
  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const body = (await request.json().catch(() => ({}))) as { body?: unknown };
    return { text: typeof body.body === "string" ? body.body.trim().slice(0, MAX_BODY) : "", files: [] };
  }
  const form = await request.formData().catch(() => null);
  if (!form) return { error: "Couldn't read the upload. Try smaller files." };
  const body = form.get("body");
  const entries = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
  const invalid = checkFiles(entries);
  if (invalid) return { error: invalid };
  const files: Upload[] = [];
  for (const file of entries) {
    const data = new Uint8Array(await file.arrayBuffer());
    // A body cut short by the proxy's buffer limit arrives smaller than sent.
    if (data.byteLength !== file.size) return { error: `${cleanName(file.name)} didn't arrive whole. Try a smaller file.` };
    const verified = verifyFile(file.name, file.type, data);
    if ("error" in verified) return { error: verified.error };
    files.push({ name: cleanName(file.name), mediaType: verified.mediaType, data });
  }
  return { text: typeof body === "string" ? body.trim().slice(0, MAX_BODY) : "", files };
}

/** What you say. With the crew on, a bot answers on the next tick. */
async function handlePost(request: Request) {
  const read = await readMessage(request);
  if ("error" in read) return NextResponse.json({ error: read.error }, { status: 400 });
  const { text, files } = read;
  if (!text && files.length === 0) return NextResponse.json({ error: "Say something" }, { status: 400 });
  const enabled = getBotsEnabled();
  // Files are for a bot to read, so a message carrying them always goes to
  // the crew rather than the shortcuts below.
  if (files.length) {
    const message = postHumanMessage(text, { pending: enabled, files });
    return NextResponse.json({
      message,
      notice: enabled ? null : "Bots are off, so nobody will answer. Turn them on in Settings.",
    });
  }
  // /model and /models are answered here, not by a bot, so they work even
  // when the chat model is what needs switching.
  const command = parseCommand(text);
  if (command) {
    const message = postHumanMessage(text, { pending: false });
    postEvent("pip", await runCommand(command));
    return NextResponse.json({ message, notice: null });
  }
  // "Make the PR for the theme toggle one" is the person approving a card in
  // their own words, so Kru matches it and runs the same approve flow as the
  // card's button; no model decides to open a pull request.
  const prChat = resolvePrChat(text);
  if (prChat) {
    resetRevisePick();
    const message = postHumanMessage(text, { pending: false });
    postEvent("pip", prChat.reply, prChat.cardId);
    const approve = prChat.approve;
    if (approve) {
      after(async () => {
        const result = await approveRun(approve.runId);
        postEvent(
          "pip",
          result.ok
            ? result.mode === "pushed"
              ? `Pushed the follow-up for "${approve.card.title}" to its pull request: ${result.run.prUrl}`
              : `Opened the pull request for "${approve.card.title}": ${result.run.prUrl}`
            : `Couldn't open the pull request for "${approve.card.title}": ${result.error}`,
          approve.card.id,
        );
      });
    }
    return NextResponse.json({ message, notice: null });
  }
  // "On the landing page one, make the hero smaller" is the "Ask for changes"
  // box in the person's own words: Kru matches the card in Review and sends
  // it back with the note, the same revise flow as the card's form.
  const reviseChat = resolveReviseChat(text);
  if (reviseChat) {
    const message = postHumanMessage(text, { pending: false });
    const revise = reviseChat.revise;
    if (revise) {
      const result = reviseRun(revise.runId, revise.note);
      postEvent(
        "pip",
        result.ok
          ? `Sent "${revise.card.title}" back to Run with your note: "${clip(revise.note)}". The agent continues from its changes in the same workspace, and the card returns to Review when it's done.`
          : `Couldn't send "${revise.card.title}" back: ${result.error}`,
        revise.card.id,
      );
    } else {
      postEvent("pip", reviseChat.reply, reviseChat.cardId);
    }
    return NextResponse.json({ message, notice: null });
  }
  const message = postHumanMessage(text, { pending: enabled });
  return NextResponse.json({
    message,
    notice: enabled ? null : "Bots are off, so nobody will answer. Turn them on in Settings.",
  });
}

/** Clears the room: every line, yours and the crew's, from the database. */
async function handleDelete() {
  resetRevisePick();
  const deleted = clearChatMessages();
  return NextResponse.json({ deleted });
}

export const GET = withSession(handleGet);
export const POST = withSession(handlePost);
export const DELETE = withSession(handleDelete);
