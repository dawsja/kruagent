import { generateText, stepCountIs, tool } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import {
  changesToWrites,
  createWorkspace,
  deleteWorkspace,
  deleteWorkspaceFile,
  EXEC_TIMEOUT_MS,
  execInWorkspace,
  readWorkspaceFile,
  sayInWorkspace,
  workspaceChanges,
  requireBoxConfig,
  writeWorkspaceFile,
  type BoxConfig,
} from "./box";
import { isOfficialEndpoint } from "./byok";
import { BYOK_DEFAULT_BASE_URL, parseModelRef } from "./models";
import { codexHeaders } from "./openai-oauth";
import { validateProposedWrites } from "./proposed-writes";
import { noRedirectFetch } from "./safe-fetch";
import { codexFetch, xaiOAuthFetch } from "./subscription-fetch";
import { isSubscriptionConnection, type Connection } from "./types";
import {
  BOX_RUN_TIMEOUT_MS,
  CollectFailedError,
  FRESH_START,
  agentNotesSection,
  logCommand,
  logText,
  REVIEW_CAREFULLY,
  RunCancelledError,
  RunStoppedError,
  isTimeout,
  steerStep,
  revisionPrompt,
  taskPrompt,
  type AgentInput,
  type AgentResult,
} from "./agent-shared";

export { RunCancelledError, type AgentInput, type AgentResult } from "./agent-shared";

/** The agent stops itself with `finish`; these are safety limits. */
const MAX_BOX_STEPS = 150;
/** Longest tool result handed back to the model. */
const MAX_TOOL_RESULT = 48_000;

/** Provider-specific request settings, as `generateText` takes them. */
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

/**
 * Builds the language model for a card from its `connectionId:modelId` ref
 * and the matching API endpoint or subscription sign-in. `providerOptions`,
 * when present, must travel with every call on the model.
 */
export function modelFor(
  connection: Connection,
  modelRef: string | null,
): { model: LanguageModel; providerOptions?: ProviderOptions } {
  const ref = parseModelRef(modelRef);
  if (connection.id !== ref.connectionId) {
    throw new Error("This card's model belongs to a different connection");
  }
  switch (connection.provider) {
    case "openai": {
      if (isSubscriptionConnection(connection)) {
        // A ChatGPT sign-in: the Codex backend's Responses API, which wants
        // the account header, nothing stored server-side, the system prompt
        // as `instructions`, and reasoning carried between steps encrypted.
        const openai = createOpenAI({
          apiKey: "subscription",
          baseURL: connection.meta.baseUrl,
          fetch: codexFetch({ connectionId: connection.id, accountHeaders: codexHeaders(connection.meta.accountId) }),
        });
        return {
          model: openai.responses(ref.modelId),
          providerOptions: {
            openai: {
              instructions: BOX_INSTRUCTIONS,
              systemMessageMode: "remove",
              store: false,
              include: ["reasoning.encrypted_content"],
            },
          },
        };
      }
      const baseURL = connection.meta.baseUrl || BYOK_DEFAULT_BASE_URL.openai;
      // No redirects: the API key must never follow one to another server.
      const openai = createOpenAI({ apiKey: connection.accessToken, baseURL, fetch: noRedirectFetch });
      // api.openai.com serves every text model on the Responses API,
      // including Responses-only ones (Codex, -pro). Other OpenAI-compatible
      // servers generally implement only chat completions.
      const model = isOfficialEndpoint("openai", baseURL)
        ? openai.responses(ref.modelId)
        : openai.chat(ref.modelId);
      return { model };
    }
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: connection.accessToken,
        baseURL: connection.meta.baseUrl || BYOK_DEFAULT_BASE_URL.anthropic,
        fetch: noRedirectFetch,
      });
      return { model: anthropic(ref.modelId) };
    }
    case "xai": {
      const xai = createXai({
        apiKey: isSubscriptionConnection(connection) ? "subscription" : connection.accessToken,
        baseURL: connection.meta.baseUrl || BYOK_DEFAULT_BASE_URL.xai,
        // An X sign-in's token expires, so its fetch looks one up per request.
        fetch: isSubscriptionConnection(connection) ? xaiOAuthFetch({ connectionId: connection.id }) : noRedirectFetch,
      });
      // The Responses API (POST /v1/responses) is xAI's agent primitive.
      return { model: xai.responses(ref.modelId) };
    }
    default:
      throw new Error("This connection can't run models");
  }
}

function modelFailure(error: unknown): never {
  if (error instanceof RunCancelledError) throw error;
  const detail = error instanceof Error ? error.message : "unknown error";
  throw new Error(`The model call failed: ${detail.slice(0, 300)}`);
}

function clip(text: string, limit = MAX_TOOL_RESULT) {
  return text.length > limit ? `${text.slice(0, limit)}\n[… ${text.length - limit} more characters]` : text;
}

const BOX_INSTRUCTIONS = [
  "You are a coding agent on a Kanban board, working in a clone of the repo. Your working directory is the repo root, a folder under ~/workspace in your own box, and you have a shell. Stay inside that folder; it's the only place your work is collected from.",
  "Work like an engineer: look around first, make the change, then run the project's own checks (build, lint, tests) and fix what breaks. Install only the dependencies the task needs.",
  "Use write_file and edit_file to change files; use bash for everything else. Do not commit, push, or create branches: Kru collects your working-tree changes and a person reviews them before anything reaches GitHub.",
  "A browser is installed as `google-chrome`, with CHROME_BIN set; it already runs with --no-sandbox because the box blocks Chrome's sandbox. Add --headless=new when there is no display, and don't download another browser to work around a sandbox error.",
  "Before each group of tool calls, say in a sentence or two what you're about to do and why; use Markdown, with `backticks` for paths and commands. Keep it brief: it's shown to the person watching the run.",
  "When the task is done and verified, call finish with a short summary of what changed. Finishing without changing anything accomplishes nothing.",
].join(" ");

/**
 * The tools that work in a run's workspace: a shell, and reading, writing
 * and editing files by path from the repo root. The builder gets all four;
 * the reviewer only the shell and reading.
 */
export function workspaceTools(box: BoxConfig, id: string, log: (line: string) => void) {
  return {
    bash: tool({
      description:
        "Run a shell command in the repo root and get its exit code and output. Long output is trimmed in the middle. Commands time out after 10 minutes.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        log(logCommand(command));
        const result = await execInWorkspace(box, id, command, EXEC_TIMEOUT_MS);
        if (result.timedOut) log(`  timed out after ${EXEC_TIMEOUT_MS / 60_000} minutes`);
        else if (result.exitCode !== 0) log(`  exit ${result.exitCode}`);
        const status = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
        return clip(`${status}\n${result.output}`);
      },
    }),
    read_file: tool({
      description: "Read a file, or list a folder, by path relative to the repo root.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        log(`read ${path}`);
        const file = await readWorkspaceFile(box, id, path);
        if (file.directory) return `directory:\n${file.directory.join("\n")}`;
        if (file.binary) return `binary file, ${file.size} bytes`;
        return clip(file.content ?? "");
      },
    }),
    write_file: tool({
      description: "Create or overwrite a file with the given content. Parent folders are created.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        log(`write ${path}`);
        await writeWorkspaceFile(box, id, path, content);
        return "written";
      },
    }),
    edit_file: tool({
      description:
        "Replace one exact, unique occurrence of old_text in a file with new_text. Fails if old_text is missing or appears more than once.",
      inputSchema: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: async ({ path, old_text, new_text }) => {
        const file = await readWorkspaceFile(box, id, path);
        if (typeof file.content !== "string") return "error: not a text file";
        const first = file.content.indexOf(old_text);
        if (first === -1) return "error: old_text not found";
        if (file.content.indexOf(old_text, first + old_text.length) !== -1) {
          return "error: old_text appears more than once; include more context";
        }
        log(`edit ${path}`);
        const next = file.content.slice(0, first) + new_text + file.content.slice(first + old_text.length);
        await writeWorkspaceFile(box, id, path, next);
        return "edited";
      },
    }),
  };
}

/** The first of AGENTS.md and CLAUDE.md at the repo root, if either exists. */
async function readAgentNotes(box: BoxConfig, id: string): Promise<{ name: string; content: string } | null> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = await readWorkspaceFile(box, id, name).catch(() => null);
    if (typeof file?.content === "string" && file.content.trim()) return { name, content: file.content };
  }
  return null;
}

/**
 * Runs the agent for a card: the repo is cloned into a box workspace where
 * the agent has a shell and works until it says it's done. The result is
 * proposed writes for a person to approve; nothing reaches GitHub here.
 */
export async function runCardAgent(input: AgentInput): Promise<AgentResult> {
  if (!input.card.repo) throw new Error("Card has no repo");
  const box = requireBoxConfig();
  const repo = input.card.repo;
  const id = input.runId;
  const { model, providerOptions } = modelFor(input.model, input.card.model);

  // A revision continues in the reviewed run's own workspace when the box
  // still has it: the clone, its installed dependencies and whatever the
  // build cached are all still there, and so are the changes being revised.
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
    // Cloned fresh, so the reviewed changes have to be put back on top;
    // unless the branch cloned already carries them.
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

  let summary: string | null = null;
  let stepCount = 0;
  let timedOut = false;
  let stopped = false;
  // The repo's own notes for agents; Claude Code finds them itself.
  const agentNotes = agentNotesSection(await readAgentNotes(box, id));
  try {
    const result = await generateText({
      model,
      providerOptions,
      instructions: BOX_INSTRUCTIONS,
      prompt: taskPrompt(input, [agentNotes, previous ? revisionPrompt(previous) : FRESH_START]),
      stopWhen: [stepCountIs(MAX_BOX_STEPS), () => summary !== null],
      abortSignal: AbortSignal.timeout(BOX_RUN_TIMEOUT_MS),
      // Between two steps: where a cancel lands, and a steering note from
      // the room. The override carries forward to every later step.
      prepareStep: ({ messages }) => steerStep(input, messages),
      // What the model says before its tools run, so the log and the watch
      // feed read in order. Reasoning stays out; only its visible words.
      onLanguageModelCallEnd: async ({ content }) => {
        const said = content
          .flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : []))
          .join("\n\n");
        if (!said) return;
        input.log(logText(said));
        // An older box has no feed for words; the run log still has them.
        await sayInWorkspace(box, id, said).catch(() => undefined);
      },
      tools: {
        ...workspaceTools(box, id, input.log),
        finish: tool({
          description: "Call when the task is done and verified. The summary is shown to the reviewer.",
          inputSchema: z.object({ summary: z.string() }),
          execute: async ({ summary: given }) => {
            summary = given.trim() || "Done";
            return "finished";
          },
        }),
      },
    });
    stepCount = result.steps.length;
  } catch (error) {
    if (error instanceof RunStoppedError) {
      // Stopped to be restarted later: what it changed so far is collected.
      stopped = true;
    } else if (!(error instanceof RunCancelledError) && isTimeout(error)) {
      // Out of time: keep whatever the agent got done and flag it for review.
      timedOut = true;
    } else {
      await deleteWorkspace(box, id).catch(() => undefined);
      modelFailure(error);
    }
  }

  let warning: string | null = null;
  if (stopped) {
    // Nobody reviews a stopped run; the card's next run continues it.
  } else if (timedOut) {
    warning = `The agent ran out of time (${BOX_RUN_TIMEOUT_MS / 60_000} minutes) before saying it was done. ${REVIEW_CAREFULLY}`;
  } else if (!summary && stepCount >= MAX_BOX_STEPS) {
    warning = `The agent hit its ${MAX_BOX_STEPS}-step limit before saying it was done. ${REVIEW_CAREFULLY}`;
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
    // The workspace is left standing: a revision continues in it, and a
    // shell can be opened in it while the card waits for review. Whoever
    // owns the run decides when it goes (see `releaseWorkspace`).
    return { writes: validateProposedWrites(writes), warning, summary, ...(stopped ? { stopped } : {}) };
  } catch (error) {
    if (changed === 0) {
      await deleteWorkspace(box, id).catch(() => undefined);
      throw error;
    }
    // The agent's work is done and only in the workspace: keep it.
    throw new CollectFailedError(error);
  }
}
