import { generateText, stepCountIs } from "ai";
import { modelFor, workspaceTools } from "../agent";
import {
  BoxError,
  boxConfig,
  deleteWorkspaceFile,
  execInWorkspace,
  readWorkspaceFile,
  runClaudeInWorkspace,
  workspaceChanges,
  writeWorkspaceFile,
  type BoxConfig,
} from "../box";
import { askCardModel } from "../card-model";
import { readStreamLine } from "../claude-code";
import { appendRunLog, getConnection } from "../data";
import { ensureFreshConnection } from "../model-auth";
import { isClaudeCodeRef, parseModelRef } from "../models";
import type { Card, Run } from "../types";

/*
 * Lulu's review with her hands on the workspace: she can open files around
 * the change, grep, and run the one test that covers it, instead of judging
 * a diff from memory. Her tools are for looking; if the tree moves anyway
 * (a test that writes a fixture, a stray format), Kru puts it back exactly
 * as the builder left it before anyone else sees it. When the workspace is
 * gone, the review is the single question it always was.
 */

/** Tool steps one review may take; Kiko already ran the full checks. */
export const REVIEW_STEPS = 12;
/** Longest one review may take, tools and all. */
const REVIEW_TIMEOUT_MS = 8 * 60 * 1000;

export type ReviewQuestion = { instructions: string; prompt: string; toolRules: string };

/** What the tree looks like, as a comparable string: every changed path with its diff. */
async function fingerprint(box: BoxConfig, runId: string): Promise<string> {
  const { files } = await workspaceChanges(box, runId);
  return JSON.stringify(
    files
      .map((file) => [file.path, file.status, file.diff ?? file.content ?? (file.binary ? "binary" : "")])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * Puts the workspace back to the builder's result: the clone as cloned,
 * then every proposed write. Ignored files (build output, caches) stay.
 */
async function restore(box: BoxConfig, run: Run) {
  const reset = await execInWorkspace(box, run.id, "git checkout -- . && git clean -fd", 60_000);
  if (reset.exitCode !== 0) throw new Error(`Couldn't reset the workspace after review: ${reset.output.slice(-300)}`);
  for (const write of run.proposedWrites) {
    if (write.deleted) await deleteWorkspaceFile(box, run.id, write.path);
    else await writeWorkspaceFile(box, run.id, write.path, write.content);
  }
}

async function workspaceExists(box: BoxConfig, runId: string) {
  try {
    await readWorkspaceFile(box, runId, ".");
    return true;
  } catch (error) {
    if (error instanceof BoxError && error.status === 404) return false;
    throw error;
  }
}

async function withTools(card: Card, run: Run, question: ReviewQuestion, box: BoxConfig): Promise<string | null> {
  const instructions = `${question.instructions}\n\n${question.toolRules}`;
  const log = (line: string) => {
    appendRunLog(run.id, `Lulu: ${line}`);
  };

  if (isClaudeCodeRef(card.model)) {
    let answer: string | null = null;
    await runClaudeInWorkspace(
      box,
      run.id,
      {
        model: parseModelRef(card.model).modelId,
        prompt: question.prompt,
        systemPrompt: instructions,
        timeoutMs: REVIEW_TIMEOUT_MS,
        readOnly: true,
        maxTurns: REVIEW_STEPS,
      },
      {
        signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS + 5_000),
        onEvent: (event) => {
          if (event.type !== "line") return;
          const read = readStreamLine(event.line, run.id);
          // Commands she ran, not her prose: that is the verdict, logged apart.
          for (const line of read.log) if (/^(\$ |read |Grep |Glob |LS )/.test(line)) log(line);
          if (read.result && !read.result.isError) answer = read.result.text;
        },
      },
    );
    return answer;
  }

  const stored = getConnection(parseModelRef(card.model).connectionId);
  if (!stored) return null;
  const connection = await ensureFreshConnection(stored);
  const { model, providerOptions } = modelFor(connection, card.model);
  const { bash, read_file } = workspaceTools(box, run.id, log);
  // A ChatGPT sign-in carries the box instructions here; swap in Lulu's.
  const options = providerOptions?.openai
    ? { ...providerOptions, openai: { ...providerOptions.openai, instructions } }
    : providerOptions;
  const result = await generateText({
    model,
    providerOptions: options,
    instructions,
    prompt: question.prompt,
    tools: { bash, read_file },
    stopWhen: stepCountIs(REVIEW_STEPS),
    abortSignal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
  });
  return result.text;
}

/**
 * Lulu's verdict text for a run. With the workspace still in the box she
 * reviews with a shell and file reads; without it, from the diff alone.
 */
export async function reviewRun(card: Card, run: Run, question: ReviewQuestion): Promise<string | null> {
  const box = boxConfig();
  const fallback = () =>
    askCardModel(card, run, { instructions: question.instructions, prompt: question.prompt, timeoutMs: 3 * 60 * 1000 });
  if (!box || !(await workspaceExists(box, run.id))) return fallback();

  const before = await fingerprint(box, run.id);
  let text: string | null;
  try {
    text = await withTools(card, run, question, box);
  } finally {
    // Whatever happened in there, the person reviews what the builder made.
    const after = await fingerprint(box, run.id).catch(() => null);
    if (after !== before) {
      appendRunLog(run.id, "Lulu's review changed the workspace; putting it back as the builder left it");
      await restore(box, run);
    }
  }
  return text;
}
