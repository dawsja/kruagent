import {
  BOX_RUN_TIMEOUT_MS,
  CollectFailedError,
  FRESH_START,
  LOG_COMMAND_CHARS,
  REVIEW_CAREFULLY,
  logCommand,
  logText,
  RunCancelledError,
  revisionPrompt,
  taskPrompt,
  type AgentInput,
  type AgentResult,
} from "./agent-shared.ts";
import {
  boxConfig,
  changesToWrites,
  checkClaude,
  createWorkspace,
  deleteWorkspace,
  deleteWorkspaceFile,
  requireBoxConfig,
  runClaudeInWorkspace,
  workspaceChanges,
  writeWorkspaceFile,
  type BoxConfig,
  type ClaudeCheck,
} from "./box.ts";
import { parseModelRef } from "./models.ts";
import { validateProposedWrites } from "./proposed-writes.ts";
import { createRedactor } from "./redact.ts";

/*
 * Claude Code as a runner: a card whose model is `claude-code:<model>` runs
 * on the `claude` CLI inside the box instead of a model connection. The CLI
 * brings its own agent loop and tools, so this is a sibling of
 * `runCardAgent`, not a model for it. Kru's part is the same on both sides
 * of the run: clone into a workspace, hand over the task, then collect the
 * working tree for review.
 *
 * Kru never holds Claude credentials. The person signs in to the CLI from
 * the box desktop; here we only ask the box whether that has happened.
 */

/** How often a running card is checked for cancellation. */
const CANCEL_POLL_MS = 2_000;

/**
 * The CLI's version of the box instructions: same rules, minus the tools
 * Kru's own runner defines, since the CLI has its own and no `finish`.
 */
export const CLAUDE_CODE_INSTRUCTIONS = [
  "You are a coding agent on a Kanban board, working in a clone of the repo. Your working directory is the repo root, a folder under ~/workspace in your own box. Stay inside that folder; it's the only place your work is collected from.",
  "Work like an engineer: look around first, make the change, then run the project's own checks (build, lint, tests) and fix what breaks. Install only the dependencies the task needs.",
  "Do not commit, push, or create branches: Kru collects your working-tree changes and a person reviews them before anything reaches GitHub.",
  "Do not modify anything under ~/.claude or ~/.claude.json; that is the person's own sign-in and settings.",
  "A browser is installed as `google-chrome`, with CHROME_BIN set; it already runs with --no-sandbox because the box blocks Chrome's sandbox. Add --headless=new when there is no display, and don't download another browser to work around a sandbox error.",
  "Your final message is shown to the reviewer as the summary: make it a short account of what changed and how you verified it. Finishing without changing anything accomplishes nothing.",
].join(" ");

export const CLAUDE_MISSING_MESSAGE =
  "The box image has no `claude` CLI. Update the box image (docker compose pull, or build it from box/) and restart it.";
export const CLAUDE_SIGN_IN_MESSAGE =
  "Claude Code isn't signed in. Open the box desktop, run `claude` in a terminal, and sign in — it's saved for future runs.";

/** Masks token formats in text the CLI printed; Kru knows no secret to add. */
const redactPatterns = createRedactor([]);

/** How long a sign-in check answers for the model picker before it's redone. */
const CHECK_CACHE_MS = 5 * 60 * 1000;
let cachedCheck: { at: number; check: ClaudeCheck } | null = null;

/**
 * The box's answer about the CLI, kept for a while: the picker asks on
 * every board load, and each check is a CLI run. `fresh` asks again now.
 * Whatever the runner learns at the start of a run lands here too.
 */
export async function checkClaudeCached(box: BoxConfig, { fresh = false } = {}): Promise<ClaudeCheck> {
  if (!fresh && cachedCheck && Date.now() - cachedCheck.at < CHECK_CACHE_MS) return cachedCheck.check;
  const check = await checkClaude(box);
  cachedCheck = { at: Date.now(), check };
  return check;
}

/** True when a box is configured and its CLI is signed in, as last checked. */
export async function claudeCodeSignedIn(): Promise<boolean> {
  let box: BoxConfig | null;
  try {
    box = boxConfig();
  } catch {
    return false;
  }
  if (!box) return false;
  try {
    return (await checkClaudeCached(box)).status === "ok";
  } catch {
    return false;
  }
}

/** The message a failed preflight puts on the card, or null when it passed. */
export function preflightProblem(check: ClaudeCheck): string | null {
  switch (check.status) {
    case "ok":
      return null;
    case "missing":
      return CLAUDE_MISSING_MESSAGE;
    case "unauthenticated":
      return CLAUDE_SIGN_IN_MESSAGE;
    default:
      return `Claude Code check failed: ${redactPatterns(check.detail || "no output").slice(0, 300)}`;
  }
}

type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: unknown };
};

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

/**
 * What one tool call looks like in the run log. Paths inside the run's
 * workspace (a folder named for the run) are shown relative to it.
 */
function describeToolUse(block: ContentBlock, runId?: string) {
  const input = block.input ?? {};
  const name = block.name ?? "tool";
  if (name === "Bash" && typeof input.command === "string") {
    // The workspace's own path is noise in a log about that workspace.
    const command = runId ? input.command.replace(new RegExp(`[^\\s'"=]*/${runId}(?![\\w-])`, "g"), ".") : input.command;
    return logCommand(command);
  }
  const inWorkspace = runId ? `/${runId}/` : null;
  const filePath =
    typeof input.file_path !== "string"
      ? null
      : inWorkspace && input.file_path.includes(inWorkspace)
        ? input.file_path.slice(input.file_path.indexOf(inWorkspace) + inWorkspace.length)
        : input.file_path;
  if (filePath) {
    const verb = name === "Read" ? "read" : name === "Edit" ? "edit" : name === "Write" ? "write" : name;
    return `${verb} ${filePath}`;
  }
  const first = Object.values(input).find((value) => typeof value === "string") as string | undefined;
  return first ? `${name} ${first.replace(/\s+/g, " ").slice(0, LOG_COMMAND_CHARS)}` : name;
}

/**
 * Turns one stream-json line into run-log lines, and reports the final
 * result when the line is the CLI's closing `result` event.
 */
export function readStreamLine(line: string, runId?: string): {
  log: string[];
  result?: { text: string; isError: boolean };
} {
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return { log: [] };
  }
  if (event.type === "result") {
    return {
      log: [],
      result: { text: typeof event.result === "string" ? event.result : "", isError: Boolean(event.is_error) },
    };
  }
  if (event.type !== "assistant") return { log: [] };
  const blocks = Array.isArray(event.message?.content) ? (event.message.content as ContentBlock[]) : [];
  const log: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      log.push(logText(block.text));
    } else if (block.type === "tool_use") {
      log.push(describeToolUse(block, runId));
    }
  }
  return { log };
}

const SIGN_IN_TEXT = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i;

/**
 * Runs the card with Claude Code in a box workspace: same clone, same
 * collection of changes for a person to approve, with the CLI doing the
 * work in between.
 */
export async function runCardClaudeCode(input: AgentInput): Promise<AgentResult> {
  if (!input.card.repo) throw new Error("Card has no repo");
  const box = requireBoxConfig();
  const repo = input.card.repo;
  const id = input.runId;
  const model = parseModelRef(input.card.model).modelId;
  if (!model) throw new Error("Pick a Claude Code model on the card");

  // Cheap first: no point cloning when the CLI can't run.
  const problem = preflightProblem(await checkClaudeCached(box, { fresh: true }));
  if (problem) throw new Error(problem);
  if (input.isCancelled?.()) throw new RunCancelledError();

  const adopt = input.adopt ?? null;
  if (!adopt) input.log(`Cloning ${repo}@${input.branch} into the box`);
  const created = await createWorkspace(box, {
    id,
    repo,
    ref: input.branch,
    token: input.github.accessToken,
    adopt,
  });
  const previous = input.previous;

  if (created.adopted) {
    input.log("Continuing in the previous run's workspace");
  } else {
    input.log("Workspace ready");
    // The reviewed changes go back on top, unless the branch carries them.
    if (previous && !previous.applied) {
      try {
        for (const write of previous.writes) {
          if (write.deleted) await deleteWorkspaceFile(box, id, write.path);
          else await writeWorkspaceFile(box, id, write.path, write.content);
        }
      } catch (error) {
        await deleteWorkspace(box, id).catch(() => undefined);
        throw error;
      }
      input.log(`Applied ${previous.writes.length} file${previous.writes.length === 1 ? "" : "s"} from the previous run`);
    }
  }

  input.log(`Running Claude Code (${model})`);
  const stop = new AbortController();
  let cancelled = false;
  const poll = setInterval(() => {
    if (input.isCancelled?.()) {
      cancelled = true;
      stop.abort();
    }
  }, CANCEL_POLL_MS);

  // Filled in from the stream's closing event; a holder, since the
  // assignment happens inside the callback.
  const seen: { result: { text: string; isError: boolean } | null } = { result: null };
  let stderr = "";
  let exit: Awaited<ReturnType<typeof runClaudeInWorkspace>> = null;
  try {
    exit = await runClaudeInWorkspace(
      box,
      id,
      {
        model,
        prompt: taskPrompt(input, [previous ? revisionPrompt(previous) : FRESH_START]),
        systemPrompt: CLAUDE_CODE_INSTRUCTIONS,
        timeoutMs: BOX_RUN_TIMEOUT_MS,
      },
      {
        signal: stop.signal,
        onEvent: (event) => {
          if (event.type === "line") {
            const read = readStreamLine(event.line, id);
            for (const line of read.log) input.log(line);
            if (read.result) seen.result = read.result;
          } else if (event.type === "stderr") {
            stderr = (stderr + event.text).slice(-2_000);
          }
        },
      },
    );
  } catch (error) {
    clearInterval(poll);
    await deleteWorkspace(box, id).catch(() => undefined);
    if (cancelled || input.isCancelled?.()) throw new RunCancelledError();
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Claude Code failed: ${redactPatterns(detail).slice(0, 300)}`);
  }
  clearInterval(poll);

  if (cancelled || input.isCancelled?.()) {
    await deleteWorkspace(box, id).catch(() => undefined);
    throw new RunCancelledError();
  }

  const final = seen.result;
  const timedOut = Boolean(exit?.timedOut);
  if (!timedOut && (final?.isError || (!final && exit && exit.code !== 0))) {
    await deleteWorkspace(box, id).catch(() => undefined);
    const text = final?.text.trim() || stderr.trim() || `exit ${exit?.code ?? "?"}`;
    if (SIGN_IN_TEXT.test(text)) throw new Error(CLAUDE_SIGN_IN_MESSAGE);
    throw new Error(`Claude Code failed: ${redactPatterns(text.replace(/\s*\n\s*/g, " ")).slice(0, 300)}`);
  }

  const summary = final && !final.isError ? final.text.trim() || null : null;
  let warning: string | null = null;
  if (timedOut) {
    warning = `The agent ran out of time (${BOX_RUN_TIMEOUT_MS / 60_000} minutes) before saying it was done. ${REVIEW_CAREFULLY}`;
  } else if (!summary) {
    warning = `The agent stopped without saying it was done. ${REVIEW_CAREFULLY}`;
  }

  // Unknown until the box answers; zero means there is nothing to recover.
  let changed: number | null = null;
  try {
    if (summary) input.log(`Finished: ${logText(summary)}`);
    else if (warning) input.log(warning);
    const { files } = await workspaceChanges(box, id);
    changed = files.length;
    const message = (summary ?? input.card.title).split("\n")[0].slice(0, 200);
    const { writes, skipped } = changesToWrites(files, message);
    for (const item of skipped) input.log(`Skipped ${item}`);
    // Left standing for a revision or a shell, like the other runner's.
    return { writes: validateProposedWrites(writes), warning, summary };
  } catch (error) {
    if (changed === 0) {
      await deleteWorkspace(box, id).catch(() => undefined);
      throw error;
    }
    // The agent's work is done and only in the workspace: keep it.
    throw new CollectFailedError(error);
  }
}
