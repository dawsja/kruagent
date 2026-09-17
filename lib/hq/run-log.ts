import { parseInline, plainInline } from "./markdown.ts";

/*
 * What each run-log line is, for showing the log like an agent CLI does:
 * commands as code blocks with how they ended, file activity and other
 * tool calls as compact rows, Kru's own progress as quiet steps, and the
 * agent's words as Markdown. Log lines stay plain strings in the database;
 * this only reads them.
 */

export type RunLogEntry =
  | { kind: "command"; command: string; outcome: string | null }
  | { kind: "file"; verb: "read" | "write" | "edit" | "delete"; path: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "step"; text: string }
  | { kind: "finished"; text: string }
  | { kind: "approval"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "error"; text: string }
  | { kind: "text"; text: string };

/** Lines Kru itself writes about the run's progress. */
const STEP =
  /^(Agent started$|Revising the previous result\. |Base branch |Cloning \S+ into the box$|Workspace ready$|Continuing in the previous run's workspace$|Applied \d+ files? from the previous run$|Running Claude Code \()/;
/** Claude Code's own tools, logged as "<Name> <first argument>". */
const TOOL =
  /^(Glob|Grep|LS|WebFetch|WebSearch|TodoWrite|Task|Agent|NotebookEdit|MultiEdit|Skill|ToolSearch|KillShell|BashOutput|ExitPlanMode|mcp__\S+)(?: ([\s\S]*))?$/;
const FILE = /^(read|write|edit|delete) (\S[^\n]*)$/;
const OUTCOME = /^\s+(exit -?\d+|timed out[^\n]*)$/;
const WARNING = /^The agent (ran out of time|hit its|stopped without)/;
const FAILURE =
  /^(Claude Code failed|Claude Code isn't signed in|Claude Code check failed|The box image has no|Connect GitHub first|Card has no repo|Pick a Claude Code model|Agent failed)|\b(failed|error):/i;

export function readRunLog(lines: string[]): RunLogEntry[] {
  const entries: RunLogEntry[] = [];
  for (const line of lines) {
    const outcome = OUTCOME.exec(line);
    const previous = entries.at(-1);
    if (outcome && previous?.kind === "command" && !previous.outcome) {
      previous.outcome = outcome[1];
      continue;
    }
    const entry = readLine(line);
    // Claude Code's last message is also its summary: show it once, as the summary.
    if (entry.kind === "finished" && previous?.kind === "text" && sameText(previous.text, entry.text)) {
      entries.pop();
    }
    entries.push(entry);
  }
  return entries;
}

/** Equal, allowing for one of them having been cut short with "…". */
function sameText(a: string, b: string) {
  const [x, y] = [a.replace(/…$/, "").trim(), b.replace(/…$/, "").trim()];
  return Boolean(x) && (x.startsWith(y) || y.startsWith(x));
}

function readLine(line: string): RunLogEntry {
  if (line.startsWith("$ ")) return { kind: "command", command: line.slice(2), outcome: null };
  const file = FILE.exec(line);
  if (file) return { kind: "file", verb: file[1] as "read" | "write" | "edit" | "delete", path: file[2] };
  // Before tools: "Agent started" is Kru's, not Claude Code's Agent tool.
  if (STEP.test(line)) return { kind: "step", text: line };
  const tool = TOOL.exec(line);
  if (tool) return { kind: "tool", name: tool[1], detail: tool[2] ?? "" };
  if (line.startsWith("Finished: ")) return { kind: "finished", text: line.slice("Finished: ".length) };
  if (line.startsWith("Waiting for approval")) return { kind: "approval", text: line };
  if (line.startsWith("Skipped ") || WARNING.test(line)) return { kind: "warning", text: line };
  if (FAILURE.test(line)) return { kind: "error", text: line };
  return { kind: "text", text: line };
}

/**
 * One short line for a status indicator: the first line of a log entry,
 * without Markdown markers.
 */
export function logHeadline(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const first = line.split("\n").find((part) => part.trim()) ?? line;
  if (line.startsWith("$ ")) return first;
  return plainInline(parseInline(first.replace(/^\s*(#{1,6}|[-*+]|\d+[.)]|>)\s+/, ""))).trim();
}
