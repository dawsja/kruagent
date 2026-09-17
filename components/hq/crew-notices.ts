"use client";

import { useEffect, useRef, useState } from "react";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { crewNotice, unreadBot } from "@/lib/hq/bots/notices";
import type { BotId, BotJob, Card, ChatMessage, Run } from "@/lib/hq/types";

/*
 * The crew's reach outside the board: Pip's browser notifications when a
 * card moves, and the unread dot on the Team chat button.
 */

const READ_KEY = "kru.chatReadAt";
/** How often the room is checked for new lines while the panel is closed. */
const UNREAD_POLL_MS = 5_000;
/** Before any line exists, everything the crew posts is new. */
const EPOCH = new Date(0).toISOString();

function readStoredReadAt(): string | null {
  try {
    return window.localStorage.getItem(READ_KEY);
  } catch {
    return null;
  }
}

/**
 * Asks once, from a click, whether Pip may send notifications. Browsers
 * without the API, or where you said no, just don't get them.
 */
export function requestNotificationPermission() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Promise.resolve(Notification.requestPermission()).catch(() => undefined);
}

function notify(body: string, tag: string, onClick: () => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  // You're looking at the board already.
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const notification = new Notification("Pip", { body, tag, icon: "/logo.png" });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

/**
 * Sends Pip's line whenever a crew job changes stage between two loads of
 * the board. The first load is the baseline, so a reload notifies nothing.
 */
export function useCrewNotices({
  jobs,
  cards,
  runs,
  loaded,
  onOpenCard,
}: {
  jobs: BotJob[];
  cards: Card[];
  runs: Pick<Run, "id" | "headBranch" | "prUrl" | "prNumber" | "status">[];
  loaded: boolean;
  onOpenCard: (cardId: string) => void;
}) {
  const seen = useRef<Map<string, BotJob> | null>(null);
  const openCard = useRef(onOpenCard);
  useEffect(() => {
    openCard.current = onOpenCard;
  }, [onOpenCard]);

  useEffect(() => {
    if (!loaded) return;
    const previous = seen.current;
    seen.current = new Map(jobs.map((job) => [job.id, job]));
    if (!previous) return;
    for (const job of jobs) {
      const card = cards.find((item) => item.id === job.cardId);
      if (!card) continue;
      // A job on a pull request's branch is a follow-up; once its run is
      // approved by the time the job is done, the crew pushed it itself.
      const run = job.runId ? runs.find((item) => item.id === job.runId) : undefined;
      const followUp = run?.headBranch && run.prUrl ? (run.prNumber ?? null) : null;
      const text = crewNotice(previous.get(job.id), job, card.title, { followUp, pushed: run?.status === "approved" });
      if (text) notify(text, `kru-card-${card.id}`, () => openCard.current(card.id));
    }
  }, [jobs, cards, runs, loaded]);
}

/**
 * The bot whose line you haven't seen, for the dot on the chat button.
 * Opening the room marks everything in it read. `onActivity` runs when new
 * lines arrive while the room is closed, so the board catches up with them.
 */
export function useChatUnread({
  open,
  enabled,
  onActivity,
}: {
  open: boolean;
  enabled: boolean;
  onActivity?: () => void;
}): BotId | null {
  // The newest few lines; only the last bot's matters.
  const [recent, setRecent] = useState<ChatMessage[]>([]);
  const [fetched, setFetched] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  }, [onActivity]);

  const latestAt = recent.at(-1)?.createdAt ?? null;

  // Seeded once the room has been fetched: a first visit starts caught up.
  if (fetched && readAt === null) {
    setReadAt(readStoredReadAt() ?? latestAt ?? EPOCH);
  }
  // With the room open, whatever arrives is read as it lands.
  if (open && readAt !== null && latestAt !== null && latestAt > readAt) {
    setReadAt(latestAt);
  }

  useEffect(() => {
    if (readAt === null) return;
    try {
      window.localStorage.setItem(READ_KEY, readAt);
    } catch {
      // Private mode: the dot only lasts for this page.
    }
  }, [readAt]);

  // A new line in the room checks at once; the poll is the safety net.
  const [nudge, setNudge] = useState(0);
  const live = useLiveEvents((message) => {
    if (message.topic === "chat" && message.cleared) setRecent([]);
    if (message.topic === "chat" || message.topic === "open") setNudge((n) => n + 1);
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const check = () => {
      const after = latestAt ? `after=${encodeURIComponent(latestAt)}&` : "";
      void fetch(`/api/chat?${after}limit=20`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { messages?: ChatMessage[] } | null) => {
          if (cancelled || !data?.messages) return;
          const incoming = data.messages;
          setFetched(true);
          if (incoming.length === 0) return;
          setRecent((current) => [...current, ...incoming].slice(-20));
          if (latestAt && !open) activity.current?.();
        })
        .catch(() => undefined);
    };
    if (!latestAt || nudge > 0) check();
    const timer = window.setInterval(check, pollInterval(live, UNREAD_POLL_MS));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, open, latestAt, live, nudge]);

  return open ? null : unreadBot(recent, readAt);
}
