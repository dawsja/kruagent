/**
 * Runs the Claude Code CLI (`claude`) inside the box, as the agent user, in
 * a run's workspace. The binary is installed as published and never
 * modified; the person signs in to it themselves through the box desktop,
 * and the login lives in CLAUDE_CONFIG_DIR on a volume. Nothing here reads
 * or forwards those credentials: the box only runs the CLI and relays what
 * it prints.
 *
 * The prompt always travels on stdin, never in argv (ARG_MAX), and the
 * system prompt goes through a temp file the CLI reads with
 * --append-system-prompt-file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The CLI to run; tests point this at a script. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
/** A cheap model for the "are you signed in?" check. */
export const CLAUDE_CHECK_MODEL = "claude-haiku-4-5";
export const CLAUDE_CHECK_TIMEOUT_MS = 30_000;
/** Grace between SIGTERM and SIGKILL when a run is stopped. */
const KILL_GRACE_MS = 5_000;
/** Longest stderr kept for the error report. */
const MAX_STDERR = 4_000;
/** Longest single stdout line handed on; stream-json lines are normally short. */
const MAX_LINE = 256 * 1024;

/** Tools a read-only run (a review) may not use: nothing that writes files or moves the tree. */
export const READ_ONLY_DENIED = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash(git checkout:*)",
  "Bash(git reset:*)",
  "Bash(git clean:*)",
  "Bash(git stash:*)",
  "Bash(rm:*)",
];

/** Most turns a capped run may take. */
export const MAX_TURNS_CAP = 200;

/**
 * The argv for one run. Permissions are skipped outright: the container and
 * its unprivileged user are the sandbox, the same as the shell the other
 * runner gets. Committing and pushing are denied by rule as well as by the
 * instructions, because Kru collects the working tree for review. A
 * read-only run also loses the file-writing tools; Kru still checks the
 * tree afterwards, since a shell can write anyway.
 *
 * @param {{ model: string; systemPromptFile: string; readOnly?: boolean; maxTurns?: number | null }} run
 * @returns {string[]}
 */
export function claudeArgs({ model, systemPromptFile, readOnly = false, maxTurns = null }) {
  const turns = Number(maxTurns);
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(Number.isInteger(turns) && turns > 0 ? ["--max-turns", String(Math.min(turns, MAX_TURNS_CAP))] : []),
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--disallowedTools",
    "Bash(git commit:*)",
    "Bash(git push:*)",
    ...(readOnly ? READ_ONLY_DENIED : []),
    "--append-system-prompt-file",
    systemPromptFile,
  ];
}

/** Model ids are plain tokens; anything else is refused before it reaches argv. */
export const MODEL_ID = /^[A-Za-z0-9._-]{1,80}$/;

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * @typedef {object} SpawnOptions
 * @property {string} [bin] The CLI to run; defaults to CLAUDE_BIN.
 * @property {string[]} args
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {number} [uid] Run as this user; left out, the current one.
 * @property {number} [gid]
 * @property {string} prompt Written to stdin, then stdin is closed.
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {(line: string) => void} [onLine] Each stdout line as it arrives.
 * @property {(text: string) => void} [onStderr]
 */

/**
 * @typedef {object} SpawnResult
 * @property {number} exitCode
 * @property {string | null} signal
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string} stderr The tail of what the CLI wrote to stderr.
 */

/**
 * Spawns the CLI with `prompt` on stdin and streams stdout to `onLine`, one
 * line at a time as they arrive. Stops on `signal` or after `timeoutMs`,
 * killing the whole process group. Resolves with how it ended; rejects only
 * when the binary can't be started.
 *
 * @param {SpawnOptions} options
 * @returns {Promise<SpawnResult>}
 */
export function spawnClaude({
  bin = CLAUDE_BIN,
  args,
  cwd,
  env,
  uid,
  gid,
  prompt,
  timeoutMs,
  signal,
  onLine,
  onStderr,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      ...(uid !== undefined ? { uid, gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    const stop = (why) => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = timeoutMs ? setTimeout(() => stop("timeout"), timeoutMs) : null;
    const onAbort = () => stop("abort");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) onLine?.(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      onStderr?.(chunk);
    });

    const done = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code, sig) => {
      done();
      if (pending.trim()) onLine?.(pending.replace(/\r$/, ""));
      resolve({
        exitCode: code ?? (sig ? 128 : 1),
        signal: sig ?? null,
        timedOut,
        aborted,
        stderr,
      });
    });

    // The CLI may exit before reading its stdin (not signed in, bad flag);
    // a closed pipe then is not an error worth reporting.
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  });
}

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i;

/**
 * What a check run means. `missing` is the binary not being there at all;
 * `unauthenticated` is the CLI asking for a login; `error` is anything else
 * that isn't a clean exit.
 *
 * @param {{ spawnError?: NodeJS.ErrnoException; exitCode?: number; output?: string }} run
 * @returns {"ok" | "missing" | "unauthenticated" | "error"}
 */
export function classifyCheck({ spawnError, exitCode, output }) {
  if (spawnError) {
    return spawnError.code === "ENOENT" || spawnError.code === "EACCES" ? "missing" : "error";
  }
  if (exitCode === 0 && !NOT_SIGNED_IN.test(output ?? "")) return "ok";
  if (NOT_SIGNED_IN.test(output ?? "")) return "unauthenticated";
  return "error";
}

/** True when the CLI's own final text is it asking for a login. */
export function isSignInError(text) {
  return NOT_SIGNED_IN.test(text ?? "");
}

/**
 * Asks the CLI to reply to "reply ok" in text mode with a cheap model. Costs
 * one tiny request when signed in; nothing when not.
 *
 * @param {{ bin?: string; cwd: string; env: NodeJS.ProcessEnv; uid?: number; gid?: number }} options
 * @returns {Promise<{ status: "ok" | "missing" | "unauthenticated" | "error"; detail: string }>}
 */
export async function checkClaude({ bin = CLAUDE_BIN, cwd, env, uid, gid }) {
  let output = "";
  const keep = (text) => {
    output = (output + text).slice(-2_000);
  };
  try {
    const result = await spawnClaude({
      bin,
      args: ["-p", "--model", CLAUDE_CHECK_MODEL, "--output-format", "text"],
      cwd,
      env,
      uid,
      gid,
      prompt: "reply ok",
      timeoutMs: CLAUDE_CHECK_TIMEOUT_MS,
      onLine: (line) => keep(`${line}\n`),
      onStderr: keep,
    });
    const status = result.timedOut ? "error" : classifyCheck({ exitCode: result.exitCode, output });
    const detail = result.timedOut ? "The check timed out" : output.trim().slice(0, 300);
    return { status, detail };
  } catch (error) {
    return { status: classifyCheck({ spawnError: error }), detail: error.message.slice(0, 300) };
  }
}

/**
 * Writes the system prompt where only the agent user reads it and returns
 * the path plus a cleanup. Outside the workspace on purpose: the repo's
 * working tree is what Kru collects, and nothing of ours belongs in it.
 *
 * @param {string} text
 * @param {{ uid?: number; gid?: number }} [owner]
 */
export function writeSystemPrompt(text, { uid, gid } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kru-claude-"));
  const file = path.join(dir, "system-prompt.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (uid !== undefined) {
    fs.chownSync(dir, uid, gid);
    fs.chownSync(file, uid, gid);
  }
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
