import { tool } from "ai";
import { z } from "zod";
import { boxConfig, deleteBoxFile, execOnBox, readBoxFile, writeBoxFile, EXEC_TIMEOUT_MS } from "../box";
import { createCardFrom } from "../cards";
import {
  claimDropCard,
  createBotJobForRun,
  getActiveBotJobForCard,
  getBotsAutoPush,
  getCard,
  getIssueLabel,
  getOnboarding,
  getRepoInstructions,
  MAX_REPO_INSTRUCTIONS,
  setRepoInstructions,
  setIssueLabel,
  setIssuesEnabled,
  getRun,
  latestBotJobByCard,
  listCards,
  listPrFeedback,
  listRuns,
  patchCard,
  setBotsAutoPush,
} from "../data";
import { beginFollowUp } from "../follow-up";
import { importIssue } from "../issue-sync";
import { cleanLabel } from "../issue-sync-logic";
import { randomString } from "../oauth";
import { prOwners } from "../pr-sync-logic";
import { defaultCardModel, findModel, listModelsText, switchCardModel, switchChatModel } from "./models";
import { beginRun, claimForRevision, runProblem } from "../runs";
import type { Bot } from "./registry";
import { MAX_CHAIN } from "./chat-logic";
import { postBotMessage, postEvent } from "./room";
import type { ChatMessage } from "../types";

/*
 * What a bot can do from the Team room. Every bot gets every tool; the
 * SOULs say who reaches for which. Card work started here is picked up by
 * the dispatcher, so a tool returns quickly and says what will happen.
 */

/** Longest tool result handed back to the model. */
const MAX_TOOL_RESULT = 24_000;
/** Longest a command from chat may run. */
const CHAT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

function clip(text: string, limit = MAX_TOOL_RESULT) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

export const TOOL_NOTES = [
  "list_models shows the numbered list of models this Kru can use right now. use_model switches by name, loosely spelled (\"grok sub\", \"claude opus 5\", \"gpt api\", or a number from the list): target chat switches what the crew chats with, target card switches one card. If it says the name is ambiguous or unknown, show the person the options it gave.",
  "create_card takes a model by the same loose names; left out, the card gets the crew's model.",
  "create_card starts work: with the crew on, Momo picks the card up within seconds. Don't also call run_card.",
  "run_card restarts a card that stopped, errored, or was moved back to Drop. revise_run sends a card waiting for approval back to Momo with notes.",
  "follow_up_pr starts a follow-up on a card whose pull request is open: Momo continues on the pull request's own branch with the note, and the result waits in Review to be pushed to that pull request (or is pushed at once when auto-push is on). Feedback GitHub sent on the pull request starts a follow-up by itself; don't start another for it.",
  "set_crew_setting changes a crew setting, only when the person asks: auto_push (follow-ups pushed without Approve), issue_pickup (labelled GitHub issues become cards), issue_label (which label).",
  "import_issue turns one GitHub issue into a card by number (\"grab issue 42 from owner/repo\"). The card's pull request closes the issue. Don't also call create_card or run_card for it.",
  "set_repo_instructions saves standing rules for a repo that Momo follows on every card there and Lulu reviews against. Use it when the person states a rule for a repo (\"always use pnpm in owner/repo\"), not for one card's task.",
  "exec_on_box runs a shell command on the box as the agent user, in ~ by default. Card workspaces are under ~/workspace/<run id>. Keep your own files under ~/bots.",
  "post_message adds a second line to the room, e.g. to hand off with an @mention. Your final answer is posted for you; don't repeat it.",
].join("\n");

export function botTools(context: { bot: Bot; message: ChatMessage }) {
  const { bot, message } = context;
  const depth = message.depth + 1;

  return {
    list_cards: tool({
      description: "The board: every card with its id, column, status, repo, and whether the crew has it.",
      inputSchema: z.object({ column: z.enum(["drop", "run", "review"]).optional() }),
      execute: async ({ column }) => {
        const jobs = latestBotJobByCard();
        const cards = listCards().filter((card) => !column || card.column === column);
        if (cards.length === 0) return "No cards.";
        return cards
          .map((card) => {
            const job = jobs.get(card.id);
            const crew = job ? ` · crew: ${job.stage}${job.error ? ` (${job.error})` : ""}` : "";
            const issue = card.issueNumber ? ` · issue #${card.issueNumber}` : "";
            return `${card.id} · "${card.title}" · ${card.column} · ${card.status} · ${card.repo ?? "no repo"} · ${card.model ?? "no model"}${issue}${crew}`;
          })
          .join("\n");
      },
    }),
    create_card: tool({
      description:
        "Create a card in Drop. Title is the task in one line; body holds details. Repo and model default to the board's usual ones.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        body: z.string().max(4000).optional(),
        repo: z.string().optional(),
        model: z.string().optional(),
      }),
      execute: async (input) => {
        let model: string | null;
        if (input.model?.trim()) {
          const found = await findModel(input.model);
          if (!found.ok || !found.ref) return `Didn't create the card: ${found.message}`;
          model = found.ref;
        } else {
          model = await defaultCardModel();
        }
        if (!model) {
          return "Didn't create the card: no model is available to run it. Ask the person to add an endpoint or sign in to Claude Code under Settings.";
        }
        const card = createCardFrom({ ...input, model });
        const repo = card.repo ?? "no repo (ask the person which repo before the crew can run it)";
        return `Created card ${card.id} "${card.title}" on ${repo} with ${card.model}. The crew picks it up on the next tick.`;
      },
    }),
    list_models: tool({
      description: "The numbered list of models this Kru can use right now, with the crew's current chat model marked.",
      inputSchema: z.object({}),
      execute: async () => listModelsText(),
    }),
    use_model: tool({
      description:
        "Switch models by a loose name or a number from list_models. target \"chat\" switches what the crew chats with (and new cards from chat); target \"card\" switches one card's model and needs cardId.",
      inputSchema: z.object({
        query: z.string().min(1).max(120),
        target: z.enum(["chat", "card"]).default("chat"),
        cardId: z.string().optional(),
      }),
      execute: async ({ query, target, cardId }) => {
        if (target === "card") {
          if (!cardId) return "Say which card: cardId is required for target card.";
          return (await switchCardModel(cardId, query)).message;
        }
        return (await switchChatModel(query)).message;
      },
    }),
    run_card: tool({
      description: "Start or restart the crew on a card by id: one that is open in Drop, errored, or was moved back to Drop.",
      inputSchema: z.object({ cardId: z.string() }),
      execute: async ({ cardId }) => {
        const card = getCard(cardId);
        if (!card) return "No such card.";
        if (getActiveBotJobForCard(card.id)) return "The crew already has this card.";
        if (card.status === "running") return "This card is already running.";
        if (card.status === "needs_approval") return "This card is waiting for approval. Use revise_run to send it back with notes.";
        if (card.status === "approved") return "This card already has a pull request. Use follow_up_pr to change it.";
        if (card.status === "merged") return "This card's pull request was merged. Create a new card for further changes.";
        const problem = runProblem(card);
        if (problem) return `Can't run it: ${problem}`;
        if (card.column !== "drop" || card.status !== "open") patchCard(card.id, { column: "drop", status: "open" });
        const job = claimDropCard(card.id, null, randomString(9));
        return job ? `Queued "${card.title}"; Momo picks it up on the next tick.` : "Couldn't queue it; try again.";
      },
    }),
    revise_run: tool({
      description: "Send a card that is waiting for approval back to Momo with a note saying what should change.",
      inputSchema: z.object({ runId: z.string(), note: z.string().min(1).max(4000) }),
      execute: async ({ runId, note }) => {
        const run = getRun(runId);
        if (!run) return "No such run.";
        if (run.status === "approved" && run.prUrl) return "That run already has a pull request. Use follow_up_pr on its card to change it.";
        if (run.status !== "needs_approval") return `That run is ${run.status}, not waiting for approval.`;
        const card = getCard(run.cardId);
        if (!card) return "The card is gone.";
        if (getActiveBotJobForCard(card.id)) return "The crew is still working on this card.";
        const problem = runProblem(card);
        if (problem) return `Can't revise it: ${problem}`;
        if (!claimForRevision(run, note)) return "That run was just approved or discarded.";
        const next = beginRun(card, { of: run, note }, { bot: "momo" });
        const job = createBotJobForRun(randomString(9), card.id, next.id);
        return job ? `Sent "${card.title}" back to Momo with your note.` : "Started a revision, but couldn't queue the crew.";
      },
    }),
    follow_up_pr: tool({
      description:
        "Start a follow-up on a card whose pull request is open: Momo continues on the pull request's branch with the note, and the result is pushed to that pull request once approved (or at once with auto-push on).",
      inputSchema: z.object({ cardId: z.string(), note: z.string().min(1).max(4000) }),
      execute: async ({ cardId, note }) => {
        const card = getCard(cardId);
        if (!card) return "No such card.";
        if (getActiveBotJobForCard(card.id)) return "The crew already has this card.";
        if (card.status === "running") return "This card is already running.";
        const owner = prOwners(listRuns()).find((run) => run.cardId === card.id);
        if (!owner) {
          return card.status === "merged"
            ? "This card's pull request was merged; create a new card for further changes."
            : "This card has no open pull request. run_card or revise_run are for cards without one.";
        }
        const problem = runProblem(card);
        if (problem) return `Can't start a follow-up: ${problem}`;
        const pending = listPrFeedback({ cardId: card.id, pending: true }).filter((item) => item.prUrl === owner.prUrl);
        const run = beginFollowUp(card, owner, pending, "manual", { bot: "momo", note });
        return `Started a follow-up on PR #${owner.prNumber ?? "?"} for "${card.title}" (run ${run.id}); Momo picks it up on the next tick. ${getBotsAutoPush() ? "Auto-push is on, so it's pushed once Bibi is done." : "It waits in Review to be pushed."}`;
      },
    }),
    set_crew_setting: tool({
      description:
        "Change a crew setting the person asked for. auto_push (on): whether follow-ups to the crew's own pull requests are pushed without waiting for Approve; new pull requests always wait for the person. issue_pickup (on): whether open GitHub issues carrying the label become cards. issue_label (value): the label that marks those issues.",
      inputSchema: z.object({
        setting: z.enum(["auto_push", "issue_pickup", "issue_label"]),
        on: z.boolean().optional(),
        value: z.string().optional(),
      }),
      execute: async ({ setting, on, value }) => {
        if (setting === "issue_label") {
          const label = cleanLabel(value);
          if (!label) return "Give the label as value: up to 50 characters, no commas.";
          setIssueLabel(label);
          postEvent("pip", `Issues labelled "${label}" are the ones I pick up now.`);
          return `The issue label is now "${label}".`;
        }
        if (on === undefined) return `Say on: true or false for ${setting}.`;
        if (setting === "issue_pickup") {
          setIssuesEnabled(on);
          postEvent(
            "pip",
            on
              ? `Issue pickup is on: open issues labelled "${getIssueLabel()}" in your repos become cards, and their pull requests close them.`
              : "Issue pickup is off.",
          );
          return `Issue pickup is now ${on ? "on" : "off"}.`;
        }
        setBotsAutoPush(on);
        postEvent(
          "pip",
          on
            ? "Auto-push is on: follow-ups to the crew's own pull requests are pushed as soon as Bibi is done. New pull requests still wait for you."
            : "Auto-push is off: follow-ups wait in Review until you approve them.",
        );
        return `Auto-push is now ${on ? "on" : "off"}.`;
      },
    }),
    import_issue: tool({
      description:
        "Turn one GitHub issue into a card in Drop, by number. repo defaults to the board's usual one. Works without the label and with issue pickup off.",
      inputSchema: z.object({ number: z.number().int().positive(), repo: z.string().optional() }),
      execute: async ({ number, repo }) => {
        const target = repo?.trim() || getOnboarding()?.repo;
        if (!target) return "Say which repo, as owner/name.";
        const result = await importIssue(target, number);
        if (!result.ok) return `Didn't import it: ${result.error}`;
        const card = result.card;
        return `Created card ${card.id} "${card.title}" from ${target}#${number}${card.model ? " with " + card.model : ", but with no model (ask the person to connect one)"}. Its pull request will close the issue. The crew picks it up on the next tick.`;
      },
    }),
    exec_on_box: tool({
      description:
        "Run a shell command on the box as the agent user. cwd defaults to the home folder; it must stay under it. Output is trimmed.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(CHAT_EXEC_TIMEOUT_MS).optional(),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const box = boxConfig();
        if (!box) return "The box isn't configured.";
        const result = await execOnBox(box, command, { cwd, timeoutMs: Math.min(timeoutMs ?? EXEC_TIMEOUT_MS, CHAT_EXEC_TIMEOUT_MS) });
        const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
        return clip(`${status}\n${result.output}`);
      },
    }),
    delete_box_file: tool({
      description: "Delete a file under the agent's home on the box, e.g. a note under bots/ that is out of date.",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const box = boxConfig();
        if (!box) return "The box isn't configured.";
        await deleteBoxFile(box, path);
        return "deleted";
      },
    }),
    set_repo_instructions: tool({
      description:
        "Save the person's standing instructions for a repo: rules Momo follows on every card there and Lulu reviews against (\"always use pnpm\", \"never touch the migrations folder\"). mode replace swaps them; append adds a line. Empty instructions with replace clears them.",
      inputSchema: z.object({
        repo: z.string().optional(),
        instructions: z.string().max(MAX_REPO_INSTRUCTIONS),
        mode: z.enum(["replace", "append"]).default("append"),
      }),
      execute: async ({ repo, instructions, mode }) => {
        const target = repo?.trim() || getOnboarding()?.repo;
        if (!target) return "Say which repo, as owner/name.";
        const current = getRepoInstructions(target);
        const next = mode === "append" && current ? `${current}\n${instructions.trim()}` : instructions.trim();
        if (next.length > MAX_REPO_INSTRUCTIONS) return `That would be over ${MAX_REPO_INSTRUCTIONS} characters; replace instead of appending.`;
        setRepoInstructions(target, next);
        return next ? `Standing instructions for ${target} are now:\n${next}` : `Cleared the standing instructions for ${target}.`;
      },
    }),
    read_box_file: tool({
      description: "Read a file, or list a folder, under the agent's home on the box, e.g. bots/notes.md or workspace/<run id>/README.md.",
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path }) => {
        const box = boxConfig();
        if (!box) return "The box isn't configured.";
        const file = await readBoxFile(box, path);
        if (file.directory) return `directory:\n${file.directory.join("\n")}`;
        if (file.binary) return `binary file, ${file.size} bytes`;
        return clip(file.content ?? "");
      },
    }),
    write_box_file: tool({
      description: "Create or overwrite a file under the agent's home on the box. Keep your own notes under bots/.",
      inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
      execute: async ({ path, content }) => {
        const box = boxConfig();
        if (!box) return "The box isn't configured.";
        await writeBoxFile(box, path, content);
        return "written";
      },
    }),
    post_message: tool({
      description:
        "Post an extra line in the room right now, e.g. to hand off to a teammate with mention set to their id. Your final answer is posted separately.",
      inputSchema: z.object({
        text: z.string().min(1).max(2000),
        mention: z.enum(["pip", "momo", "kiko", "lulu", "bibi"]).optional(),
      }),
      execute: async ({ text, mention }) => {
        const tag = mention && mention !== bot.id && !text.toLowerCase().includes(`@${mention}`) ? `@${mention} ` : "";
        const posted = postBotMessage(bot.id, `${tag}${text}`, { replyTo: message.id, depth, cardId: message.cardId });
        return depth >= MAX_CHAIN && posted.mentions.length
          ? "Posted, but this thread is as deep as it goes: no bot will answer the mention."
          : "Posted.";
      },
    }),
  };
}
