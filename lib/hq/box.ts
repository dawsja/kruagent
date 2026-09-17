import { readFileSync } from "node:fs";
import path from "node:path";
import type { ProposedWrite } from "./types";

/*
 * Client for the Kru box (box/server.mjs): the container where an agent
 * clones a repo and runs commands. Configured with KRU_BOX_URL; the token
 * comes from KRU_BOX_TOKEN or the file the box writes into the shared state
 * volume (KRU_BOX_STATE_DIR/token, /box-state in Docker).
 */

export type BoxConfig = { url: string; token: string };

export type ExecResult = {
  exitCode: number;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
};

export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted";
  content?: string;
  diff?: string;
  binary?: boolean;
  tooLarge?: boolean;
  size?: number;
};

/** The box's address without a trailing slash, or null when no box is set up. */
export function boxUrl(): string | null {
  const url = (process.env.KRU_BOX_URL ?? "").trim().replace(/\/+$/, "");
  return url || null;
}

function boxToken(): string {
  const fromEnv = (process.env.KRU_BOX_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const file = path.join(process.env.KRU_BOX_STATE_DIR || "/box-state", "token");
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    /* fall through */
  }
  throw new Error(
    `No box token: set KRU_BOX_TOKEN on Kru and the box, or mount the box's state volume at ${path.dirname(file)}.`,
  );
}

export function boxConfig(): BoxConfig | null {
  const url = boxUrl();
  return url ? { url, token: boxToken() } : null;
}

/** Agents can't run without the box; Kru is the two containers together. */
export function requireBoxConfig(): BoxConfig {
  const config = boxConfig();
  if (!config) {
    throw new Error(
      "Kru needs its box to run agents. Start the box container and set KRU_BOX_URL (docker-compose.yml does both).",
    );
  }
  return config;
}

export class BoxError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BoxError";
    this.status = status;
  }
}

async function call<T>(
  config: BoxConfig,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  return data;
}

/** Longest a single command may run; the box enforces its own cap too. */
export const EXEC_TIMEOUT_MS = 10 * 60 * 1000;

export function createWorkspace(
  config: BoxConfig,
  input: {
    id: string;
    repo: string;
    ref: string;
    token: string;
    /**
     * A finished run's workspace to continue in, under this run's id. Used
     * for a revision: when it is still there the clone, the installed
     * dependencies and the changes being revised are all reused, and
     * `adopted` comes back true. When it is gone the repo is cloned as usual.
     */
    adopt?: string | null;
  },
): Promise<{ id: string; head: string; adopted?: boolean }> {
  return call(config, "POST", "/workspaces", input, 6 * 60 * 1000);
}

export function listWorkspaces(
  config: BoxConfig,
): Promise<{ workspaces: { id: string; at: number }[] }> {
  return call(config, "GET", "/workspaces");
}

export function execInWorkspace(
  config: BoxConfig,
  id: string,
  command: string,
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
  return call(config, "POST", `/workspaces/${id}/exec`, { command, timeoutMs }, timeoutMs + 30_000);
}

export function readWorkspaceFile(
  config: BoxConfig,
  id: string,
  filePath: string,
): Promise<{ content?: string; directory?: string[]; binary?: boolean; size?: number }> {
  return call(config, "GET", `/workspaces/${id}/file?path=${encodeURIComponent(filePath)}`);
}

export function writeWorkspaceFile(
  config: BoxConfig,
  id: string,
  filePath: string,
  content: string,
): Promise<{ ok: true }> {
  return call(config, "PUT", `/workspaces/${id}/file`, { path: filePath, content });
}

export async function deleteWorkspaceFile(config: BoxConfig, id: string, filePath: string): Promise<void> {
  await call(config, "DELETE", `/workspaces/${id}/file?path=${encodeURIComponent(filePath)}`);
}

export function workspaceChanges(config: BoxConfig, id: string): Promise<{ files: ChangedFile[] }> {
  return call(config, "GET", `/workspaces/${id}/changes`, undefined, 5 * 60 * 1000);
}

/**
 * Puts the agent's words on the workspace's watch feed, between the
 * commands and file activity the box sees for itself.
 */
export async function sayInWorkspace(config: BoxConfig, id: string, text: string): Promise<void> {
  await call(config, "POST", `/workspaces/${id}/say`, { text }, 5_000);
}

export async function deleteWorkspace(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/workspaces/${id}`);
}

/**
 * Turns the box's changed files into proposed writes. Binary and oversized
 * files can't be shown for approval or pushed through the contents API, so
 * they're reported through `skipped` and left out.
 */
export function changesToWrites(
  files: ChangedFile[],
  message: string,
): { writes: ProposedWrite[]; skipped: string[] } {
  const writes: ProposedWrite[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const diff = file.diff ? { diff: file.diff } : {};
    if (file.status === "deleted") {
      writes.push({ path: file.path, content: "", message, deleted: true, ...diff });
    } else if (file.binary) {
      skipped.push(`${file.path} (binary)`);
    } else if (file.tooLarge || typeof file.content !== "string") {
      skipped.push(`${file.path} (larger than 1 MB)`);
    } else {
      writes.push({ path: file.path, content: file.content, message, ...diff });
    }
  }
  return { writes, skipped };
}

// ---------- the box itself, for the bots ----------

/**
 * Runs a command on the box outside any workspace, as the agent user, in
 * its home or a folder under it. This is the crew's own shell.
 */
export function execOnBox(
  config: BoxConfig,
  command: string,
  options: { cwd?: string | null; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
  return call(config, "POST", "/exec", { command, cwd: options.cwd ?? null, timeoutMs }, timeoutMs + 30_000);
}

/** A file or folder under the agent's home on the box. */
export function readBoxFile(
  config: BoxConfig,
  filePath: string,
): Promise<{ content?: string; directory?: string[]; binary?: boolean; size?: number }> {
  return call(config, "GET", `/files?path=${encodeURIComponent(filePath)}`);
}

export function writeBoxFile(config: BoxConfig, filePath: string, content: string): Promise<{ ok: true }> {
  return call(config, "PUT", "/files", { path: filePath, content });
}

export async function deleteBoxFile(config: BoxConfig, filePath: string): Promise<void> {
  await call(config, "DELETE", `/files?path=${encodeURIComponent(filePath)}`);
}

// ---------- live streams and terminals ----------

/**
 * Opens one of the box's server-sent event streams and returns the raw
 * response, for a route handler to pass through to the browser. The
 * request's abort signal closes the upstream when the viewer leaves. A
 * `body` makes it a POST, for streams that start something.
 */
export async function openBoxStream(
  config: BoxConfig,
  route: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "text/event-stream",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new BoxError(`The box at ${config.url} isn't reachable (${detail}). Is the box service running?`, 0);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new BoxError(data.error ?? `Box request failed (${res.status})`, res.status);
  }
  return res;
}

export function createTerminal(
  config: BoxConfig,
  input: { workspace?: string | null; cols: number; rows: number },
): Promise<{ id: string; cwd: string }> {
  return call(config, "POST", "/terminals", input);
}

export function terminalInput(config: BoxConfig, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/input`, { data });
}

export function terminalResize(
  config: BoxConfig,
  id: string,
  size: { cols: number; rows: number },
): Promise<{ ok: true }> {
  return call(config, "POST", `/terminals/${id}/resize`, size);
}

export async function closeTerminal(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/terminals/${id}`);
}

// ---------- Claude Code ----------

/**
 * Whether the `claude` CLI in the box can run: installed and signed in.
 * The box answers by running it, never by reading its files.
 */
export type ClaudeCheck = {
  status: "ok" | "missing" | "unauthenticated" | "error";
  detail: string;
};

export function checkClaude(config: BoxConfig): Promise<ClaudeCheck> {
  return call(config, "POST", "/claude/check", {}, 45_000);
}

/** One event from a Claude Code run in the box. */
export type ClaudeRunEvent =
  | { type: "line"; line: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number; signal: string | null; timedOut: boolean; aborted: boolean }
  | { type: "error"; missing: boolean; message: string };

/**
 * Reads server-sent events off a response body: the JSON after each
 * `data:` line, with comments and keepalives skipped.
 */
export async function* readEvents<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let end = pending.indexOf("\n\n");
    while (end !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as T;
      }
      end = pending.indexOf("\n\n");
    }
  }
}

/**
 * Runs Claude Code in a workspace and hands every event to `onEvent` as it
 * arrives, resolving with the exit. Aborting `signal` stops the run in the
 * box, which kills the CLI.
 */
export async function runClaudeInWorkspace(
  config: BoxConfig,
  id: string,
  input: {
    model: string;
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
    /** No file-writing tools; an older box ignores it. */
    readOnly?: boolean;
    maxTurns?: number;
  },
  options: { signal?: AbortSignal; onEvent: (event: ClaudeRunEvent) => void },
): Promise<Extract<ClaudeRunEvent, { type: "exit" }> | null> {
  const res = await openBoxStream(config, `/workspaces/${id}/claude`, options.signal, input);
  if (!res.body) throw new BoxError("The box sent no stream", 502);
  let exit: Extract<ClaudeRunEvent, { type: "exit" }> | null = null;
  for await (const event of readEvents<ClaudeRunEvent>(res.body)) {
    options.onEvent(event);
    if (event.type === "exit") exit = event;
    if (event.type === "error") throw new BoxError(event.message, event.missing ? 424 : 502);
  }
  return exit;
}

// ---------- bots on Claude Code ----------

/** A tool as the CLI's `kru` MCP server lists it. */
export type AgentTool = { name: string; description: string; inputSchema: unknown };

export type AgentTurnInput = {
  model: string;
  effort?: string | null;
  maxTurns?: number | null;
  systemPrompt: string;
  prompt: string;
  /** Images and PDFs sent with the prompt, base64. */
  attachments?: { name: string; mediaType: string; data: string }[];
  tools: AgentTool[];
  timeoutMs: number;
};

export type AgentTurnResult = {
  ok: boolean;
  text: string;
  stopReason: string | null;
  cost: number | null;
  usage: { input: number; output: number; cachedInput: number } | null;
  error?: string;
  sessionId: string | null;
  launched: boolean;
  resumed: boolean;
  recovered: boolean;
};

export type AgentEvent =
  | { type: "init"; sessionId: string | null; permissionMode: string | null }
  | { type: "line"; line: string }
  | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
  | ({ type: "result" } & AgentTurnResult)
  | { type: "error"; missing: boolean; message: string };

/**
 * One turn of a bot's persistent Claude Code session in the box. Tool calls
 * arrive as events and must be answered with `answerAgentTool` while the
 * stream is open; the turn settles with the `result` event.
 */
export async function runAgentTurn(
  config: BoxConfig,
  agentId: string,
  input: AgentTurnInput,
  options: { signal?: AbortSignal; onEvent: (event: AgentEvent) => void },
): Promise<AgentTurnResult | null> {
  const res = await openBoxStream(config, `/agents/${agentId}/turn`, options.signal, input);
  if (!res.body) throw new BoxError("The box sent no stream", 502);
  let result: AgentTurnResult | null = null;
  for await (const event of readEvents<AgentEvent>(res.body)) {
    options.onEvent(event);
    if (event.type === "result") result = event;
    if (event.type === "error") throw new BoxError(event.message, event.missing ? 424 : 502);
  }
  return result;
}

export function answerAgentTool(
  config: BoxConfig,
  agentId: string,
  answer: { callId: string; content: string; isError?: boolean },
): Promise<{ ok: true }> {
  return call(config, "POST", `/agents/${agentId}/tool-result`, answer, 30_000);
}

export async function endAgent(config: BoxConfig, agentId: string): Promise<void> {
  await call(config, "DELETE", `/agents/${agentId}`);
}

/** Who the CLI is signed in as, from `claude auth status`; display fields only. */
export type ClaudeAuth = {
  known: boolean;
  loggedIn: boolean | null;
  email?: string | null;
  org?: string | null;
  method?: string | null;
};

export function claudeAuth(config: BoxConfig): Promise<ClaudeAuth> {
  return call(config, "GET", "/claude/auth", undefined, 20_000);
}

// ---------- desktop ----------

export type DesktopStatus = {
  running: boolean;
  ready: boolean;
  width: number | null;
  height: number | null;
  viewers: number;
};

/** Starts the box desktop if it isn't running and waits until it answers. */
export function startDesktop(
  config: BoxConfig,
  size: { width: number; height: number },
): Promise<DesktopStatus> {
  return call(config, "POST", "/desktop", size, 45_000);
}

export async function stopDesktop(config: BoxConfig): Promise<void> {
  await call(config, "DELETE", "/desktop");
}

/** One viewer's VNC connection to the desktop; stream it, then send input. */
export function connectDesktop(
  config: BoxConfig,
  size: { width: number; height: number },
): Promise<{ id: string; width: number | null; height: number | null }> {
  return call(config, "POST", "/desktop/connections", size, 45_000);
}

export function desktopInput(config: BoxConfig, id: string, data: string): Promise<{ ok: true }> {
  return call(config, "POST", `/desktop/connections/${id}/input`, { data });
}

export async function disconnectDesktop(config: BoxConfig, id: string): Promise<void> {
  await call(config, "DELETE", `/desktop/connections/${id}`);
}
