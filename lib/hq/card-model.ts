import { generateText } from "ai";
import { modelFor } from "./agent";
import { boxConfig, runClaudeInWorkspace } from "./box";
import { readStreamLine } from "./claude-code";
import { getConnection } from "./data";
import { ensureFreshConnection } from "./model-auth";
import { isClaudeCodeRef, parseModelRef } from "./models";
import type { Card, Run } from "./types";

/*
 * One question to the card's own model, with no tools: a commit message, a
 * review verdict, a summary. An API connection answers directly; a Claude
 * Code card asks the CLI in the run's workspace, so that has to still exist.
 */

export type CardModelQuestion = {
  instructions: string;
  prompt: string;
  timeoutMs: number;
  /**
   * For a Claude Code card: the CLI answers without its file-writing tools.
   * For a question asked while the builder is still at work in the workspace.
   */
  readOnly?: boolean;
};

/** The model's text, or null when the card's model can't be reached. */
export async function askCardModel(card: Card, run: Run, question: CardModelQuestion): Promise<string | null> {
  return isClaudeCodeRef(card.model) ? askClaudeCode(card, run, question) : askConnection(card, question);
}

async function askConnection(card: Card, question: CardModelQuestion): Promise<string | null> {
  const stored = getConnection(parseModelRef(card.model).connectionId);
  if (!stored) return null;
  const connection = await ensureFreshConnection(stored);
  const { model, providerOptions } = modelFor(connection, card.model);
  // A ChatGPT sign-in carries the box instructions here; swap in ours.
  const options = providerOptions?.openai
    ? { ...providerOptions, openai: { ...providerOptions.openai, instructions: question.instructions } }
    : providerOptions;
  const result = await generateText({
    model,
    providerOptions: options,
    instructions: question.instructions,
    prompt: question.prompt,
    abortSignal: AbortSignal.timeout(question.timeoutMs),
  });
  return result.text;
}

async function askClaudeCode(card: Card, run: Run, question: CardModelQuestion): Promise<string | null> {
  const box = boxConfig();
  if (!box) return null;
  let answer: string | null = null;
  await runClaudeInWorkspace(
    box,
    run.id,
    {
      model: parseModelRef(card.model).modelId,
      prompt: question.prompt,
      systemPrompt: question.instructions,
      timeoutMs: question.timeoutMs,
      ...(question.readOnly ? { readOnly: true } : {}),
    },
    {
      signal: AbortSignal.timeout(question.timeoutMs + 5_000),
      onEvent: (event) => {
        if (event.type !== "line") return;
        const { result } = readStreamLine(event.line);
        if (result && !result.isError) answer = result.text;
      },
    },
  );
  return answer;
}
