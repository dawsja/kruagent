import type { Tool } from "ai";
import { z } from "zod";
import { answerAgentTool, runAgentTurn, type AgentTool, type BoxConfig } from "../box.ts";
import { readStreamLine } from "../claude-code.ts";

/*
 * The bots' Claude Code engine. Kru is the harness: it owns the tools, the
 * depth limits and the room; the box keeps one `claude` process per bot and
 * relays its tool calls here over the turn's event stream. The CLI only
 * ever sees text in, text out, and the `kru` MCP bridge.
 */

/** The bots' tools are AI SDK tools; the driver reads their schema and runs `execute`. */
export type DriverTool = Tool;

/** JSON Schema for a tool's input: zod is converted, anything else passed through. */
export function toolInputSchema(schema: unknown): unknown {
  if (schema && typeof schema === "object") {
    if ("_zod" in schema) return z.toJSONSchema(schema as z.ZodType);
    if ("jsonSchema" in schema) return (schema as { jsonSchema: unknown }).jsonSchema;
  }
  return schema ?? { type: "object", properties: {} };
}

/** The tool list the CLI's `kru` MCP server advertises. */
export function agentToolsFor(tools: Record<string, DriverTool>): AgentTool[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: typeof tool.description === "string" ? tool.description : name,
    inputSchema: toolInputSchema(tool.inputSchema),
  }));
}

/** Longest tool answer relayed back; the CLI re-reads it on every later call. */
const MAX_TOOL_RESULT = 24_000;

function clip(text: string) {
  return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n[… ${text.length - MAX_TOOL_RESULT} more characters]` : text;
}

export type ClaudeTurn = {
  box: BoxConfig;
  /** Names the process in the box: one per bot, kept across turns. */
  agentId: string;
  modelId: string;
  effort?: string | null;
  maxTurns?: number;
  instructions: string;
  prompt: string;
  /** Images and PDFs for the CLI to read with the prompt, base64. */
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: Record<string, DriverTool>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The CLI's own words and tool uses as they stream, for a log. */
  onLog?: (line: string) => void;
};

export type ClaudeTurnResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  error: string | null;
  recovered: boolean;
  usage: { input: number; output: number; cachedInput: number } | null;
};

/**
 * Runs one turn and executes every tool call the CLI makes along the way.
 * Calls run as they arrive, so the CLI's parallel tool use isn't serialised
 * here; each answer goes back through the box by call id.
 */
export async function claudeCodeTurn(turn: ClaudeTurn): Promise<ClaudeTurnResult> {
  const inflight: Promise<void>[] = [];
  const handleCall = async (callId: string, name: string, input: Record<string, unknown>) => {
    const tool = turn.tools[name];
    let content: string;
    let isError = false;
    try {
      if (!tool?.execute) throw new Error(`No such tool: ${name}`);
      const value = await tool.execute(input as never, { toolCallId: callId, messages: [] } as never);
      content = typeof value === "string" ? value : JSON.stringify(value ?? "");
    } catch (error) {
      content = error instanceof Error ? error.message : "Tool failed";
      isError = true;
    }
    await answerAgentTool(turn.box, turn.agentId, { callId, content: clip(content), isError }).catch(() => undefined);
  };

  const result = await runAgentTurn(
    turn.box,
    turn.agentId,
    {
      model: turn.modelId,
      effort: turn.effort ?? null,
      maxTurns: turn.maxTurns ?? null,
      systemPrompt: turn.instructions,
      prompt: turn.prompt,
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      tools: agentToolsFor(turn.tools),
      timeoutMs: turn.timeoutMs,
    },
    {
      signal: turn.signal,
      onEvent: (event) => {
        if (event.type === "tool_call") {
          turn.onLog?.(`${event.name} ${JSON.stringify(event.input).slice(0, 200)}`);
          inflight.push(handleCall(event.callId, event.name, event.input));
        } else if (event.type === "line" && turn.onLog) {
          for (const line of readStreamLine(event.line).log) turn.onLog(line);
        }
      },
    },
  );
  await Promise.allSettled(inflight);
  if (!result) return { ok: false, text: "", stopReason: "no_result", error: "The box closed the stream without a result", recovered: false, usage: null };
  return {
    ok: result.ok,
    text: result.text,
    stopReason: result.stopReason,
    error: result.error ?? null,
    recovered: result.recovered,
    usage: result.usage,
  };
}
