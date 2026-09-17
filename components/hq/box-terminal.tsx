"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { copyToClipboard, isPasteChord, isTerminalCopyChord } from "@/components/hq/clipboard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { markdownToAnsi } from "@/lib/hq/markdown";

/**
 * A terminal into the box. In "shell" mode it's an interactive bash for the
 * person, in the agent's ~/workspace or inside a running run's clone. In
 * "watch" mode it's read-only and shows what the agent is doing in a run:
 * the commands it runs with their live output, and the files it touches.
 *
 * Output arrives as server-sent events through Kru; keystrokes go back as
 * small POSTs. Nothing here talks to the box directly.
 *
 * Clipboard: Ctrl+Shift+C, Ctrl+Insert, or Ctrl+C with text selected copy
 * the selection; Ctrl+V, Ctrl+Shift+V and Shift+Insert paste. The
 * browser's own context menu works too, since xterm keeps the selection in
 * its hidden textarea.
 */
export type TerminalTarget =
  | { kind: "shell"; runId?: string | null; title: string }
  | { kind: "watch"; runId: string; title: string };

type Status = "connecting" | "live" | "ended" | "error";

const THEME = {
  background: "#0e1116",
  foreground: "#d7dde5",
  cursor: "#8ab4f8",
  selectionBackground: "#2c3947",
  black: "#0e1116",
  brightBlack: "#5c6773",
  green: "#7ee787",
  cyan: "#79c0ff",
  yellow: "#e3b341",
  red: "#ff7b72",
};

function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type WatchEvent =
  | { type: "clone"; repo: string; ref: string }
  | { type: "ready"; head: string }
  | { type: "command"; command: string }
  | { type: "output"; text: string }
  | { type: "say"; text: string }
  | { type: "exit"; code: number; timedOut?: boolean }
  | { type: "read" | "write" | "edit" | "delete"; path: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "collect" }
  | { type: "end" };

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BLUE = "\x1b[38;2;91;157;255m";
const ORANGE = "\x1b[38;2;255;106;51m";
const RESET = "\x1b[0m";

const FILE_VERBS = { read: "Read", write: "Write", edit: "Edit", delete: "Delete" } as const;

/** Most lines of a command shown before the rest is summarized. */
const COMMAND_LINES = 6;

/** Cuts a line to `width` columns, marking the cut. */
function clip(text: string, width: number) {
  const chars = [...text];
  return chars.length > width ? `${chars.slice(0, Math.max(1, width - 1)).join("")}…` : text;
}

/**
 * One watch event as terminal text, laid out like an agent CLI: the agent's
 * words as formatted Markdown, commands under an orange bar with their
 * output below, and file activity and other tools as one-line rows. Rows
 * and commands are cut to the terminal's width rather than wrapped, so a
 * long heredoc stays a few tidy lines.
 */
function watchLine(event: WatchEvent, cols: number): string | null {
  const width = Math.max(20, cols - 1);
  switch (event.type) {
    case "clone":
      return `${DIM}◇ ${clip(`Cloning ${event.repo}@${event.ref}…`, width - 2)}${RESET}\n`;
    case "ready":
      return `${DIM}◇ Workspace ready at ${event.head.slice(0, 10)}${RESET}\n`;
    case "say":
      return `\n${markdownToAnsi(event.text)}`;
    case "command": {
      const lines = event.command.trim().split("\n");
      const shown = lines.slice(0, COMMAND_LINES);
      const bar = `${ORANGE}┃${RESET} `;
      const body = shown
        .map((line, index) =>
          index === 0
            ? `${bar}${BOLD}${ORANGE}$${RESET} ${BOLD}${clip(line, width - 4)}${RESET}\n`
            : `${bar}  ${clip(line, width - 4)}\n`,
        )
        .join("");
      const hidden = lines.length - shown.length;
      const more = hidden > 0 ? `${bar}  ${DIM}… ${hidden} more line${hidden === 1 ? "" : "s"}${RESET}\n` : "";
      return `\n${body}${more}`;
    }
    case "output":
      return event.text;
    case "exit":
      return event.timedOut
        ? `${RED}✗ timed out${RESET}\n`
        : event.code === 0
          ? `${DIM}${GREEN}✓${RESET}\n`
          : `${RED}✗ exit ${event.code}${RESET}\n`;
    case "read":
    case "write":
    case "edit":
    case "delete": {
      const verb = FILE_VERBS[event.type];
      return `${BLUE}→${RESET} ${BOLD}${verb}${RESET} ${BLUE}${clip(event.path, width - verb.length - 3)}${RESET}\n`;
    }
    case "tool": {
      const detail = event.detail.replace(/\s+/g, " ").trim();
      const room = width - event.name.length - 3;
      return `${ORANGE}⚙${RESET} ${BOLD}${event.name}${RESET}${detail && room > 4 ? ` ${DIM}${clip(detail, room)}${RESET}` : ""}\n`;
    }
    case "collect":
      return `\n${DIM}◇ Collecting changes for review…${RESET}\n`;
    case "end":
      return `\n${DIM}◇ Run finished; the workspace was removed${RESET}\n`;
    default:
      return null;
  }
}

export function BoxTerminal({
  target,
  sessionId,
  onSession,
  onClose,
}: {
  target: TerminalTarget;
  /** A shell opened earlier and hidden; reconnects to it instead of starting a new one. */
  sessionId?: string | null;
  /** Reports the shell's id, or null when it has ended. */
  onSession?: (id: string | null) => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Tooltips portal into the panel, since the body sits below this overlay.
  const panel = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [message, setMessage] = useState<string | null>(null);
  const [shellId, setShellId] = useState<string | null>(sessionId ?? null);
  // Read once when the terminal mounts; the id itself lives in board state.
  const initialSession = useRef(sessionId ?? null);
  const report = useRef(onSession);
  useEffect(() => {
    report.current = onSession;
  }, [onSession]);

  async function endShell() {
    if (shellId) {
      await fetch(`/api/box/terminals/${shellId}`, { method: "DELETE" }).catch(() => undefined);
      report.current?.(null);
    }
    onClose();
  }

  useEffect(() => {
    if (target.kind !== "watch") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target.kind, onClose]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // xterm touches the DOM at import time, so it's loaded in the browser only.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      const term = new Terminal({
        theme: THEME,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        cursorBlink: target.kind === "shell",
        disableStdin: target.kind === "watch",
        convertEol: target.kind === "watch",
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(node);
      fit.fit();

      // Copy and paste keys. Returning false hands the key to the browser
      // instead of the shell: for a paste chord that raises the paste event
      // xterm listens for, so nothing is stopped; for a copy chord the copy
      // is done here and the default (Ctrl+Shift+C opens the inspector) is
      // stopped. Ctrl+C with a selection copies, without one it interrupts.
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        if (isPasteChord(event)) return false;
        const selectionCopy =
          event.code === "KeyC" && event.ctrlKey && !event.shiftKey && !event.altKey && term.hasSelection();
        if (isTerminalCopyChord(event) || selectionCopy) {
          event.preventDefault();
          void copyToClipboard(term.getSelection());
          if (selectionCopy) term.clearSelection();
          return false;
        }
        return true;
      });

      const disposers: (() => void)[] = [() => term.dispose()];
      cleanup = () => disposers.splice(0).forEach((fn) => fn());

      const fail = (text: string) => {
        setStatus("error");
        setMessage(text);
        term.write(`\r\n${RED}${text}${RESET}\r\n`);
      };

      const listen = (url: string, onEvent: (data: string) => void, onGone: () => void) => {
        const source = new EventSource(url);
        source.onopen = () => setStatus("live");
        source.onmessage = (event) => onEvent(event.data as string);
        source.onerror = () => {
          // EventSource retries on its own; a closed connection means the
          // other side is gone for good.
          if (source.readyState === EventSource.CLOSED) onGone();
        };
        disposers.push(() => source.close());
        return source;
      };

      if (target.kind === "watch") {
        // Refit when the panel changes size; what is already written keeps
        // its width, what comes next uses the new one.
        const observer = new ResizeObserver(() => fit.fit());
        observer.observe(node);
        disposers.push(() => observer.disconnect());
        // Whether the terminal is at the start of a line, so a row never
        // lands on the end of a command's unfinished output.
        let lineStart = true;
        const source = listen(
          `/api/runs/${target.runId}/watch`,
          (raw) => {
            const event = JSON.parse(raw) as WatchEvent;
            const line = watchLine(event, term.cols);
            if (line) {
              term.write(event.type === "output" || lineStart ? line : `\n${line}`);
              lineStart = line.endsWith("\n");
            }
            if (event.type === "end") {
              setStatus("ended");
              source.close();
            }
          },
          () => {
            if (status !== "ended") fail("Nothing to watch: the run isn't working in the box.");
          },
        );
        return;
      }

      // Shell: reconnect to a hidden one when it still exists (the resize
      // doubles as the probe and syncs the size), else open a PTY sized to
      // this view. Closing the panel hides the shell; End shell kills it.
      let id: string | null = null;
      const existing = initialSession.current;
      if (existing) {
        const probe = await fetch(`/api/box/terminals/${existing}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
        });
        if (probe.ok) id = existing;
        else report.current?.(null);
      }
      if (!id) {
        const res = await fetch("/api/box/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: target.runId ?? null, cols: term.cols, rows: term.rows }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          terminal?: { id: string; cwd: string };
          error?: string;
        };
        if (disposed) return;
        if (!res.ok || !data.terminal) {
          fail(data.error ?? "Could not open a terminal in the box.");
          return;
        }
        id = data.terminal.id;
        report.current?.(id);
      }
      if (disposed) return;
      setShellId(id);

      listen(
        `/api/box/terminals/${id}/stream`,
        (raw) => {
          const event = JSON.parse(raw) as { data?: string; exit?: number };
          if (event.data) term.write(fromBase64(event.data));
          if (event.exit !== undefined) {
            setStatus("ended");
            report.current?.(null);
            term.write(`\r\n${DIM}[shell exited]${RESET}\r\n`);
          }
        },
        () => setStatus((current) => (current === "ended" ? current : "error")),
      );

      // Keystrokes are sent in order, one request at a time.
      let sending: Promise<unknown> = Promise.resolve();
      disposers.push(
        term.onData((input) => {
          sending = sending.then(() =>
            fetch(`/api/box/terminals/${id}/input`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data: toBase64(input) }),
            }).catch(() => undefined),
          );
        }).dispose,
      );

      let resizeTimer: number | undefined;
      const observer = new ResizeObserver(() => {
        fit.fit();
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          void fetch(`/api/box/terminals/${id}/resize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          });
        }, 150);
      });
      observer.observe(node);
      disposers.push(() => observer.disconnect());
      term.focus();
    })();

    return () => {
      disposed = true;
      cleanup();
    };
    // The terminal is created once per target; status is read for the watch fallback only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label="Close terminal"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div ref={panel} className="relative flex h-[min(80vh,42rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0e1116] shadow-subtle-3">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-[13px] font-medium text-white/90">{target.title}</span>
            <span
              className={
                "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
                (status === "live"
                  ? "bg-mint/20 text-mint"
                  : status === "error"
                    ? "bg-ember/20 text-ember"
                    : "bg-white/10 text-white/60")
              }
            >
              {status === "live" ? (target.kind === "watch" ? "watching" : "connected") : status}
            </span>
            {message ? <span className="truncate text-[12px] text-white/50">{message}</span> : null}
          </div>
          <div className="flex items-center gap-1">
            {target.kind === "shell" && shellId && status !== "ended" ? (
              <button
                type="button"
                onClick={() => void endShell()}
                className="rounded-full px-2.5 py-1 text-[12px] text-white/60 hover:bg-white/10 hover:text-white"
              >
                End shell
              </button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={target.kind === "shell" ? "Hide (the shell keeps running)" : "Close"}
                    className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
                  />
                }
              >
                <X className="size-4" />
              </TooltipTrigger>
              <TooltipContent side="bottom" container={panel}>
                {target.kind === "shell" ? "Hide — the shell keeps running" : "Close"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {/* The padding sits outside the terminal's own parent: the fit addon
            measures that parent's width with its padding. And the page's
            tight letter-spacing must not reach xterm, which measures a cell
            with it and then draws text wider than the columns it fitted. */}
        <div className="min-h-0 flex-1 p-2">
          <div ref={host} className="h-full tracking-normal [&_.xterm]:h-full" />
        </div>
      </div>
    </div>
  );
}
