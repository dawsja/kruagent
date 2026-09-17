/**
 * Persistent Claude Code sessions for the bots. One `claude` process per
 * agent, kept across turns and closed after an idle timeout; a turn is one
 * NDJSON user message on stdin and settles when the CLI prints a `result`.
 *
 * The CLI sees Kru's tools through the `kru` MCP server (kru-mcp.mjs),
 * which forwards each call over a per-agent unix socket to this file, and
 * from here to Kru on the turn's event stream. Kru executes the tool and
 * answers; the CLI never talks to anything but this bridge.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CLAUDE_BIN, writeSystemPrompt } from "./claude.mjs";

/** A session with nothing to do is closed after this long. */
export const IDLE_MS = Math.max(30_000, Number(process.env.BOT_IDLE_MS) || 10 * 60 * 1000);
/** Grace between asking the CLI to exit (stdin EOF) and killing it. */
const EXIT_GRACE_MS = 5_000;
/** Longest stderr kept for error reports. */
const MAX_STDERR = 4_000;
const MAX_LINE = 256 * 1024;
/** The protocol log is rolled over past this size. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Flags that don't exist on older CLIs, with the first version that has
 * them. A flag under its floor is left out with a warning rather than
 * crashing the session; a wrong floor is caught the other way too, since a
 * launch failing on an unknown option relaunches without the optional ones.
 */
export const FLAG_FLOORS = {
  "--input-format": "1.0.0",
  "--strict-mcp-config": "1.0.30",
  "--setting-sources": "1.0.100",
  "--effort": "2.0.30",
  "--max-turns": "1.0.0",
};

/** Optional flags, dropped together on an "unknown option" launch failure. */
const OPTIONAL_FLAGS = ["--strict-mcp-config", "--setting-sources", "--effort"];

/** `[major, minor, patch]` from `claude --version` output, or null. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version, floor) {
  const want = parseVersion(floor);
  if (!version || !want) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] > want[i]) return true;
    if (version[i] < want[i]) return false;
  }
  return true;
}

/** The optional flags this CLI version is known to accept. Unknown version: all of them. */
export function flagsFor(version) {
  const allowed = new Set();
  for (const [flag, floor] of Object.entries(FLAG_FLOORS)) {
    if (!version || atLeast(version, floor)) allowed.add(flag);
  }
  return allowed;
}

let cachedVersion;
/** Runs `claude --version` once per process. */
export function claudeVersion({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const result = spawnSync(bin, ["--version"], { env, uid, gid, encoding: "utf8", timeout: 15_000 });
    cachedVersion = parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/** Credentials the parent may carry; a bot must not inherit them. */
export const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export function stripCredentialEnv(env) {
  const clean = { ...env };
  for (const name of CREDENTIAL_ENV) delete clean[name];
  return clean;
}

/**
 * The argv for a session. Permissions are skipped as for card runs: the
 * container and its unprivileged user are the sandbox, and the bots have
 * the box on purpose. Git pushes and commits are still denied by rule.
 *
 * @param {{
 *   model: string; effort?: string | null; maxTurns?: number;
 *   systemPromptFile: string; mcpConfigFile?: string | null;
 *   sessionId: string; resume: boolean; allowed: Set<string>; optional?: boolean;
 * }} input
 */
export function sessionArgs({ model, effort, maxTurns, systemPromptFile, mcpConfigFile, sessionId, resume, allowed, optional = true }) {
  const has = (flag) => optional && allowed.has(flag);
  const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", model];
  if (effort && has("--effort")) args.push("--effort", effort);
  if (maxTurns && allowed.has("--max-turns")) args.push("--max-turns", String(maxTurns));
  args.push("--dangerously-skip-permissions");
  args.push("--disallowedTools", "Bash(git commit:*)", "Bash(git push:*)");
  args.push("--append-system-prompt-file", systemPromptFile);
  if (mcpConfigFile) {
    args.push("--mcp-config", mcpConfigFile, "--allowedTools", "mcp__kru");
    if (has("--strict-mcp-config")) args.push("--strict-mcp-config");
  }
  if (has("--setting-sources")) args.push("--setting-sources", "project");
  args.push(resume ? "--resume" : "--session-id", sessionId);
  return args;
}

/**
 * Everything that would make a running process the wrong one for a turn.
 * @param {{ model: string; effort?: string | null; maxTurns?: number | null; toolNames: string[] }} input
 */
export function argsKeyFor({ model, effort, maxTurns, toolNames }) {
  return createHash("sha256").update(JSON.stringify({ model, effort: effort ?? null, maxTurns: maxTurns ?? null, toolNames })).digest("hex").slice(0, 16);
}

/** The note prepended when the persona changed under a live session. */
export function systemReminder(text) {
  return `<system-reminder>\nThis part of your instructions changed since this session started. It replaces the earlier copy:\n\n${text}\n</system-reminder>\n\n`;
}

/**
 * Reads a `result` line. Null when it isn't one, or when it is a background
 * task notification, which is not the end of the submitted turn.
 */
export function settle(event) {
  if (!event || event.type !== "result") return null;
  if (event.origin?.kind === "task-notification") return null;
  const usage = event.usage ?? {};
  const cached = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return {
    ok: event.is_error !== true,
    text: typeof event.result === "string" ? event.result : "",
    stopReason: event.stop_reason ?? event.terminal_reason ?? null,
    cost: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
    usage: { input: (usage.input_tokens ?? 0) + cached, output: usage.output_tokens ?? 0, cachedInput: cached },
  };
}

/** A resume the CLI refused before reading the prompt. */
export function isResumeFailure({ resume, sawInit, stderr, exitCode }) {
  if (!resume || sawInit || exitCode === 0) return false;
  return /no conversation found|session.*(not found|does not exist|invalid)|could not resume|resume/i.test(stderr ?? "");
}

/** A launch that died on an argument this CLI doesn't know. */
export function isUnknownOption(stderr) {
  return /unknown option|unrecognized option|unknown argument|too many arguments/i.test(stderr ?? "");
}

/**
 * The user message the CLI reads: text only, or with images and PDFs as
 * content blocks ahead of it. Anything else is left out.
 */
export function userMessage(prompt, images = []) {
  const blocks = images.flatMap((file) => {
    if (!file || typeof file.data !== "string" || typeof file.mediaType !== "string") return [];
    const source = { type: "base64", media_type: file.mediaType, data: file.data };
    if (file.mediaType === "application/pdf") {
      return [{ type: "document", source, ...(typeof file.name === "string" ? { title: file.name } : {}) }];
    }
    return file.mediaType.startsWith("image/") ? [{ type: "image", source }] : [];
  });
  if (!blocks.length) return { type: "user", message: { role: "user", content: prompt } };
  return { type: "user", message: { role: "user", content: [...blocks, { type: "text", text: prompt }] } };
}

/** A user message for the protocol log, with file contents left out. */
export function loggable(message) {
  const content = message.message.content;
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: content.map((block) =>
        block.source?.data ? { ...block, source: { ...block.source, data: `[${block.source.data.length} base64 characters]` } } : block,
      ),
    },
  };
}

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

/** Appends one line to the per-agent protocol log, rolling it over when big. */
function protocolLogger(dir, id) {
  if (!dir) return () => undefined;
  const file = path.join(dir, `${id}.ndjson`);
  return (direction, payload) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`, { mode: 0o600 });
    } catch {
      /* logging never breaks a turn */
    }
  };
}

/**
 * One agent: its process, session cursor, bridge socket, and the turn in
 * flight. Owned by the box server; Kru drives it over HTTP.
 */
export class AgentSession {
  /**
   * @param {{
   *   id: string; cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number;
   *   bin?: string; socketDir: string; mcpScript: string; logDir?: string | null;
   *   onWarning?: (text: string) => void;
   * }} options
   */
  constructor(options) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.env = stripCredentialEnv(options.env);
    this.uid = options.uid;
    this.gid = options.gid;
    this.bin = options.bin ?? CLAUDE_BIN;
    this.socketDir = options.socketDir;
    this.mcpScript = options.mcpScript;
    this.log = protocolLogger(options.logDir, options.id);
    this.onWarning = options.onWarning ?? (() => undefined);
    this.child = null;
    this.sessionId = null;
    this.argsKey = null;
    this.systemPromptHash = null;
    this.turn = null;
    this.idleTimer = null;
    this.bridge = null;
    this.tools = [];
    this.cleanups = [];
    this.stderr = "";
    this.sawInit = false;
    this.pendingCalls = new Map();
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** Opens the unix socket the MCP proxy connects to. One per agent. */
  async listen() {
    if (this.bridge) return this.bridge.path;
    fs.mkdirSync(this.socketDir, { recursive: true, mode: 0o755 });
    const socketPath = path.join(this.socketDir, `${this.id}.sock`);
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          if (line.trim()) void this.onBridgeMessage(socket, line);
        }
      });
      socket.on("error", () => undefined);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    if (this.uid !== undefined) fs.chownSync(socketPath, this.uid, this.gid);
    fs.chmodSync(socketPath, 0o600);
    this.bridge = { server, path: socketPath };
    return socketPath;
  }

  async onBridgeMessage(socket, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.log("mcp", message);
    const answer = (result, error) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(error ? { id: message.id, error } : { id: message.id, result })}\n`);
    };
    if (message.method === "tools/list") {
      answer({ tools: this.tools });
      return;
    }
    if (message.method === "tools/call") {
      if (!this.turn) {
        answer(null, "No turn in flight");
        return;
      }
      const callId = randomUUID();
      this.pendingCalls.set(callId, answer);
      this.turn.onEvent({ type: "tool_call", callId, name: message.params?.name, input: message.params?.arguments ?? {} });
      return;
    }
    answer(null, `Unknown method ${message.method}`);
  }

  /** Kru's answer to a tool call the CLI made. */
  answerTool(callId, { content, isError = false }) {
    const answer = this.pendingCalls.get(callId);
    if (!answer) return false;
    this.pendingCalls.delete(callId);
    answer({ content, isError });
    return true;
  }

  /** Writes the MCP config the CLI reads; owner-only, gone when the turn settles. */
  writeMcpConfig(socketPath) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kru-mcp-"));
    const file = path.join(dir, "mcp.json");
    const config = { mcpServers: { kru: { command: process.execPath, args: [this.mcpScript, socketPath] } } };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    if (this.uid !== undefined) {
      fs.chownSync(dir, this.uid, this.gid);
      fs.chownSync(file, this.uid, this.gid);
    }
    return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * Makes sure a process for these settings is running: reuses the live one
   * when the args match, otherwise closes it and launches afresh (resuming
   * the saved session where there is one).
   */
  async ensure({ model, effort, maxTurns, systemPrompt, tools }) {
    const toolNames = tools.map((tool) => tool.name).sort();
    const argsKey = argsKeyFor({ model, effort, maxTurns, toolNames });
    this.tools = tools;
    if (this.running && this.argsKey === argsKey) return { launched: false };
    if (this.running) await this.close({ keepSession: true });

    const version = claudeVersion({ bin: this.bin, env: this.env, uid: this.uid, gid: this.gid });
    const allowed = flagsFor(version);
    for (const flag of Object.keys(FLAG_FLOORS)) {
      if (!allowed.has(flag)) this.onWarning(`Claude Code ${version?.join(".") ?? "?"} predates ${flag}; bots run without it.`);
    }
    const socketPath = await this.listen();
    const persona = writeSystemPrompt(systemPrompt, { uid: this.uid, gid: this.gid });
    const mcp = this.writeMcpConfig(socketPath);
    this.cleanups = [persona.cleanup, mcp.cleanup];
    this.systemPromptHash = createHash("sha256").update(systemPrompt).digest("hex");

    const resume = Boolean(this.sessionId);
    const sessionId = this.sessionId ?? randomUUID();
    const launch = (optional) =>
      this.spawn(
        sessionArgs({ model, effort, maxTurns, systemPromptFile: persona.file, mcpConfigFile: mcp.file, sessionId, resume, allowed, optional }),
        { resume },
      );
    let outcome = await launch(true);
    if (outcome.failed && isUnknownOption(outcome.stderr)) {
      this.onWarning(`Claude Code rejected an optional flag (${outcome.stderr.trim().slice(0, 120)}); relaunching without ${OPTIONAL_FLAGS.join(", ")}.`);
      outcome = await launch(false);
    }
    if (outcome.failed) throw new Error(`Claude Code didn't start: ${outcome.stderr.trim().slice(0, 300) || "no output"}`);
    this.argsKey = argsKey;
    this.sessionId = sessionId;
    return { launched: true, resumed: resume };
  }

  /**
   * Starts the process and waits briefly for it to stay up. A CLI that
   * exits at once (bad flag, refused resume, not signed in) is reported
   * with its stderr instead of being handed a prompt.
   */
  spawn(args, { resume }) {
    this.stderr = "";
    this.sawInit = false;
    this.resume = resume;
    this.log("spawn", { args });
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: this.env,
      ...(this.uid !== undefined ? { uid: this.uid, gid: this.gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let pending = "";
    // utf8 before buffering, or a multibyte character split across reads
    // comes out as garbage.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) this.onLine(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR);
      this.log("stderr", chunk);
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.log("exit", { code, signal, resume: this.resume, sawInit: this.sawInit });
      const turn = this.turn;
      this.child = null;
      if (turn) {
        this.turn = null;
        turn.finish({
          ok: false,
          text: "",
          stopReason: turn.interrupted ? "interrupted" : "exited",
          cost: null,
          usage: null,
          error: turn.interrupted ? "The turn was interrupted" : this.stderr.trim().slice(0, 500) || `Claude Code exited (${signal ?? code})`,
          resumeFailed: isResumeFailure({ resume: this.resume, sawInit: this.sawInit, stderr: this.stderr, exitCode: code }),
        });
      }
      this.cleanup();
    });
    return new Promise((resolve) => {
      const settleLaunch = (failed) => resolve({ failed, stderr: this.stderr });
      child.once("error", (error) => {
        this.stderr = error.message;
        this.child = null;
        settleLaunch(true);
      });
      child.once("close", () => settleLaunch(true));
      // No exit within a moment means the CLI is up and waiting on stdin.
      setTimeout(() => {
        if (this.child === child && child.exitCode === null) settleLaunch(false);
      }, 1_500);
    });
  }

  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.log("out", event);
    if (event.type === "system" && event.subtype === "init") {
      this.sawInit = true;
      // The CLI may hand back a different cursor than it was given.
      if (typeof event.session_id === "string") this.sessionId = event.session_id;
      this.turn?.onEvent({ type: "init", sessionId: this.sessionId, permissionMode: event.permissionMode ?? null });
      return;
    }
    if (!this.turn) return;
    // Subagent narration interleaves into the same stream; not this turn's words.
    if (event.parent_tool_use_id) return;
    const result = settle(event);
    if (result) {
      const turn = this.turn;
      this.turn = null;
      turn.finish(result);
      return;
    }
    this.turn.onEvent({ type: "line", line });
  }

  /**
   * Runs one turn: writes the prompt, streams events to `onEvent`, resolves
   * with the settled result. Rejects when a turn is already in flight.
   */
  turnWith({ prompt, images, timeoutMs, onEvent, systemPrompt, signal }) {
    if (this.turn) return Promise.reject(new Error("A turn is already in flight"));
    if (!this.running) return Promise.reject(new Error("No session"));
    this.clearIdle();
    let text = prompt;
    const hash = createHash("sha256").update(systemPrompt).digest("hex");
    if (hash !== this.systemPromptHash) {
      // The process launched with the old persona; say what changed instead of relaunching.
      text = systemReminder(systemPrompt) + prompt;
      this.systemPromptHash = hash;
    }
    return new Promise((resolve) => {
      const turn = {
        onEvent,
        interrupted: false,
        finish: (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", interrupt);
          this.pendingCalls.clear();
          if (this.running) this.armIdle();
          resolve(result);
        },
      };
      const interrupt = () => {
        if (this.turn !== turn) return;
        turn.interrupted = true;
        this.kill();
      };
      const timer = setTimeout(interrupt, timeoutMs);
      if (signal?.aborted) {
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "interrupted", cost: null, usage: null, error: "Aborted before the turn started" });
        return;
      }
      signal?.addEventListener("abort", interrupt, { once: true });
      this.turn = turn;
      const message = userMessage(text, images);
      this.log("in", loggable(message));
      const stdin = this.child.stdin;
      if (!stdin.writable || stdin.destroyed) {
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", cost: null, usage: null, error: "The CLI's stdin is closed" });
        void this.close();
        return;
      }
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error || this.turn !== turn) return;
        this.turn = null;
        clearTimeout(timer);
        resolve({ ok: false, text: "", stopReason: "stdin_write_failed", cost: null, usage: null, error: error.message });
        void this.close();
      });
    });
  }

  armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => void this.close({ keepSession: true }), IDLE_MS);
    this.idleTimer.unref?.();
  }

  clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  kill() {
    const child = this.child;
    if (!child) return;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), EXIT_GRACE_MS).unref?.();
  }

  cleanup() {
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    this.cleanups = [];
  }

  /** Ends the process: EOF first, then the signal. The session cursor stays unless told otherwise. */
  async close({ keepSession = true } = {}) {
    this.clearIdle();
    const child = this.child;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* closed */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          killTree(child, "SIGKILL");
          resolve();
        }, EXIT_GRACE_MS);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        killTree(child, "SIGTERM");
      });
    }
    this.child = null;
    this.cleanup();
    if (!keepSession) this.sessionId = null;
    // The bridge closes after the child, so a replacement session binding
    // the same path isn't unlinked by the dying one.
    if (this.bridge) {
      const { server, path: socketPath } = this.bridge;
      this.bridge = null;
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    }
  }
}

/**
 * Whether the CLI is signed in, from `claude auth status --json`. Only the
 * display identity is returned, never the CLI's whole answer.
 */
export function authStatus({ bin = CLAUDE_BIN, env, uid, gid } = {}) {
  try {
    const result = spawnSync(bin, ["auth", "status", "--json"], { env, uid, gid, encoding: "utf8", timeout: 10_000 });
    const text = `${result.stdout ?? ""}`.trim();
    const start = text.indexOf("{");
    if (start === -1) return { known: false, loggedIn: null };
    const data = JSON.parse(text.slice(start));
    const loggedIn = data.loggedIn ?? data.logged_in ?? data.isLoggedIn ?? null;
    return {
      known: typeof loggedIn === "boolean",
      loggedIn: typeof loggedIn === "boolean" ? loggedIn : null,
      email: typeof data.email === "string" ? data.email : (data.account?.email ?? null),
      org: typeof data.orgName === "string" ? data.orgName : (data.organization?.name ?? data.org ?? null),
      method: typeof data.method === "string" ? data.method : (data.authMethod ?? null),
    };
  } catch {
    return { known: false, loggedIn: null };
  }
}
