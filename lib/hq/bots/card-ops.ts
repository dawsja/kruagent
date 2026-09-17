import { deleteCard, getActiveBotJobForCard, getCard, getRun, listRuns, patchCard, stopCardWork, type CardPatch } from "../data.ts";
import { prOwners } from "../pr-sync-logic.ts";
import type { BotId, Card, Run } from "../types.ts";
import { queueSteering, workingOn } from "./steering.ts";

/*
 * What Pip can do to a card that is already on the board: edit it, steer
 * whoever has it, stop it, delete it. These sit behind the edit_card,
 * steer_card, stop_card and delete_card tools; the room and the box are
 * handed in, so every answer can be tested without either.
 *
 * Every function returns the tool's result: one plain statement of what
 * happened, including when that is "nothing", so a bot never has to guess
 * and never reports something a tool didn't do.
 */

export type CardOpsDeps = {
  newId: () => string;
  /** A line in the room from Pip, about the card. */
  say: (text: string, cardId: string | null) => void;
  /** Drops a run's workspace in the box; resolves whether or not it was there. */
  releaseWorkspace: (runId: string) => Promise<void>;
};

const BOT_NAMES: Record<BotId, string> = { pip: "Pip", momo: "Momo", kiko: "Kiko", lulu: "Lulu", bibi: "Bibi" };
const STAGE_VERBS: Record<string, string> = { build: "building", test: "running checks", review: "reviewing", scribe: "writing it up" };

function quote(card: Pick<Card, "title">) {
  return `"${card.title}"`;
}

/** "Momo is building it", or for a run started by hand, "its agent is running". */
function holder(working: NonNullable<ReturnType<typeof workingOn>>, tense: "is" | "was" = "is") {
  return working.bot === "pip"
    ? `its agent ${tense} running`
    : `${BOT_NAMES[working.bot]} ${tense} ${STAGE_VERBS[working.stage] ?? "working on it"}`;
}

/** Where a card that nobody is working on sits, for saying why nothing happened. */
function restingState(card: Card): string {
  switch (card.status) {
    case "open":
      return card.stopped ? "stopped, waiting in Drop to be run again" : "waiting in Drop";
    case "needs_approval":
      return "waiting in Review for the person";
    case "approved":
      return "approved, with its pull request open";
    case "merged":
      return "merged";
    case "error":
      return "stopped on an error";
    default:
      return card.status;
  }
}

/** The run holding the card's open pull request, if it has one. */
export function openPullFor(cardId: string, runs: readonly Run[] = listRuns()): Run | null {
  return prOwners(runs).find((run) => run.cardId === cardId) ?? null;
}

// ---------- steer ----------

export function steerCard(
  input: { cardId: string; note: string; author: BotId; messageId?: string | null },
  deps: CardOpsDeps,
): string {
  const card = getCard(input.cardId);
  if (!card) return "No such card. Nothing was delivered.";
  const working = workingOn(card);
  if (!working) {
    const next =
      card.status === "needs_approval"
        ? "Use revise_run to send it back with the note."
        : card.status === "approved"
          ? "Use follow_up_pr to change its pull request."
          : card.status === "merged"
            ? "Create a new card for further changes."
            : "Use edit_card to change the task, then run_card to start it.";
    return `Steering NOT delivered: nothing is running on ${quote(card)} (it is ${restingState(card)}), so there is nobody to steer. ${next}`;
  }
  const queued = queueSteering(card, { id: deps.newId(), author: input.author, body: input.note, messageId: input.messageId ?? null });
  if (!queued) return `Steering NOT delivered: ${quote(card)} stopped being worked on just now.`;
  return `Steering delivered to ${quote(card)}: ${holder(working)}, and reads the note at the next safe point, then answers in the room with what changes. Nothing has changed yet; don't say it has.`;
}

// ---------- stop ----------

export function stopCard(input: { cardId: string; reason?: string | null; by: BotId }, deps: CardOpsDeps): string {
  const card = getCard(input.cardId);
  if (!card) return "No such card. Nothing was stopped.";
  const working = workingOn(card);
  const run = card.runId ? getRun(card.runId) : null;
  if (run?.status === "applying") {
    return `NOT stopped: ${quote(card)} is pushing to GitHub right now, which can't be interrupted. It finishes in a moment.`;
  }
  const reason = input.reason?.replace(/\s+/g, " ").trim();
  const note = `${BOT_NAMES[input.by]} stopped it${reason ? `: ${reason}` : " when asked to"}`.slice(0, 300);
  const stopped = stopCardWork(card.id, note);
  if (!stopped) {
    return `NOT stopped: nothing is running on ${quote(card)} (it is ${restingState(card)}), so there was nothing to stop.`;
  }
  const what = working ? holder(working, "was") : "its run was going";
  deps.say(`Stopped ${quote(card)} while ${what}. It's back in Drop with the work so far kept; ask me to run it again and it continues from there.`, card.id);
  return `Stopped ${quote(card)}: ${what}, and that work has been halted. The card is in Drop marked as stopped, not deleted, and keeps what was changed so far. run_card restarts it from there.`;
}

// ---------- edit ----------

export type CardEdit = {
  cardId: string;
  title?: string | null;
  body?: string | null;
  repo?: string | null;
  /** A model ref, already settled from whatever loose name was given. */
  model?: string | null;
  by: BotId;
  messageId?: string | null;
};

export function editCard(input: CardEdit, deps: CardOpsDeps): string {
  const card = getCard(input.cardId);
  if (!card) return "No such card. Nothing was edited.";
  const working = workingOn(card);
  const busy = Boolean(working) || Boolean(getActiveBotJobForCard(card.id));
  const patch: CardPatch = {};
  const done: string[] = [];
  const refused: string[] = [];

  const title = input.title?.trim();
  if (input.title != null && !title) refused.push("the title can't be empty");
  else if (title && title !== card.title) {
    patch.title = title;
    done.push(`title is now "${title}"`);
  }
  if (input.body != null && input.body.trim() !== card.body) {
    patch.body = input.body.trim();
    done.push(patch.body ? "details replaced" : "details cleared");
  }

  // The repo and the model are what a run is built on, so they only move
  // while nothing is built on them.
  const repo = input.repo?.trim();
  if (repo && repo !== card.repo) {
    if (busy) refused.push("the repo can't change while the card is being worked on (stop_card first)");
    else if (card.status !== "open" && card.status !== "error") {
      refused.push(`the repo can't change on a card that is ${restingState(card)}: its result belongs to ${card.repo}`);
    } else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) refused.push(`"${repo}" isn't a repo as owner/name`);
    else {
      patch.repo = repo;
      done.push(`repo is now ${repo}`);
    }
  }
  const model = input.model?.trim();
  if (model && model !== card.model) {
    if (busy) refused.push("the model can't change while the card is being worked on (stop_card first); it would apply from the next run");
    else {
      patch.model = model;
      done.push(`model is now ${model}`);
    }
  }

  const refusal = refused.length ? ` NOT changed: ${refused.join("; ")}.` : "";
  if (done.length === 0) return `Nothing was edited on ${quote(card)}.${refusal || " What you gave matches what the card already says."}`;
  const next = patchCard(card.id, patch);
  if (!next) return "The card was deleted just now. Nothing was edited.";

  let reach: string;
  const textChanged = patch.title !== undefined || patch.body !== undefined;
  if (working && textChanged) {
    const note = [
      "The card you are working on was edited. This is its task now; where it differs from what you were given, the new text wins:",
      `Task: ${next.title}`,
      next.body ? `Details:\n${next.body}` : "Details: (none)",
    ].join("\n");
    const queued = queueSteering(next, { id: deps.newId(), author: input.by, body: note, messageId: input.messageId ?? null });
    reach = queued
      ? ` It is being worked on (${holder(working)}), so the edit was also delivered as a steering note: the bot reads it at its next safe point and answers in the room. The run has not changed yet.`
      : " It stopped being worked on just now, so the edit reached nobody; the next run uses the new text.";
    if (queued) deps.say(`Edited ${quote(next)} while ${holder(working)}; the new scope is on its way to the run.`, next.id);
  } else if (next.status === "needs_approval") {
    reach = " The change waiting in Review was built from the old text and is NOT changed; use revise_run to have it reworked.";
  } else if (next.status === "approved" || next.status === "merged") {
    reach = " Its pull request is NOT changed by this; use follow_up_pr for that.";
  } else if (next.status === "error" || next.stopped) {
    reach = " Nothing is running on it; run_card starts it with the new text.";
  } else {
    reach = " It is in Drop, and the crew picks it up with the new text.";
  }
  return `Edited ${quote(next)} (${next.id}): ${done.join(", ")}.${reach}${refusal}`;
}

// ---------- delete ----------

export type CardDelete = {
  cardId: string;
  /** Delete even though the card's pull request is open on GitHub. */
  confirmOpenPullRequest?: boolean;
  /** Whether the message being answered came from the person, who alone can confirm that. */
  askedByPerson: boolean;
};

export async function removeCard(input: CardDelete, deps: CardOpsDeps): Promise<string> {
  const card = getCard(input.cardId);
  if (!card) return "No such card. Nothing was deleted.";
  const runs = listRuns().filter((run) => run.cardId === card.id);
  if (runs.some((run) => run.status === "applying")) {
    return `NOT deleted: ${quote(card)} is pushing to GitHub right now. Try again in a moment.`;
  }

  // Kru never touches GitHub from here, so deleting the card would leave an
  // open pull request that nothing follows any more. The person decides that.
  const pull = openPullFor(card.id, runs);
  const where = pull ? `pull request${pull.prNumber ? ` #${pull.prNumber}` : ""} (${pull.prUrl})` : "";
  if (pull && !(input.confirmOpenPullRequest && input.askedByPerson)) {
    return [
      `NOT deleted: ${quote(card)} has an open ${where}.`,
      "Deleting the card would orphan it: Kru would stop following its reviews and checks, and nothing here closes it on GitHub.",
      input.confirmOpenPullRequest
        ? "Only the person can confirm that, in their own message."
        : "Tell the person exactly that and ask. Only if they then say to delete it anyway, call delete_card again with confirmOpenPullRequest: true.",
    ].join(" ");
  }

  // Stop first, then delete, with nothing in between for a run to see: a
  // runner that looks next finds no run, and unwinds as cancelled.
  const working = workingOn(card);
  const stopped = stopCardWork(card.id, "The card was deleted");
  if (!deleteCard(card.id)) return "The card was deleted just now by someone else.";
  await Promise.all(runs.map((run) => deps.releaseWorkspace(run.id).catch(() => undefined)));

  const halted = stopped ? ` It was being worked on (${working ? holder(working, "was") : "its run was going"}): that was stopped first.` : "";
  const cleaned = runs.length ? ` Its workspace${runs.length === 1 ? "" : "s"} in the box ${runs.length === 1 ? "was" : "were"} cleaned up.` : "";
  const orphan = pull ? ` Its ${where} is still open on GitHub and is no longer followed; close it there if it isn't wanted.` : "";
  deps.say(`Deleted ${quote(card)}.${halted}${cleaned}${orphan || " Nothing on GitHub was touched."}`, null);
  return `Deleted ${quote(card)} (${card.id}) with its runs and history.${halted}${cleaned}${orphan || " Nothing on GitHub was touched."}`;
}
