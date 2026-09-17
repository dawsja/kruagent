"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A small "agent is working" indicator for a running card. The label is the
 * latest log line and is announced politely to screen readers. The dots only
 * animate when the user hasn't asked for reduced motion.
 */
export function RunStatus({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <output
      aria-live="polite"
      className={cn(
        "flex min-w-0 items-center gap-2.5 text-[12px] text-graphite",
        className,
      )}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="size-1.5 rounded-full bg-brand motion-safe:animate-pulse"
            style={{ animationDelay: `${dot * 180}ms` }}
          />
        ))}
      </span>
      <span className="truncate">{label}</span>
    </output>
  );
}

/** "42s", "3:07", "1:02:09": seconds since `since`, counting up once a second. */
export function RunElapsed({
  since,
  className,
}: {
  since: string;
  className?: string;
}) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (Number.isNaN(start)) return null;
  const total = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  const text =
    hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : minutes > 0
        ? `${minutes}:${pad(seconds)}`
        : `${seconds}s`;

  return (
    <time
      dateTime={`PT${total}S`}
      title="Time running"
      className={cn("shrink-0 font-mono text-[12px] tabular-nums text-ash", className)}
    >
      {text}
    </time>
  );
}
