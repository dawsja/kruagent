"use client";

import {
  Check,
  CircleCheck,
  Copy,
  FilePen,
  FileText,
  FileX,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { parseMarkdown, type Inline } from "@/lib/hq/markdown";
import { readRunLog, type RunLogEntry } from "@/lib/hq/run-log";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The run log, collapsible so finished runs lead with their changes. While
 * the run is live it follows the newest entry. Entries are shown the way an
 * agent CLI shows them: the agent's words as Markdown, commands as code
 * blocks, file activity and tools as compact rows.
 */
export function RunLog({ lines, live, defaultOpen }: { lines: string[]; live: boolean; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const body = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => readRunLog(lines), [lines]);

  useEffect(() => {
    if (live && open && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines.length, live, open]);

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
        Run log <span className="font-mono normal-case text-ash/70">· {lines.length} lines</span>
      </summary>
      <div className="relative mt-2">
        <CopyLogButton text={lines.join("\n")} />
        <div
          ref={body}
          role="log"
          // Not a flex column: in a height-capped flex box the entries shrink
          // once the log overflows, and the ones that clip collapse to nothing.
          className="max-h-[32rem] space-y-2 overflow-auto rounded-lg border border-fog bg-mist p-3 pr-10"
        >
          {entries.map((entry, index) => (
            <LogEntry key={index} entry={entry} />
          ))}
        </div>
      </div>
    </details>
  );
}

const FILE_ICONS = { read: FileText, write: FilePen, edit: FilePen, delete: FileX } as const;

function LogEntry({ entry }: { entry: RunLogEntry }) {
  switch (entry.kind) {
    case "command":
      return <CommandBlock command={entry.command} outcome={entry.outcome} />;
    case "file": {
      const Icon = FILE_ICONS[entry.verb];
      return (
        <p className="flex min-w-0 items-center gap-2 text-[12px] text-graphite">
          <Icon className="size-3.5 shrink-0 text-sky" aria-hidden="true" />
          <span className="font-semibold capitalize text-carbon">{entry.verb}</span>
          <code className="truncate rounded bg-sky/10 px-1.5 py-0.5 font-mono text-[11px] text-sky" title={entry.path}>
            {entry.path}
          </code>
        </p>
      );
    }
    case "tool":
      return (
        <p className="flex min-w-0 items-center gap-2 text-[12px] text-graphite">
          <Wrench className="size-3.5 shrink-0 text-ash" aria-hidden="true" />
          <span className="font-semibold text-carbon">{entry.name}</span>
          {entry.detail ? (
            <code className="truncate font-mono text-[11px] text-ash" title={entry.detail}>
              {entry.detail}
            </code>
          ) : null}
        </p>
      );
    case "step":
      return (
        <p className="flex items-center gap-2 text-[12px] text-ash">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fog" />
          {entry.text}
        </p>
      );
    case "finished":
      return (
        <div className="rounded-md border border-mint/40 bg-mint/10 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-mint">
            <CircleCheck className="size-3.5" aria-hidden="true" />
            Finished
          </p>
          <Markdown source={entry.text} className="mt-1" />
        </div>
      );
    case "approval":
      return (
        <p className="flex items-center gap-2 text-[12px] font-medium text-mint">
          <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
          {entry.text}
        </p>
      );
    case "warning":
      return (
        <p className="flex items-start gap-2 text-[12px] leading-5 text-amber">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {entry.text}
        </p>
      );
    case "error":
      return (
        <p className="flex items-start gap-2 text-[12px] leading-5 text-ember">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{entry.text}</span>
        </p>
      );
    case "text":
      return <Markdown source={entry.text} />;
  }
}

/** Most lines of a command shown before it folds. */
const COMMAND_LINES = 8;

/** A command as a code block; a long one (a heredoc, say) folds after a few lines. */
function CommandBlock({ command, outcome }: { command: string; outcome: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const lines = command.split("\n");
  const hidden = expanded ? 0 : Math.max(0, lines.length - COMMAND_LINES);
  const shown = hidden ? lines.slice(0, COMMAND_LINES).join("\n") : command;
  return (
    <div className="overflow-hidden rounded-md border border-fog bg-linen">
      <pre className="overflow-x-auto border-l-2 border-brand px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap break-words text-carbon">
        <span className="mr-2 select-none font-semibold text-brand-ink">$</span>
        {shown}
      </pre>
      {lines.length > COMMAND_LINES ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="block w-full border-t border-fog px-3 py-1 text-left font-mono text-[11px] text-ash hover:text-carbon"
        >
          {expanded ? "Show less" : `… ${hidden} more line${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {outcome ? (
        <p className="border-t border-fog bg-ember/10 px-3 py-1 font-mono text-[11px] text-ember">{outcome}</p>
      ) : null}
    </div>
  );
}

/** Markdown from an agent, rendered as elements; nothing is injected as HTML. */
function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 text-[13px] leading-6 text-carbon", className)}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "paragraph":
            return (
              <p key={index} className="whitespace-pre-wrap break-words">
                <Inlines inlines={block.inlines} />
              </p>
            );
          case "heading": {
            const Heading = block.level <= 2 ? "h4" : "h5";
            return (
              <Heading
                key={index}
                className={cn("font-semibold text-carbon", block.level <= 2 ? "text-[14px]" : "text-[13px]")}
              >
                <Inlines inlines={block.inlines} />
              </Heading>
            );
          }
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index} className="flex flex-col gap-0.5">
                {block.items.map((item, itemIndex) => (
                  <li
                    key={itemIndex}
                    className="flex gap-2 break-words"
                    style={{ paddingLeft: `${item.depth * 16}px` }}
                  >
                    <span
                      aria-hidden="true"
                      className={cn("shrink-0 select-none text-brand-ink", block.ordered && "font-mono text-[12px]")}
                    >
                      {item.marker}
                    </span>
                    <span className="min-w-0">
                      <Inlines inlines={item.inlines} />
                    </span>
                  </li>
                ))}
              </List>
            );
          }
          case "quote":
            return (
              <blockquote
                key={index}
                className="whitespace-pre-wrap border-l-2 border-fog pl-3 italic text-graphite"
              >
                <Inlines inlines={block.inlines} />
              </blockquote>
            );
          case "code":
            return (
              <div key={index} className="overflow-hidden rounded-md border border-fog bg-linen">
                {block.lang ? (
                  <p className="border-b border-fog px-3 py-1 font-mono text-[10px] uppercase text-ash">
                    {block.lang}
                  </p>
                ) : null}
                <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre text-graphite">
                  {block.text}
                </pre>
              </div>
            );
          case "rule":
            return <hr key={index} className="border-fog" />;
        }
      })}
    </div>
  );
}

function Inlines({ inlines }: { inlines: Inline[] }): ReactNode {
  return inlines.map((inline, index) => {
    switch (inline.kind) {
      case "text":
        return <Fragment key={index}>{inline.text}</Fragment>;
      case "code":
        return (
          <code key={index} className="rounded bg-linen px-1 py-px font-mono text-[11.5px] text-amber">
            {inline.text}
          </code>
        );
      case "bold":
        return (
          <strong key={index} className="font-semibold text-carbon">
            <Inlines inlines={inline.children} />
          </strong>
        );
      case "italic":
        return (
          <em key={index}>
            <Inlines inlines={inline.children} />
          </em>
        );
      case "link":
        return (
          <a key={index} href={inline.href} target="_blank" rel="noreferrer" className="text-sky underline underline-offset-2">
            {inline.text}
          </a>
        );
    }
  });
}

function CopyLogButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard may be denied */
    }
  }

  const label = copied ? "Copied" : "Copy run log";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => void copy()}
            className="absolute top-2 right-2 z-10 rounded-md border border-fog bg-paper-white p-1.5 text-ash hover:border-brand hover:text-carbon"
          />
        }
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
