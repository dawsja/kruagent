/**
 * The Kru box: a small HTTP server that gives an agent a real workspace.
 * Each run gets a clone of its repo under WORK_DIR (the agent user's
 * ~/workspace), where Kru can run shell commands, read and write files, and
 * collect the working-tree changes to show for approval. Everything the
 * agent runs happens as the unprivileged `agent` user; this server runs as
 * root only so it can drop to that user.
 *
 * Two live streams, both server-sent events: every workspace has a watch
 * feed of what the agent is doing, and people can open interactive
 * terminals (PTYs, via node-pty) in the box. There's also a desktop: a
 * GNOME session on a VNC server bound to loopback, bridged to the browser
 * the same way (VNC bytes out over server-sent events, input back as POSTs).
 *
 * Cards on the Claude Code engine run the `claude` CLI here too (see
 * claude.mjs): one process per run, its output streamed back to Kru.
 *
 * Kru authenticates with a bearer token that is read from BOX_TOKEN or
 * generated once into STATE_DIR/token.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import {
  MODEL_ID as CLAUDE_MODEL_ID,
  checkClaude,
  claudeArgs,
  spawnClaude,
  writeSystemPrompt,
} from "./claude.mjs";
import { AgentSession, authStatus } from "./agents.mjs";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const STATE_DIR = process.env.STATE_DIR || "/state";
/** The user commands run as; workspaces belong to it. */
const AGENT_UID = Number(process.env.AGENT_UID || 1001);
const AGENT_GID = Number(process.env.AGENT_GID || 1001);
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
/** Where runs are cloned: the agent's own ~/workspace. */
const WORK_DIR = process.env.WORK_DIR || path.join(AGENT_HOME, "workspace");
/**
 * Package caches, kept on a volume so installs in a fresh clone come from
 * disk instead of the network. Every package manager is pointed here.
 */
const CACHE_DIR = process.env.CACHE_DIR || path.join(AGENT_HOME, ".cache");
/**
 * Where the Claude Code CLI keeps its login and settings, on a volume so a
 * sign-in survives restarts. The box never reads what's in it.
 */
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(AGENT_HOME, ".claude");
/**
 * Where the bots keep their own notes and scripts between cards. Unlike the
 * workspaces it survives a restart of the box.
 */
const BOTS_DIR = process.env.BOTS_DIR || path.join(AGENT_HOME, "bots");
/** Unix sockets the bots' MCP bridge connects to, one per agent. */
const AGENT_SOCKET_DIR = process.env.AGENT_SOCKET_DIR || "/tmp/kru-agents";
/** The bridge script Claude Code launches as the `kru` MCP server. */
const KRU_MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "kru-mcp.mjs");
/** Longest one bot turn may take before it is interrupted. */
const MAX_AGENT_TURN_MS = 30 * 60 * 1000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Group that may read the generated token file: Kru's uid 1000 `node` user. */
const TOKEN_READER_GID = Number(process.env.TOKEN_READER_GID || 1000);

export const MAX_OUTPUT = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** A bot's turn may carry the files attached in the Team room. */
const MAX_TURN_BODY_BYTES = 16 * 1024 * 1024;
/** Longest per-file diff sent for review; the full file still travels. */
const MAX_DIFF_CHARS = 200_000;
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1000;
/** Longest one Claude Code run may take; Kru asks for its own, shorter limit. */
const MAX_CLAUDE_TIMEOUT_MS = 60 * 60 * 1000;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
/** Scrollback replayed to a viewer who joins a stream late. */
const FEED_BYTES = 256 * 1024;
const MAX_TERMINALS = 8;
/** A terminal nobody is looking at is closed after this long. */
const TERMINAL_IDLE_MS = 30 * 60 * 1000;
const SSE_KEEPALIVE_MS = 15_000;

/** The X display and loopback VNC port the desktop runs on. */
const DESKTOP_DISPLAY = Number(process.env.DESKTOP_DISPLAY || 1);
const DESKTOP_VNC_PORT = Number(process.env.DESKTOP_VNC_PORT || 5901);
const DESKTOP_SCRIPT = process.env.DESKTOP_SCRIPT || path.join(path.dirname(new URL(import.meta.url).pathname), "desktop.sh");
/** Per-user runtime dir for the session bus, dconf and friends. */
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR_AGENT || path.join(AGENT_HOME, ".run");
const MAX_DESKTOP_CONNECTIONS = 4;
/** How long the desktop gets to come up before a connection is refused. */
const DESKTOP_START_MS = 30_000;
/** A desktop nobody is looking at is stopped after this long. */
const DESKTOP_IDLE_MS = 2 * 60 * 60 * 1000;
/** A connection opened but never streamed is dropped after this long. */
const CONNECTION_CLAIM_MS = 30_000;

/** Never proposed even when a repo forgets to ignore them. */
const ALWAYS_EXCLUDED = ["node_modules/", ".next/", "__pycache__/", ".venv/", ".DS_Store"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- live feeds ----------

/**
 * An append-only event log with subscribers: recent events are replayed to
 * whoever joins, then new ones are pushed as they happen. Backs both the
 * per-workspace watch stream and terminal output.
 */
export class Feed {
  constructor(limit = FEED_BYTES) {
    this.limit = limit;
    this.lines = [];
    this.size = 0;
    this.subscribers = new Set();
    this.closed = false;
  }

  publish(event) {
    const line = JSON.stringify(event);
    this.lines.push(line);
    this.size += line.length;
    while (this.size > this.limit && this.lines.length > 1) {
      this.size -= this.lines.shift().length;
    }
    for (const send of this.subscribers) send(line);
  }

  /** Replays history to `send`, then keeps sending. Returns an unsubscribe. */
  subscribe(send) {
    for (const line of this.lines) send(line);
    if (this.closed) {
      send(JSON.stringify({ type: "end" }));
      return () => undefined;
    }
    this.subscribers.add(send);
    return () => this.subscribers.delete(send);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.publish({ type: "end" });
    this.subscribers.clear();
  }
}

/** Longest message from the agent put on a watch feed. */
const MAX_SAY_CHARS = 20_000;

/** Watch feeds by workspace id; created with the workspace, closed with it. */
const watchFeeds = new Map();

function watch(id) {
  return watchFeeds.get(id);
}

function streamFeed(request, response, feed) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const send = (line) => response.write(`data: ${line}\n\n`);
  const unsubscribe = feed.subscribe(send);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = () => {
    clearInterval(keepalive);
    unsubscribe();
    response.end();
  };
  request.on("close", stop);
  if (feed.closed) stop();
  return stop;
}

// ---------- paths ----------

export function workspaceDir(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError(400, "Bad workspace id");
  return path.join(WORK_DIR, id);
}

/**
 * Resolves a repo-relative path inside a workspace, or throws. Anything
 * climbing out of the workspace or touching .git is refused.
 */
export function insideWorkspace(root, relative) {
  if (typeof relative !== "string" || !relative.trim()) throw new HttpError(400, "Missing path");
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new HttpError(400, "Path is outside the workspace");
  }
  const parts = path.relative(root, full).split(path.sep);
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    throw new HttpError(400, "Path is inside .git");
  }
  return full;
}

/**
 * Resolves a path inside the agent's home, for the bots' own use of the
 * box: anywhere under home except the Claude Code login, and never .git.
 */
export function insideHome(relative, home = AGENT_HOME, forbidden = CLAUDE_CONFIG_DIR) {
  const full = insideWorkspace(home, relative);
  if (full === forbidden || full.startsWith(forbidden + path.sep)) {
    throw new HttpError(400, "Path is inside the Claude Code login");
  }
  return full;
}

/**
 * The working directory for a command on the box outside any workspace:
 * the agent's home, or a folder under it. Absolute paths must stay inside.
 */
export function boxCwd(given, home = AGENT_HOME, forbidden = CLAUDE_CONFIG_DIR) {
  if (given === undefined || given === null || given === "") return home;
  if (typeof given !== "string") throw new HttpError(400, "cwd must be a string");
  const relative = path.isAbsolute(given) ? path.relative(home, given) || "." : given;
  if (relative.startsWith("..")) throw new HttpError(400, "cwd is outside the agent's home");
  const full = insideHome(relative, home, forbidden);
  return full;
}

// ---------- processes ----------

function agentEnv(extra = {}) {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: AGENT_HOME,
    USER: "agent",
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    XDG_CACHE_HOME: CACHE_DIR,
    BUN_INSTALL_CACHE_DIR: path.join(CACHE_DIR, "bun"),
    npm_config_cache: path.join(CACHE_DIR, "npm"),
    npm_config_store_dir: path.join(CACHE_DIR, "pnpm"),
    YARN_CACHE_FOLDER: path.join(CACHE_DIR, "yarn"),
    PIP_CACHE_DIR: path.join(CACHE_DIR, "pip"),
    UV_CACHE_DIR: path.join(CACHE_DIR, "uv"),
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    // Shared by runs, terminals and the desktop, so one sign-in serves all.
    CLAUDE_CONFIG_DIR,
    ...extra,
  };
}

/** Keeps the start and end of long output, which is where errors usually are. */
export function capOutput(text, limit = MAX_OUTPUT) {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit / 4);
  const tail = limit - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

/**
 * Runs a command as the agent user in `cwd`, in its own process group so a
 * timeout kills everything it started. Resolves with the exit code and the
 * combined, capped output.
 */
export function runAsAgent(argv, { cwd, timeoutMs, env, onChunk }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: agentEnv(env),
      uid: AGENT_UID,
      gid: AGENT_GID,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    const collect = (chunk) => {
      // Keep collecting past the cap; capOutput trims the middle later.
      if (size < MAX_OUTPUT * 4) chunks.push(chunk);
      size += chunk.length;
      onChunk?.(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const { text, truncated } = capOutput(Buffer.concat(chunks).toString("utf8"));
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        signal: signal ?? null,
        output: text,
        truncated,
        timedOut,
      });
    });
  });
}

async function git(cwd, args, env) {
  const result = await runAsAgent(["git", ...args], { cwd, timeoutMs: CLONE_TIMEOUT_MS, env });
  if (result.exitCode !== 0) {
    throw new HttpError(502, `git ${args[0]} failed: ${result.output.trim().slice(-500)}`);
  }
  return result.output;
}

// ---------- workspaces ----------

/**
 * Lists the workspaces on disk, newest first. Kru decides which ones are
 * worth keeping; the box only says what is there and how old it is.
 */
function listWorkspaces() {
  const workspaces = [];
  for (const entry of fs.readdirSync(WORK_DIR)) {
    let stat;
    try {
      stat = fs.statSync(path.join(WORK_DIR, entry));
    } catch {
      continue;
    }
    if (stat.isDirectory()) workspaces.push({ id: entry, at: stat.mtimeMs });
  }
  workspaces.sort((a, b) => b.at - a.at);
  return { workspaces };
}

async function createWorkspace({ id, repo, ref, token, adopt }) {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new HttpError(400, "Bad repo");
  }
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw new HttpError(400, "Bad ref");
  if (typeof token !== "string" || !token) throw new HttpError(400, "Missing token");
  const dir = workspaceDir(id);
  if (fs.existsSync(dir)) throw new HttpError(409, "Workspace exists");

  // A revision continues in the workspace the reviewed run left behind,
  // under the new run's id: the repo, its dependencies and whatever the
  // build cached are all still there, and so are the changes being revised.
  if (adopt !== undefined && adopt !== null && adopt !== "") {
    const from = workspaceDir(adopt);
    if (fs.existsSync(from)) {
      fs.renameSync(from, dir);
      watch(adopt)?.close();
      watchFeeds.delete(adopt);
      const adopted = new Feed();
      watchFeeds.set(id, adopted);
      const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
      adopted.publish({ type: "ready", head });
      return { id, head, adopted: true };
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(dir, AGENT_UID, AGENT_GID);
  const feed = new Feed();
  watchFeeds.set(id, feed);
  feed.publish({ type: "clone", repo, ref });
  // The token travels in git's config environment, not on the command line
  // and never into .git/config, so the clone's remote stays token-free.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  try {
    await git(WORK_DIR, ["clone", "--quiet", "--depth", "1", "--branch", ref, `https://github.com/${repo}.git`, dir], env);
    await git(dir, ["config", "user.name", "Kru agent"]);
    await git(dir, ["config", "user.email", "kru-agent@localhost"]);
    const exclude = path.join(dir, ".git", "info", "exclude");
    fs.appendFileSync(exclude, `\n${ALWAYS_EXCLUDED.join("\n")}\n`);
    fs.chownSync(exclude, AGENT_UID, AGENT_GID);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    feed.publish({ type: "ready", head });
    return { id, head };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    feed.close();
    watchFeeds.delete(id);
    throw error;
  }
}

function existingWorkspace(id) {
  const dir = workspaceDir(id);
  if (!fs.existsSync(dir)) throw new HttpError(404, "No such workspace");
  return dir;
}

function readWorkspaceFile(dir, relative, resolve = insideWorkspace) {
  const full = resolve(dir, relative);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new HttpError(404, "No such file");
  }
  if (stat.isDirectory()) {
    return { directory: fs.readdirSync(full).sort() };
  }
  if (stat.size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 1 MB");
  const buffer = fs.readFileSync(full);
  if (buffer.includes(0)) return { binary: true, size: stat.size };
  return { content: buffer.toString("utf8") };
}

function writeWorkspaceFile(dir, relative, content, resolve = insideWorkspace) {
  if (typeof content !== "string") throw new HttpError(400, "Content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new HttpError(413, "Content is larger than 1 MB");
  }
  const full = resolve(dir, relative);
  // Create parent folders as the agent so it can keep working in them.
  let parent = path.dirname(full);
  const created = [];
  while (!fs.existsSync(parent)) {
    created.push(parent);
    parent = path.dirname(parent);
  }
  for (const folder of created.reverse()) {
    fs.mkdirSync(folder);
    fs.chownSync(folder, AGENT_UID, AGENT_GID);
  }
  fs.writeFileSync(full, content);
  fs.chownSync(full, AGENT_UID, AGENT_GID);
  return { ok: true };
}

function deleteWorkspaceFile(dir, relative, resolve = insideWorkspace) {
  const full = resolve(dir, relative);
  if (full === dir) throw new HttpError(400, "Refusing to delete the workspace root");
  fs.rmSync(full, { recursive: true, force: true });
  return { ok: true };
}

/** Parses `git diff --name-status -z` output into [status, path] pairs. */
export function parseNameStatus(raw) {
  const fields = raw.split("\0").filter((field) => field !== "");
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    entries.push([fields[i][0], fields[i + 1]]);
  }
  return entries;
}

/** The unified diff of one staged file against HEAD, capped for review. */
async function fileDiff(dir, relative) {
  const diff = await git(dir, ["diff", "--cached", "--no-color", "--no-renames", "--", relative]);
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[… diff truncated …]\n`
    : diff;
}

/**
 * Stages everything (respecting .gitignore) and reports each changed file
 * against the clone's HEAD, with its unified diff for review. Deleted files
 * carry no content; binary files are flagged so Kru can skip them.
 */
async function collectChanges(dir) {
  await git(dir, ["add", "-A"]);
  const raw = await git(dir, ["diff", "--cached", "--name-status", "-z", "--no-renames"]);
  const files = [];
  for (const [code, relative] of parseNameStatus(raw)) {
    const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    if (status === "deleted") {
      files.push({ path: relative, status, diff: await fileDiff(dir, relative) });
      continue;
    }
    const full = path.join(dir, relative);
    const stat = fs.statSync(full);
    if (stat.size > MAX_FILE_BYTES) {
      files.push({ path: relative, status, tooLarge: true, size: stat.size });
      continue;
    }
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) {
      files.push({ path: relative, status, binary: true, size: stat.size });
      continue;
    }
    files.push({
      path: relative,
      status,
      content: buffer.toString("utf8"),
      diff: await fileDiff(dir, relative),
    });
  }
  return { files };
}

function deleteWorkspace(id) {
  fs.rmSync(workspaceDir(id), { recursive: true, force: true });
  watch(id)?.close();
  watchFeeds.delete(id);
  return { ok: true };
}

// ---------- terminals ----------

const terminals = new Map();

/**
 * Where a terminal starts: a run's workspace, or the agent's ~/workspace.
 * Never anywhere else, so a stray path can't open a shell outside the
 * agent's home.
 */
export function terminalCwd(workspace) {
  if (workspace === undefined || workspace === null || workspace === "") return WORK_DIR;
  const dir = workspaceDir(workspace);
  if (!fs.existsSync(dir)) {
    throw new HttpError(404, "That run's workspace is gone. The box keeps one only while a run waits for review or has work to recover, and clears them all when it restarts.");
  }
  return dir;
}

function terminalSize(body) {
  const cols = Math.min(Math.max(Math.floor(Number(body.cols)) || 80, 20), 500);
  const rows = Math.min(Math.max(Math.floor(Number(body.rows)) || 24, 5), 200);
  return { cols, rows };
}

async function createTerminal(body) {
  if (terminals.size >= MAX_TERMINALS) throw new HttpError(429, `At most ${MAX_TERMINALS} terminals at once`);
  const cwd = terminalCwd(body.workspace);
  const { cols, rows } = terminalSize(body);
  // Loaded on demand: node-pty is native, and nothing else needs it.
  const { default: pty } = await import("node-pty");
  const id = randomBytes(8).toString("hex");
  const shell = pty.spawn("bash", ["-l"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    uid: AGENT_UID,
    gid: AGENT_GID,
    env: agentEnv({ TERM: "xterm-256color", COLORTERM: "truecolor", SHELL: "/bin/bash" }),
  });
  const terminal = { id, shell, feed: new Feed(), viewers: 0, idle: null };
  terminals.set(id, terminal);
  shell.onData((data) => terminal.feed.publish({ data: Buffer.from(data).toString("base64") }));
  shell.onExit(({ exitCode }) => {
    terminal.feed.publish({ exit: exitCode });
    terminal.feed.close();
    terminals.delete(id);
  });
  touchTerminal(terminal);
  return { id, cwd };
}

function touchTerminal(terminal) {
  if (terminal.idle) clearTimeout(terminal.idle);
  terminal.idle = null;
  if (terminal.viewers === 0) {
    terminal.idle = setTimeout(() => closeTerminal(terminal.id), TERMINAL_IDLE_MS);
  }
}

function existingTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) throw new HttpError(404, "No such terminal");
  return terminal;
}

function closeTerminal(id) {
  const terminal = terminals.get(id);
  if (!terminal) return { ok: true };
  terminals.delete(id);
  if (terminal.idle) clearTimeout(terminal.idle);
  try {
    terminal.shell.kill("SIGHUP");
  } catch {
    /* already gone */
  }
  terminal.feed.close();
  return { ok: true };
}

// ---------- desktop ----------

/**
 * One desktop per box: desktop.sh starts a VNC X server on loopback and a
 * GNOME session as the agent user, in its own process group. It starts when
 * someone opens it, keeps running while the panel is hidden, and stops after
 * a long idle or on request. Browsers never reach the VNC port; each viewer
 * gets a loopback TCP connection bridged over the HTTP API instead.
 */
let desktop = null;
const connections = new Map();

/** Clamps a requested desktop size to something an X server will accept. */
export function desktopSize(body) {
  const width = Math.min(Math.max(Math.floor(Number(body.width)) || 1280, 640), 4096);
  const height = Math.min(Math.max(Math.floor(Number(body.height)) || 800, 480), 4096);
  return { width, height };
}

/** Tries a TCP connect to the VNC port, resolving with the socket. */
function connectVnc() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: DESKTOP_VNC_PORT });
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function desktopStatus() {
  return {
    running: Boolean(desktop),
    ready: Boolean(desktop?.ready),
    width: desktop?.width ?? null,
    height: desktop?.height ?? null,
    viewers: connections.size,
  };
}

/** Starts the desktop if it isn't running and waits until VNC answers. */
async function ensureDesktop(body = {}) {
  if (desktop) {
    await desktop.readyPromise;
    return desktopStatus();
  }
  const { width, height } = desktopSize(body);
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  fs.chownSync(RUNTIME_DIR, AGENT_UID, AGENT_GID);
  const child = spawn("bash", [DESKTOP_SCRIPT], {
    cwd: AGENT_HOME,
    env: agentEnv({
      DISPLAY: `:${DESKTOP_DISPLAY}`,
      DESKTOP_VNC_PORT: String(DESKTOP_VNC_PORT),
      DESKTOP_WIDTH: String(width),
      DESKTOP_HEIGHT: String(height),
      XDG_RUNTIME_DIR: RUNTIME_DIR,
      XDG_CONFIG_HOME: path.join(AGENT_HOME, ".config"),
      XDG_DATA_HOME: path.join(AGENT_HOME, ".local", "share"),
    }),
    uid: AGENT_UID,
    gid: AGENT_GID,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = { child, width, height, ready: false, idle: null, readyPromise: null };
  desktop = started;
  let log = "";
  const collect = (chunk) => {
    log = (log + chunk.toString("utf8")).slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code, signal) => {
    // stopDesktop() clears `desktop` first; anything else is unexpected.
    const unexpected = desktop === started;
    if (unexpected) desktop = null;
    if (started.idle) clearTimeout(started.idle);
    for (const connection of connections.values()) closeConnection(connection.id);
    if (unexpected) console.warn(`[box] desktop exited (${signal ?? code}): ${log.trim().slice(-500)}`);
  });
  child.on("error", (error) => console.error("[box] desktop failed to start", error));

  started.readyPromise = (async () => {
    const deadline = Date.now() + DESKTOP_START_MS;
    while (Date.now() < deadline) {
      if (desktop !== started) throw new HttpError(502, `The desktop didn't start: ${log.trim().slice(-300) || "no output"}`);
      try {
        const probe = await connectVnc();
        probe.destroy();
        started.ready = true;
        touchDesktop();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    stopDesktop();
    throw new HttpError(504, "The desktop didn't start in time");
  })();
  await started.readyPromise;
  return desktopStatus();
}

function touchDesktop() {
  if (!desktop) return;
  if (desktop.idle) clearTimeout(desktop.idle);
  desktop.idle = null;
  if (connections.size === 0) desktop.idle = setTimeout(stopDesktop, DESKTOP_IDLE_MS);
}

function stopDesktop() {
  const current = desktop;
  desktop = null;
  for (const connection of connections.values()) closeConnection(connection.id);
  if (!current) return { ok: true };
  if (current.idle) clearTimeout(current.idle);
  try {
    // The whole process group: X server, session bus and the GNOME session.
    process.kill(-current.child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const force = setTimeout(() => {
    try {
      process.kill(-current.child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000);
  current.child.once("exit", () => clearTimeout(force));
  return { ok: true };
}

/** Opens a loopback VNC connection for one viewer; the stream claims it. */
async function createConnection(body) {
  if (connections.size >= MAX_DESKTOP_CONNECTIONS) {
    throw new HttpError(429, `At most ${MAX_DESKTOP_CONNECTIONS} desktop viewers at once`);
  }
  await ensureDesktop(body);
  let socket;
  try {
    socket = await connectVnc();
  } catch (error) {
    throw new HttpError(502, `Could not reach the desktop's VNC server: ${error.message}`);
  }
  const id = randomBytes(8).toString("hex");
  const connection = { id, socket, response: null, claim: null };
  // Hold the server's greeting until a viewer attaches.
  socket.pause();
  socket.on("error", () => closeConnection(id));
  socket.on("close", () => closeConnection(id));
  connection.claim = setTimeout(() => closeConnection(id), CONNECTION_CLAIM_MS);
  connections.set(id, connection);
  touchDesktop();
  return { id, width: desktop?.width ?? null, height: desktop?.height ?? null };
}

function existingConnection(id) {
  const connection = connections.get(id);
  if (!connection) throw new HttpError(404, "No such desktop connection");
  return connection;
}

function closeConnection(id) {
  const connection = connections.get(id);
  if (!connection) return { ok: true };
  connections.delete(id);
  if (connection.claim) clearTimeout(connection.claim);
  connection.socket.destroy();
  connection.response?.end();
  connection.response = null;
  touchDesktop();
  return { ok: true };
}

/**
 * Streams VNC bytes to one viewer as base64 server-sent events. Unlike the
 * feeds, nothing is replayed: a VNC connection is one stateful conversation,
 * so when the stream ends the connection ends with it.
 */
function streamConnection(request, response, connection) {
  if (connection.response) throw new HttpError(409, "That connection already has a viewer");
  if (connection.claim) clearTimeout(connection.claim);
  connection.claim = null;
  connection.response = response;
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const { socket } = connection;
  socket.on("data", (chunk) => {
    if (!response.write(`data: ${chunk.toString("base64")}\n\n`)) socket.pause();
  });
  response.on("drain", () => socket.resume());
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  request.on("close", () => {
    clearInterval(keepalive);
    closeConnection(connection.id);
  });
  socket.resume();
}

async function desktopRoute(request, response, parts) {
  // /desktop, /desktop/connections, /desktop/connections/:id[/stream|/input]
  if (parts.length === 1) {
    if (request.method === "GET") return desktopStatus();
    if (request.method === "POST") return ensureDesktop(await readJson(request));
    if (request.method === "DELETE") return stopDesktop();
    throw new HttpError(404, "Not found");
  }
  if (parts[1] !== "connections") throw new HttpError(404, "Not found");
  const id = parts[2];
  const action = parts[3];
  if (request.method === "POST" && !id) return createConnection(await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "DELETE" && !action) return closeConnection(id);
  const connection = existingConnection(id);
  if (request.method === "GET" && action === "stream") {
    streamConnection(request, response, connection);
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    connection.socket.write(Buffer.from(body.data, "base64"));
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

// ---------- auth ----------

function loadToken() {
  if (process.env.BOX_TOKEN) return process.env.BOX_TOKEN;
  const file = path.join(STATE_DIR, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o640 });
  try {
    fs.chownSync(file, 0, TOKEN_READER_GID);
    fs.chmodSync(STATE_DIR, 0o750);
    fs.chownSync(STATE_DIR, 0, TOKEN_READER_GID);
  } catch (error) {
    console.warn(`[box] could not set token file ownership: ${error.message}`);
  }
  return token;
}

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- http ----------

function readJson(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  response.end(json);
}

/** Streaming routes write the response themselves and return STREAMED. */
const STREAMED = Symbol("streamed");

/**
 * What a stream-json line from the CLI means for the workspace watch feed:
 * the agent's words as "say" (Markdown), its tool calls as commands, file
 * activity, or other tools. Paths inside the workspace are shown relative
 * to it.
 *
 * @param {string} line
 * @param {string | null} [dir] the workspace folder
 */
export function watchEventFor(line, dir = null) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event?.type !== "assistant") return null;
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const relative = (file) => (dir && file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file);
  const events = [];
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ type: "say", text: block.text.trim() });
    } else if (block?.type === "tool_use") {
      const input = block.input ?? {};
      const verb = { Read: "read", Edit: "edit", MultiEdit: "edit", Write: "write" }[block.name];
      if (block.name === "Bash" && typeof input.command === "string") {
        events.push({ type: "command", command: dir ? input.command.split(dir).join(".") : input.command });
      } else if (verb && typeof input.file_path === "string") {
        events.push({ type: verb, path: relative(input.file_path) });
      } else {
        const first = Object.values(input).find((value) => typeof value === "string");
        events.push({ type: "tool", name: String(block.name ?? "tool"), detail: first ? relative(first) : "" });
      }
    }
  }
  return events;
}

/**
 * Runs Claude Code in a workspace and streams what it prints, one
 * server-sent event per stdout line, until it exits. Closing the request
 * stops the run: the CLI and everything it started are killed.
 */
async function claudeRoute(request, response, dir, feed) {
  const body = await readJson(request);
  if (typeof body.model !== "string" || !CLAUDE_MODEL_ID.test(body.model)) {
    throw new HttpError(400, "Bad model id");
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Missing prompt");
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || MAX_CLAUDE_TIMEOUT_MS, 1000), MAX_CLAUDE_TIMEOUT_MS);
  const { file, cleanup } = writeSystemPrompt(systemPrompt, { uid: AGENT_UID, gid: AGENT_GID });
  const args = claudeArgs({
    model: body.model,
    systemPromptFile: file,
    readOnly: body.readOnly === true,
    maxTurns: Number.isInteger(body.maxTurns) ? body.maxTurns : null,
  });

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = new AbortController();
  // The response, not the request: the request's own close fires once its
  // body has been read, which was before this line.
  response.on("close", () => stop.abort());
  feed?.publish({ type: "command", command: `claude -p --model ${body.model}` });
  try {
    const result = await spawnClaude({
      args,
      cwd: dir,
      env: agentEnv(),
      uid: AGENT_UID,
      gid: AGENT_GID,
      prompt: body.prompt,
      timeoutMs,
      signal: stop.signal,
      onLine: (line) => {
        send({ type: "line", line });
        for (const event of watchEventFor(line, dir) ?? []) feed?.publish(event);
      },
      onStderr: (text) => send({ type: "stderr", text }),
    });
    send({ type: "exit", code: result.exitCode, signal: result.signal, timedOut: result.timedOut, aborted: result.aborted });
    feed?.publish({ type: "exit", code: result.exitCode, timedOut: result.timedOut });
  } catch (error) {
    const missing = error.code === "ENOENT" || error.code === "EACCES";
    send({ type: "error", missing, message: missing ? "The claude CLI isn't installed in the box" : error.message });
  } finally {
    clearInterval(keepalive);
    cleanup();
    response.end();
  }
  return STREAMED;
}

// ---------- bots: persistent Claude Code sessions ----------

/** @type {Map<string, AgentSession>} */
const agents = new Map();

function agentFor(id) {
  if (!AGENT_ID.test(id)) throw new HttpError(400, "Bad agent id");
  let agent = agents.get(id);
  if (!agent) {
    agent = new AgentSession({
      id,
      cwd: BOTS_DIR,
      env: agentEnv(),
      uid: AGENT_UID,
      gid: AGENT_GID,
      socketDir: AGENT_SOCKET_DIR,
      mcpScript: KRU_MCP_SCRIPT,
      logDir: path.join(BOTS_DIR, ".protocol"),
      onWarning: (text) => console.warn(`[box] ${id}: ${text}`),
    });
    agents.set(id, agent);
  }
  return agent;
}

/**
 * One turn of a bot's Claude Code session, streamed as server-sent events:
 * `init`, raw stream-json `line`s, `tool_call`s for Kru to answer through
 * /agents/:id/tool-result, and a final `result`. Closing the response
 * interrupts the turn. A refused resume is retried once on a fresh session,
 * reported with `recovered: true` so Kru can replay context.
 */
async function agentTurnRoute(request, response, id) {
  const body = await readJson(request, MAX_TURN_BODY_BYTES);
  if (typeof body.model !== "string" || !CLAUDE_MODEL_ID.test(body.model)) throw new HttpError(400, "Bad model id");
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Missing prompt");
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const tools = Array.isArray(body.tools) ? body.tools.filter((tool) => tool && typeof tool.name === "string") : [];
  const effort = typeof body.effort === "string" && /^[a-z]+$/.test(body.effort) ? body.effort : null;
  const maxTurns = Number.isInteger(body.maxTurns) && body.maxTurns > 0 ? Math.min(body.maxTurns, 200) : null;
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || MAX_AGENT_TURN_MS, 1000), MAX_AGENT_TURN_MS);
  const images = [...(Array.isArray(body.images) ? body.images : []), ...(Array.isArray(body.attachments) ? body.attachments : [])];
  const agent = agentFor(id);
  if (agent.turn) throw new HttpError(409, "This bot is already answering");

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": connected\n\n");
  const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const keepalive = setInterval(() => response.write(": ping\n\n"), SSE_KEEPALIVE_MS);
  const stop = new AbortController();
  response.on("close", () => stop.abort());
  try {
    const settings = { model: body.model, effort, maxTurns, systemPrompt, tools };
    let launch = await agent.ensure(settings);
    let result = await agent.turnWith({ prompt: body.prompt, images, timeoutMs, systemPrompt, onEvent: send, signal: stop.signal });
    let recovered = false;
    if (result.resumeFailed && !stop.signal.aborted) {
      // The provider lost the session: start over once, and say so.
      await agent.close({ keepSession: false });
      launch = await agent.ensure(settings);
      recovered = true;
      result = await agent.turnWith({ prompt: body.prompt, images, timeoutMs, systemPrompt, onEvent: send, signal: stop.signal });
    }
    send({ type: "result", ...result, sessionId: agent.sessionId, launched: launch.launched, resumed: launch.resumed ?? false, recovered });
  } catch (error) {
    const missing = error.code === "ENOENT" || error.code === "EACCES";
    send({ type: "error", missing, message: missing ? "The claude CLI isn't installed in the box" : error.message });
  } finally {
    clearInterval(keepalive);
    response.end();
  }
  return STREAMED;
}

async function agentRoute(request, response, parts) {
  const id = parts[1];
  const action = parts[2];
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "POST" && action === "turn") return agentTurnRoute(request, response, id);
  if (request.method === "POST" && action === "tool-result") {
    const body = await readJson(request);
    const agent = agents.get(id);
    if (!agent || typeof body.callId !== "string") throw new HttpError(404, "No such call");
    const content = typeof body.content === "string" ? body.content : JSON.stringify(body.content ?? "");
    if (!agent.answerTool(body.callId, { content, isError: Boolean(body.isError) })) throw new HttpError(404, "No such call");
    return { ok: true };
  }
  if (request.method === "DELETE" && !action) {
    const agent = agents.get(id);
    if (agent) {
      agents.delete(id);
      await agent.close({ keepSession: false });
    }
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

async function terminalRoute(request, response, parts) {
  const id = parts[1];
  const action = parts[2];
  if (request.method === "POST" && !id) return createTerminal(await readJson(request));
  if (!id) throw new HttpError(404, "Not found");
  if (request.method === "DELETE" && !action) return closeTerminal(id);
  const terminal = existingTerminal(id);
  if (request.method === "GET" && action === "stream") {
    terminal.viewers += 1;
    touchTerminal(terminal);
    streamFeed(request, response, terminal.feed);
    request.on("close", () => {
      terminal.viewers -= 1;
      if (terminals.has(id)) touchTerminal(terminal);
    });
    return STREAMED;
  }
  if (request.method === "POST" && action === "input") {
    const body = await readJson(request);
    if (typeof body.data !== "string") throw new HttpError(400, "Missing data");
    terminal.shell.write(Buffer.from(body.data, "base64").toString("utf8"));
    return { ok: true };
  }
  if (request.method === "POST" && action === "resize") {
    const { cols, rows } = terminalSize(await readJson(request));
    terminal.shell.resize(cols, rows);
    return { ok: true };
  }
  throw new HttpError(404, "Not found");
}

async function route(request, response, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "terminals") return terminalRoute(request, response, parts);
  if (parts[0] === "desktop") return desktopRoute(request, response, parts);
  if (parts[0] === "agents") return agentRoute(request, response, parts);
  if (request.method === "GET" && parts.length === 2 && parts[0] === "claude" && parts[1] === "auth") {
    return authStatus({ env: agentEnv(), uid: AGENT_UID, gid: AGENT_GID });
  }

  if (request.method === "POST" && parts.length === 1 && parts[0] === "workspaces") {
    const body = await readJson(request);
    return createWorkspace(body);
  }
  if (request.method === "GET" && parts.length === 1 && parts[0] === "workspaces") {
    return listWorkspaces();
  }
  if (request.method === "POST" && parts.length === 2 && parts[0] === "claude" && parts[1] === "check") {
    return checkClaude({ cwd: WORK_DIR, env: agentEnv(), uid: AGENT_UID, gid: AGENT_GID });
  }

  // The bots' own use of the box: a command or a file anywhere in the
  // agent's home, not tied to a card's workspace.
  if (request.method === "POST" && parts.length === 1 && parts[0] === "exec") {
    const body = await readJson(request);
    if (typeof body.command !== "string" || !body.command.trim()) {
      throw new HttpError(400, "Missing command");
    }
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1000),
      MAX_EXEC_TIMEOUT_MS,
    );
    const cwd = boxCwd(body.cwd);
    if (!fs.existsSync(cwd)) throw new HttpError(404, "No such directory");
    return runAsAgent(["bash", "-lc", body.command], { cwd, timeoutMs });
  }
  if (parts.length === 1 && parts[0] === "files") {
    if (request.method === "GET") {
      const relative = url.searchParams.get("path");
      return readWorkspaceFile(AGENT_HOME, relative, insideHome);
    }
    if (request.method === "PUT") {
      const body = await readJson(request);
      return writeWorkspaceFile(AGENT_HOME, body.path, body.content, insideHome);
    }
    if (request.method === "DELETE") {
      const relative = url.searchParams.get("path");
      return deleteWorkspaceFile(AGENT_HOME, relative, insideHome);
    }
  }

  if (parts.length < 2 || parts[0] !== "workspaces") throw new HttpError(404, "Not found");
  const id = parts[1];
  const action = parts[2];

  if (request.method === "DELETE" && !action) return deleteWorkspace(id);
  if (request.method === "GET" && action === "watch") {
    const feed = watch(id);
    if (!feed) throw new HttpError(404, "No such workspace");
    streamFeed(request, response, feed);
    return STREAMED;
  }

  const dir = existingWorkspace(id);
  const feed = watch(id);
  if (request.method === "POST" && action === "claude") {
    return claudeRoute(request, response, dir, feed);
  }
  if (request.method === "POST" && action === "exec") {
    const body = await readJson(request);
    if (typeof body.command !== "string" || !body.command.trim()) {
      throw new HttpError(400, "Missing command");
    }
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS, 1000),
      MAX_EXEC_TIMEOUT_MS,
    );
    feed?.publish({ type: "command", command: body.command });
    const result = await runAsAgent(["bash", "-lc", body.command], {
      cwd: dir,
      timeoutMs,
      onChunk: (chunk) => feed?.publish({ type: "output", text: chunk.toString("utf8") }),
    });
    feed?.publish({ type: "exit", code: result.exitCode, timedOut: result.timedOut });
    return result;
  }
  if (request.method === "GET" && action === "file") {
    const filePath = url.searchParams.get("path");
    feed?.publish({ type: "read", path: filePath });
    return readWorkspaceFile(dir, filePath);
  }
  if (request.method === "PUT" && action === "file") {
    const body = await readJson(request);
    feed?.publish({ type: "write", path: body.path });
    return writeWorkspaceFile(dir, body.path, body.content);
  }
  if (request.method === "DELETE" && action === "file") {
    const filePath = url.searchParams.get("path");
    feed?.publish({ type: "delete", path: filePath });
    return deleteWorkspaceFile(dir, filePath);
  }
  if (request.method === "POST" && action === "say") {
    // The agent's own words, from a runner the box doesn't see think.
    const body = await readJson(request);
    if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "Missing text");
    feed?.publish({ type: "say", text: body.text.trim().slice(0, MAX_SAY_CHARS) });
    return { ok: true };
  }
  if (request.method === "GET" && action === "changes") {
    feed?.publish({ type: "collect" });
    return collectChanges(dir);
  }
  throw new HttpError(404, "Not found");
}

/**
 * A system D-Bus for the desktop. gnome-session aborts outright when it
 * can't reach one, and a container has none of its own. dbus-daemon runs
 * as root only long enough to bind the socket, then drops to `messagebus`.
 * Nothing on the bus (logind, UPower) exists here; the session copes with
 * their absence but not with the bus's.
 */
function startSystemBus() {
  const socket = "/run/dbus/system_bus_socket";
  try {
    fs.mkdirSync("/run/dbus", { recursive: true });
    // The bus needs a machine id; the image may not carry one.
    spawnSync("dbus-uuidgen", ["--ensure"], { stdio: "ignore" });
    fs.rmSync(socket, { force: true });
    const bus = spawn("dbus-daemon", ["--system", "--nofork", "--nopidfile"], { stdio: ["ignore", "ignore", "pipe"] });
    let log = "";
    bus.stderr.on("data", (chunk) => {
      log = (log + chunk.toString("utf8")).slice(-1000);
    });
    bus.on("error", (error) => console.warn(`[box] system bus failed to start: ${error.message}`));
    bus.on("exit", (code, signal) => console.warn(`[box] system bus exited (${signal ?? code}): ${log.trim().slice(-300)}`));
  } catch (error) {
    console.warn(`[box] could not start a system bus: ${error.message}`);
  }
}

export function start() {
  const token = loadToken();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.chownSync(WORK_DIR, AGENT_UID, AGENT_GID);
  // The cache volume may arrive owned by root; the agent must write to it.
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.chownSync(CACHE_DIR, AGENT_UID, AGENT_GID);
  // Same for the Claude Code login volume; only its top level is touched.
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  fs.chownSync(CLAUDE_CONFIG_DIR, AGENT_UID, AGENT_GID);
  // The bots' own folder, kept across restarts, and the sockets their
  // Claude Code sessions reach Kru's tools through.
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.chownSync(BOTS_DIR, AGENT_UID, AGENT_GID);
  fs.rmSync(AGENT_SOCKET_DIR, { recursive: true, force: true });
  fs.mkdirSync(AGENT_SOCKET_DIR, { recursive: true, mode: 0o755 });
  // The desktop's X server and session, running as the agent, need the
  // socket dirs; gnome-session also needs a system bus (see startSystemBus).
  for (const dir of ["/tmp/.X11-unix", "/tmp/.ICE-unix"]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o1777);
    } catch (error) {
      console.warn(`[box] could not prepare ${dir}: ${error.message}`);
    }
  }
  startSystemBus();
  // Runs a restart interrupted can't resume; Kru marks them as errors.
  for (const entry of fs.readdirSync(WORK_DIR)) {
    fs.rmSync(path.join(WORK_DIR, entry), { recursive: true, force: true });
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://box");
    if (url.pathname === "/health") return send(response, 200, { ok: true });
    if (!authorized(request, token)) return send(response, 401, { error: "Unauthorized" });
    try {
      const result = await route(request, response, url);
      if (result !== STREAMED) send(response, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("[box]", error);
      send(response, status, { error: error.message || "Box error" });
    }
  });
  server.requestTimeout = MAX_EXEC_TIMEOUT_MS + 60_000;
  server.headersTimeout = 65_000;
  server.listen(PORT, HOST, () => {
    console.info(`[box] listening on ${HOST}:${PORT}, workspaces in ${WORK_DIR}`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  start();
}
