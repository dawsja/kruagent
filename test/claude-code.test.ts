import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkClaude, claudeArgs, classifyCheck, spawnClaude } from "../box/claude.mjs";
import { CollectFailedError, RunCancelledError, type AgentInput } from "../lib/hq/agent-shared.ts";
import type { ClaudeCheck } from "../lib/hq/box.ts";
import {
  CLAUDE_MISSING_MESSAGE,
  CLAUDE_SIGN_IN_MESSAGE,
  preflightProblem,
  readStreamLine,
  runCardClaudeCode,
} from "../lib/hq/claude-code.ts";
import type { Connection } from "../lib/hq/types";

/*
 * Two layers. The box side runs fake `claude` scripts through the real
 * spawn code: the prompt has to arrive on stdin, lines have to stream, an
 * abort has to kill the child, and the sign-in check has to tell the
 * failures apart. The Kru side runs the real runner against a fake box that
 * answers with canned stream-json, so parsing, cancellation and the
 * preflight messages are covered without a container.
 */

// ---------- fake CLIs ----------

const OK_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.ARGV_FILE) fs.writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(2)));
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (!process.argv.includes("stream-json")) { console.log("ok"); return; }
  const say = (event) => console.log(JSON.stringify(event));
  say({ type: "system", subtype: "init", model: "fake", prompt_chars: stdin.length });
  say({ type: "assistant", message: { content: [{ type: "text", text: "Looking around first." }] } });
  say({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  say({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } });
  say({ type: "result", subtype: "success", is_error: false, result: "Added the thing" });
});
`;

const AUTH_ERROR_SCRIPT = `#!/usr/bin/env node
process.stdin.resume();
const text = "Not logged in · Please run /login";
if (process.argv.includes("stream-json")) {
  console.log(JSON.stringify({ type: "system", subtype: "init" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text }));
} else {
  console.log(text);
}
process.exit(1);
`;

const SLOW_SCRIPT = `#!/usr/bin/env node
process.stdin.resume();
console.log(JSON.stringify({ type: "system", subtype: "init" }));
setTimeout(() => console.log("late"), 30_000);
`;

function fakeClis() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kru-claude-test-"));
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
    return file;
  };
  return {
    dir,
    ok: write("claude-ok", OK_SCRIPT),
    authError: write("claude-auth", AUTH_ERROR_SCRIPT),
    slow: write("claude-slow", SLOW_SCRIPT),
    missing: path.join(dir, "claude-missing"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------- box layer ----------

test("box: the prompt goes to the CLI on stdin, never in argv", async () => {
  const clis = fakeClis();
  try {
    const argvFile = path.join(clis.dir, "argv.json");
    const prompt = `Repo: o/r\nTask: ${"x".repeat(5000)}`;
    const lines: string[] = [];
    const result = await spawnClaude({
      bin: clis.ok,
      args: claudeArgs({ model: "claude-sonnet-5", systemPromptFile: "/tmp/system.md" }),
      cwd: clis.dir,
      env: { ...process.env, ARGV_FILE: argvFile },
      prompt,
      timeoutMs: 10_000,
      onLine: (line: string) => lines.push(line),
    });
    assert.equal(result.exitCode, 0);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    assert.ok(!argv.some((arg) => arg.includes("Task:")), "prompt must not be in argv");
    assert.ok(argv.includes("--model") && argv.includes("claude-sonnet-5"));
    assert.ok(argv.includes("--append-system-prompt-file"));
    assert.ok(argv.includes("--dangerously-skip-permissions"));
    const init = JSON.parse(lines[0]) as { prompt_chars: number };
    assert.equal(init.prompt_chars, prompt.length, "the whole prompt reached stdin");
    const last = JSON.parse(lines.at(-1) ?? "{}") as { type: string; result: string };
    assert.equal(last.type, "result");
    assert.equal(last.result, "Added the thing");
  } finally {
    clis.cleanup();
  }
});

test("box: a read-only run loses the writing tools, and turns are capped", () => {
  const plain = claudeArgs({ model: "claude-sonnet-5", systemPromptFile: "/tmp/s.md" });
  assert.ok(!plain.includes("Edit") && !plain.includes("--max-turns"));
  const review = claudeArgs({ model: "claude-sonnet-5", systemPromptFile: "/tmp/s.md", readOnly: true, maxTurns: 12 });
  for (const tool of ["Edit", "Write", "MultiEdit", "Bash(git checkout:*)", "Bash(rm:*)", "Bash(git commit:*)"]) {
    assert.ok(review.includes(tool), tool);
  }
  assert.deepEqual(review.slice(review.indexOf("--max-turns"), review.indexOf("--max-turns") + 2), ["--max-turns", "12"]);
  // The tool list must end before the system prompt flag, or the CLI would read it as a tool.
  assert.equal(review.at(-2), "--append-system-prompt-file");
  assert.equal(claudeArgs({ model: "m", systemPromptFile: "f", maxTurns: 10_000 }).includes("200"), true);
  assert.equal(claudeArgs({ model: "m", systemPromptFile: "f", maxTurns: 0 }).includes("--max-turns"), false);
});

test("box: aborting kills the CLI", async () => {
  const clis = fakeClis();
  try {
    const stop = new AbortController();
    const started = Date.now();
    const result = await spawnClaude({
      bin: clis.slow,
      args: ["-p"],
      cwd: clis.dir,
      env: process.env,
      prompt: "go",
      timeoutMs: 60_000,
      signal: stop.signal,
      onLine: () => stop.abort(),
    });
    assert.equal(result.aborted, true);
    assert.equal(result.signal, "SIGTERM");
    assert.ok(Date.now() - started < 10_000, "the child died on the abort, not the timeout");
  } finally {
    clis.cleanup();
  }
});

test("box: the sign-in check tells missing, signed out and ok apart", async () => {
  const clis = fakeClis();
  try {
    const run = (bin: string) => checkClaude({ bin, cwd: clis.dir, env: process.env });
    assert.equal((await run(clis.missing)).status, "missing");
    const signedOut = await run(clis.authError);
    assert.equal(signedOut.status, "unauthenticated");
    assert.match(signedOut.detail, /Not logged in/);
    assert.equal((await run(clis.ok)).status, "ok");
    assert.equal(classifyCheck({ exitCode: 2, output: "segfault" }), "error");
    assert.equal(classifyCheck({ spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) }), "missing");
  } finally {
    clis.cleanup();
  }
});

// ---------- stream parsing ----------

test("runner: stream-json lines become log lines and a result", () => {
  const text = readStreamLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking\n around" }] } }));
  assert.deepEqual(text.log, ["Looking\n around"]);
  const tool = readStreamLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: `npm test ${"a".repeat(1_200)}` } },
          { type: "tool_use", name: "Edit", input: { file_path: "/work/run-1/src/a.ts", old_string: "x" } },
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          { type: "tool_use", name: "Bash", input: { command: "cd /home/agent/workspace/run-1/src && ls /x/run-10" } },
        ],
      },
    }),
    "run-1",
  );
  assert.equal(tool.log[0].length, 1_003);
  assert.ok(tool.log[0].startsWith("$ npm test "));
  assert.equal(tool.log[1], "edit src/a.ts");
  assert.equal(tool.log[2], "Grep foo");
  assert.equal(tool.log[3], "$ cd ./src && ls /x/run-10");
  const result = readStreamLine(JSON.stringify({ type: "result", is_error: true, result: "boom" }));
  assert.deepEqual(result.result, { text: "boom", isError: true });
  assert.deepEqual(readStreamLine("not json"), { log: [] });
  assert.deepEqual(readStreamLine(JSON.stringify({ type: "rate_limit_event" })), { log: [] });
});

test("runner: preflight failures have their own messages", () => {
  assert.equal(preflightProblem({ status: "ok", detail: "ok" }), null);
  assert.equal(preflightProblem({ status: "missing", detail: "" }), CLAUDE_MISSING_MESSAGE);
  assert.equal(preflightProblem({ status: "unauthenticated", detail: "Not logged in" }), CLAUDE_SIGN_IN_MESSAGE);
  assert.equal(
    preflightProblem({ status: "error", detail: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz leaked" }),
    "Claude Code check failed: token *** leaked",
  );
});

// ---------- runner against a fake box ----------

type FakeBox = {
  check: ClaudeCheck;
  /** What the CLI prints. `{ wait: ms }` pauses the stream, for a run that is still working. */
  events: unknown[];
  /** Later CLI processes in the same run print these instead, one entry each. */
  thenEvents?: unknown[][];
  /** Keep the stream open after the events, until the client goes away. */
  hold?: boolean;
  /** What the workspace's changes are; one added file by default. */
  changes?: unknown[];
};

function listen(server: Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startFakeBox(box: FakeBox) {
  let markClosed = () => undefined as void;
  const seen = {
    calls: [] as string[],
    run: null as Record<string, unknown> | null,
    /** Every CLI process started, oldest first. */
    runs: [] as Record<string, unknown>[],
    /** Resolves when a held run request is closed by the client. */
    closedEarly: new Promise<void>((resolve) => {
      markClosed = resolve;
    }),
  };
  const server = createServer(async (req, res) => {
    seen.calls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== "Bearer tok") {
      res.writeHead(401);
      res.end('{"error":"Unauthorized"}');
      return;
    }
    const body = await readBody(req);
    if (req.url === "/claude/check") return json(res, box.check);
    if (req.url === "/workspaces" && req.method === "POST") return json(res, { id: body.id, head: "abc" });
    if (req.url?.endsWith("/claude") && req.method === "POST") {
      seen.run = body;
      seen.runs.push(body);
      const later = seen.runs.length > 1 ? box.thenEvents?.[seen.runs.length - 2] : undefined;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      for (const event of later ?? box.events) {
        const wait = (event as { wait?: number }).wait;
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        else if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (box.hold && !later) {
        const ping = setInterval(() => res.write(": ping\n\n"), 200);
        res.on("close", () => {
          clearInterval(ping);
          markClosed();
        });
        return;
      }
      res.end();
      return;
    }
    if (req.url?.endsWith("/changes")) return json(res, { files: box.changes ?? [{ path: "a.txt", status: "added", content: "hi" }] });
    if (req.method === "DELETE") return json(res, { ok: true });
    res.writeHead(404);
    res.end('{"error":"Not found"}');
  });
  const port = await listen(server);
  process.env.KRU_BOX_URL = `http://127.0.0.1:${port}`;
  process.env.KRU_BOX_TOKEN = "tok";
  return {
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function line(event: unknown) {
  return { type: "line", line: JSON.stringify(event) };
}

const OK_EVENTS = [
  line({ type: "system", subtype: "init" }),
  line({ type: "assistant", message: { content: [{ type: "text", text: "Looking around first." }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
  line({ type: "result", subtype: "success", is_error: false, result: "Added the thing" }),
  { type: "exit", code: 0, signal: null, timedOut: false, aborted: false },
];

function agentInput(overrides: Partial<AgentInput> = {}): AgentInput & { lines: string[] } {
  const at = "2026-09-16T00:00:00.000Z";
  const github: Connection = {
    id: "github",
    provider: "github",
    accessToken: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    refreshToken: null,
    expiresAt: null,
    label: "octo",
    meta: {},
  };
  const lines: string[] = [];
  return {
    card: {
      id: "card1",
      title: "Add the thing",
      body: "Please",
      column: "run",
      repo: "o/r",
      model: "claude-code:claude-sonnet-5",
      status: "running",
      runId: "run1",
      createdAt: at,
      updatedAt: at,
    },
    github,
    model: github,
    branch: "main",
    runId: "run1",
    log: (text) => lines.push(text),
    lines,
    ...overrides,
  };
}

test("runner: a finished run yields the summary, log lines and changes", async () => {
  const box = await startFakeBox({ check: { status: "ok", detail: "ok" }, events: OK_EVENTS });
  try {
    const input = agentInput();
    const result = await runCardClaudeCode(input);
    assert.equal(result.summary, "Added the thing");
    assert.equal(result.warning, null);
    assert.deepEqual(result.writes, [{ path: "a.txt", content: "hi", message: "Added the thing" }]);
    assert.ok(input.lines.includes("Looking around first."));
    assert.ok(input.lines.includes("$ npm test"));
    assert.ok(input.lines.includes("Finished: Added the thing"));
    assert.equal(box.seen.run?.model, "claude-sonnet-5");
    assert.match(String(box.seen.run?.prompt), /^Repo: o\/r\n\nTask: Add the thing\n\nDetails:\nPlease/);
    assert.match(String(box.seen.run?.systemPrompt), /Do not commit, push, or create branches/);
    assert.ok(!box.seen.calls.some((call) => call.startsWith("DELETE")), "the workspace stays for review");
  } finally {
    box.close();
  }
});

test("runner: changes that can't be collected keep the workspace, unless there are none", async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.txt`, status: "added", content: "x" }));
  const box = await startFakeBox({ check: { status: "ok", detail: "ok" }, events: OK_EVENTS, changes: many });
  try {
    await assert.rejects(runCardClaudeCode(agentInput()), (error: Error) => {
      assert.ok(error instanceof CollectFailedError);
      assert.match(error.message, /^The model proposed 60 files; the limit is 50\. The agent's work is still in the box/);
      return true;
    });
    assert.ok(!box.seen.calls.some((call) => call.startsWith("DELETE")), "the work stays recoverable");
  } finally {
    box.close();
  }
  const empty = await startFakeBox({ check: { status: "ok", detail: "ok" }, events: OK_EVENTS, changes: [] });
  try {
    await assert.rejects(runCardClaudeCode(agentInput()), (error: Error) => error.message === "The model proposed no changes");
    assert.ok(empty.seen.calls.includes("DELETE /workspaces/run1"));
  } finally {
    empty.close();
  }
});

test("runner: the CLI's error result fails the run and drops the workspace", async () => {
  const box = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [
      line({ type: "system", subtype: "init" }),
      line({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
      { type: "exit", code: 1, signal: null, timedOut: false, aborted: false },
    ],
  });
  try {
    await assert.rejects(runCardClaudeCode(agentInput()), (error: Error) => error.message === CLAUDE_SIGN_IN_MESSAGE);
    assert.ok(box.seen.calls.includes("DELETE /workspaces/run1"));
  } finally {
    box.close();
  }
  const other = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [
      line({ type: "result", subtype: "error_during_execution", is_error: true, result: "API overloaded" }),
      { type: "exit", code: 1, signal: null, timedOut: false, aborted: false },
    ],
  });
  try {
    await assert.rejects(runCardClaudeCode(agentInput()), (error: Error) => error.message === "Claude Code failed: API overloaded");
  } finally {
    other.close();
  }
});

test("runner: preflight failures stop before anything is cloned", async () => {
  const cases: [ClaudeCheck, string][] = [
    [{ status: "missing", detail: "" }, CLAUDE_MISSING_MESSAGE],
    [{ status: "unauthenticated", detail: "Not logged in" }, CLAUDE_SIGN_IN_MESSAGE],
    [{ status: "error", detail: "timed out" }, "Claude Code check failed: timed out"],
  ];
  for (const [check, message] of cases) {
    const box = await startFakeBox({ check, events: [] });
    try {
      await assert.rejects(runCardClaudeCode(agentInput()), (error: Error) => error.message === message);
      assert.deepEqual(box.seen.calls, ["POST /claude/check"]);
    } finally {
      box.close();
    }
  }
});

test("runner: cancelling aborts the box request, which ends the CLI", async () => {
  const box = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [line({ type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } })],
    hold: true,
  });
  try {
    let cancelled = false;
    const input = agentInput({ isCancelled: () => cancelled });
    const run = runCardClaudeCode({
      ...input,
      log: (text) => {
        input.lines.push(text);
        if (text === "Starting.") cancelled = true;
      },
    });
    await assert.rejects(run, RunCancelledError);
    // The box sees the socket go a moment after the client aborts.
    await Promise.race([
      box.seen.closedEarly,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the box never saw the request close")), 5_000)),
    ]);
    assert.ok(box.seen.calls.includes("DELETE /workspaces/run1"));
  } finally {
    box.close();
  }
});

// ---------- steering a run in flight ----------

test("runner: a steering note that changes the work interrupts the CLI after a tool result and continues with it", async () => {
  const box = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [
      line({ type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } }),
      line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm install" } }] } }),
      // Long enough for the note to be read while the command runs.
      { wait: 3_000 },
      line({ type: "user", message: { content: [{ type: "tool_result", content: "added 3 packages" }] } }),
    ],
    hold: true,
    thenEvents: [OK_EVENTS],
  });
  try {
    let pending = false;
    let considered = 0;
    const input = agentInput({
      steering: {
        pending: () => pending,
        consider: async () => {
          pending = false;
          considered += 1;
          return { decision: "adjust", reply: "Switching to pnpm.", notes: [], direction: "The person: use pnpm, not npm.\n\nYou decided to adjust." };
        },
      },
    });
    const result = await runCardClaudeCode({
      ...input,
      log: (text) => {
        input.lines.push(text);
        if (text === "Starting.") pending = true;
      },
    });

    assert.equal(considered, 1, "the note was read once");
    assert.equal(box.seen.runs.length, 2, "the CLI was started again in the same workspace");
    const first = String(box.seen.runs[0].prompt);
    const second = String(box.seen.runs[1].prompt);
    assert.doesNotMatch(first, /pnpm/);
    assert.match(second, /Task: Add the thing/, "the task is still the task");
    assert.match(second, /continuation, not a fresh start/);
    assert.match(second, /The person: use pnpm, not npm\./);
    assert.match(second, /\$ npm install/, "it is told what it had done");
    assert.ok(input.lines.includes("Steering from the room (adjust): Switching to pnpm."));
    assert.ok(input.lines.includes("Continuing in the same workspace with the new direction"));
    assert.ok(!box.seen.calls.includes("DELETE /workspaces/run1"), "the work so far is kept");
    assert.equal(result.summary, "Added the thing");
    assert.equal(result.stopped, undefined);
    assert.equal(result.writes.length, 1);
  } finally {
    box.close();
  }
});

test("runner: a note that changes nothing never interrupts the CLI", async () => {
  const box = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [line({ type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } }), { wait: 2_500 }, ...OK_EVENTS],
  });
  try {
    let pending = false;
    const input = agentInput({
      steering: {
        pending: () => pending,
        consider: async () => {
          pending = false;
          return { decision: "continue", reply: "Thanks, carrying on.", notes: [], direction: "Carry on." };
        },
      },
    });
    const result = await runCardClaudeCode({
      ...input,
      log: (text) => {
        input.lines.push(text);
        if (text === "Starting.") pending = true;
      },
    });
    assert.equal(box.seen.runs.length, 1);
    assert.ok(input.lines.includes("Steering from the room (continue): Thanks, carrying on."));
    assert.equal(result.summary, "Added the thing");
  } finally {
    box.close();
  }
});

test("runner: a run stopped to be restarted later ends the CLI and keeps what it changed", async () => {
  const box = await startFakeBox({
    check: { status: "ok", detail: "ok" },
    events: [line({ type: "assistant", message: { content: [{ type: "text", text: "Starting." }] } })],
    hold: true,
  });
  try {
    let stopped = false;
    const input = agentInput({ isCancelled: () => stopped, isStopped: () => stopped });
    const result = await runCardClaudeCode({
      ...input,
      log: (text) => {
        input.lines.push(text);
        if (text === "Starting.") stopped = true;
      },
    });
    await Promise.race([
      box.seen.closedEarly,
      new Promise((_, reject) => setTimeout(() => reject(new Error("the box never saw the request close")), 5_000)),
    ]);
    assert.equal(result.stopped, true);
    assert.equal(result.summary, null);
    assert.equal(result.warning, null);
    assert.deepEqual(result.writes.map((write) => write.path), ["a.txt"], "the work so far goes with the run");
    assert.ok(!box.seen.calls.includes("DELETE /workspaces/run1"), "and the workspace stays for the restart");
  } finally {
    box.close();
  }
});
